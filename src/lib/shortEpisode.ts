import { createHash } from "node:crypto";
import {
  dossierReleaseValidationError,
  type Dossier,
  type DossierCitation,
} from "@/lib/dossier";
import { publicResearchContentIssues } from "@/lib/notifications";

export const SHORT_EPISODE_SCHEMA = "amm-short-episode-v1" as const;
export const SHORT_DRAFT_SCHEMA = "amm-short-draft-v1" as const;
export const SHORT_WEEKDAY_TEMPLATE_VERSION = "amm-weekday-locked-v3" as const;
export const SHORT_WEEKEND_TEMPLATE_VERSION = "amm-weekend-recap-v1" as const;
export const SHORT_WEEKDAY_MIN_SECONDS = 36;
export const SHORT_WEEKDAY_MAX_SECONDS = 46;
export const SHORT_WEEKDAY_MIN_WORDS = 60;
export const SHORT_WEEKDAY_MAX_WORDS = 63;
export const SHORT_MIN_SECONDS = 50;
export const SHORT_MAX_SECONDS = 70;
export const SHORT_MIN_WORDS = 150;
export const SHORT_MAX_WORDS = 175;
/**
 * Kept for compatibility with historical episode receipts. Weekday release
 * timing is now validated beat by beat because the locked voice slows
 * materially around numbers and inserts natural pauses between scenes.
 */
export const SHORT_WEEKDAY_WORDS_PER_SECOND = 1.73;
/** Weekend presenter calibration remains approximately 180 spoken words/minute. */
export const SHORT_WORDS_PER_SECOND = 3;

export type ShortEpisodeFormat = "weekday" | "weekend-recap";

export interface ShortEpisodeContract {
  templateVersion:
    | typeof SHORT_WEEKDAY_TEMPLATE_VERSION
    | typeof SHORT_WEEKEND_TEMPLATE_VERSION;
  minSeconds: number;
  maxSeconds: number;
  minWords: number;
  maxWords: number;
  targetWords: { min: number; max: number };
}

export function shortEpisodeContract(
  format: ShortEpisodeFormat = "weekday",
): ShortEpisodeContract {
  if (format === "weekend-recap") {
    return {
      templateVersion: SHORT_WEEKEND_TEMPLATE_VERSION,
      minSeconds: SHORT_MIN_SECONDS,
      maxSeconds: SHORT_MAX_SECONDS,
      minWords: SHORT_MIN_WORDS,
      maxWords: SHORT_MAX_WORDS,
      targetWords: { min: 165, max: 170 },
    };
  }
  return {
    templateVersion: SHORT_WEEKDAY_TEMPLATE_VERSION,
    minSeconds: SHORT_WEEKDAY_MIN_SECONDS,
    maxSeconds: SHORT_WEEKDAY_MAX_SECONDS,
    minWords: SHORT_WEEKDAY_MIN_WORDS,
    maxWords: SHORT_WEEKDAY_MAX_WORDS,
    targetWords: { min: 60, max: 63 },
  };
}

function shortSignalLabel(dossier: Dossier): string {
  return `${dossier.signalCase.strength} ${
    dossier.signalCase.direction === "UP" ? "UPSIDE" : "DOWNSIDE"
  }`;
}

export function shortSpokenCompanyName(ticker: string): string {
  const names: Record<string, string> = {
    AAPL: "Apple",
    AMD: "AMD",
    AMZN: "Amazon",
    GOOG: "Google",
    GOOGL: "Google",
    META: "Meta",
    MSFT: "Microsoft",
    NVDA: "Nvidia",
    PLTR: "Palantir",
    TSLA: "Tesla",
  };
  return names[ticker.toUpperCase()] ?? ticker.toUpperCase();
}

export function lockedShortHook(
  dossier: Dossier,
  format: ShortEpisodeFormat = "weekday",
): string {
  const label = shortSignalLabel(dossier).toLowerCase();
  return format === "weekend-recap"
    ? `${dossier.ticker}. Weekend recap. Current read: ${label}. ` +
      `${dossier.emailHook.votes.support} of ${dossier.emailHook.votesTotal} council votes ` +
      "support the active thesis."
    : `${shortSpokenCompanyName(dossier.ticker)}. AMM thesis: ${label}.`;
}

export function lockedShortClose(
  format: ShortEpisodeFormat = "weekday",
): string {
  return format === "weekend-recap"
    ? "See the full dossier and every source at aftermarketmovers dot com."
    : "For daily thesis updates and evidence, visit aftermarketmovers dot com.";
}

export interface ShortReportingCycle {
  publicationDate: string;
  sourceDate: string;
  startDate: string;
  startLabel: string;
  endDate: string;
  endLabel: string;
}

export interface ShortEpisodeBuildOptions {
  format?: ShortEpisodeFormat;
  reportingCycle?: ShortReportingCycle;
}

function shortDisplayDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid reporting-cycle date: ${value}`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date).toUpperCase();
}

function resultsCitationPriority(citation: DossierCitation): number {
  const text = `${citation.title} ${citation.url}`;
  if (/\b8-k\b.*(?:items?\s*)?2\.02|(?:items?\s*)?2\.02.*\b8-k\b/i.test(text)) return 3;
  // SEC companyfacts is the canonical filed XBRL record used by the dossier
  // compiler. It carries the quarter end as the citation date even when the
  // admitted excerpt does not repeat the 10-Q form name.
  if (/data\.sec\.gov\/api\/xbrl\/companyfacts\//i.test(citation.url)) return 2;
  if (/\b10-[qk]\b|quarterly report|annual report/i.test(text)) return 2;
  if (
    ["primary", "company"].includes(citation.authority) &&
    /\b(?:earnings|quarterly results|annual results)\b/i.test(text)
  ) {
    return 1;
  }
  return 0;
}

function nextResultsDate(nextEvent: string | null | undefined, sourceDate: string): string | null {
  if (!nextEvent || !/\b(?:earnings|results)\b/i.test(nextEvent)) return null;
  const explicit = nextEvent.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (explicit?.[1]) return explicit[1] > sourceDate ? explicit[1] : null;
  const monthDay = nextEvent.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i,
  );
  if (!monthDay) return null;
  const parsed = new Date(`${monthDay[1]} ${monthDay[2]}, ${sourceDate.slice(0, 4)} 12:00:00 UTC`);
  if (Number.isNaN(parsed.getTime())) return null;
  const value = parsed.toISOString().slice(0, 10);
  return value > sourceDate ? value : null;
}

/**
 * Builds the weekend visual's quarter-to-quarter frame from admitted evidence.
 * A lifecycle's openedDate is deliberately not used: a thesis can open days
 * after the company released results.
 */
export function deriveWeekendReportingCycle(
  dossier: Dossier,
  publicationDate: string,
  nextEvent?: string | null,
): ShortReportingCycle {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(publicationDate)) {
    throw new Error("invalid weekend publication date");
  }
  const lastResults = [...(dossier.citations ?? [])]
    .map((citation) => ({ citation, priority: resultsCitationPriority(citation) }))
    .filter(({ citation, priority }) =>
      priority > 0 &&
      citation.publishedDate <= dossier.date &&
      ["primary", "company"].includes(citation.authority))
    .sort((a, b) =>
      b.priority - a.priority ||
      b.citation.publishedAt - a.citation.publishedAt)[0]?.citation;
  if (!lastResults) {
    throw new Error("weekend recap requires an admitted company-results filing");
  }
  const exactNextResults = nextResultsDate(nextEvent, dossier.date);
  const reviewDueBy =
    dossier.thesisLifecycle?.canonicalOracle.dueBy ?? dossier.emailHook.oracle.dueBy;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(reviewDueBy) || reviewDueBy <= lastResults.publishedDate) {
    throw new Error("weekend recap requires a valid next-results review boundary");
  }
  return {
    publicationDate,
    sourceDate: dossier.date,
    startDate: lastResults.publishedDate,
    startLabel: `LAST RESULTS · ${shortDisplayDate(lastResults.publishedDate)}`,
    endDate: exactNextResults ?? reviewDueBy,
    endLabel: exactNextResults
      ? `NEXT RESULTS · ${shortDisplayDate(exactNextResults)}`
      : "NEXT RESULTS · DATE PENDING",
  };
}

export type ShortSourcePath =
  | "emailHook.priorUpdate.text"
  | "emailHook.whatChanged"
  | "emailHook.thesis"
  | "emailHook.primaryEvidence"
  | `emailHook.secondaryEvidence.${number}`
  | "signalCase.mechanism"
  | "signalCase.invalidation"
  | "emailHook.confidence.majorityReason"
  | "emailHook.confidence.dissentReason"
  | "emailHook.confidence.uncertaintyReason"
  | "emailHook.confidence.flipCondition";

export interface ShortSourceExcerpt {
  id: string;
  path: ShortSourcePath;
  text: string;
  citationIds: string[];
}

export interface ShortClaimSupport {
  sourceId: string;
  /** Exact excerpt copied from source.text. This makes review mechanical. */
  quote: string;
}

export interface ShortDraftClaim {
  id: string;
  statement: string;
  support: ShortClaimSupport[];
}

export interface ShortDraftBeat {
  text: string;
  claimIds: string[];
}

export interface ShortEpisodeDraft {
  schema: typeof SHORT_DRAFT_SCHEMA;
  claims: ShortDraftClaim[];
  beats: {
    hook: ShortDraftBeat;
    change: ShortDraftBeat;
    thesis: ShortDraftBeat;
    evidence: ShortDraftBeat;
    council: ShortDraftBeat;
    close: ShortDraftBeat;
  };
}

export interface ShortEpisodePackage {
  schema: typeof SHORT_EPISODE_SCHEMA;
  episodeId: string;
  createdAt: number;
  /** Omitted for legacy weekday packages so their content hash stays stable. */
  format?: "weekend-recap";
  reportingCycle?: ShortReportingCycle;
  /** Display identity only. It never enters research copy or claim support. */
  identity?: {
    companyName: string;
    source: "explicit" | "market-metadata" | "ticker-only";
  };
  dossier: {
    artifactVersion: number;
    artifactKey: string;
    ticker: string;
    date: string;
    generatedAt: number;
    briefAuditId: string;
    councilRunId: string;
    sha256: string;
  };
  editorial: {
    templateVersion: ShortEpisodeContract["templateVersion"];
    words: number;
    estimatedSeconds: number;
    targetSeconds: { min: number; max: number };
    script: string;
    beats: ShortEpisodeDraft["beats"];
    claims: ShortDraftClaim[];
  };
  signal: {
    direction: Dossier["signalCase"]["direction"];
    strength: Dossier["signalCase"]["strength"];
    horizonSessions: { min: 10; max: 15 };
    votes: Dossier["emailHook"]["votes"];
    label: string;
  };
  lifecycle: {
    id: string;
    openedDate: string;
    observationDate: string;
    observationIndex: number;
    status: "opened" | "strengthened" | "weakened" | "open";
    canonicalSubjectPunchline: string;
    canonicalLabel: string;
    currentLabel: string;
    reviewDueBy: string;
  };
  provenance: {
    sourceBundleSha256: string;
    excerpts: ShortSourceExcerpt[];
    citations: Array<Pick<
      DossierCitation,
      "id" | "title" | "url" | "publisher" | "authority" | "publishedDate" |
      "sourceDocumentId" | "contentSha256"
    >>;
  };
  publication: {
    traceUrl: string;
    sourceDescription: string;
  };
}

/**
 * The citations actually spoken or shown in an episode, in first-use order.
 * The package deliberately retains the wider dossier citation ledger for
 * audit, so publication surfaces must use this narrower set.
 */
export function shortEpisodeUsedCitationIds(
  episode: Pick<ShortEpisodePackage, "editorial" | "provenance">,
): string[] {
  const excerptById = new Map(
    episode.provenance.excerpts.map((excerpt) => [excerpt.id, excerpt]),
  );
  const admittedCitationIds = new Set(
    episode.provenance.citations.map((citation) => citation.id),
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const claim of episode.editorial.claims) {
    for (const support of claim.support) {
      const excerpt = excerptById.get(support.sourceId);
      for (const citationId of excerpt?.citationIds ?? []) {
        if (!admittedCitationIds.has(citationId) || seen.has(citationId)) continue;
        seen.add(citationId);
        result.push(citationId);
      }
    }
  }
  return result;
}

export function shortEpisodeUsedCitations(
  episode: Pick<ShortEpisodePackage, "editorial" | "provenance">,
): ShortEpisodePackage["provenance"]["citations"] {
  const citationById = new Map(
    episode.provenance.citations.map((citation) => [citation.id, citation]),
  );
  return shortEpisodeUsedCitationIds(episode).flatMap((citationId) => {
    const citation = citationById.get(citationId);
    return citation ? [citation] : [];
  });
}

const BEAT_ORDER: Array<keyof ShortEpisodeDraft["beats"]> = [
  "hook",
  "change",
  "thesis",
  "evidence",
  "council",
  "close",
];

const LOCKED_WEEKDAY_BEAT_ORDER: Array<keyof ShortEpisodeDraft["beats"]> = [
  "hook",
  "change",
  "evidence",
  "thesis",
  "council",
  "close",
];

function shortBeatOrder(
  format: ShortEpisodeBuildOptions["format"] = "weekday",
): Array<keyof ShortEpisodeDraft["beats"]> {
  return format === "weekday" ? LOCKED_WEEKDAY_BEAT_ORDER : BEAT_ORDER;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function stripRenderedCitations(value: string): string {
  return value
    .replace(/\[(\d+ · \d{4}-\d{2}-\d{2})\]\(https?:\/\/[^\s)]+(?:\s+"[^"]*")?\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function citationsFor(value: string, citations: DossierCitation[]): string[] {
  return citations.filter((citation) => value.includes(citation.url)).map((citation) => citation.id);
}

export function shortSourceBundle(dossier: Dossier): ShortSourceExcerpt[] {
  const citations = dossier.citations ?? [];
  const values: Array<[ShortSourcePath, string | null | undefined]> = [
    ["emailHook.priorUpdate.text", dossier.emailHook.priorUpdate?.text],
    ["emailHook.whatChanged", dossier.emailHook.whatChanged],
    ["emailHook.thesis", dossier.emailHook.thesis],
    ["emailHook.primaryEvidence", dossier.emailHook.primaryEvidence],
    ...dossier.emailHook.secondaryEvidence.map(
      (value, index): [ShortSourcePath, string] => [`emailHook.secondaryEvidence.${index}`, value],
    ),
    ["signalCase.mechanism", dossier.signalCase.mechanism],
    ["signalCase.invalidation", dossier.signalCase.invalidation],
    ["emailHook.confidence.majorityReason", dossier.emailHook.confidence.majorityReason],
    ["emailHook.confidence.dissentReason", dossier.emailHook.confidence.dissentReason],
    ["emailHook.confidence.uncertaintyReason", dossier.emailHook.confidence.uncertaintyReason],
    ["emailHook.confidence.flipCondition", dossier.emailHook.confidence.flipCondition],
  ];
  return values
    .filter((item): item is [ShortSourcePath, string] => Boolean(item[1]?.trim()))
    .map(([path, rendered], index) => ({
      id: `D${index + 1}`,
      path,
      text: stripRenderedCitations(rendered),
      citationIds: citationsFor(rendered, citations),
    }));
}

function words(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeFactToken(value: string): string {
  return value
    .toLowerCase()
    // Sentence-final punctuation is not part of a numeric fact. Preserve
    // decimal points inside the token while normalising a trailing full stop.
    .replace(/\.$/, "")
    .replace(/[,$]/g, "")
    .replace(/\s+/g, "")
    .replace(/billion/g, "b")
    .replace(/million/g, "m")
    .replace(/trillion/g, "t")
    .replace(/percent/g, "%")
    .replace(/per\s*cent/g, "%");
}

function factTokens(value: string): string[] {
  const matches = value.match(
    /\$?\d[\d,.]*(?:\.\d+)?(?:\s*(?:%|percent\b|per cent\b|billion\b|million\b|trillion\b|[BMT]\b))?/gi,
  ) ?? [];
  return [...new Set(matches.map(normalizeFactToken).filter(Boolean))];
}

const WEEKDAY_BEAT_ORDER = [
  "hook",
  "change",
  "evidence",
  "thesis",
  "council",
  "close",
] as const;

type WeekdayBeatName = (typeof WEEKDAY_BEAT_ORDER)[number];

/**
 * Conservative calibration from the locked weekday production voice.
 * Evidence gets the slowest allowance because currency, percentages and
 * accounting phrases are delivered more deliberately than plain synthesis.
 * The 0.9-second scene gap mirrors the pauses returned by HeyGen subtitles.
 */
const WEEKDAY_BEAT_WORDS_PER_SECOND: Record<WeekdayBeatName, number> = {
  hook: 1.45,
  change: 1.45,
  evidence: 1.2,
  thesis: 2,
  council: 2,
  close: 2.3,
};
const WEEKDAY_INITIAL_LEAD_SECONDS = 0.4;
const WEEKDAY_INTER_BEAT_GAP_SECONDS = 0.9;
const WEEKDAY_BEAT_MAX_END_SECONDS: Record<WeekdayBeatName, number> = {
  hook: 5.5,
  change: 14.5,
  evidence: 24.5,
  thesis: 32,
  council: 40,
  close: 46.5,
};

export function estimatedWeekdayBeatEnds(
  draft: ShortEpisodeDraft,
): Record<WeekdayBeatName, number> {
  let elapsed = WEEKDAY_INITIAL_LEAD_SECONDS;
  const ends = {} as Record<WeekdayBeatName, number>;
  WEEKDAY_BEAT_ORDER.forEach((beatName, index) => {
    elapsed += words(draft.beats?.[beatName]?.text ?? "") /
      WEEKDAY_BEAT_WORDS_PER_SECOND[beatName];
    ends[beatName] = Math.round(elapsed * 100) / 100;
    if (index < WEEKDAY_BEAT_ORDER.length - 1) {
      elapsed += WEEKDAY_INTER_BEAT_GAP_SECONDS;
    }
  });
  return ends;
}

export function estimatedShortDurationSeconds(
  draft: ShortEpisodeDraft,
  format: ShortEpisodeFormat = "weekday",
): number {
  if (format === "weekday") return estimatedWeekdayBeatEnds(draft).close;
  const script = shortBeatOrder(format)
    .map((beat) => draft.beats?.[beat]?.text ?? "")
    .join(" ");
  return words(script) / SHORT_WORDS_PER_SECOND;
}

function citationDescription(citations: DossierCitation[]): string {
  return citations
    .map((citation) =>
      `${citation.id}. ${citation.publisher} — ${citation.title} (${citation.publishedDate}) ${citation.url}`)
    .join("\n");
}

export function validateShortDraft(
  dossier: Dossier,
  draft: ShortEpisodeDraft,
  options: ShortEpisodeBuildOptions = {},
): string[] {
  const issues = new Set<string>();
  const format = options.format ?? "weekday";
  const beatOrder = shortBeatOrder(format);
  const releaseError = dossierReleaseValidationError(dossier);
  if (releaseError) issues.add(`dossier is not publishable: ${releaseError}`);
  if (draft.schema !== SHORT_DRAFT_SCHEMA) issues.add(`draft schema must be ${SHORT_DRAFT_SCHEMA}`);

  const excerpts = shortSourceBundle(dossier);
  const excerptById = new Map(excerpts.map((source) => [source.id, source]));
  const claimById = new Map<string, ShortDraftClaim>();
  for (const claim of draft.claims ?? []) {
    if (!/^C[1-9]\d*$/.test(claim.id)) issues.add(`invalid claim id: ${claim.id}`);
    if (claimById.has(claim.id)) issues.add(`duplicate claim id: ${claim.id}`);
    claimById.set(claim.id, claim);
    if (!claim.statement?.trim()) issues.add(`${claim.id} has no statement`);
    if (!claim.support?.length) issues.add(`${claim.id} has no dossier support`);
    for (const support of claim.support ?? []) {
      const source = excerptById.get(support.sourceId);
      if (!source) {
        issues.add(`${claim.id} references unknown source ${support.sourceId}`);
        continue;
      }
      if (!support.quote?.trim() || support.quote.trim().length < 12) {
        issues.add(`${claim.id}/${support.sourceId} support quote is too short`);
      } else if (!source.text.includes(support.quote.trim())) {
        issues.add(`${claim.id}/${support.sourceId} quote is not verbatim dossier text`);
      }
      if (!source.citationIds.length) issues.add(`${claim.id}/${support.sourceId} has no admitted citation`);
    }
  }

  for (const beatName of beatOrder) {
    const beat = draft.beats?.[beatName];
    if (!beat?.text?.trim()) {
      issues.add(`${beatName} beat is empty`);
      continue;
    }
    // The opening answer is deterministic product state (ticker, current
    // qualitative read and vote count), not a research assertion. Every
    // factual editorial beat remains citation-bound.
    if (!["hook", "close"].includes(beatName) && !beat.claimIds?.length) {
      issues.add(`${beatName} beat has no claim references`);
    }
    for (const claimId of beat.claimIds ?? []) {
      if (!claimById.has(claimId)) issues.add(`${beatName} references unknown claim ${claimId}`);
    }
    const supported = (beat.claimIds ?? []).flatMap((claimId) => {
      const claim = claimById.get(claimId);
      return claim?.support.flatMap((support) => {
        const source = excerptById.get(support.sourceId);
        return [claim.statement, support.quote, source?.text ?? ""];
      }) ?? [];
    }).join(" ");
    const allowedDerived = [
      dossier.ticker,
      dossier.date,
      `${dossier.emailHook.votes.support}`,
      `${dossier.emailHook.votes.oppose}`,
      `${dossier.emailHook.votes.uncertain}`,
      `${dossier.emailHook.votesTotal}`,
      `${dossier.signalCase.horizonSessions.min}`,
      `${dossier.signalCase.horizonSessions.max}`,
      `${dossier.thesisLifecycle?.observationIndex ?? 1}`,
      dossier.thesisLifecycle?.openedDate ?? dossier.date,
      dossier.thesisLifecycle?.observationDate ?? dossier.date,
      "2",
      "3",
    ].join(" ");
    if (beatName !== "close") {
      for (const token of factTokens(beat.text)) {
        const supportedTokens = new Set(factTokens(`${supported} ${allowedDerived}`));
        if (!supportedTokens.has(token)) {
          issues.add(`${beatName} contains unsupported numeric fact: ${token}`);
        }
      }
    }
  }

  if (format === "weekday") {
    const beatWordRanges: Partial<Record<
      keyof ShortEpisodeDraft["beats"],
      { min: number; max: number }
    >> = {
      change: { min: 9, max: 12 },
      evidence: { min: 8, max: 11 },
      thesis: { min: 8, max: 10 },
      council: { min: 11, max: 14 },
    };
    for (const [beatName, range] of Object.entries(beatWordRanges) as Array<
      [keyof ShortEpisodeDraft["beats"], { min: number; max: number }]
    >) {
      const beatWords = words(draft.beats?.[beatName]?.text ?? "");
      if (beatWords < range.min || beatWords > range.max) {
        issues.add(
          `${beatName} beat is ${beatWords} words; locked weekday range is ` +
          `${range.min}–${range.max}`,
        );
      }
    }
    for (const beatName of ["change", "evidence"] as const) {
      const numericFacts = factTokens(draft.beats?.[beatName]?.text ?? "").length;
      if (numericFacts > 3) {
        issues.add(
          `${beatName} contains ${numericFacts} numeric facts; locked weekday maximum is 3`,
        );
      }
    }
    const estimatedBeatEnds = estimatedWeekdayBeatEnds(draft);
    for (const beatName of WEEKDAY_BEAT_ORDER) {
      if (estimatedBeatEnds[beatName] > WEEKDAY_BEAT_MAX_END_SECONDS[beatName]) {
        issues.add(
          `${beatName} estimated to end at ${estimatedBeatEnds[beatName].toFixed(1)}s; ` +
          `locked weekday maximum is ${WEEKDAY_BEAT_MAX_END_SECONDS[beatName].toFixed(1)}s`,
        );
      }
    }
  }

  const script = beatOrder.map((beat) => draft.beats?.[beat]?.text ?? "").join(" ");
  const wordCount = words(script);
  const contract = shortEpisodeContract(format);
  const estimatedSeconds = estimatedShortDurationSeconds(draft, format);
  if (wordCount < contract.minWords || wordCount > contract.maxWords) {
    issues.add(
      `narration is ${wordCount} words; expected ${contract.minWords}–${contract.maxWords} ` +
      `for Ash's measured ${contract.minSeconds}–${contract.maxSeconds} second ` +
      `${format === "weekday" ? "weekday" : "weekend"} delivery`,
    );
  }
  if (estimatedSeconds < contract.minSeconds || estimatedSeconds > contract.maxSeconds) {
    issues.add(
      `estimated duration is ${estimatedSeconds.toFixed(1)}s; expected ` +
      `${contract.minSeconds}–${contract.maxSeconds}s`,
    );
  }
  if (!/aftermarketmovers dot com/i.test(draft.beats?.close?.text ?? "")) {
    issues.add("close must name aftermarketmovers dot com");
  }
  const expectedHook = lockedShortHook(dossier, format);
  if (draft.beats?.hook?.text !== expectedHook) {
    issues.add("hook must use the deterministic current-read opener");
  }
  if (draft.beats?.close?.text !== lockedShortClose(format)) {
    issues.add("close must use the locked AMM routing line");
  }
  if (
    /\b(?:10\s*[–-]\s*15|next\s+\d+\s+(?:trading\s+)?sessions?|expected impact)\b/i.test(script)
  ) {
    issues.add(
      `${options.format === "weekend-recap" ? "weekend recap" : "weekday short"} ` +
      "must explain the standing thesis, not a short-window prediction",
    );
  }
  if (
    options.format === "weekend-recap" &&
    options.reportingCycle &&
    options.reportingCycle.startDate !==
      (dossier.thesisLifecycle?.openedDate ?? dossier.date) &&
    /\b(?:opened|began|started)\s+(?:with|on)\s+(?:these|the|those)?\s*results\b/i.test(script)
  ) {
    issues.add("weekend recap must not conflate the results date with the later thesis-open date");
  }
  if ((draft.beats?.hook?.claimIds ?? []).length > 0) {
    issues.add("deterministic hook must not borrow editorial claim ids");
  }
  if (words(draft.beats?.close?.text ?? "") > 16) issues.add("close must stay under 17 words");
  for (const issue of publicResearchContentIssues({
    subject: `${dossier.ticker} AMM video`,
    text: script,
  })) {
    issues.add(`public-copy gate: ${issue}`);
  }
  return [...issues];
}

export function buildShortEpisodePackage(
  dossier: Dossier,
  draft: ShortEpisodeDraft,
  now = Date.now(),
  identity?: ShortEpisodePackage["identity"],
  options: ShortEpisodeBuildOptions = {},
): ShortEpisodePackage {
  const issues = validateShortDraft(dossier, draft, options);
  if (issues.length) throw new Error(`short episode blocked:\n- ${issues.join("\n- ")}`);
  if (options.format === "weekend-recap" && !options.reportingCycle) {
    throw new Error("weekend recap requires an explicit reporting cycle");
  }

  const excerpts = shortSourceBundle(dossier);
  const excerptById = new Map(excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const usedCitationIds = new Set(
    draft.claims.flatMap((claim) =>
      claim.support.flatMap((support) => excerptById.get(support.sourceId)?.citationIds ?? [])),
  );
  const usedDossierCitations = (dossier.citations ?? [])
    .filter((citation) => usedCitationIds.has(citation.id));
  const citations = (dossier.citations ?? []).map((citation) => ({
    id: citation.id,
    title: citation.title,
    url: citation.url,
    publisher: citation.publisher,
    authority: citation.authority,
    publishedDate: citation.publishedDate,
    sourceDocumentId: citation.sourceDocumentId,
    ...(citation.contentSha256 ? { contentSha256: citation.contentSha256 } : {}),
  }));
  const format = options.format ?? "weekday";
  const script = shortBeatOrder(format)
    .map((beat) => draft.beats[beat].text)
    .join(" ");
  const wordCount = words(script);
  const estimatedSeconds =
    Math.round(estimatedShortDurationSeconds(draft, format) * 10) / 10;
  const contract = shortEpisodeContract(format);
  const dossierSha256 = digest(dossier);
  const sourceBundleSha256 = digest({ excerpts, citations });
  const artifactKey =
    `dossier-v${dossier.artifactVersion}:${dossier.ticker}:${dossier.date}:${dossier.generatedAt}`;
  const label = `${dossier.signalCase.strength} ${dossier.signalCase.direction === "UP" ? "UPSIDE" : "DOWNSIDE"}`;
  const lifecycle = dossier.thesisLifecycle;
  const canonicalSignal = lifecycle?.canonicalSignal ?? dossier.signalCase;
  const canonicalLabel =
    `${canonicalSignal.strength} ${canonicalSignal.direction === "UP" ? "UPSIDE" : "DOWNSIDE"}`;
  const episodeId = digest({
    schema: SHORT_EPISODE_SCHEMA,
    templateVersion: contract.templateVersion,
    dossierSha256,
    sourceBundleSha256,
    draft,
    ...(identity ? { identity } : {}),
    ...(options.format === "weekend-recap"
      ? { format: options.format, reportingCycle: options.reportingCycle }
      : {}),
  }).slice(0, 48);
  const traceUrl = `https://aftermarketmovers.com/stock/${dossier.ticker.toLowerCase()}?dossier=${encodeURIComponent(artifactKey)}`;

  return {
    schema: SHORT_EPISODE_SCHEMA,
    episodeId,
    createdAt: now,
    ...(options.format === "weekend-recap"
      ? { format: options.format, reportingCycle: options.reportingCycle }
      : {}),
    ...(identity ? { identity } : {}),
    dossier: {
      artifactVersion: dossier.artifactVersion,
      artifactKey,
      ticker: dossier.ticker,
      date: dossier.date,
      generatedAt: dossier.generatedAt,
      briefAuditId: dossier.briefAuditId!,
      councilRunId: dossier.councilRunId!,
      sha256: dossierSha256,
    },
    editorial: {
      templateVersion: contract.templateVersion,
      words: wordCount,
      estimatedSeconds,
      targetSeconds: { min: contract.minSeconds, max: contract.maxSeconds },
      script,
      beats: draft.beats,
      claims: draft.claims,
    },
    signal: {
      direction: dossier.signalCase.direction,
      strength: dossier.signalCase.strength,
      horizonSessions: dossier.signalCase.horizonSessions,
      votes: dossier.emailHook.votes,
      label,
    },
    lifecycle: {
      id: lifecycle?.id ?? digest({
        ticker: dossier.ticker,
        openedDate: dossier.date,
        subjectPunchline: dossier.emailHook.subjectPunchline,
      }).slice(0, 48),
      openedDate: lifecycle?.openedDate ?? dossier.date,
      observationDate: lifecycle?.observationDate ?? dossier.date,
      observationIndex: lifecycle?.observationIndex ?? 1,
      status: lifecycle?.observationStatus ?? "opened",
      canonicalSubjectPunchline:
        lifecycle?.canonicalSubjectPunchline ?? dossier.emailHook.subjectPunchline,
      canonicalLabel,
      currentLabel: label,
      reviewDueBy: lifecycle?.canonicalOracle.dueBy ?? dossier.emailHook.oracle.dueBy,
    },
    provenance: {
      sourceBundleSha256,
      excerpts,
      citations,
    },
    publication: {
      traceUrl,
      sourceDescription:
        `AMM dossier ${artifactKey}\nAudit ${dossier.briefAuditId}\n\n` +
        `Sources used in this episode\n${citationDescription(usedDossierCitations)}`,
    },
  };
}

export function shortPackageValidationError(
  dossier: Dossier,
  episode: ShortEpisodePackage,
): string | null {
  try {
    const rebuilt = buildShortEpisodePackage(dossier, {
      schema: SHORT_DRAFT_SCHEMA,
      claims: episode.editorial.claims,
      beats: episode.editorial.beats,
    }, episode.createdAt, episode.identity, {
      format: episode.format ?? "weekday",
      reportingCycle: episode.reportingCycle,
    });
    return canonical(rebuilt) === canonical(episode) ? null : "episode package does not match dossier";
  } catch (error) {
    return String(error);
  }
}
