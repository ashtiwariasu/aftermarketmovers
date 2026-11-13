import {
  dossierReleaseValidationError,
  type Dossier,
  type DossierThesisObservationStatus,
} from "@/lib/dossier";
import {
  SHORTS_CELEBRITY_UNIVERSE,
  dailyShortArtifactKey,
  isShortsCelebrityTicker,
} from "@/lib/dailyShorts";
import { deriveWeekendReportingCycle } from "@/lib/shortEpisode";

export const WEEKLY_SHORT_MIN_STOCKS = 5;
export const WEEKLY_SHORT_MAX_STOCKS = 6;
export const WEEKLY_SHORT_MIN_SUPPORT = 3;
// Correctness is enforced by the release, evidence, source-family and ballot
// gates below. The composite editorial score also prices novelty/asymmetry, so
// it is a ranking input rather than a reason to discard an otherwise auditable
// weekend stock.
export const WEEKLY_SHORT_MIN_EDITORIAL_SCORE = 50;

export type WeeklyShortEdition = "weekly-review" | "week-ahead";

export interface WeeklyThesisMovement {
  observationDates: string[];
  statuses: DossierThesisObservationStatus[];
  meaningfulChangeCount: number;
  strongestStatus: DossierThesisObservationStatus;
}

export function weeklyShortEditionForPublicationDate(
  publicationDate: string,
): WeeklyShortEdition {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)) {
    throw new Error("invalid weekly Short publication date");
  }
  const date = new Date(`${publicationDate}T12:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== publicationDate
  ) {
    throw new Error("invalid weekly Short publication date");
  }
  return date.getUTCDay() === 6 ? "weekly-review" : "week-ahead";
}

export interface WeeklyShortCandidate {
  ticker: string;
  date: string;
  artifactKey: string;
  eligible: boolean;
  reasons: string[];
  lifecycleStatus: DossierThesisObservationStatus;
  signal: Dossier["emailHook"]["signal"];
  votes: Dossier["emailHook"]["votes"];
  editorialStrength: Dossier["emailHook"]["editorialStrength"];
  weeklyMovement: WeeklyThesisMovement;
  selectionScore: number;
}

export interface WeeklyShortSelection {
  schema: "amm-weekly-short-selection-v1";
  targetDate: string;
  publicationDate: string;
  edition: WeeklyShortEdition;
  selected: WeeklyShortCandidate[];
  assessments: WeeklyShortCandidate[];
  eligible: boolean;
  reason: string | null;
  rules: {
    minimumStocks: typeof WEEKLY_SHORT_MIN_STOCKS;
    maximumStocks: typeof WEEKLY_SHORT_MAX_STOCKS;
    minimumSupport: typeof WEEKLY_SHORT_MIN_SUPPORT;
    minimumEditorialScore: typeof WEEKLY_SHORT_MIN_EDITORIAL_SCORE;
    minimumMateriality: 3;
    minimumEvidence: 3;
    minimumNonSocialSources: 2;
    minimumPrimaryOrCompanySources: 1;
    celebrityUniverse: string[];
  };
}

function publicTexts(dossier: Dossier): string[] {
  return [
    dossier.emailHook.whatChanged,
    dossier.emailHook.thesis,
    dossier.emailHook.primaryEvidence,
    ...dossier.emailHook.secondaryEvidence,
    dossier.signalCase.mechanism,
    dossier.signalCase.invalidation,
    dossier.emailHook.confidence.majorityReason,
    dossier.emailHook.confidence.dissentReason,
    dossier.emailHook.confidence.uncertaintyReason,
    dossier.emailHook.confidence.flipCondition,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function movementWeight(status: DossierThesisObservationStatus): number {
  switch (status) {
    case "strengthened":
    case "weakened":
      return 4;
    case "opened":
      return 3;
    case "open":
      return 1;
  }
}

function signalWeight(dossier: Dossier): number {
  switch (dossier.emailHook.signal.strength) {
    case "STRONG":
      return 3;
    case "MODERATE":
      return 2;
    case "GENTLE":
      return 1;
  }
}

function summarizeWeeklyMovement(
  dossier: Dossier,
  history: Dossier[],
): WeeklyThesisMovement {
  const byDate = new Map<string, Dossier>();
  for (const observation of [...history, dossier]) {
    if (
      observation.ticker.toUpperCase() !== dossier.ticker.toUpperCase() ||
      !observation.thesisLifecycle ||
      observation.thesisLifecycle.observationDate !== observation.date
    ) continue;
    const current = byDate.get(observation.date);
    if (!current || observation.generatedAt > current.generatedAt) {
      byDate.set(observation.date, observation);
    }
  }
  const observations = [...byDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date));
  const statuses = observations.map(
    (observation) => observation.thesisLifecycle!.observationStatus,
  );
  const meaningful = statuses.filter((status) => status !== "open");
  const strongestStatus = [...meaningful]
    .sort((left, right) => movementWeight(right) - movementWeight(left))[0] ??
    dossier.thesisLifecycle?.observationStatus ??
    "open";
  return {
    observationDates: observations.map((observation) => observation.date),
    statuses,
    meaningfulChangeCount: meaningful.length,
    strongestStatus,
  };
}

function score(dossier: Dossier, movement: WeeklyThesisMovement): number {
  const editorial = dossier.emailHook.editorialStrength;
  const celebrity = isShortsCelebrityTicker(dossier.ticker)
    ? SHORTS_CELEBRITY_UNIVERSE[dossier.ticker]
    : 0;
  // A real change in the standing thesis is the weekly product. Evidence and
  // council support follow. Fame is only the final tie-breaker.
  return (
    movementWeight(movement.strongestStatus) * 10_000_000 +
    Math.min(movement.meaningfulChangeCount, 5) * 500_000 +
    signalWeight(dossier) * 1_000_000 +
    dossier.emailHook.votes.support * 100_000 -
    dossier.emailHook.votes.oppose * 50_000 +
    editorial.score * 500 +
    editorial.evidence * 100 +
    editorial.materiality * 50 +
    celebrity
  );
}

export function assessWeeklyShortStock(
  dossier: Dossier,
  targetDate: string,
  history: Dossier[] = [],
  minimumDossierDate = targetDate,
): WeeklyShortCandidate {
  const reasons: string[] = [];
  const ticker = dossier.ticker.toUpperCase();
  const releaseError = dossierReleaseValidationError(dossier);
  const lifecycle = dossier.thesisLifecycle;
  const texts = publicTexts(dossier);
  const citations = (dossier.citations ?? []).filter((citation) =>
    texts.some((text) => text.includes(citation.url)));
  const nonSocial = citations.filter((citation) => citation.authority !== "social").length;
  const primaryOrCompany = citations.filter(
    (citation) => citation.authority === "primary" || citation.authority === "company",
  ).length;
  const editorial = dossier.emailHook.editorialStrength;
  const weeklyMovement = summarizeWeeklyMovement(dossier, history);

  if (dossier.date < minimumDossierDate || dossier.date > targetDate) {
    reasons.push(
      `outside the completed research window ${minimumDossierDate}–${targetDate}`,
    );
  }
  if (releaseError) reasons.push(`dossier release gate failed: ${releaseError}`);
  if (!isShortsCelebrityTicker(ticker)) reasons.push("outside the approved popular-stock universe");
  if (lifecycle) {
    if (lifecycle.observationDate !== dossier.date) {
      reasons.push("thesis observation date does not match the dossier");
    }
    if (
      lifecycle.latestSignal.direction !== dossier.emailHook.signal.direction ||
      lifecycle.latestSignal.strength !== dossier.emailHook.signal.strength
    ) {
      reasons.push("current read does not match the lifecycle observation");
    }
  }
  if (dossier.emailHook.votes.support < WEEKLY_SHORT_MIN_SUPPORT) {
    reasons.push(`only ${dossier.emailHook.votes.support}/5 analysts support the standing thesis`);
  }
  if (dossier.emailHook.votes.oppose >= dossier.emailHook.votes.support) {
    reasons.push("opposition is not lower than support");
  }
  if (editorial.score < WEEKLY_SHORT_MIN_EDITORIAL_SCORE) {
    reasons.push(
      `editorial strength ${editorial.score} is below ${WEEKLY_SHORT_MIN_EDITORIAL_SCORE}`,
    );
  }
  if (editorial.materiality < 3) reasons.push("materiality is below 3/5");
  if (editorial.evidence < 3) reasons.push("evidence quality is below 3/5");
  if (nonSocial < 2) reasons.push("fewer than two non-social sources");
  if (primaryOrCompany < 1) reasons.push("no primary or company source");
  try {
    deriveWeekendReportingCycle(dossier, targetDate);
  } catch (error) {
    reasons.push(`reporting-cycle frame is unavailable: ${String(error)}`);
  }

  return {
    ticker,
    date: dossier.date,
    artifactKey: dailyShortArtifactKey(dossier),
    eligible: reasons.length === 0,
    reasons,
    lifecycleStatus: lifecycle?.observationStatus ?? "open",
    signal: { ...dossier.emailHook.signal },
    votes: { ...dossier.emailHook.votes },
    editorialStrength: { ...editorial },
    weeklyMovement,
    selectionScore: score(dossier, weeklyMovement),
  };
}

export function selectWeeklyShortStocks(input: {
  dossiers: Dossier[];
  targetDate: string;
  publicationDate: string;
  edition: WeeklyShortEdition;
  minimumDossierDate?: string;
  historyByTicker?: Record<string, Dossier[]>;
}): WeeklyShortSelection {
  const byTicker = new Map<string, Dossier>();
  for (const dossier of input.dossiers) {
    const ticker = dossier.ticker.toUpperCase();
    const current = byTicker.get(ticker);
    if (
      !current ||
      dossier.generatedAt > current.generatedAt ||
      (
        dossier.generatedAt === current.generatedAt &&
        dailyShortArtifactKey(dossier) > dailyShortArtifactKey(current)
      )
    ) {
      byTicker.set(ticker, dossier);
    }
  }
  const assessments = [...byTicker.values()]
    .map((dossier) => assessWeeklyShortStock(
      dossier,
      input.targetDate,
      input.historyByTicker?.[dossier.ticker.toUpperCase()] ?? [],
      input.minimumDossierDate ?? input.targetDate,
    ))
    .sort((left, right) =>
      right.selectionScore - left.selectionScore ||
      left.ticker.localeCompare(right.ticker));
  const selected = assessments
    .filter((candidate) => candidate.eligible)
    .slice(0, WEEKLY_SHORT_MAX_STOCKS);
  const eligible = selected.length >= WEEKLY_SHORT_MIN_STOCKS;
  return {
    schema: "amm-weekly-short-selection-v1",
    targetDate: input.targetDate,
    publicationDate: input.publicationDate,
    edition: input.edition,
    selected: eligible ? selected : [],
    assessments,
    eligible,
    reason: eligible
      ? null
      : `only ${selected.length} released stocks cleared the ${WEEKLY_SHORT_MIN_STOCKS}-stock weekly evidence gate`,
    rules: {
      minimumStocks: WEEKLY_SHORT_MIN_STOCKS,
      maximumStocks: WEEKLY_SHORT_MAX_STOCKS,
      minimumSupport: WEEKLY_SHORT_MIN_SUPPORT,
      minimumEditorialScore: WEEKLY_SHORT_MIN_EDITORIAL_SCORE,
      minimumMateriality: 3,
      minimumEvidence: 3,
      minimumNonSocialSources: 2,
      minimumPrimaryOrCompanySources: 1,
      celebrityUniverse: Object.keys(SHORTS_CELEBRITY_UNIVERSE),
    },
  };
}
