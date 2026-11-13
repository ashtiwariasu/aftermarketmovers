/**
 * The sitting bundle — everything AMM Desk chat is allowed to read for a
 * member's question: the canonical company store (tape, filings, XBRL,
 * wires) plus the member's checked-in file documents and the session so far.
 * The bundle is the ONLY admissible source for the answer; its manifest feeds
 * the narration ("Reading: …").
 */

import { getTickerSnapshot } from "@/lib/ticker";
import { newsStamp } from "@/lib/news";
import { fundamentalsMd } from "@/lib/sec";
import { getBarsStored, getFilingsStored, getFundamentalsStored } from "@/lib/companyStore";
import { listFolderDocs, previewDocForIntent } from "@/lib/companyFile";
import { formatIntentEvidence, selectIntentEvidence, type IntentSource } from "@/lib/intentContext";
import { getArticle, getCompanyNews } from "@/lib/newsStore";
import { newsBucketFor } from "@/lib/newsBuckets";
import type { Desk } from "@/lib/desk";
import type { SittingTurn } from "@/lib/desk";

const BUNDLE_CAP = 90_000; // chars total (~22k tokens)
const PREVIEW_CONCURRENCY = 8;

function pct(v: number | null): string {
  if (v == null) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export interface SittingBundle {
  context: string;
  /** Human-readable source names for the narration. */
  sources: string[];
  /** Short factual lines the narrator may surface ("Filed fundamentals: …"). */
  stats: string[];
  retrieval: {
    intent: string;
    eligibleSources: number;
    readableSources: number;
    matchedSources: number;
    matchedPassages: number;
  };
}

async function loadReadableSources(
  email: string,
  docs: Array<{ id: string; name: string }>
): Promise<IntentSource[]> {
  const readable: IntentSource[] = [];
  for (let offset = 0; offset < docs.length; offset += PREVIEW_CONCURRENCY) {
    const batch = docs.slice(offset, offset + PREVIEW_CONCURRENCY);
    const previews = await Promise.all(
      batch.map(async (doc) => ({
        doc,
        preview: await previewDocForIntent(email, doc.id).catch(() => null),
      }))
    );
    for (const { doc, preview } of previews) {
      if (!preview?.content?.trim()) continue;
      readable.push({ id: doc.id, name: preview.name?.trim() || doc.name, content: preview.content });
    }
  }
  return readable;
}

export async function buildSittingBundle(
  desk: Desk,
  sym: string,
  documentIds: string[] | null,
  priorTurns: SittingTurn[],
  question: string
): Promise<SittingBundle | null> {
  const folderId = desk.folders?.[sym];
  const [snap, daily, filings, fundamentals, companyNewsLinks, folderDocs] = await Promise.all([
    getTickerSnapshot(sym),
    getBarsStored(sym),
    getFilingsStored(sym, 8),
    getFundamentalsStored(sym),
    getCompanyNews(sym, 12).catch(() => []),
    folderId ? listFolderDocs(desk.email, folderId).catch(() => []) : Promise.resolve([]),
  ]);
  if (!snap) return null;

  const traceableNews = (
    await Promise.all(companyNewsLinks.map((link) => getArticle(link.articleId).catch(() => null)))
  ).filter((article) => article != null);
  const excluded = new Set(desk.contextExclude?.[sym] ?? []);
  const tapeUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`;
  const capturedDate = new Date().toISOString().slice(0, 10);

  const sources: string[] = [];
  const stats: string[] = [];
  const parts: string[] = [
    `COMPANY: ${snap.name} (${sym}), ${snap.exchange}.`,
    `COMPANY FILE FRESHNESS: market snapshot captured ${capturedDate}; each filing and news item retains its own source date. For "latest" or "today" questions, the evidence cutoff is the newest relevant dated source admitted below.`,
  ];

  const month = daily.slice(-21);
  if (fundamentals) {
    const filedSource = filings.find((filing) => filing.form === "10-Q" || filing.form === "10-K");
    parts.push(
      `FILED FUNDAMENTALS (SEC XBRL):\n${fundamentalsMd(sym, fundamentals)}\n` +
      `Source period end: ${fundamentals.asOf}. ` +
      `${filedSource ? `Supporting filed source: ${filedSource.formLabel} filed ${filedSource.date}. Original source: ${filedSource.url}` : "Original filing date and URL are not supplied in this file."}`
    );
    sources.push(`the filed fundamentals (${fundamentals.fiscal})`);
    stats.push(`Filed fundamentals loaded — ${fundamentals.fiscal} series.`);
  }
  // ---- session memory: this conversation so far ----
  if (priorTurns.length > 0) {
    const turns = priorTurns.slice(-6);
    parts.push(
      `THIS SESSION SO FAR (continuity only — not independent evidence):\n` +
        turns
          .map((t) => `${t.role === "member" ? "MEMBER" : "THE DESK"}: ${t.text.slice(0, 1200)}`)
          .join("\n\n")
    );
    sources.push("this session's earlier turns");
  }

  const retrieval: SittingBundle["retrieval"] = {
    intent: "company thesis and evidence",
    eligibleSources: 0,
    readableSources: 0,
    matchedSources: 0,
    matchedPassages: 0,
  };

  // Every visible source is eligible by default. The checkbox controls
  // eligibility; "File it" separately persists a fresh source to the folder.
  let eligibleDocs = folderDocs.filter((doc) => !excluded.has(doc.id));
  if (documentIds && documentIds.length > 0) {
    const allowed = new Set(documentIds);
    eligibleDocs = eligibleDocs.filter((doc) => allowed.has(doc.id));
  }
  const readableDocs = await loadReadableSources(desk.email, eligibleDocs);

  const freshSources: IntentSource[] = [];
  if (!excluded.has(tapeUrl)) {
    const tapeLines = [
      `Last $${snap.price?.toFixed(2)}, ${pct(snap.dayChangePercent)} on the day` +
        `${snap.afterHoursChangePercent != null ? `, ${pct(snap.afterHoursChangePercent)} after hours` : ""}.`,
      `Captured: ${capturedDate}.`,
    ];
    if (month.length > 1) {
      const first = month[0].close;
      const last = month[month.length - 1].close;
      if (first && last) tapeLines.push(`One-month price change: ${pct(((last - first) / first) * 100)} over ${month.length} trading days.`);
    }
    tapeLines.push(`Original market-data page: ${tapeUrl}`);
    freshSources.push({ id: `market:${tapeUrl}`, name: `${sym} trading snapshot`, content: tapeLines.join("\n") });
    stats.push(`Tape: $${snap.price?.toFixed(2)}, ${pct(snap.dayChangePercent)} on the day.`);
  }

  const freshFilings = filings.filter(
    (filing) =>
      !excluded.has(filing.url) &&
      !folderDocs.some((doc) => doc.name.startsWith(`${filing.formLabel} — ${filing.date}`))
  );
  for (const filing of freshFilings) {
    freshSources.push({
      id: `filing:${filing.url}`,
      name: `${filing.formLabel} — ${filing.date} · ${sym}`,
      content:
        `Official SEC EDGAR filing.\nForm: ${filing.formLabel}.\nFiled: ${filing.date}.\n` +
        `Title: ${filing.title}.\nOriginal source: ${filing.url}`,
    });
  }

  if (traceableNews.length > 0) {
    for (const article of traceableNews) {
      const bucket = newsBucketFor(article);
      if (bucket === "filings" && filings.some((filing) => filing.url === article.canonicalUrl)) continue;
      if (folderDocs.some((doc) => doc.name.includes(article.title.slice(0, 40)))) continue;
      if (excluded.has(article.canonicalUrl)) continue;
      const assessment = article.relevance[sym];
      freshSources.push({
        id: `news:${article.canonicalUrl}`,
        name: `${bucket.toUpperCase()} — ${article.title}`,
        content: [
          `Dated source: ${article.title}`,
          `Publisher: ${article.publisher}. Published: ${new Date(article.publishedAt).toISOString().slice(0, 10)} (${newsStamp(article.publishedAt)}).`,
          article.summary ? `Retained summary: ${article.summary}` : "",
          assessment?.reasons?.length ? `Relevance record: ${assessment.reasons.join("; ")}.` : "",
          `Original source: ${article.canonicalUrl}`,
        ].filter(Boolean).join("\n"),
      });
    }
  }

  const readable = [...readableDocs, ...freshSources];
  retrieval.eligibleSources = eligibleDocs.length + freshSources.length;
  retrieval.readableSources = readable.length;
  const fixedChars = parts.reduce((sum, part) => sum + part.length + 2, 0);
  const selection = selectIntentEvidence(question, readable, {
    maxChars: Math.max(8_000, BUNDLE_CAP - fixedChars),
  });
  retrieval.intent = selection.label;
  retrieval.matchedSources = selection.matchedSourceIds.length;
  retrieval.matchedPassages = selection.passages.length;
  if (selection.passages.length > 0) {
    parts.push(
      `INTENT-MATCHED COMPANY CONTEXT\n` +
      `Question focus: ${selection.label}. All ${retrieval.eligibleSources} checked sources were eligible; ` +
      `${selection.matchedSourceIds.length} supplied the strongest relevant passages.\n\n` +
      formatIntentEvidence(selection)
    );
    sources.push(
      `${selection.matchedSourceIds.length} intent-matched source${selection.matchedSourceIds.length === 1 ? "" : "s"} ` +
      `from ${retrieval.eligibleSources} selected for ${sym}`
    );
  }

  return { context: parts.join("\n\n"), sources, stats, retrieval };
}
