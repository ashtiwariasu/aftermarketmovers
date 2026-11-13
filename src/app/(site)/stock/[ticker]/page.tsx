import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getCouncilPage } from "@/lib/council";
import { getTickerSnapshot } from "@/lib/ticker";
import { getTickerNews, newsStamp, daysToEvent } from "@/lib/news";
import { getArticle, getCompanyNews } from "@/lib/newsStore";
import { newsBucketFor } from "@/lib/newsBuckets";
import { getDesk, isDeskServiceActive, setCompanyFolder, tierOf } from "@/lib/desk";
import {
  ensureCompanyFolder,
  listFolderDocs,
  addEvidenceNote,
  updateNote,
  type FileDoc,
} from "@/lib/companyFile";
import { fundamentalsMd, type Fundamentals, type SecFiling } from "@/lib/sec";
import { getBarsSnapshot, getDossierHistory, getFilingsStored, getFundamentalsStored } from "@/lib/companyStore";
import { dossierReleaseValidationError, type Dossier } from "@/lib/dossier";
import { buildStockChairmanRun, type StockChairmanRun } from "@/lib/stockChairmanDeck";
import {
  projectSignalTrack,
  toPublicSignalTrackView,
} from "@/lib/signalTrack";
import { storyFor, claimsLedgerMd } from "@/lib/story";
import { getRoomHistory } from "@/lib/roomHistory";
import RoomWorkspace from "@/components/RoomWorkspace";
import Workbench from "@/components/Workbench";
import TalkToThesis from "@/components/TalkToThesis";
import StockChairmanDeck from "@/components/StockChairmanDeck";
import PublicStockEvidence from "@/components/PublicStockEvidence";
import type { PublicSignalTrackRun } from "@/components/PublicSignalTrackHistory";
import GetStartedCta from "@/components/GetStartedCta";
import JsonLd from "@/components/JsonLd";
import ResearchAnalytics from "@/components/ResearchAnalytics";
import { getLatestPublicShortForTicker } from "@/lib/publicShorts";
import { type RoomMsg } from "@/components/CouncilRoom";
import { citedTextHtml } from "@/lib/morningNote";
import {
  conciseResearchText,
  getLatestPublishableDossier,
  isPublishablePublicDossier,
  isPublicResearchTicker,
  plainResearchText,
  stockSeoCopy,
} from "@/lib/publicResearch";

interface Params {
  params: Promise<{ ticker: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { ticker } = await params;
  const sym = ticker.toUpperCase();
  const publicEvidenceTicker = isPublicResearchTicker(sym);
  const [snapshot, dossier] = await Promise.all([
    getTickerSnapshot(sym),
    publicEvidenceTicker
      ? getLatestPublishableDossier(sym)
      : Promise.resolve(null),
  ]);
  const company = snapshot?.name ?? sym;
  const copy = stockSeoCopy(sym, company, dossier);
  const canonical = `https://aftermarketmovers.com/stock/${sym.toLowerCase()}`;
  const openGraph: Metadata["openGraph"] = {
    type: "website",
    title: copy.title,
    description: copy.description,
    url: canonical,
    siteName: "AMM · After Market Movers",
    images: ["/opengraph-image.png"],
  };
  return {
    title: copy.title,
    description: copy.description,
    robots: publicEvidenceTicker && dossier
      ? { index: true, follow: true }
      : { index: false, follow: true },
    alternates: { canonical },
    openGraph,
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      images: ["/opengraph-image.png"],
    },
  };
}

function pct(v: number | null): string {
  if (v == null) return "—";
  if (Math.abs(v) < 0.005) return "0.00%";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function pctColor(v: number | null): string {
  if (v == null) return "var(--pr-faint)";
  return v >= 0 ? "var(--pr-up)" : "var(--pr-down)";
}

function fmtVol(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(v);
}

function etNow(): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date()) + " ET"
  );
}

function etDateIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default async function StockPage({ params }: Params) {
  const { ticker } = await params;
  const sym = ticker.toUpperCase();
  const publicEvidenceTicker = isPublicResearchTicker(sym);
  const { userId } = await auth();
  const [snapshot, page, desk, publicDossier, latestPublicShort] = await Promise.all([
    getTickerSnapshot(sym),
    Promise.resolve(getCouncilPage(sym)),
    userId ? getDesk(userId) : Promise.resolve(null),
    getLatestPublishableDossier(sym),
    publicEvidenceTicker
      ? getLatestPublicShortForTicker(sym)
      : Promise.resolve(null),
  ]);
  if (!snapshot) notFound();
  const traceableLinks = await getCompanyNews(sym, 12);
  const traceableArticles = (await Promise.all(traceableLinks.map((link) => getArticle(link.articleId))))
    .filter((article) => article != null);
  const fallbackNews = traceableArticles.length === 0
    ? await getTickerNews(sym, 4, snapshot.name)
    : [];
  const news = traceableArticles.length > 0
    ? traceableArticles.map((article) => {
        const evidenceTier = article.evidenceTier ?? "discovery";
        return {
          title: article.title,
          publisher: article.publisher,
          link: article.canonicalUrl,
          at: article.publishedAt,
          publishedDate: new Date(article.publishedAt).toISOString().slice(0, 10),
          authority: evidenceTier === "authoritative" &&
            article.provenance.some((source) => source.sourceType === "primary")
            ? "PRIMARY"
            : evidenceTier === "discovery" ? "DISCOVERY" : "VERIFIED NEWS",
          bucket: newsBucketFor(article),
          sourceCount: article.observationCount ?? article.provenance.length,
          traceable: evidenceTier !== "discovery",
        };
      })
    : fallbackNews.map((article) => ({
        ...article,
        publishedDate: new Date(article.at).toISOString().slice(0, 10),
        authority: "DISCOVERY",
        bucket: "discovery" as const,
        sourceCount: 1,
        traceable: false,
      }));

  const eventDays = daysToEvent(snapshot.nextEvent);
  const day = Math.abs(snapshot.dayChangePercent ?? 0);
  const ah = Math.abs(snapshot.afterHoursChangePercent ?? 0);
  const flagged = ah >= 1.5 || day >= 2.5;
  const eventSoon = eventDays != null && eventDays >= 0 && eventDays <= 14;

  const legacyRoomMessages = (desk?.messages ?? []).filter(
    (m) => m.ticker === sym
  );
  const councilAnswers = legacyRoomMessages.filter(
    (m) => m.kind === "council"
  ).length;
  const serviceActive = desk ? isDeskServiceActive(desk) : false;
  const watching = serviceActive && (desk?.tickers.includes(sym) ?? false);
  const roomIntroText = watching
    ? `This is ${sym} in AMM Desk. Ask anything about ${snapshot.name} below. AMM Desk matches your question to the relevant verified research and answers only from the dated evidence in this company file.`
    : `Ask AMM Desk anything about ${snapshot.name} — and add it to your watch to receive it in your Morning Note.`;

  // The company file: an llmcouncil library folder ring-fencing this
  // company's context — created on first visit, evidence filed daily.
  let companyFolderId = desk?.folders?.[sym] ?? null;
  if (desk && watching && !companyFolderId) {
    companyFolderId = await ensureCompanyFolder(desk.email, sym);
    if (companyFolderId) await setCompanyFolder(desk.id, sym, companyFolderId);
  }

  // Room transcript: the llmcouncil session is the store; legacy Firestore
  // messages (pre-live-engine) are kept as the head of the thread.
  const roomSessionId = desk?.rooms?.[sym] ?? null;
  const llmc3History =
    roomSessionId && desk ? await getRoomHistory(roomSessionId, desk.email) : [];
  const roomHistory: RoomMsg[] = [
    ...legacyRoomMessages.map(
      (m): RoomMsg => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      })
    ),
    ...llmc3History,
  ];

  const councilBase = process.env.LLMC3_COUNCIL_URL ?? "";
  const roomWsUrl = councilBase
    ? `wss://${new URL(councilBase).host}/ws/chat`
    : "";
  const contextNote =
    `${sym} (${snapshot.name}) — $${snapshot.price?.toFixed(2) ?? "?"}, ` +
    `${pct(snapshot.dayChangePercent)} on the day, ` +
    `${snapshot.afterHoursChangePercent != null ? `${pct(snapshot.afterHoursChangePercent)} after hours` : "quiet after hours"}. ` +
    `${snapshot.nextEvent ? `Next company event: ${snapshot.nextEvent}. ` : ""}` +
    `${page ? `Five analysts have ${page.claims.length} claims recorded with ${page.split.vote} agreement; the open question: ${page.split.question} ` : ""}` +
    `You are AMM Desk for this member's ${sym} file. Research and evidence framing only — no buy/sell/hold advice, no price targets.`;

  // ---- member workspace data: chairman runs, context docs ----
  const memberView = Boolean(desk && serviceActive && watching && roomWsUrl && companyFolderId);
  const renderedAt = new Date();
  let initialDocs: FileDoc[] = [];
  let chairmanRuns: StockChairmanRun[] = [];
  let publicSignalRuns: PublicSignalTrackRun[] = [];

  let filings: SecFiling[] = [];
  let publicFundamentals: Fundamentals | null = null;
  if (memberView && desk && companyFolderId) {
    const [docsRaw, filingsRaw, fundamentals, dossierHistory, dailyBars] = await Promise.all([
      listFolderDocs(desk.email, companyFolderId),
      getFilingsStored(sym, 8),
      getFundamentalsStored(sym),
      getDossierHistory<Dossier>(sym, 7).catch(() => [] as Dossier[]),
      getBarsSnapshot(sym).catch(() => []),
    ]);
    initialDocs = docsRaw;
    filings = filingsRaw;
    publicFundamentals = fundamentals;

    // The Numbers tab: one rolling note, rewritten when a newer quarter files.
    if (fundamentals) {
      const desired = `Fundamentals — ${sym} · ${fundamentals.asOf}`;
      const existing = initialDocs.find((d) => d.name.startsWith(`Fundamentals — ${sym}`));
      if (!existing) {
        await addEvidenceNote(desk.email, companyFolderId, desired, fundamentalsMd(sym, fundamentals));
        initialDocs = await listFolderDocs(desk.email, companyFolderId);
      } else if (existing.name !== desired) {
        await updateNote(desk.email, existing.id, {
          name: desired,
          content: fundamentalsMd(sym, fundamentals),
        });
        initialDocs = await listFolderDocs(desk.email, companyFolderId);
      }
    }

    // The claims ledger becomes a real context doc, once.
    if (page && !initialDocs.some((d) => d.name.startsWith("Claims ledger"))) {
      const ok = await addEvidenceNote(
        desk.email,
        companyFolderId,
        `Claims ledger — ${sym}`,
        claimsLedgerMd(page)
      );
      if (ok) initialDocs = await listFolderDocs(desk.email, companyFolderId);
    }

    // Calendar runs are complete release-valid chairman dossiers only. The
    // current pointer is included even if a history write was briefly delayed.
    const dossiersByDate = new Map<string, Dossier>();
    for (const candidate of [...dossierHistory, ...(publicDossier ? [publicDossier] : [])]) {
      if (candidate.ticker !== sym || dossierReleaseValidationError(candidate) !== null) continue;
      const existing = dossiersByDate.get(candidate.date);
      if (!existing || candidate.generatedAt > existing.generatedAt) dossiersByDate.set(candidate.date, candidate);
    }
    chairmanRuns = [...dossiersByDate.values()]
      .sort((a, b) => b.date.localeCompare(a.date) || b.generatedAt - a.generatedAt)
      .slice(0, 7)
      .map((dossier) =>
        buildStockChairmanRun(
          dossier,
          projectSignalTrack({
            direction: dossier.signalCase.direction,
            strength: dossier.signalCase.strength,
            horizon: dossier.signalCase.horizonSessions,
            issueDate: dossier.date,
            generatedAt: dossier.generatedAt,
            bars: dailyBars,
          }),
        ),
      );
  } else if (publicEvidenceTicker) {
    const [filingsRaw, fundamentalsRaw, dossierHistory, dailyBars] = await Promise.all([
      getFilingsStored(sym, 8),
      getFundamentalsStored(sym),
      getDossierHistory<Dossier>(sym, 14).catch(() => [] as Dossier[]),
      getBarsSnapshot(sym).catch(() => []),
    ]);
    filings = filingsRaw;
    publicFundamentals = fundamentalsRaw;

    const publicDossiersByDate = new Map<string, Dossier>();
    for (const candidate of [
      ...dossierHistory,
      ...(publicDossier ? [publicDossier] : []),
    ]) {
      if (
        candidate.ticker !== sym ||
        !isPublishablePublicDossier(candidate)
      ) {
        continue;
      }
      const existing = publicDossiersByDate.get(candidate.date);
      if (!existing || candidate.generatedAt > existing.generatedAt) {
        publicDossiersByDate.set(candidate.date, candidate);
      }
    }

    publicSignalRuns = [...publicDossiersByDate.values()]
      .sort(
        (left, right) =>
          right.date.localeCompare(left.date) ||
          right.generatedAt - left.generatedAt,
      )
      .slice(0, 7)
      .map((dossier) => ({
        date: dossier.date,
        view: toPublicSignalTrackView(
          projectSignalTrack({
            direction: dossier.signalCase.direction,
            strength: dossier.signalCase.strength,
            horizon: dossier.signalCase.horizonSessions,
            issueDate: dossier.date,
            generatedAt: dossier.generatedAt,
            bars: dailyBars,
          }),
        ),
      }));
  }

  const freshNews = news
    .filter((n) => n.bucket !== "filings" || !filings.some((filing) => filing.url === n.link))
    .filter((n) => !initialDocs.some((d) => d.name.includes(n.title.slice(0, 40))))
    .map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      stamp: newsStamp(n.at),
      publishedDate: n.publishedDate,
      authority: n.authority,
      bucket: n.bucket,
      sourceCount: n.sourceCount,
      traceable: n.traceable,
    }))
    .concat({
      title: `${sym} trading snapshot · ${pct(snapshot.dayChangePercent)} day${
        snapshot.afterHoursChangePercent == null ? "" : ` · ${pct(snapshot.afterHoursChangePercent)} after hours`
      }`,
      publisher: "Yahoo Finance market data",
      link: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`,
      stamp: etNow(),
      publishedDate: etDateIso(),
      authority: "MARKET DATA",
      bucket: "market" as const,
      sourceCount: 1,
      traceable: true,
    });
  const roomSessions =
    desk?.roomList?.[sym] ??
    (roomSessionId
      ? [{ id: roomSessionId, title: "Earlier session", at: desk?.createdAt ?? renderedAt.getTime() }]
      : []);
  const freshFilings = filings
    .filter((f) => !initialDocs.some((d) => d.name.startsWith(`${f.formLabel} — ${f.date}`)))
    .map((f) => ({ formLabel: f.formLabel, date: f.date, url: f.url, title: f.title }));

  const eventShort = snapshot.nextEvent?.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/
  )?.[0];

  const seoCopy = stockSeoCopy(sym, snapshot.name, publicDossier);
  const stockUrl = `https://aftermarketmovers.com/stock/${sym.toLowerCase()}`;
  const publicEvidenceLinks = news.map((item) => ({
    title: item.title,
    publisher: item.publisher,
    link: item.link,
    stamp: newsStamp(item.at),
    publishedDate: item.publishedDate,
    authority: item.authority,
    bucket: item.bucket,
    sourceCount: item.sourceCount,
  }));
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "After Market Movers", item: "https://aftermarketmovers.com/" },
          { "@type": "ListItem", position: 2, name: `${sym} stock research`, item: stockUrl },
        ],
      },
      ...(publicEvidenceTicker && publicDossier
        ? [{
            "@type": "CollectionPage",
            "@id": `${stockUrl}#public-evidence`,
            name: seoCopy.title,
            description: seoCopy.description,
            dateModified: new Date(publicDossier.generatedAt).toISOString(),
            url: stockUrl,
            publisher: { "@type": "Organization", name: "After Market Movers", url: "https://aftermarketmovers.com/", logo: { "@type": "ImageObject", url: "https://aftermarketmovers.com/icon.png" } },
            about: { "@type": "Organization", name: snapshot.name, tickerSymbol: sym },
            isAccessibleForFree: true,
            inLanguage: "en",
          }]
        : []),
      ...(latestPublicShort
        ? [{
            "@type": "VideoObject",
            "@id": `${stockUrl}#daily-short-${latestPublicShort.videoId}`,
            name: `${latestPublicShort.ticker}: ${latestPublicShort.title}`,
            description:
              `AMM's latest one-minute, evidence-checked analysis of ${snapshot.name}.`,
            thumbnailUrl: [latestPublicShort.thumbnailUrl],
            uploadDate: latestPublicShort.publishedAt,
            embedUrl:
              `https://www.youtube-nocookie.com/embed/${latestPublicShort.videoId}`,
            contentUrl:
              `https://www.youtube.com/watch?v=${latestPublicShort.videoId}`,
            isAccessibleForFree: true,
            publisher: {
              "@type": "Organization",
              name: "After Market Movers",
              url: "https://aftermarketmovers.com/",
            },
          }]
        : []),
    ],
  };

  const fileHeader = (
    <>
      <div className="flex items-end gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-4">
            <h1 className="pp-disp font-extrabold text-5xl tracking-tight leading-none" style={{ color: "var(--pr-blue)" }}>
              {snapshot.symbol}
            </h1>
            <span className="hidden sm:inline text-[15px] truncate" style={{ color: "var(--pr-dim)" }}>
              {snapshot.name}
            </span>
          </div>
          <span className="sm:hidden block mt-1 text-[12px] truncate" style={{ color: "var(--pr-dim)" }}>
            {snapshot.name}
          </span>
        </div>
        <div className="ml-auto shrink-0 text-right">
          <span className="block pp-mono font-semibold text-[19px] sm:text-[22px]">
            ${snapshot.price?.toFixed(2) ?? "—"}
          </span>
          <span className="block pp-mono text-[11px] sm:text-[13px]" style={{ color: pctColor(snapshot.dayChangePercent) }}>
            {pct(snapshot.dayChangePercent)}
            {snapshot.afterHoursChangePercent != null ? ` · ${pct(snapshot.afterHoursChangePercent)} AH` : ""}
          </span>
        </div>
      </div>
      <div className={`flex gap-2 mt-4 flex-wrap ${memberView ? "mb-1" : "mb-7"}`}>
        {flagged && (
          <span
            className="pp-mono text-[9.5px] uppercase tracking-[0.16em] px-2.5 py-1 rounded-full"
            style={{ background: "var(--pr-orange)", color: "var(--pr-paper)", border: "1.5px solid var(--pr-ink)" }}
          >
            FLAG · MOVE
          </span>
        )}
        {eventSoon && eventShort && (
          <span
            className="pp-mono text-[9.5px] uppercase tracking-[0.16em] px-2.5 py-1 rounded-full"
            style={{ background: "var(--pr-lime)", border: "1.5px solid var(--pr-ink)" }}
          >
            EVENT · {eventShort.toUpperCase()}
          </span>
        )}
        {memberView && page && <span className="pp-chip">{page.claims.length} CLAIMS LOCKED</span>}
        {watching && !memberView && <span className="pp-chip">IN AMM DESK</span>}
        {!watching && userId && (
          <Link href={`/desk/new?add=${encodeURIComponent(sym)}`} className="pp-chip hover:opacity-70">
            + WATCH {sym}
          </Link>
        )}
      </div>
    </>
  );

  if (!memberView) {
    return (
      <div className="pt-6 pb-16">
        {publicEvidenceTicker && publicDossier ? <JsonLd data={structuredData} /> : null}
        <ResearchAnalytics
          ticker={sym}
          hasPublishedThesis={Boolean(publicDossier)}
          pageVariant={publicEvidenceTicker ? "public_evidence" : "subscription_gate"}
          hasDailyShort={Boolean(latestPublicShort)}
        />
        {userId && (
          <Link
            href="/desk"
            className="pp-mono text-[11px] inline-block mb-5 hover:opacity-70"
            style={{ color: "var(--pr-dim)" }}
          >
            ← AMM DESK
          </Link>
        )}
        {fileHeader}
        <PublicStockEvidence
          ticker={sym}
          snapshot={snapshot}
          publicEvidence={publicEvidenceTicker}
          fundamentals={publicFundamentals}
          filings={filings}
          news={publicEvidenceLinks}
          eventDays={eventDays}
          refreshedAt={publicDossier?.date ?? etDateIso()}
          dailyShort={latestPublicShort}
          signalRuns={publicSignalRuns}
        />
      </div>
    );
  }

  return (
    <div className="pt-6 pb-16">
      <JsonLd data={structuredData} />
      <ResearchAnalytics
        ticker={sym}
        hasPublishedThesis={Boolean(publicDossier)}
        pageVariant="member"
        hasDailyShort={Boolean(latestPublicShort)}
      />
      {userId && (
        <Link
          href="/desk"
          className="pp-mono text-[11px] inline-block mb-5 hover:opacity-70"
          style={{ color: "var(--pr-dim)" }}
        >
          ← AMM DESK
        </Link>
      )}

      {/* File header */}
      {fileHeader}

      {memberView && desk && companyFolderId ? (
        <>
          <StockChairmanDeck ticker={sym} runs={chairmanRuns} />

          <TalkToThesis ticker={sym} tier={tierOf(desk)} />

          <section id="room" className="mt-9">
            <Workbench
              ticker={sym}
              userEmail={desk.email}
              wsUrl={roomWsUrl}
              intro={roomIntroText}
              contextNote={contextNote}
              initialFolderId={companyFolderId}
              initialDocs={initialDocs}
              initialExcluded={desk.contextExclude?.[sym] ?? []}
              sessions={roomSessions}
              latestSessionId={roomSessionId}
              initialHistory={roomHistory}
              freshNews={freshNews}
              freshFilings={freshFilings}
            />
          </section>
        </>
      ) : (
        <>
      <div className="grid lg:grid-cols-12 gap-6 items-start">
        {/* Left: the file */}
        <div className="lg:col-span-8 space-y-5">
          {publicDossier && (
            <article id="latest-analysis" className="pp-card pp-shadow p-6" aria-labelledby="latest-analysis-title">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="pp-mono text-[9.5px] uppercase tracking-[0.2em]" style={{ color: "var(--pr-orange)" }}>
                  Latest AMM Desk thesis · {publicDossier.date}
                </p>
                <span className="pp-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--pr-blue)" }}>
                  {publicDossier.emailHook.signal.strength === "STRONG" ? "STRONG" : "GENTLE"} {publicDossier.emailHook.signal.direction === "UP" ? "UPSIDE" : "DOWNSIDE"} · {publicDossier.emailHook.signal.horizonSessions.min}–{publicDossier.emailHook.signal.horizonSessions.max} SESSIONS
                </span>
              </div>
              <h2 id="latest-analysis-title" className="pp-disp font-extrabold text-2xl sm:text-3xl leading-tight mt-4">
                {plainResearchText(publicDossier.emailHook.subjectPunchline)}
              </h2>
              <p className="mt-4 text-[14.5px] leading-[1.65]" dangerouslySetInnerHTML={{ __html: citedTextHtml(publicDossier.emailHook.whatChanged) }} />
              <div className="mt-5 pt-4 flex items-start justify-between gap-4 flex-wrap" style={{ borderTop: "1.5px solid rgba(22,21,15,.18)" }}>
                <p className="text-[13px] leading-relaxed max-w-[560px]" style={{ color: "var(--pr-dim)" }}>
                  <strong style={{ color: "var(--pr-ink)" }}>{publicDossier.emailHook.votes.support}/5 analysts support this thesis.</strong>{" "}
                  {conciseResearchText(publicDossier.emailHook.confidence.majorityReason, 190)}
                </p>
                <GetStartedCta ticker={sym} className="pp-btn pp-btn-orange text-[13px] px-4 py-2.5">
                  Track {sym} for $25 →
                </GetStartedCta>
              </div>
            </article>
          )}
          <section className="pp-card pp-shadow p-6">
            <p className="pp-mono text-[9.5px] uppercase tracking-[0.2em] mb-3" style={{ color: "var(--pr-faint)" }}>
              The story so far
            </p>
            <p className="text-[14.5px] leading-[1.65]">
              {storyFor(snapshot, page, eventDays, flagged)}
            </p>
            <p className="pp-mono text-[11px] mt-3" style={{ color: "var(--pr-faint)" }}>
              — AMM Desk · updated {etNow()}
            </p>
          </section>

          <section className="pp-card p-6">
            <p className="pp-mono text-[9.5px] uppercase tracking-[0.2em] mb-1" style={{ color: "var(--pr-faint)" }}>
              News &amp; evidence file
            </p>
            <div className="divide-y" style={{ borderColor: "rgba(22,21,15,.12)" }}>
              <div className="flex gap-4 py-3 text-[13.5px] leading-relaxed">
                <span className="pp-mono text-[10.5px] pt-0.5 w-[84px] shrink-0" style={{ color: "var(--pr-faint)" }}>
                  LATEST
                </span>
                <span>
                  {pct(snapshot.dayChangePercent)} on the day on {fmtVol(snapshot.volume)} volume
                  {snapshot.afterHoursChangePercent != null
                    ? `; ${pct(snapshot.afterHoursChangePercent)} in the after-hours session`
                    : "; after-hours quiet"}
                  .{" "}
                  <span
                    className="pp-mono text-[9px] uppercase tracking-[0.12em] px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={{ border: "1.5px solid var(--pr-ink)" }}
                  >
                    TRADING
                  </span>
                </span>
              </div>
              {news.map((n) => (
                <div key={n.link || n.title} className="flex gap-4 py-3 text-[13.5px] leading-relaxed" style={{ borderTop: "1.5px solid rgba(22,21,15,.12)" }}>
                  <span className="pp-mono text-[10.5px] pt-0.5 w-[84px] shrink-0" style={{ color: "var(--pr-faint)" }}>
                    {newsStamp(n.at)}
                  </span>
                  <span>
                    <a
                      href={n.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium underline"
                      style={{ color: "var(--pr-blue)" }}
                      title={`Published ${n.publishedDate} · open original source`}
                    >
                      {n.title} [{n.publishedDate}] ↗
                    </a>{" "}
                    <span
                      className="pp-mono text-[9px] uppercase tracking-[0.12em] px-2 py-0.5 rounded-full whitespace-nowrap"
                      style={{ border: "1.5px solid var(--pr-ink)" }}
                    >
                      {n.authority} · {n.publisher}
                    </span>
                  </span>
                </div>
              ))}
              {page && (
                <div className="flex gap-4 py-3 text-[13.5px] leading-relaxed" style={{ borderTop: "1.5px solid rgba(22,21,15,.12)" }}>
                  <span className="pp-mono text-[10.5px] pt-0.5 w-[84px] shrink-0" style={{ color: "var(--pr-faint)" }}>
                    {page.asOf.toUpperCase()}
                  </span>
                  <span>
                    Analyst review: {page.claims.length} claims recorded; disagreement retained in the {page.split.vote} result.{" "}
                    <span
                      className="pp-mono text-[9px] uppercase tracking-[0.12em] px-2 py-0.5 rounded-full whitespace-nowrap"
                      style={{ border: "1.5px solid var(--pr-ink)", background: "var(--pr-lime)" }}
                    >
                      ANALYSTS
                    </span>
                  </span>
                </div>
              )}
            </div>
          </section>

          {page && (
            <section className="pp-card p-6">
              <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
                <p className="pp-mono text-[9.5px] uppercase tracking-[0.2em]" style={{ color: "var(--pr-faint)" }}>
                  The claims ledger — scored the morning after
                </p>
                <span className="pp-mono text-[10.5px]" style={{ color: "var(--pr-faint)" }}>
                  misses stay on the page
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {page.claims.map((c, i) => (
                      <tr key={c.id} style={{ borderTop: i > 0 ? "1.5px solid rgba(22,21,15,.12)" : undefined }}>
                        <td className="py-2.5 pr-3 pp-mono text-[10.5px] align-baseline" style={{ color: "var(--pr-faint)", width: 56 }}>
                          C-{String(i + 1).padStart(2, "0")}
                        </td>
                        <td className="py-2.5 pr-3 text-[13.5px] leading-snug">{c.claim}</td>
                        <td className="py-2.5 text-right pp-mono font-semibold text-[12.5px] whitespace-nowrap align-baseline" style={{ color: "var(--pr-blue)" }}>
                          {c.status === "open" ? "OPEN" : c.status.replace("resolved_", "").toUpperCase()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        {/* Right: baseline + event + activity */}
        <aside className="lg:col-span-4 space-y-4">
          <div className="pp-card pp-shadow-sm p-5">
            <p className="pp-mono text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: "var(--pr-faint)" }}>
              Current snapshot
            </p>
            <div className="grid grid-cols-2">
              {[
                ["Last", `$${snapshot.price?.toFixed(2) ?? "—"}`],
                ["Prev close", `$${snapshot.previousClose?.toFixed(2) ?? "—"}`],
                [
                  "52-week",
                  snapshot.fiftyTwoWeekLow != null && snapshot.fiftyTwoWeekHigh != null
                    ? `${snapshot.fiftyTwoWeekLow.toFixed(0)}–${snapshot.fiftyTwoWeekHigh.toFixed(0)}`
                    : "—",
                ],
                ["Volume", fmtVol(snapshot.volume)],
                ["Session", snapshot.marketState === "POST" ? "AFTER HRS" : "CLOSED"],
                ["Exchange", snapshot.exchange || "—"],
              ].map(([k, v], i) => (
                <div key={k} className="py-2.5" style={{ borderTop: i > 1 ? "1.5px solid rgba(22,21,15,.12)" : undefined }}>
                  <p className="pp-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--pr-faint)" }}>
                    {k}
                  </p>
                  <p className="pp-mono font-semibold text-[13.5px] mt-0.5">{v}</p>
                </div>
              ))}
            </div>
          </div>

          {snapshot.nextEvent && (
            <div className="rounded-[14px] p-5" style={{ background: "var(--pr-ink)", color: "rgba(244,241,234,.85)" }}>
              <p className="pp-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--pr-lime)" }}>
                Next company event
              </p>
              <p className="pp-disp font-extrabold text-[16px] mt-2 leading-snug" style={{ color: "var(--pr-paper)" }}>
                {snapshot.nextEvent}
              </p>
              <p className="pp-mono text-[11px] mt-1">
                {eventDays != null && eventDays >= 0
                  ? eventDays === 0
                    ? "today"
                    : `in ${eventDays} days`
                  : "monitored"}
                {page ? ` · ${page.claims.length} claims scored the morning after` : ""}
              </p>
            </div>
          )}

          <div className="pp-card p-5">
            <p className="pp-mono text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: "var(--pr-faint)" }}>
              AMM Desk activity
            </p>
            <div className="pp-mono text-[11px] leading-[2]" style={{ color: "var(--pr-dim)" }}>
              <p><b style={{ color: "var(--pr-ink)" }}>{etNow()}</b> — baseline refreshed, story updated</p>
              {desk?.lastNoteDate && watching && (
                <p><b style={{ color: "var(--pr-ink)" }}>{desk.lastNoteDate}</b> — covered in your Morning Note</p>
              )}
              {councilAnswers > 0 && (
                <p><b style={{ color: "var(--pr-ink)" }}>{councilAnswers}</b> research {councilAnswers === 1 ? "answer" : "answers"} on this file</p>
              )}
              {page && (
                <p><b style={{ color: "var(--pr-ink)" }}>{page.asOf}</b> — {page.claims.length} claims locked</p>
              )}
              {watching && desk && (
                <p><b style={{ color: "var(--pr-ink)" }}>{new Date(desk.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</b> — company added to AMM Desk</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Council split + seats — the standing record */}
      {page && (
        <>
          <section
            className="rounded-[14px] p-7 mt-8"
            style={{ background: "var(--pr-ink)", color: "var(--pr-paper)", boxShadow: "6px 6px 0 var(--pr-orange)" }}
          >
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="pp-disp font-extrabold text-2xl">How the analysts split</h2>
              <span className="pp-disp font-extrabold text-4xl" style={{ color: "var(--pr-lime)" }}>
                {page.split.vote}
              </span>
            </div>
            <p className="mt-1 font-medium text-[15px]" style={{ color: "rgba(244,241,234,.85)" }}>
              {page.split.question}
            </p>
            <div className="mt-5 grid md:grid-cols-2 gap-4 text-[14px] leading-relaxed">
              <div className="rounded-lg p-4" style={{ background: "rgba(244,241,234,.08)", border: "1px solid rgba(244,241,234,.2)" }}>
                <p className="pp-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: "var(--pr-lime)" }}>
                  Majority
                </p>
                <p className="mt-1.5" style={{ color: "rgba(244,241,234,.9)" }}>
                  {page.split.majority}
                </p>
              </div>
              <div className="rounded-lg p-4" style={{ background: "rgba(255,77,31,.14)", border: "1px solid rgba(255,77,31,.5)" }}>
                <p className="pp-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: "#FF8B7A" }}>
                  Strongest dissent
                </p>
                <p className="mt-1.5" style={{ color: "rgba(244,241,234,.9)" }}>
                  {page.split.dissent}
                </p>
              </div>
            </div>
            <p className="mt-4 pp-mono text-[11px]" style={{ color: "rgba(244,241,234,.55)" }}>
              Next review: {page.split.nextResolutionEvent}
            </p>
          </section>

          <section className="mt-8">
            <h2 className="pp-disp font-extrabold text-2xl tracking-tight mb-4">
              The five analysts
            </h2>
            <div className="grid md:grid-cols-2 gap-4">
              {page.seats.map((s) => (
                <div key={s.seat} className="pp-card p-5">
                  <p className="pp-disp font-extrabold text-[16px]">{s.seat}</p>
                  <p className="pp-mono text-[10.5px] mt-0.5" style={{ color: "var(--pr-faint)" }}>
                    {s.focus}
                  </p>
                  <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
                    {s.position}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* The room — company-scoped council chat */}
      <section id="room" className="pt-6 mt-10" style={{ borderTop: "2px solid var(--pr-ink)" }}>
        {desk && roomWsUrl ? (
          <RoomWorkspace
            ticker={sym}
            userEmail={desk.email}
            wsUrl={roomWsUrl}
            initialSessionId={roomSessionId}
            history={roomHistory}
            intro={roomIntroText}
            contextNote={contextNote}
            initialFolderId={companyFolderId}
          />
        ) : (
          <div className="pp-card pp-shadow-sm p-6 max-w-[560px] mx-auto">
            <p className="text-[14px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
              Sign in to ask AMM Desk about {snapshot.name}. Every answer stays
              inside this company file and shows the dated sources it relies on.
            </p>
            <div className="mt-4">
              <GetStartedCta ticker={sym} className="pp-btn pp-btn-orange text-[14px] px-5 py-2.5">
                Track {sym} for $25 →
              </GetStartedCta>
            </div>
          </div>
        )}
      </section>
        </>
      )}

    </div>
  );
}
