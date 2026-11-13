import { createHash } from "node:crypto";
import type { Dossier, DossierCitation } from "@/lib/dossier";
import { publicResearchContentIssues } from "@/lib/notifications";
import { dailyShortArtifactKey } from "@/lib/dailyShorts";
import {
  deriveWeekendReportingCycle,
  shortSourceBundle,
  type ShortClaimSupport,
  type ShortReportingCycle,
  type ShortSourceExcerpt,
} from "@/lib/shortEpisode";
import type { WeeklyShortEdition } from "@/lib/weeklyShorts";

export const WEEKLY_SHORT_DRAFT_SCHEMA = "amm-weekly-short-draft-v1" as const;
export const WEEKLY_SHORT_EPISODE_SCHEMA = "amm-weekly-short-episode-v1" as const;
export const WEEKLY_SHORT_MIN_WORDS = 150;
export const WEEKLY_SHORT_MAX_WORDS = 175;

export interface WeeklyShortClaim {
  id: string;
  ticker: string;
  statement: string;
  support: ShortClaimSupport[];
}

export interface WeeklyShortDraftStock {
  ticker: string;
  line1: string;
  line2: string;
  claimIds: string[];
}

export interface WeeklyShortDraft {
  schema: typeof WEEKLY_SHORT_DRAFT_SCHEMA;
  intro: string;
  stocks: WeeklyShortDraftStock[];
  close: string;
  claims: WeeklyShortClaim[];
}

export interface WeeklyShortEpisodePackage {
  schema: typeof WEEKLY_SHORT_EPISODE_SCHEMA;
  episodeId: string;
  createdAt: number;
  targetDate: string;
  publicationDate: string;
  edition: WeeklyShortEdition;
  editorial: {
    words: number;
    estimatedSeconds: number;
    script: string;
    intro: string;
    stocks: WeeklyShortDraftStock[];
    close: string;
    claims: WeeklyShortClaim[];
  };
  stocks: Array<{
    ticker: string;
    artifactKey: string;
    date: string;
    generatedAt: number;
    activeThesis: string;
    lifecycleStatus: "opened" | "strengthened" | "weakened" | "open";
    signal: Dossier["emailHook"]["signal"];
    votes: Dossier["emailHook"]["votes"];
    reportingCycle: ShortReportingCycle;
  }>;
  provenance: {
    sourceBundleSha256: string;
    excerpts: ShortSourceExcerpt[];
    citations: Array<Pick<
      DossierCitation,
      "id" | "title" | "url" | "publisher" | "authority" | "publishedDate" |
      "sourceDocumentId" | "contentSha256"
    >>;
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(object[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function words(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function dossierMap(dossiers: Dossier[]): Map<string, Dossier> {
  return new Map(dossiers.map((dossier) => [dossier.ticker.toUpperCase(), dossier]));
}

export function weeklySourceBundle(dossiers: Dossier[]): ShortSourceExcerpt[] {
  return dossiers.flatMap((dossier) =>
    shortSourceBundle(dossier).map((excerpt) => ({
      ...excerpt,
      id: `${dossier.ticker.toUpperCase()}:${excerpt.id}`,
      citationIds: excerpt.citationIds.map(
        (citationId) => `${dossier.ticker.toUpperCase()}:${citationId}`,
      ),
    })));
}

export function validateWeeklyShortDraft(
  dossiers: Dossier[],
  draft: WeeklyShortDraft,
  edition: WeeklyShortEdition,
): string[] {
  const issues = new Set<string>();
  if (draft.schema !== WEEKLY_SHORT_DRAFT_SCHEMA) {
    issues.add(`draft schema must be ${WEEKLY_SHORT_DRAFT_SCHEMA}`);
  }
  if (draft.stocks.length < 5 || draft.stocks.length > 6) {
    issues.add("weekly short must contain five or six stocks");
  }
  const byTicker = dossierMap(dossiers);
  const excerpts = weeklySourceBundle(dossiers);
  const excerptById = new Map(excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const claimById = new Map<string, WeeklyShortClaim>();
  const usedClaimIds = new Set<string>();
  const seenTickers = new Set<string>();
  for (const claim of draft.claims ?? []) {
    if (!/^W[1-9]\d*$/.test(claim.id)) issues.add(`invalid weekly claim id: ${claim.id}`);
    if (claimById.has(claim.id)) issues.add(`duplicate weekly claim id: ${claim.id}`);
    claimById.set(claim.id, claim);
    const ticker = claim.ticker.toUpperCase();
    if (!byTicker.has(ticker)) issues.add(`${claim.id} references unselected ticker ${ticker}`);
    if (!claim.statement?.trim()) issues.add(`${claim.id} has no statement`);
    if (!claim.support?.length) issues.add(`${claim.id} has no dossier support`);
    for (const support of claim.support ?? []) {
      const excerpt = excerptById.get(support.sourceId);
      if (!excerpt) {
        issues.add(`${claim.id} references unknown source ${support.sourceId}`);
        continue;
      }
      if (!support.sourceId.startsWith(`${ticker}:`)) {
        issues.add(`${claim.id} crosses evidence between companies`);
      }
      if (!support.quote?.trim() || support.quote.trim().length < 12) {
        issues.add(`${claim.id}/${support.sourceId} quote is too short`);
      } else if (!excerpt.text.includes(support.quote.trim())) {
        issues.add(`${claim.id}/${support.sourceId} quote is not verbatim dossier text`);
      }
      if (!excerpt.citationIds.length) {
        issues.add(`${claim.id}/${support.sourceId} has no admitted citation`);
      }
    }
  }
  for (const stock of draft.stocks ?? []) {
    const ticker = stock.ticker.toUpperCase();
    if (seenTickers.has(ticker)) issues.add(`duplicate stock: ${ticker}`);
    seenTickers.add(ticker);
    if (!byTicker.has(ticker)) issues.add(`stock ${ticker} has no selected dossier`);
    if (!stock.line1?.trim() || !stock.line2?.trim()) {
      issues.add(`${ticker} must have exactly two non-empty spoken lines`);
    }
    if ((stock.line1.match(/[.!?](?:\s|$)/g) ?? []).length > 1) {
      issues.add(`${ticker} line 1 contains more than one sentence`);
    }
    if ((stock.line2.match(/[.!?](?:\s|$)/g) ?? []).length > 1) {
      issues.add(`${ticker} line 2 contains more than one sentence`);
    }
    if (stock.claimIds?.length !== 2) {
      issues.add(`${ticker} must reference exactly two claims, one for each spoken line`);
    }
    if (new Set(stock.claimIds ?? []).size !== (stock.claimIds ?? []).length) {
      issues.add(`${ticker} repeats a claim reference`);
    }
    const spokenLines = [stock.line1?.trim(), stock.line2?.trim()];
    for (const [index, claimId] of (stock.claimIds ?? []).entries()) {
      usedClaimIds.add(claimId);
      const claim = claimById.get(claimId);
      if (!claim) issues.add(`${ticker} references unknown claim ${claimId}`);
      else if (claim.ticker.toUpperCase() !== ticker) {
        issues.add(`${ticker} references another company's claim ${claimId}`);
      } else if (claim.statement.trim() !== spokenLines[index]) {
        issues.add(
          `${ticker} line ${index + 1} must exactly match the statement in ${claimId}`,
        );
      }
    }
  }
  for (const claim of draft.claims ?? []) {
    if (!usedClaimIds.has(claim.id)) issues.add(`${claim.id} is not used by any spoken line`);
  }
  if (seenTickers.size !== draft.stocks.length) issues.add("weekly stock list is not unique");
  const expectedOrder = dossiers.map((dossier) => dossier.ticker.toUpperCase());
  const actualOrder = draft.stocks.map((stock) => stock.ticker.toUpperCase());
  if (
    actualOrder.length !== expectedOrder.length ||
    actualOrder.some((ticker, index) => ticker !== expectedOrder[index])
  ) {
    issues.add("draft stock order must match the selected weekly dossiers exactly");
  }
  const script = [
    draft.intro,
    ...draft.stocks.flatMap((stock) => [stock.line1, stock.line2]),
    draft.close,
  ].join(" ");
  const wordCount = words(script);
  if (wordCount < WEEKLY_SHORT_MIN_WORDS || wordCount > WEEKLY_SHORT_MAX_WORDS) {
    issues.add(
      `narration is ${wordCount} words; expected ${WEEKLY_SHORT_MIN_WORDS}–${WEEKLY_SHORT_MAX_WORDS}`,
    );
  }
  const countWord = draft.stocks.length === 5 ? "Five" : "Six";
  const expectedIntro = edition === "weekly-review"
    ? `${countWord} big stocks moved most in AMM's research this week. Here is what changed and what could matter next.`
    : `${countWord} big stocks carry the clearest evidence changes into next week. Here is what could matter next.`;
  if (draft.intro !== expectedIntro) issues.add("weekly intro must use the locked edition opener");
  if (draft.close !== "Track every thesis and source at aftermarketmovers dot com.") {
    issues.add("weekly close must use the locked AMM call to action");
  }
  if (
    /\b(?:10\s*[–-]\s*15|next\s+\d+\s+(?:trading\s+)?sessions?|expected impact)\b/i.test(script)
  ) {
    issues.add("weekly short must describe reporting-cycle movement, not a short-window prediction");
  }
  for (const issue of publicResearchContentIssues({
    subject: "AMM weekly stock briefing",
    text: script,
  })) {
    issues.add(`public-copy gate: ${issue}`);
  }
  return [...issues];
}

export function buildWeeklyShortEpisodePackage(input: {
  dossiers: Dossier[];
  draft: WeeklyShortDraft;
  targetDate: string;
  publicationDate: string;
  edition: WeeklyShortEdition;
  nextEventByTicker?: Record<string, string | null>;
  now?: number;
}): WeeklyShortEpisodePackage {
  const issues = validateWeeklyShortDraft(input.dossiers, input.draft, input.edition);
  if (issues.length) throw new Error(`weekly short blocked:\n- ${issues.join("\n- ")}`);
  const excerpts = weeklySourceBundle(input.dossiers);
  const citationByTicker = input.dossiers.flatMap((dossier) =>
    (dossier.citations ?? []).map((citation) => ({
      ...citation,
      id: `${dossier.ticker.toUpperCase()}:${citation.id}`,
    })));
  const usedSourceIds = new Set(
    input.draft.claims.flatMap((claim) => claim.support.map((support) => support.sourceId)),
  );
  const usedCitationIds = new Set(
    excerpts
      .filter((excerpt) => usedSourceIds.has(excerpt.id))
      .flatMap((excerpt) => excerpt.citationIds),
  );
  const citations = citationByTicker
    .filter((citation) => usedCitationIds.has(citation.id))
    .map((citation) => ({
      id: citation.id,
      title: citation.title,
      url: citation.url,
      publisher: citation.publisher,
      authority: citation.authority,
      publishedDate: citation.publishedDate,
      sourceDocumentId: citation.sourceDocumentId,
      contentSha256: citation.contentSha256,
    }));
  const script = [
    input.draft.intro,
    ...input.draft.stocks.flatMap((stock) => [stock.line1, stock.line2]),
    input.draft.close,
  ].join(" ");
  const stable = {
    targetDate: input.targetDate,
    publicationDate: input.publicationDate,
    edition: input.edition,
    artifacts: input.dossiers.map(dailyShortArtifactKey),
    draft: input.draft,
  };
  const now = input.now ?? Date.now();
  return {
    schema: WEEKLY_SHORT_EPISODE_SCHEMA,
    episodeId: `amm-weekly-${digest(stable).slice(0, 24)}`,
    createdAt: now,
    targetDate: input.targetDate,
    publicationDate: input.publicationDate,
    edition: input.edition,
    editorial: {
      words: words(script),
      estimatedSeconds: words(script) / 3,
      script,
      intro: input.draft.intro,
      stocks: input.draft.stocks,
      close: input.draft.close,
      claims: input.draft.claims,
    },
    stocks: input.dossiers.map((dossier) => ({
      ticker: dossier.ticker.toUpperCase(),
      artifactKey: dailyShortArtifactKey(dossier),
      date: dossier.date,
      generatedAt: dossier.generatedAt,
      activeThesis:
        dossier.thesisLifecycle?.canonicalSubjectPunchline ??
        dossier.emailHook.subjectPunchline,
      lifecycleStatus: dossier.thesisLifecycle?.observationStatus ?? "open",
      signal: { ...dossier.emailHook.signal },
      votes: { ...dossier.emailHook.votes },
      reportingCycle: deriveWeekendReportingCycle(
        dossier,
        input.publicationDate,
        input.nextEventByTicker?.[dossier.ticker.toUpperCase()] ?? null,
      ),
    })),
    provenance: {
      sourceBundleSha256: digest(excerpts),
      excerpts,
      citations,
    },
  };
}

export function weeklyShortPackageValidationError(
  dossiers: Dossier[],
  episode: WeeklyShortEpisodePackage,
  nextEventByTicker?: Record<string, string | null>,
): string | null {
  if (episode.schema !== WEEKLY_SHORT_EPISODE_SCHEMA) {
    return `unsupported weekly episode schema: ${String(episode.schema)}`;
  }
  if (dossiers.length < 5 || dossiers.length > 6) {
    return "weekly episode snapshot must contain five or six dossiers";
  }
  const expectedArtifacts = dossiers.map(dailyShortArtifactKey);
  const actualArtifacts = episode.stocks.map((stock) => stock.artifactKey);
  if (
    expectedArtifacts.length !== actualArtifacts.length ||
    expectedArtifacts.some((artifact, index) => artifact !== actualArtifacts[index])
  ) {
    return "weekly episode is not bound to the supplied dossier artifacts in order";
  }
  for (const [index, dossier] of dossiers.entries()) {
    const stock = episode.stocks[index];
    if (!stock) return `weekly episode is missing ${dossier.ticker}`;
    const activeThesis =
      dossier.thesisLifecycle?.canonicalSubjectPunchline ??
      dossier.emailHook.subjectPunchline;
    const lifecycleStatus = dossier.thesisLifecycle?.observationStatus ?? "open";
    let reportingCycle: ShortReportingCycle;
    try {
      reportingCycle = deriveWeekendReportingCycle(
        dossier,
        episode.publicationDate,
        nextEventByTicker?.[dossier.ticker.toUpperCase()] ?? null,
      );
    } catch (error) {
      return `${dossier.ticker} reporting cycle is invalid: ${String(error)}`;
    }
    const reportingCycleMatches = nextEventByTicker
      ? canonical(stock.reportingCycle) === canonical(reportingCycle)
      : (
        stock.reportingCycle.publicationDate === reportingCycle.publicationDate &&
        stock.reportingCycle.sourceDate === reportingCycle.sourceDate &&
        stock.reportingCycle.startDate === reportingCycle.startDate &&
        stock.reportingCycle.startLabel === reportingCycle.startLabel &&
        /^20\d{2}-\d{2}-\d{2}$/.test(stock.reportingCycle.endDate) &&
        stock.reportingCycle.endDate > stock.reportingCycle.startDate &&
        (
          stock.reportingCycle.endLabel === "NEXT RESULTS · DATE PENDING" ||
          /^NEXT RESULTS · [A-Z]{3} \d{1,2}$/.test(stock.reportingCycle.endLabel)
        )
      );
    if (
      stock.ticker !== dossier.ticker.toUpperCase() ||
      stock.date !== dossier.date ||
      stock.generatedAt !== dossier.generatedAt ||
      stock.activeThesis !== activeThesis ||
      stock.lifecycleStatus !== lifecycleStatus ||
      canonical(stock.signal) !== canonical(dossier.emailHook.signal) ||
      canonical(stock.votes) !== canonical(dossier.emailHook.votes) ||
      !reportingCycleMatches
    ) {
      return `${dossier.ticker} weekly state no longer matches its dossier snapshot`;
    }
  }
  const draft: WeeklyShortDraft = {
    schema: WEEKLY_SHORT_DRAFT_SCHEMA,
    intro: episode.editorial.intro,
    stocks: episode.editorial.stocks,
    close: episode.editorial.close,
    claims: episode.editorial.claims,
  };
  const issues = validateWeeklyShortDraft(dossiers, draft, episode.edition);
  if (issues.length) return issues.join("; ");
  const script = [
    draft.intro,
    ...draft.stocks.flatMap((stock) => [stock.line1, stock.line2]),
    draft.close,
  ].join(" ");
  if (
    episode.editorial.script !== script ||
    episode.editorial.words !== words(script) ||
    episode.provenance.sourceBundleSha256 !== digest(weeklySourceBundle(dossiers))
  ) {
    return "weekly episode editorial or source bundle digest is stale";
  }
  return null;
}
