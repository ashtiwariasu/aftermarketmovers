import {
  dossierReleaseValidationError,
  type Dossier,
} from "@/lib/dossier";

/**
 * Cold-start audience priors for widely followed names. This is not an
 * admission list: every active, release-ready US stock competes for a Short.
 * Once a ticker has measured audience data, that evidence replaces the prior.
 */
export const SHORTS_CELEBRITY_UNIVERSE = {
  NVDA: 9,
  TSLA: 8,
  AAPL: 7,
  META: 6,
  AMZN: 5,
  MSFT: 4,
  GOOGL: 3,
  AMD: 2,
  PLTR: 1,
} as const;

export type ShortsCelebrityTicker = keyof typeof SHORTS_CELEBRITY_UNIVERSE;

// The public dossier itself clears at a majority ballot. Video keeps the same
// research standard: 3/5 is the admission floor, while support, opposition and
// editorial strength determine which two of the evidence-cleared candidates
// win the daily slots. Requiring 4/5 here made the distribution layer silently
// discard valid, honestly divided AMM work.
export const DAILY_SHORT_MIN_SUPPORT = 3;
export const DAILY_SHORT_MIN_EDITORIAL_SCORE = 50;
export const DAILY_SHORT_LIMIT = 2;
export const DAILY_SHORT_REQUIRED_COUNT = 2;
export const DAILY_SHORT_FATIGUE_WINDOW_TRADING_DAYS = 5;
export const DAILY_SHORT_MAX_APPEARANCES_IN_WINDOW = 2;

export type DailyShortSelectionRole = "audience-magnet" | "breakout-opportunity";

export interface DailyShortAudienceSignal {
  ticker: string;
  /** 0–100, based on recent demand for this ticker's AMM videos. */
  currentInterest: number;
  /** 0–100, retention/engagement quality across prior AMM videos. */
  historicalEngagement: number;
  /** 0–100, recent demand versus the ticker's own prior baseline. */
  demandAcceleration: number;
  /** 0–100, dossier-page visits/trials attributed to prior videos. */
  conversionIntent: number;
  sampleSize: number;
  measuredAt?: number;
}

export interface DailyShortPublicationHistory {
  ticker: string;
  publicationDate: string;
}

export interface DailyShortRankingBreakdown {
  currentInterest: number;
  historicalEngagement: number;
  materiality: number;
  timeliness: number;
  conversionIntent: number;
  demandAcceleration: number;
  fatiguePenalty: number;
  recentAppearances: number;
  usedMeasuredAudience: boolean;
  audienceOpportunityScore: number;
  breakoutOpportunityScore: number;
}

export interface DailyShortAssessment {
  ticker: string;
  date: string;
  artifactKey: string;
  eligible: boolean;
  reasons: string[];
  votes: {
    support: number;
    oppose: number;
    uncertain: number;
  };
  editorialStrength: Dossier["emailHook"]["editorialStrength"];
  selectionScore: number;
  selectionRole?: DailyShortSelectionRole;
  ranking: DailyShortRankingBreakdown;
}

export interface DailyShortSelection {
  schema: "amm-daily-short-selection-v3";
  date: string;
  selected: DailyShortAssessment[];
  assessments: DailyShortAssessment[];
  rules: {
    audiencePriorTickers: string[];
    admissionUniverse: "all-active-release-ready-us-stocks";
    minimumSupport: typeof DAILY_SHORT_MIN_SUPPORT;
    minimumEditorialScore: typeof DAILY_SHORT_MIN_EDITORIAL_SCORE;
    minimumMateriality: 4;
    minimumEvidence: 4;
    noveltyRole: "ranking-only";
    asymmetryRole: "ranking-only";
    minimumNonSocialSources: 2;
    minimumPrimaryOrCompanySources: 1;
    fatigueWindowTradingDays: typeof DAILY_SHORT_FATIGUE_WINDOW_TRADING_DAYS;
    maximumAppearancesInWindow: typeof DAILY_SHORT_MAX_APPEARANCES_IN_WINDOW;
    slots: ["audience-magnet", "breakout-opportunity"];
    limit: number;
  };
}

export function dailyShortArtifactKey(dossier: Pick<
  Dossier,
  "artifactVersion" | "ticker" | "date" | "generatedAt"
>): string {
  return `dossier-v${dossier.artifactVersion}:${dossier.ticker}:${dossier.date}:${dossier.generatedAt}`;
}

export function isShortsCelebrityTicker(ticker: string): ticker is ShortsCelebrityTicker {
  return Object.hasOwn(SHORTS_CELEBRITY_UNIVERSE, ticker.toUpperCase());
}

function selectionScore(dossier: Dossier): number {
  const strength = dossier.emailHook.editorialStrength;
  // This remains a deterministic research-quality tie-breaker. Audience
  // opportunity chooses the scarce slots only after this release gate clears.
  return (
    dossier.emailHook.votes.support * 1_000_000 -
    dossier.emailHook.votes.oppose * 100_000 +
    strength.score * 1_000 +
    strength.evidence * 100 +
    strength.materiality * 50 +
    strength.novelty * 20 +
    strength.asymmetry * 10
  );
}

function clampScore(value: number, fallback = 50): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, value));
}

function audiencePrior(ticker: string): number {
  if (!isShortsCelebrityTicker(ticker)) return 35;
  return 40 + SHORTS_CELEBRITY_UNIVERSE[ticker] * 5;
}

function timelinessScore(dossier: Dossier): number {
  const status = dossier.thesisLifecycle?.observationStatus;
  if (status === "opened") return 100;
  if (status === "strengthened" || status === "weakened") return 90;
  if (dossier.emailHook.signal.eventType === "earnings") return 70;
  return 50;
}

function hasMaterialThesisChange(dossier: Dossier): boolean {
  const lifecycle = dossier.thesisLifecycle;
  return Boolean(
    lifecycle && (
      lifecycle.observationIndex === 1 ||
      lifecycle.observationStatus === "opened" ||
      lifecycle.observationStatus === "strengthened" ||
      lifecycle.observationStatus === "weakened"
    )
  );
}

function priorTradingDates(date: string, count: number): Set<string> {
  const dates = new Set<string>();
  const cursor = new Date(`${date}T12:00:00Z`);
  while (dates.size < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const day = cursor.getUTCDay();
    if (day === 0 || day === 6) continue;
    dates.add(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function rankingBreakdown(input: {
  dossier: Dossier;
  audience?: DailyShortAudienceSignal;
  publicationHistory: readonly DailyShortPublicationHistory[];
  targetDate: string;
}): DailyShortRankingBreakdown {
  const { dossier, audience } = input;
  const prior = audiencePrior(dossier.ticker);
  const measured = Boolean(audience && audience.sampleSize > 0);
  const currentInterest = clampScore(audience?.currentInterest ?? prior);
  const historicalEngagement = clampScore(audience?.historicalEngagement ?? prior);
  const demandAcceleration = clampScore(audience?.demandAcceleration ?? 50);
  const conversionIntent = clampScore(audience?.conversionIntent ?? 50);
  const materiality = clampScore(dossier.emailHook.editorialStrength.materiality * 20);
  const timeliness = timelinessScore(dossier);
  const recentDates = priorTradingDates(
    input.targetDate,
    DAILY_SHORT_FATIGUE_WINDOW_TRADING_DAYS,
  );
  const recentAppearances = input.publicationHistory.filter((publication) =>
    publication.ticker.toUpperCase() === dossier.ticker.toUpperCase() &&
    recentDates.has(publication.publicationDate)
  ).length;
  const fatiguePenalty = hasMaterialThesisChange(dossier)
    ? 0
    : Math.min(40, recentAppearances * 15);
  const audienceOpportunityScore = (
    currentInterest * 0.30 +
    historicalEngagement * 0.25 +
    materiality * 0.20 +
    timeliness * 0.15 +
    conversionIntent * 0.10 -
    fatiguePenalty
  );
  const breakoutOpportunityScore = (
    demandAcceleration * 0.35 +
    materiality * 0.25 +
    currentInterest * 0.20 +
    timeliness * 0.15 +
    conversionIntent * 0.05 -
    fatiguePenalty
  );
  return {
    currentInterest,
    historicalEngagement,
    materiality,
    timeliness,
    conversionIntent,
    demandAcceleration,
    fatiguePenalty,
    recentAppearances,
    usedMeasuredAudience: measured,
    audienceOpportunityScore,
    breakoutOpportunityScore,
  };
}

function publicShortSourceTexts(dossier: Dossier): string[] {
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

export function assessDailyShort(
  dossier: Dossier,
  date: string,
  alreadyPublishedArtifactKeys: ReadonlySet<string> = new Set(),
  options: {
    audience?: DailyShortAudienceSignal;
    publicationHistory?: readonly DailyShortPublicationHistory[];
  } = {},
): DailyShortAssessment {
  const reasons: string[] = [];
  const ticker = dossier.ticker.toUpperCase();
  const artifactKey = dailyShortArtifactKey(dossier);
  const strength = dossier.emailHook.editorialStrength;
  const releaseError = dossierReleaseValidationError(dossier);
  const sourceTexts = publicShortSourceTexts(dossier);
  // Count only sources actually referenced by material admitted to the video
  // editor. A strong source elsewhere in a long dossier cannot launder a weak
  // or social-only public proposition through this gate.
  const citations = (dossier.citations ?? []).filter((citation) =>
    sourceTexts.some((text) => text.includes(citation.url)));
  const nonSocialSources = citations.filter((citation) => citation.authority !== "social").length;
  const primaryOrCompanySources = citations.filter(
    (citation) => citation.authority === "primary" || citation.authority === "company",
  ).length;
  const ranking = rankingBreakdown({
    dossier,
    audience: options.audience,
    publicationHistory: options.publicationHistory ?? [],
    targetDate: date,
  });

  if (dossier.date !== date) reasons.push("not from the completed target research date");
  if (releaseError) reasons.push(`dossier release gate failed: ${releaseError}`);
  if (!dossier.thesisLifecycle) {
    reasons.push("missing the continuous-thesis lifecycle receipt");
  } else {
    if (dossier.thesisLifecycle.observationDate !== dossier.date) {
      reasons.push("thesis observation date does not match the dossier");
    }
    if (
      dossier.thesisLifecycle.latestSignal.direction !== dossier.emailHook.signal.direction ||
      dossier.thesisLifecycle.latestSignal.strength !== dossier.emailHook.signal.strength
    ) {
      reasons.push("current read does not match the lifecycle observation");
    }
  }
  if (alreadyPublishedArtifactKeys.has(artifactKey)) reasons.push("this exact dossier was already published");
  if (dossier.emailHook.votes.support < DAILY_SHORT_MIN_SUPPORT) {
    reasons.push(`only ${dossier.emailHook.votes.support}/5 analysts support the thesis`);
  }
  if (strength.score < DAILY_SHORT_MIN_EDITORIAL_SCORE) {
    reasons.push(`editorial strength ${strength.score} is below ${DAILY_SHORT_MIN_EDITORIAL_SCORE}`);
  }
  if (strength.materiality < 4) reasons.push("materiality is below 4/5");
  if (strength.evidence < 4) reasons.push("evidence quality is below 4/5");
  // Novelty and asymmetry decide which of the evidence-cleared candidates
  // wins a scarce public slot; they are not truth or safety gates. Making
  // either a hard veto caused the fleet to withhold a fully traceable second
  // video even when two current majority reads were available.
  if (nonSocialSources < 2) reasons.push("fewer than two non-social sources");
  if (primaryOrCompanySources < 1) reasons.push("no primary or company source");
  if (
    ranking.recentAppearances >= DAILY_SHORT_MAX_APPEARANCES_IN_WINDOW &&
    !hasMaterialThesisChange(dossier)
  ) {
    reasons.push(
      `ticker already appeared ${ranking.recentAppearances} times in the prior ` +
      `${DAILY_SHORT_FATIGUE_WINDOW_TRADING_DAYS} trading days`,
    );
  }

  return {
    ticker,
    date: dossier.date,
    artifactKey,
    eligible: reasons.length === 0,
    reasons,
    votes: { ...dossier.emailHook.votes },
    editorialStrength: { ...strength },
    selectionScore: selectionScore(dossier),
    ranking,
  };
}

export function selectDailyShorts(input: {
  dossiers: Dossier[];
  date: string;
  alreadyPublishedArtifactKeys?: ReadonlySet<string>;
  audienceSignals?: ReadonlyMap<string, DailyShortAudienceSignal>;
  publicationHistory?: readonly DailyShortPublicationHistory[];
  limit?: number;
}): DailyShortSelection {
  const published = input.alreadyPublishedArtifactKeys ?? new Set<string>();
  const byTicker = new Map<string, Dossier>();
  for (const dossier of input.dossiers) {
    const ticker = dossier.ticker.toUpperCase();
    const current = byTicker.get(ticker);
    if (
      !current ||
      dossier.generatedAt > current.generatedAt ||
      (dossier.generatedAt === current.generatedAt &&
        dailyShortArtifactKey(dossier) > dailyShortArtifactKey(current))
    ) {
      byTicker.set(ticker, dossier);
    }
  }
  const assessments = [...byTicker.values()]
    .map((dossier) => assessDailyShort(dossier, input.date, published, {
      audience: input.audienceSignals?.get(dossier.ticker.toUpperCase()),
      publicationHistory: input.publicationHistory,
    }))
    .sort((left, right) =>
      right.ranking.audienceOpportunityScore - left.ranking.audienceOpportunityScore ||
      right.selectionScore - left.selectionScore ||
      left.ticker.localeCompare(right.ticker),
    );
  const limit = Math.max(0, Math.min(DAILY_SHORT_LIMIT, Math.floor(input.limit ?? DAILY_SHORT_LIMIT)));
  const eligible = assessments.filter((candidate) => candidate.eligible);
  const selected: DailyShortAssessment[] = [];
  const audienceMagnet = eligible[0];
  if (audienceMagnet && limit > 0) {
    audienceMagnet.selectionRole = "audience-magnet";
    selected.push(audienceMagnet);
  }
  if (limit > 1) {
    const breakout = eligible
      .filter((candidate) => candidate.ticker !== audienceMagnet?.ticker)
      .sort((left, right) =>
        right.ranking.breakoutOpportunityScore - left.ranking.breakoutOpportunityScore ||
        right.selectionScore - left.selectionScore ||
        left.ticker.localeCompare(right.ticker)
      )[0];
    if (breakout) {
      breakout.selectionRole = "breakout-opportunity";
      selected.push(breakout);
    }
  }
  return {
    schema: "amm-daily-short-selection-v3",
    date: input.date,
    selected,
    assessments,
    rules: {
      audiencePriorTickers: Object.keys(SHORTS_CELEBRITY_UNIVERSE),
      admissionUniverse: "all-active-release-ready-us-stocks",
      minimumSupport: DAILY_SHORT_MIN_SUPPORT,
      minimumEditorialScore: DAILY_SHORT_MIN_EDITORIAL_SCORE,
      minimumMateriality: 4,
      minimumEvidence: 4,
      noveltyRole: "ranking-only",
      asymmetryRole: "ranking-only",
      minimumNonSocialSources: 2,
      minimumPrimaryOrCompanySources: 1,
      fatigueWindowTradingDays: DAILY_SHORT_FATIGUE_WINDOW_TRADING_DAYS,
      maximumAppearancesInWindow: DAILY_SHORT_MAX_APPEARANCES_IN_WINDOW,
      slots: ["audience-magnet", "breakout-opportunity"],
      limit,
    },
  };
}

/**
 * A successful trading-day edition is a pair, never a partial feed. This
 * check is deliberately separate from candidate assessment so read-only
 * selection can still explain why a complete pair is unavailable.
 */
export function dailyShortSelectionValidationError(
  selection: DailyShortSelection,
): string | null {
  if (selection.rules.limit !== DAILY_SHORT_REQUIRED_COUNT) {
    return `daily Shorts limit must be exactly ${DAILY_SHORT_REQUIRED_COUNT}`;
  }
  if (selection.selected.length !== DAILY_SHORT_REQUIRED_COUNT) {
    return (
      `daily Shorts requires exactly ${DAILY_SHORT_REQUIRED_COUNT} evidence-cleared stocks; ` +
      `${selection.selected.length} qualified`
    );
  }
  return null;
}

export interface DailyShortReadinessDecision {
  shouldFinishWaiting: boolean;
  reason: "qualified-pair" | "fleet-complete" | "deadline" | "waiting";
  selectionError: string | null;
}

/**
 * Shorts are downstream of the followed-stock product, never a substitute for
 * it. A candidate pair is not ready while any active company is missing its
 * daily evidence-check receipt. This keeps distribution from rewarding two
 * lucky completions while silently abandoning the rest of the user fleet.
 */
export function evaluateDailyShortReadiness(input: {
  selection: DailyShortSelection;
  pendingTickers?: readonly string[];
  deadlineReached?: boolean;
}): DailyShortReadinessDecision {
  const selectionError = dailyShortSelectionValidationError(input.selection);
  const hasPending = Boolean((input.pendingTickers ?? []).length);
  if (!hasPending && selectionError === null) {
    return {
      shouldFinishWaiting: true,
      reason: "qualified-pair",
      selectionError: null,
    };
  }
  if (!hasPending) {
    return {
      shouldFinishWaiting: true,
      reason: "fleet-complete",
      selectionError,
    };
  }
  if (input.deadlineReached) {
    return {
      shouldFinishWaiting: true,
      reason: "deadline",
      selectionError,
    };
  }
  return {
    shouldFinishWaiting: false,
    reason: "waiting",
    selectionError,
  };
}

export interface DailyShortFleetGateDecision {
  mayProceed: boolean;
  partialFleet: boolean;
  excludedPendingTickers: string[];
  error: string | null;
}

/**
 * Publication requires both contracts: the entire active fleet has a recorded
 * daily outcome and the completed cohort contains exactly two independently
 * evidence-cleared dossiers. A timeout may end polling so an operator can see
 * the failure, but it never converts incomplete research into permission to
 * publish.
 */
export function evaluateDailyShortFleetGate(input: {
  selection: DailyShortSelection;
  pendingTickers?: readonly string[];
}): DailyShortFleetGateDecision {
  const excludedPendingTickers = [...new Set(
    (input.pendingTickers ?? [])
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  )].sort();
  const selectionError = dailyShortSelectionValidationError(input.selection);
  const partialFleet = excludedPendingTickers.length > 0;
  const incompleteFleetError = partialFleet
    ? `daily tracking incomplete for ${excludedPendingTickers.join(", ")}`
    : null;
  return {
    mayProceed: selectionError === null && !partialFleet,
    partialFleet,
    excludedPendingTickers,
    error: [selectionError, incompleteFleetError].filter(Boolean).join("; ") || null,
  };
}
