import { auth } from "@clerk/nextjs/server";
import {
  getBarsSnapshot,
  getDossierHistory,
} from "@/lib/companyStore";
import {
  dossierReleaseValidationError,
  type Dossier,
} from "@/lib/dossier";
import { getDesk, isDeskServiceActive, tierOf } from "@/lib/desk";
import { buildDeskPriorityCards } from "@/lib/deskPresentation";
import { projectSignalTrack } from "@/lib/signalTrack";
import { buildStockChairmanRun } from "@/lib/stockChairmanDeck";
import { getTickerSnapshot } from "@/lib/ticker";
import { getVoiceAllowance } from "@/lib/voiceStore";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ ticker: string }>;
}

function noStoreJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Vary", "Authorization, Cookie");
  return Response.json(body, { ...init, headers });
}

/**
 * Full, release-validated chairman deck for one company in a member's Desk.
 * The authored dossier is preserved verbatim; no mobile-only model or
 * summarizer is allowed between the audited artifact and the app.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { userId } = await auth();
  if (!userId) return noStoreJson({ error: "Sign in first" }, { status: 401 });

  const { ticker: rawTicker } = await params;
  const ticker = rawTicker.toUpperCase().trim();
  if (!/^[A-Z.\-]{1,6}$/.test(ticker)) {
    return noStoreJson({ error: "A valid ticker is required" }, { status: 400 });
  }

  const desk = await getDesk(userId);
  if (!desk) return noStoreJson({ error: "No AMM Desk found" }, { status: 404 });
  if (!desk.tickers.includes(ticker)) {
    return noStoreJson(
      { error: `${ticker} is not in this AMM Desk.` },
      { status: 403 },
    );
  }
  if (!isDeskServiceActive(desk)) {
    return noStoreJson(
      { error: "Your AMM Desk access is inactive." },
      { status: 403 },
    );
  }

  const renderedAt = new Date();
  const [snapshot, history, bars, voice, deskCards] = await Promise.all([
    getTickerSnapshot(ticker),
    getDossierHistory<Dossier>(ticker, 14).catch(() => [] as Dossier[]),
    getBarsSnapshot(ticker).catch(() => []),
    getVoiceAllowance(desk, tierOf(desk)).catch((error) => {
      console.error("[mobile-stock] voice allowance read failed", error);
      return null;
    }),
    buildDeskPriorityCards(desk, renderedAt, [ticker]).catch((error) => {
      console.error("[mobile-stock] canonical desk card read failed", error);
      return [];
    }),
  ]);
  if (!snapshot) {
    return noStoreJson(
      { error: `No supported market record was found for ${ticker}.` },
      { status: 404 },
    );
  }

  const byDate = new Map<string, Dossier>();
  for (const dossier of history) {
    if (
      dossier.ticker !== ticker ||
      dossierReleaseValidationError(dossier) !== null
    ) {
      continue;
    }
    const existing = byDate.get(dossier.date);
    if (!existing || dossier.generatedAt > existing.generatedAt) {
      byDate.set(dossier.date, dossier);
    }
  }

  const dossiers = [...byDate.values()]
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        right.generatedAt - left.generatedAt,
    )
    .slice(0, 7);
  const runs = dossiers.map((dossier) =>
    buildStockChairmanRun(
      dossier,
      projectSignalTrack({
        direction: dossier.signalCase.direction,
        strength: dossier.signalCase.strength,
        horizon: dossier.signalCase.horizonSessions,
        issueDate: dossier.date,
        generatedAt: dossier.generatedAt,
        bars,
      }),
    ),
  );

  return noStoreJson({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    company: {
      ticker: snapshot.symbol,
      name: snapshot.name,
      price: snapshot.price,
      dayChangePercent: snapshot.dayChangePercent,
      afterHoursChangePercent: snapshot.afterHoursChangePercent,
      nextEvent: snapshot.nextEvent,
    },
    voice,
    deskCard: deskCards.find((card) => card.ticker === ticker) ?? null,
    current: runs[0] ?? null,
    runs,
    sources:
      dossiers[0]?.citations?.map((citation, index) => ({
        id: index + 1,
        title: citation.title,
        url: citation.url,
        date: citation.publishedDate,
        sourceType: citation.authority,
        evidenceState: citation.evidenceState ?? null,
      })) ?? [],
  });
}
