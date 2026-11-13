import type { Dossier } from "@/lib/dossier";
import type { SignalTrackProjection } from "@/lib/signalTrack";

export type StockChairmanCardId =
  | "story"
  | "bulls-bears"
  | "numbers"
  | "risk"
  | "signal"
  | "watch-next";

export interface StockChairmanCard {
  id: StockChairmanCardId;
  label: string;
  title: string;
  markdown: string;
}

export interface StockChairmanRun {
  ticker: string;
  date: string;
  generatedAt: number;
  signalTrack: SignalTrackProjection | null;
  signal: {
    direction: Dossier["signalCase"]["direction"];
    strength: Dossier["signalCase"]["strength"];
    minSessions: number;
    maxSessions: number;
    support: number;
    oppose: number;
    uncertain: number;
  };
  cards: StockChairmanCard[];
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Presentation-only mapping. It deliberately preserves the chairman's exact
 * authored fields: no summarizer, model call, truncation, or prose rewrite is
 * allowed between the validated dossier and the stock deck.
 */
export function buildStockChairmanRun(
  dossier: Dossier,
  signalTrack: SignalTrackProjection | null = null,
): StockChairmanRun {
  const confidenceParts = [
    `### Why ${dossier.emailHook.votesSupport} analysts support it\n${dossier.emailHook.confidence.majorityReason}`,
    dossier.emailHook.confidence.dissentReason
      ? `### Why ${dossier.emailHook.votesOppose} ${dossier.emailHook.votesOppose === 1 ? "analyst disagrees" : "analysts disagree"}\n${dossier.emailHook.confidence.dissentReason}`
      : null,
    dossier.emailHook.confidence.uncertaintyReason
      ? `### Why ${dossier.emailHook.votesUncertain} ${dossier.emailHook.votesUncertain === 1 ? "analyst is uncertain" : "analysts are uncertain"}\n${dossier.emailHook.confidence.uncertaintyReason}`
      : null,
  ].filter((part): part is string => Boolean(part));
  const horizon = dossier.signalCase.horizonSessions;

  return {
    ticker: dossier.ticker,
    date: dossier.date,
    generatedAt: dossier.generatedAt,
    signalTrack,
    signal: {
      direction: dossier.signalCase.direction,
      strength: dossier.signalCase.strength,
      minSessions: horizon.min,
      maxSessions: horizon.max,
      support: dossier.emailHook.votesSupport,
      oppose: dossier.emailHook.votesOppose,
      uncertain: dossier.emailHook.votesUncertain,
    },
    cards: [
      {
        id: "story",
        label: "THE STORY",
        title: dossier.headline,
        markdown: dossier.story,
      },
      {
        id: "bulls-bears",
        label: "BULLS / BEARS",
        title: "The strongest readings on both sides",
        markdown: `### Bulls\n${bulletList(dossier.bulls)}\n\n### Bears\n${bulletList(dossier.bears)}`,
      },
      {
        id: "numbers",
        label: "NUMBERS",
        title: "What the filed numbers actually say",
        markdown: dossier.numbersRead,
      },
      {
        id: "risk",
        label: "RISK",
        title: "Where this read can break",
        markdown: dossier.risk,
      },
      {
        id: "signal",
        label: "SIGNAL",
        title: `${dossier.signalCase.direction} · ${dossier.signalCase.strength} · ${horizon.min}–${horizon.max} SESSIONS`,
        markdown: [dossier.signalCase.mechanism, ...confidenceParts].join("\n\n"),
      },
      {
        id: "watch-next",
        label: "WATCH NEXT",
        title: "What changes the read",
        markdown: dossier.signalCase.invalidation,
      },
    ],
  };
}
