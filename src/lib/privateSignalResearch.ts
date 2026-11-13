import { createHash } from "node:crypto";

/**
 * Private research calibration only.
 *
 * Nothing in this module is a public price target. The signed values are
 * empirical, event-conditioned stock returns relative to SPY after adjusting
 * for the stock's trailing beta. Public renderers must not import this module.
 */

export const PRIVATE_SIGNAL_SCHEMA_VERSION = 3 as const;
export const PRIVATE_SIGNAL_METHOD_VERSION =
  "signed-event-conditioned-spy-relative-walk-forward-v1" as const;
export const PRIVATE_SIGNAL_RESOLUTION_VERSION =
  "signed-spy-relative-outcome-v1" as const;
export const PRIVATE_SIGNAL_EVENT_TAXONOMY_VERSION = "amm-event-family-v1" as const;
export const PRIVATE_SIGNAL_HASH_VERSION = "sha256-canonical-json-v1" as const;
export const PRIVATE_SIGNAL_HORIZONS = [10, 15] as const;

export type PrivateSignalHorizon = (typeof PRIVATE_SIGNAL_HORIZONS)[number];
export type PrivateSignalDirection = "UP" | "DOWN";
export type PrivateSignalStrength = "GENTLE" | "MODERATE" | "STRONG";

export interface ResearchPriceBar {
  /** Exchange session, YYYY-MM-DD. */
  date: string;
  close: number | null;
  /** Preferred whenever the vendor supplies split/dividend adjusted history. */
  adjustedClose?: number | null;
  source?: string;
  /**
   * Epoch milliseconds when this exact daily close became observable. When a
   * vendor does not supply it, the research layer conservatively uses 16:00
   * America/New_York for the session (early closes therefore stay unavailable
   * rather than risk look-ahead).
   */
  sessionClosedAt?: number;
}

export interface HistoricalSignalEvent {
  id: string;
  ticker: string;
  /** Exact close used as the historical signal entry; never inferred from publication time. */
  signalSessionDate: string;
  /** Stable normalized family such as earnings, guidance, regulatory, or product. */
  eventType: string;
  direction: PrivateSignalDirection;
  strength?: PrivateSignalStrength;
  thesisSha256?: string;
  /** When this event record itself was first issued/observed. */
  issuedAt: number;
}

export interface VersionedResearchHash {
  algorithm: "sha256";
  canonicalization: typeof PRIVATE_SIGNAL_HASH_VERSION;
  digest: string;
}

export interface PrivateSignalCalibrationConfig {
  betaLookbackSessions: number;
  minimumBetaSessions: number;
  minimumEffectiveSamples: number;
  lowerQuantile: number;
  upperQuantile: number;
}

export interface PrivateSignalHorizonBand {
  horizonSessions: PrivateSignalHorizon;
  /**
   * Signed percentage points: stock total return minus beta × SPY total return.
   * Negative values mean the stock underperformed its beta-adjusted SPY move.
   */
  signedSpyRelativeReturnPct: {
    lower: number;
    median: number;
    upper: number;
  };
  predictedDirectionHitRate: number;
  rawResolvedSamples: number;
  deduplicatedSessionSamples: number;
  effectiveNonOverlappingSamples: number;
}

export interface PrivateSignalSampleAccounting {
  historicalEventsSeen: number;
  exactEventAndDirectionMatches: number;
  uniqueMatchedSignalSessions: number;
  alignedMatchedSignalSessions: number;
  horizons: Record<PrivateSignalHorizon, {
    resolvedBeforeIssue: number;
    effectiveNonOverlapping: number;
  }>;
}

export interface PrivateSignalCalibration {
  methodVersion: typeof PRIVATE_SIGNAL_METHOD_VERSION;
  eventTaxonomyVersion: typeof PRIVATE_SIGNAL_EVENT_TAXONOMY_VERSION;
  semantics: {
    benchmark: "SPY";
    measure: "stock_total_return_minus_beta_times_spy_total_return";
    signPreserved: true;
    units: "percentage_points";
    directionConditioned: true;
    eventConditioned: true;
    magnitudeOnly: false;
  };
  condition: {
    eventType: string;
    direction: PrivateSignalDirection;
    fallbackToPooledEvents: false;
  };
  walkForward: {
    scheme: "rolling-origin-event-walk-forward";
    noLookAhead: true;
    historicalBetaUsesOnlySessionsAtOrBeforeEvent: true;
    historicalOutcomeMustResolveBeforeCurrentIssue: true;
    overlappingOutcomeWindowsExcludedFromEffectiveSample: true;
    betaLookbackSessions: number;
    minimumBetaSessions: number;
    lowerQuantile: number;
    upperQuantile: number;
    issueSessionDate: string;
    evaluationCutoffSession: string;
  };
  currentBetaToSpy: number;
  currentBetaTrainingSessions: number;
  bands: Record<PrivateSignalHorizon, PrivateSignalHorizonBand>;
  sampleAccounting: PrivateSignalSampleAccounting;
  dataHashes: {
    stockBarsThroughIssue: VersionedResearchHash;
    spyBarsThroughIssue: VersionedResearchHash;
    matchedHistoricalEvents: VersionedResearchHash;
    methodAndConfig: VersionedResearchHash;
  };
  sources: {
    stock: string[];
    benchmark: string[];
  };
}

export interface PrivateSignalOutcome {
  resolutionVersion: typeof PRIVATE_SIGNAL_RESOLUTION_VERSION;
  horizonSessions: PrivateSignalHorizon;
  entrySessionDate: string;
  exitSessionDate: string;
  entryStockAdjustedClose: number;
  exitStockAdjustedClose: number;
  entrySpyAdjustedClose: number;
  exitSpyAdjustedClose: number;
  /** Vendors can legitimately back-adjust the entry after a dividend/split. */
  entryBasisRevision: {
    stockPct: number;
    spyPct: number;
    changed: boolean;
  };
  stockTotalReturnPct: number;
  spyTotalReturnPct: number;
  /** Explicitly stock return − issuance-time beta × SPY return. */
  signedSpyRelativeReturnPct: number;
  directionAdjustedReturnPct: number;
  predictedDirectionCorrect: boolean;
  /** Null until this exact event/direction cohort has earned a calibrated band. */
  insideCalibratedBand: boolean | null;
  resolvedAt: number;
  sourceBarsSha256: VersionedResearchHash;
  outcomeSha256: VersionedResearchHash;
}

export interface PrivateSignalEntryContract {
  market: "US-equities";
  selectionRule: "latest-aligned-close-observable-at-issuance";
  selectionCutoffAt: number;
  closeRule: "explicit-or-conservative-1600-america-new-york";
  sessionCloseMustNotExceedIssuedAt: true;
}

export interface PrivateSignalEntryBinding {
  sessionDate: string;
  sessionClosedAt: number;
  boundAt: number;
  stockAdjustedClose: number;
  spyAdjustedClose: number;
  stockSource: string;
  spySource: string;
  bindingSha256: VersionedResearchHash;
}

export interface PrivateSignalIssuanceBeta {
  value: number;
  trainingSessions: number;
  betaSha256: VersionedResearchHash;
}

export interface PrivateSignalSourceArtifact {
  dossierArtifactVersion: number;
  dossierDate: string;
  councilRunId: string;
  briefAuditId: string;
  /** Hash of the exact gated email hook/public thesis that created the signal. */
  emailHookSha256: VersionedResearchHash;
}

export interface PrivateSignalResearchRecord {
  id: string;
  schemaVersion: typeof PRIVATE_SIGNAL_SCHEMA_VERSION;
  visibility: "private-research-only";
  publicationStatus: "withheld-pending-track-record-and-legal-review";
  publicUseProhibited: true;
  ticker: string;
  thesis: string;
  thesisSha256: VersionedResearchHash;
  eventType: string;
  direction: PrivateSignalDirection;
  strength: PrivateSignalStrength;
  issuedAt: number;
  sourceArtifact: PrivateSignalSourceArtifact;
  /** Immutable rule; the exact session is appended only when adjusted bars arrive. */
  entryContract: PrivateSignalEntryContract;
  entryStatus: "pending" | "bound";
  entryPendingReason?: "no-aligned-close-observable-at-issuance";
  entryBinding?: PrivateSignalEntryBinding;
  /** Frozen to target-session history and used for every later outcome. */
  issuanceBetaStatus: "pending-entry" | "unavailable" | "available";
  issuanceBeta?: PrivateSignalIssuanceBeta;
  calibrationStatus: "pending-entry" | "unavailable" | "calibrated" | "insufficient-sample";
  /** Present only after the exact event/direction cohort clears the effective-sample gate. */
  calibration?: PrivateSignalCalibration;
  calibrationSha256?: VersionedResearchHash;
  calibrationFailure?: {
    reason: "entry-pending" | "insufficient-beta-history" | "insufficient-effective-event-samples";
    sampleAccounting?: PrivateSignalSampleAccounting;
  };
  calibrationAttemptSha256?: VersionedResearchHash;
  resolutionStatus: "pending" | "partial" | "complete";
  outcomes: Partial<Record<PrivateSignalHorizon, PrivateSignalOutcome>>;
  immutableRecordSha256: VersionedResearchHash;
  /** Derived single-field Firestore indexes; neither is public output. */
  tickerIssuedKey: string;
  resolutionQueueKey?: string;
}

export type PrivateSignalCalibrationResult =
  | { ok: true; calibration: PrivateSignalCalibration }
  | {
      ok: false;
      reason:
        | "invalid-input"
        | "issue-session-not-aligned"
        | "insufficient-beta-history"
        | "insufficient-effective-event-samples";
      sampleAccounting?: PrivateSignalSampleAccounting;
    };

export type CreatePrivateSignalResult =
  | { ok: true; record: PrivateSignalResearchRecord }
  | { ok: false; reason: "invalid-input" };

interface NormalizedPoint {
  date: string;
  price: number;
  source: string;
  sessionClosedAt: number;
}

interface AlignedPoint {
  date: string;
  stock: number;
  spy: number;
  stockSource: string;
  spySource: string;
  sessionClosedAt: number;
}

interface HistoricalOutcomeSample {
  eventId: string;
  entryIndex: number;
  exitIndex: number;
  signedReturnPct: number;
}

const DEFAULT_CONFIG: PrivateSignalCalibrationConfig = {
  betaLookbackSessions: 504,
  minimumBetaSessions: 126,
  minimumEffectiveSamples: 20,
  lowerQuantile: 0.25,
  upperQuantile: 0.75,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function researchHash(value: unknown): VersionedResearchHash {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
  return {
    algorithm: "sha256",
    canonicalization: PRIVATE_SIGNAL_HASH_VERSION,
    digest,
  };
}

function validResearchHash(value: VersionedResearchHash | undefined): value is VersionedResearchHash {
  return Boolean(
    value && value.algorithm === "sha256" &&
    value.canonicalization === PRIVATE_SIGNAL_HASH_VERSION &&
    /^[0-9a-f]{64}$/.test(value.digest),
  );
}

function sameResearchHash(left: VersionedResearchHash | undefined, right: VersionedResearchHash): boolean {
  return validResearchHash(left) && left.digest === right.digest;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizedEventType(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function validSessionDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function validTicker(value: string): boolean {
  return /^[A-Z][A-Z.\-]{0,9}$/.test(value);
}

function issuedAtKey(issuedAt: number): string {
  return String(Math.floor(issuedAt)).padStart(16, "0");
}

export function privateSignalTickerIssuedKey(
  ticker: string,
  issuedAt: number,
  id: string,
): string {
  return `${ticker}|${issuedAtKey(issuedAt)}|${id}`;
}

export function privateSignalResolutionQueueKey(issuedAt: number, id: string): string {
  return `${issuedAtKey(issuedAt)}|${id}`;
}

const NEW_YORK_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function newYorkDateAt(epochMs: number): string | null {
  if (!Number.isFinite(epochMs) || epochMs <= 0 || epochMs > 8.64e15) return null;
  const parts = Object.fromEntries(
    NEW_YORK_PARTS.formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = String(parts.year ?? "");
  const month = String(parts.month ?? "").padStart(2, "0");
  const day = String(parts.day ?? "").padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  return validSessionDate(date) ? date : null;
}

/** Conservative regular-session close. Explicit vendor/calendar closes win. */
export function conservativeUsSessionCloseAt(sessionDate: string): number {
  if (!validSessionDate(sessionDate)) return Number.NaN;
  const [year, month, day] = sessionDate.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day, 16, 0, 0);
  let guess = desired;
  // Convert the desired wall clock in New York to UTC without a timezone
  // dependency. Two passes handle both DST offsets and date rollovers.
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = Object.fromEntries(
      NEW_YORK_PARTS.formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    guess += desired - represented;
  }
  return guess;
}

function normalizeBars(bars: ResearchPriceBar[]): NormalizedPoint[] {
  const byDate = new Map<string, NormalizedPoint>();
  for (const bar of bars) {
    const price = bar.adjustedClose ?? bar.close;
    if (!validSessionDate(bar.date) || typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      continue;
    }
    byDate.set(bar.date, {
      date: bar.date,
      price,
      source: bar.source?.trim() || "unknown",
      sessionClosedAt:
        typeof bar.sessionClosedAt === "number" && Number.isFinite(bar.sessionClosedAt) && bar.sessionClosedAt > 0
          ? Math.floor(bar.sessionClosedAt)
          : conservativeUsSessionCloseAt(bar.date),
    });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function alignBars(stockBars: ResearchPriceBar[], spyBars: ResearchPriceBar[]): {
  aligned: AlignedPoint[];
  stock: NormalizedPoint[];
  spy: NormalizedPoint[];
} {
  const stock = normalizeBars(stockBars);
  const spy = normalizeBars(spyBars);
  const spyByDate = new Map(spy.map((point) => [point.date, point]));
  const aligned = stock.flatMap((point) => {
    const benchmark = spyByDate.get(point.date);
    return benchmark == null ? [] : [{
      date: point.date,
      stock: point.price,
      spy: benchmark.price,
      stockSource: point.source,
      spySource: benchmark.source,
      // Both closes must have existed before the observation was issued.
      sessionClosedAt: Math.max(point.sessionClosedAt, benchmark.sessionClosedAt),
    }];
  });
  return { aligned, stock, spy };
}

/** Pick the latest aligned close that was already observable at issuance. */
export function selectLatestIssuanceEligibleSession(input: {
  stockBars: ResearchPriceBar[];
  spyBars: ResearchPriceBar[];
  issuedAt: number;
}): { sessionDate: string; sessionClosedAt: number } | null {
  if (!Number.isFinite(input.issuedAt) || input.issuedAt <= 0) return null;
  const { aligned } = alignBars(input.stockBars, input.spyBars);
  const eligible = aligned.filter((point) => point.sessionClosedAt <= input.issuedAt);
  const latest = eligible.at(-1);
  return latest ? { sessionDate: latest.date, sessionClosedAt: latest.sessionClosedAt } : null;
}

/** Exact prior observations for the next walk-forward cohort. */
export function historicalEventsFromPrivateSignals(
  records: PrivateSignalResearchRecord[],
): HistoricalSignalEvent[] {
  return records
    .flatMap((record) => record.entryBinding ? [{
      id: record.id,
      ticker: record.ticker,
      signalSessionDate: record.entryBinding.sessionDate,
      eventType: record.eventType,
      direction: record.direction,
      strength: record.strength,
      thesisSha256: record.thesisSha256.digest,
      issuedAt: record.issuedAt,
    }] : [])
    .sort((left, right) =>
      left.signalSessionDate.localeCompare(right.signalSessionDate) || left.id.localeCompare(right.id));
}

function covarianceBeta(stockReturns: number[], spyReturns: number[]): number | null {
  if (stockReturns.length !== spyReturns.length || stockReturns.length < 2) return null;
  const stockMean = stockReturns.reduce((sum, value) => sum + value, 0) / stockReturns.length;
  const spyMean = spyReturns.reduce((sum, value) => sum + value, 0) / spyReturns.length;
  let covariance = 0;
  let spyVariance = 0;
  for (let index = 0; index < stockReturns.length; index += 1) {
    covariance += (stockReturns[index] - stockMean) * (spyReturns[index] - spyMean);
    spyVariance += (spyReturns[index] - spyMean) ** 2;
  }
  if (spyVariance <= 0) return null;
  const beta = covariance / spyVariance;
  return Number.isFinite(beta) ? Math.max(-2, Math.min(6, beta)) : null;
}

function trailingBeta(
  aligned: AlignedPoint[],
  throughIndex: number,
  config: PrivateSignalCalibrationConfig,
): { beta: number; sessions: number } | null {
  const startIndex = Math.max(1, throughIndex - config.betaLookbackSessions + 1);
  const stockReturns: number[] = [];
  const spyReturns: number[] = [];
  for (let index = startIndex; index <= throughIndex; index += 1) {
    const stockReturn = aligned[index].stock / aligned[index - 1].stock - 1;
    const spyReturn = aligned[index].spy / aligned[index - 1].spy - 1;
    // Reject obvious stale/corporate-action defects from beta estimation only.
    if (
      !Number.isFinite(stockReturn) || !Number.isFinite(spyReturn) ||
      Math.abs(stockReturn) > 0.5 || Math.abs(spyReturn) > 0.25
    ) continue;
    stockReturns.push(stockReturn);
    spyReturns.push(spyReturn);
  }
  if (stockReturns.length < config.minimumBetaSessions) return null;
  const beta = covarianceBeta(stockReturns, spyReturns);
  return beta == null ? null : { beta, sessions: stockReturns.length };
}

function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function independentSamples(samples: HistoricalOutcomeSample[]): HistoricalOutcomeSample[] {
  const sorted = [...samples].sort((left, right) =>
    left.entryIndex - right.entryIndex || left.eventId.localeCompare(right.eventId));
  const selected: HistoricalOutcomeSample[] = [];
  let lastExitIndex = -1;
  for (const sample of sorted) {
    if (sample.entryIndex <= lastExitIndex) continue;
    selected.push(sample);
    lastExitIndex = sample.exitIndex;
  }
  return selected;
}

function validConfig(config: PrivateSignalCalibrationConfig): boolean {
  return Number.isInteger(config.betaLookbackSessions) && config.betaLookbackSessions >= 60 &&
    Number.isInteger(config.minimumBetaSessions) && config.minimumBetaSessions >= 40 &&
    config.minimumBetaSessions <= config.betaLookbackSessions &&
    Number.isInteger(config.minimumEffectiveSamples) && config.minimumEffectiveSamples >= 1 &&
    config.lowerQuantile >= 0 && config.lowerQuantile < 0.5 &&
    config.upperQuantile > 0.5 && config.upperQuantile <= 1;
}

function eligibleHistoricalEvents(
  events: HistoricalSignalEvent[],
  issueSessionDate: string,
  issuedAt: number,
): HistoricalSignalEvent[] {
  return events
    .filter((event) =>
      validSessionDate(event.signalSessionDate) &&
      event.signalSessionDate < issueSessionDate &&
      Number.isFinite(event.issuedAt) && event.issuedAt > 0 && event.issuedAt <= issuedAt)
    .sort((left, right) =>
      left.signalSessionDate.localeCompare(right.signalSessionDate) || left.id.localeCompare(right.id));
}

/**
 * Calibrate signed event outcomes with a rolling-origin walk-forward design.
 * Each historical beta is estimated before its own forward outcome; the
 * current event and every unresolved historical event are excluded.
 */
export function calibratePrivateSignal(input: {
  ticker: string;
  eventType: string;
  direction: PrivateSignalDirection;
  issueSessionDate: string;
  stockBars: ResearchPriceBar[];
  spyBars: ResearchPriceBar[];
  historicalEvents: HistoricalSignalEvent[];
  /** Excludes event records first observed after this immutable issuance. */
  issuedAt: number;
  config?: Partial<PrivateSignalCalibrationConfig>;
}): PrivateSignalCalibrationResult {
  const ticker = input.ticker.trim().toUpperCase();
  const eventType = normalizedEventType(input.eventType);
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  if (
    !validTicker(ticker) || !eventType || !validSessionDate(input.issueSessionDate) ||
    !Number.isFinite(input.issuedAt) || input.issuedAt <= 0 ||
    !["UP", "DOWN"].includes(input.direction) || !validConfig(config)
  ) return { ok: false, reason: "invalid-input" };

  const { aligned, stock, spy } = alignBars(input.stockBars, input.spyBars);
  const issueIndex = aligned.findIndex((point) => point.date === input.issueSessionDate);
  if (issueIndex < 0) return { ok: false, reason: "issue-session-not-aligned" };
  const currentBeta = trailingBeta(aligned, issueIndex, config);
  if (!currentBeta) return { ok: false, reason: "insufficient-beta-history" };

  const eligibleEvents = eligibleHistoricalEvents(
    input.historicalEvents,
    input.issueSessionDate,
    input.issuedAt,
  );
  const matched = eligibleEvents
    .filter((event) =>
      event.ticker.trim().toUpperCase() === ticker &&
      normalizedEventType(event.eventType) === eventType &&
      event.direction === input.direction)
    .sort((left, right) =>
      left.signalSessionDate.localeCompare(right.signalSessionDate) || left.id.localeCompare(right.id));
  const bySession = new Map<string, HistoricalSignalEvent>();
  for (const event of matched) {
    if (!bySession.has(event.signalSessionDate)) bySession.set(event.signalSessionDate, event);
  }
  const uniqueMatched = [...bySession.values()];
  const indexByDate = new Map(aligned.map((point, index) => [point.date, index]));
  const alignedEvents = uniqueMatched.flatMap((event) => {
    const entryIndex = indexByDate.get(event.signalSessionDate);
    return entryIndex == null ? [] : [{ event, entryIndex }];
  });

  const accounting: PrivateSignalSampleAccounting = {
    historicalEventsSeen: eligibleEvents.length,
    exactEventAndDirectionMatches: matched.length,
    uniqueMatchedSignalSessions: uniqueMatched.length,
    alignedMatchedSignalSessions: alignedEvents.length,
    horizons: {
      10: { resolvedBeforeIssue: 0, effectiveNonOverlapping: 0 },
      15: { resolvedBeforeIssue: 0, effectiveNonOverlapping: 0 },
    },
  };
  const bands = {} as Record<PrivateSignalHorizon, PrivateSignalHorizonBand>;

  for (const horizon of PRIVATE_SIGNAL_HORIZONS) {
    const samples: HistoricalOutcomeSample[] = [];
    for (const { event, entryIndex } of alignedEvents) {
      const exitIndex = entryIndex + horizon;
      // Strictly before the current signal entry prevents the current issue
      // session from leaking into an allegedly historical outcome.
      if (entryIndex >= issueIndex || exitIndex >= issueIndex) continue;
      const beta = trailingBeta(aligned, entryIndex, config);
      if (!beta) continue;
      const stockReturn = aligned[exitIndex].stock / aligned[entryIndex].stock - 1;
      const spyReturn = aligned[exitIndex].spy / aligned[entryIndex].spy - 1;
      const signedReturnPct = (stockReturn - beta.beta * spyReturn) * 100;
      if (!Number.isFinite(signedReturnPct) || Math.abs(signedReturnPct) > 100) continue;
      samples.push({ eventId: event.id, entryIndex, exitIndex, signedReturnPct });
    }
    const effective = independentSamples(samples);
    accounting.horizons[horizon] = {
      resolvedBeforeIssue: samples.length,
      effectiveNonOverlapping: effective.length,
    };
    if (effective.length < config.minimumEffectiveSamples) {
      return {
        ok: false,
        reason: "insufficient-effective-event-samples",
        sampleAccounting: accounting,
      };
    }
    const values = effective.map((sample) => sample.signedReturnPct);
    const predictedDirectionHits = values.filter((value) =>
      input.direction === "UP" ? value > 0 : value < 0).length;
    bands[horizon] = {
      horizonSessions: horizon,
      signedSpyRelativeReturnPct: {
        lower: round(quantile(values, config.lowerQuantile)),
        median: round(quantile(values, 0.5)),
        upper: round(quantile(values, config.upperQuantile)),
      },
      predictedDirectionHitRate: round(predictedDirectionHits / values.length),
      rawResolvedSamples: samples.length,
      deduplicatedSessionSamples: samples.length,
      effectiveNonOverlappingSamples: effective.length,
    };
  }

  const stockThroughIssue = stock.filter((point) => point.date <= input.issueSessionDate);
  const spyThroughIssue = spy.filter((point) => point.date <= input.issueSessionDate);
  const matchedForHash = uniqueMatched.map((event) => ({
    id: event.id,
    ticker: ticker,
    signalSessionDate: event.signalSessionDate,
    eventType,
    direction: event.direction,
    ...(event.strength ? { strength: event.strength } : {}),
    ...(event.thesisSha256 ? { thesisSha256: event.thesisSha256 } : {}),
    issuedAt: event.issuedAt,
  }));
  const previousSession = aligned[Math.max(0, issueIndex - 1)].date;
  return {
    ok: true,
    calibration: {
      methodVersion: PRIVATE_SIGNAL_METHOD_VERSION,
      eventTaxonomyVersion: PRIVATE_SIGNAL_EVENT_TAXONOMY_VERSION,
      semantics: {
        benchmark: "SPY",
        measure: "stock_total_return_minus_beta_times_spy_total_return",
        signPreserved: true,
        units: "percentage_points",
        directionConditioned: true,
        eventConditioned: true,
        magnitudeOnly: false,
      },
      condition: { eventType, direction: input.direction, fallbackToPooledEvents: false },
      walkForward: {
        scheme: "rolling-origin-event-walk-forward",
        noLookAhead: true,
        historicalBetaUsesOnlySessionsAtOrBeforeEvent: true,
        historicalOutcomeMustResolveBeforeCurrentIssue: true,
        overlappingOutcomeWindowsExcludedFromEffectiveSample: true,
        betaLookbackSessions: config.betaLookbackSessions,
        minimumBetaSessions: config.minimumBetaSessions,
        lowerQuantile: config.lowerQuantile,
        upperQuantile: config.upperQuantile,
        issueSessionDate: input.issueSessionDate,
        evaluationCutoffSession: previousSession,
      },
      currentBetaToSpy: round(currentBeta.beta, 6),
      currentBetaTrainingSessions: currentBeta.sessions,
      bands,
      sampleAccounting: accounting,
      dataHashes: {
        stockBarsThroughIssue: researchHash(stockThroughIssue.map(({ date, price }) => ({ date, price }))),
        spyBarsThroughIssue: researchHash(spyThroughIssue.map(({ date, price }) => ({ date, price }))),
        matchedHistoricalEvents: researchHash(matchedForHash),
        methodAndConfig: researchHash({
          methodVersion: PRIVATE_SIGNAL_METHOD_VERSION,
          eventTaxonomyVersion: PRIVATE_SIGNAL_EVENT_TAXONOMY_VERSION,
          config,
        }),
      },
      sources: {
        stock: [...new Set(stockThroughIssue.map((point) => point.source))].sort(),
        benchmark: [...new Set(spyThroughIssue.map((point) => point.source))].sort(),
      },
    },
  };
}

function immutableRecordBody(record: Omit<PrivateSignalResearchRecord,
  "id" | "entryStatus" | "entryPendingReason" | "entryBinding" |
  "issuanceBetaStatus" | "issuanceBeta" | "calibrationStatus" | "calibration" |
  "calibrationSha256" | "calibrationFailure" | "calibrationAttemptSha256" |
  "resolutionStatus" | "outcomes" | "immutableRecordSha256" |
  "tickerIssuedKey" | "resolutionQueueKey">): unknown {
  return {
    schemaVersion: record.schemaVersion,
    visibility: record.visibility,
    publicationStatus: record.publicationStatus,
    publicUseProhibited: record.publicUseProhibited,
    ticker: record.ticker,
    thesis: record.thesis,
    thesisSha256: record.thesisSha256,
    eventType: record.eventType,
    direction: record.direction,
    strength: record.strength,
    issuedAt: record.issuedAt,
    sourceArtifact: record.sourceArtifact,
    entryContract: record.entryContract,
  };
}

function emptyAccounting(historicalEventsSeen: number): PrivateSignalSampleAccounting {
  return {
    historicalEventsSeen,
    exactEventAndDirectionMatches: 0,
    uniqueMatchedSignalSessions: 0,
    alignedMatchedSignalSessions: 0,
    horizons: {
      10: { resolvedBeforeIssue: 0, effectiveNonOverlapping: 0 },
      15: { resolvedBeforeIssue: 0, effectiveNonOverlapping: 0 },
    },
  };
}

/**
 * Bind an append-only entry to its immutable issuance contract, then attempt
 * the beta/calibration using only information eligible at issuance. Repeated
 * calls never rewrite an existing binding, beta, calibrated band, or outcome.
 */
export function hydratePrivateSignalResearchRecord(input: {
  record: PrivateSignalResearchRecord;
  stockBars: ResearchPriceBar[];
  spyBars: ResearchPriceBar[];
  historicalEvents: HistoricalSignalEvent[];
  boundAt?: number;
  config?: Partial<PrivateSignalCalibrationConfig>;
}): PrivateSignalResearchRecord {
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  if (!validConfig(config)) return input.record;
  let record = input.record;
  const { aligned } = alignBars(input.stockBars, input.spyBars);

  if (!record.entryBinding) {
    // The contract deliberately does not guess a calendar date. When a full
    // aligned history arrives, choose the latest close whose observable time
    // was already at or before the immutable issuance cutoff. A later retry
    // can therefore bind Friday for a Tuesday premarket issue after a Monday
    // holiday, while Tuesday's eventual close remains forever ineligible.
    const candidate = aligned
      .filter((point) => point.sessionClosedAt <= record.entryContract.selectionCutoffAt)
      .at(-1);
    if (!candidate) {
      return {
        ...record,
        entryStatus: "pending",
        entryPendingReason: "no-aligned-close-observable-at-issuance",
        issuanceBetaStatus: "pending-entry",
        calibrationStatus: "pending-entry",
        calibrationFailure: { reason: "entry-pending" },
      };
    }
    const bindingBody = {
      sessionDate: candidate.date,
      sessionClosedAt: candidate.sessionClosedAt,
      boundAt: Math.max(
        record.issuedAt,
        Math.floor(
          typeof input.boundAt === "number" && Number.isFinite(input.boundAt)
            ? input.boundAt
            : Date.now(),
        ),
      ),
      stockAdjustedClose: round(candidate.stock, 6),
      spyAdjustedClose: round(candidate.spy, 6),
      stockSource: candidate.stockSource,
      spySource: candidate.spySource,
    };
    const { entryPendingReason: _pendingReason, ...withoutPendingReason } = record;
    void _pendingReason;
    record = {
      ...withoutPendingReason,
      entryStatus: "bound",
      entryBinding: {
        ...bindingBody,
        bindingSha256: researchHash({ signalId: record.id, ...bindingBody }),
      },
      issuanceBetaStatus: "unavailable",
      calibrationStatus: "unavailable",
      calibrationFailure: { reason: "insufficient-beta-history" },
    };
  }

  if (!record.entryBinding) return record;
  const issueSessionDate = record.entryBinding.sessionDate;
  const issueIndex = aligned.findIndex((point) => point.date === issueSessionDate);
  // A later retry may receive a temporarily incomplete provider generation.
  // Never downgrade already-appended state merely because that input omitted
  // the immutable entry session.
  if (issueIndex < 0) return record;

  // A binding can be persisted before a sufficiently long price history is
  // backfilled. Retrying may append the issuance beta, but never rewrites one.
  let issuanceBeta = record.issuanceBeta;
  if (!issuanceBeta) {
    const beta = issueIndex < 0 ? null : trailingBeta(aligned, issueIndex, config);
    if (!beta) {
      return {
        ...record,
        issuanceBetaStatus: "unavailable",
        calibrationStatus: "unavailable",
        calibrationFailure: { reason: "insufficient-beta-history" },
      };
    }
    const betaBody = {
      value: round(beta.beta, 6),
      trainingSessions: beta.sessions,
      issueSessionDate,
      methodVersion: PRIVATE_SIGNAL_METHOD_VERSION,
    };
    issuanceBeta = {
      value: betaBody.value,
      trainingSessions: betaBody.trainingSessions,
      betaSha256: researchHash({ signalId: record.id, ...betaBody }),
    };
    record = { ...record, issuanceBetaStatus: "available", issuanceBeta };
  }
  if (record.calibrationStatus === "calibrated" && record.calibration) return record;

  const eligibleEvents = eligibleHistoricalEvents(
    input.historicalEvents,
    issueSessionDate,
    record.issuedAt,
  );
  const calibrationResult = calibratePrivateSignal({
    ticker: record.ticker,
    eventType: record.eventType,
    direction: record.direction,
    issueSessionDate,
    stockBars: input.stockBars,
    spyBars: input.spyBars,
    historicalEvents: eligibleEvents,
    issuedAt: record.issuedAt,
    config,
  });
  const calibrationAttemptSha256 = researchHash({
    signalId: record.id,
    methodVersion: PRIVATE_SIGNAL_METHOD_VERSION,
    eventTaxonomyVersion: PRIVATE_SIGNAL_EVENT_TAXONOMY_VERSION,
    config,
    stockBarsThroughIssue: normalizeBars(input.stockBars)
      .filter((point) => point.date <= issueSessionDate)
      .map(({ date, price, sessionClosedAt }) => ({ date, price, sessionClosedAt })),
    spyBarsThroughIssue: normalizeBars(input.spyBars)
      .filter((point) => point.date <= issueSessionDate)
      .map(({ date, price, sessionClosedAt }) => ({ date, price, sessionClosedAt })),
    historicalEvents: eligibleEvents,
    result: calibrationResult,
  });
  if (calibrationResult.ok) {
    const calibration: PrivateSignalCalibration = {
      ...calibrationResult.calibration,
      currentBetaToSpy: issuanceBeta.value,
      currentBetaTrainingSessions: issuanceBeta.trainingSessions,
    };
    const { calibrationFailure: _calibrationFailure, ...withoutCalibrationFailure } = record;
    void _calibrationFailure;
    return {
      ...withoutCalibrationFailure,
      issuanceBetaStatus: "available",
      issuanceBeta,
      calibrationStatus: "calibrated",
      calibration,
      calibrationSha256: researchHash({
        signalId: record.id,
        calibration,
        calibrationAttemptSha256,
      }),
      calibrationAttemptSha256,
    };
  }
  return {
    ...record,
    issuanceBetaStatus: "available",
    issuanceBeta,
    calibrationStatus: calibrationResult.reason === "insufficient-effective-event-samples"
      ? "insufficient-sample"
      : "unavailable",
    calibrationFailure: calibrationResult.reason === "insufficient-effective-event-samples"
      ? {
          reason: "insufficient-effective-event-samples",
          sampleAccounting: calibrationResult.sampleAccounting ?? emptyAccounting(eligibleEvents.length),
        }
      : { reason: "insufficient-beta-history" },
    calibrationAttemptSha256,
  };
}

/** Create the immutable private log entry for one exact thesis, even cold. */
export function createPrivateSignalResearchRecord(input: {
  ticker: string;
  thesis: string;
  eventType: string;
  direction: PrivateSignalDirection;
  strength: PrivateSignalStrength;
  issuedAt: number;
  sourceArtifact: PrivateSignalSourceArtifact;
  stockBars: ResearchPriceBar[];
  spyBars: ResearchPriceBar[];
  historicalEvents: HistoricalSignalEvent[];
  config?: Partial<PrivateSignalCalibrationConfig>;
}): CreatePrivateSignalResult {
  const ticker = input.ticker.trim().toUpperCase();
  const thesis = input.thesis.trim();
  const eventType = normalizedEventType(input.eventType);
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const issuedAt = Math.floor(input.issuedAt);
  const issuanceEtDate = newYorkDateAt(issuedAt);
  if (
    !validTicker(ticker) || thesis.length < 20 || !eventType ||
    !Number.isFinite(input.issuedAt) || input.issuedAt <= 0 || !issuanceEtDate ||
    !Number.isInteger(input.sourceArtifact?.dossierArtifactVersion) ||
    input.sourceArtifact.dossierArtifactVersion <= 0 ||
    !validSessionDate(input.sourceArtifact.dossierDate) ||
    input.sourceArtifact.dossierDate > issuanceEtDate ||
    !input.sourceArtifact.councilRunId.trim() ||
    !input.sourceArtifact.briefAuditId.trim() ||
    !validResearchHash(input.sourceArtifact.emailHookSha256) ||
    !["UP", "DOWN"].includes(input.direction) ||
    !["GENTLE", "MODERATE", "STRONG"].includes(input.strength) ||
    !validConfig(config)
  ) return { ok: false, reason: "invalid-input" };
  const thesisSha256 = researchHash(thesis);
  const immutableBase = {
    schemaVersion: PRIVATE_SIGNAL_SCHEMA_VERSION,
    visibility: "private-research-only" as const,
    publicationStatus: "withheld-pending-track-record-and-legal-review" as const,
    publicUseProhibited: true as const,
    ticker,
    thesis,
    thesisSha256,
    eventType,
    direction: input.direction,
    strength: input.strength,
    issuedAt,
    sourceArtifact: {
      dossierArtifactVersion: input.sourceArtifact.dossierArtifactVersion,
      dossierDate: input.sourceArtifact.dossierDate,
      councilRunId: input.sourceArtifact.councilRunId.trim(),
      briefAuditId: input.sourceArtifact.briefAuditId.trim(),
      emailHookSha256: input.sourceArtifact.emailHookSha256,
    },
    entryContract: {
      market: "US-equities" as const,
      selectionRule: "latest-aligned-close-observable-at-issuance" as const,
      selectionCutoffAt: issuedAt,
      closeRule: "explicit-or-conservative-1600-america-new-york" as const,
      sessionCloseMustNotExceedIssuedAt: true as const,
    },
  };
  const immutableRecordSha256 = researchHash(immutableRecordBody(immutableBase));
  const id = immutableRecordSha256.digest.slice(0, 48);
  const pending: PrivateSignalResearchRecord = {
    id,
    ...immutableBase,
    entryStatus: "pending",
    entryPendingReason: "no-aligned-close-observable-at-issuance",
    issuanceBetaStatus: "pending-entry",
    calibrationStatus: "pending-entry",
    calibrationFailure: { reason: "entry-pending" },
    resolutionStatus: "pending",
    outcomes: {},
    immutableRecordSha256,
    tickerIssuedKey: privateSignalTickerIssuedKey(ticker, issuedAt, id),
    resolutionQueueKey: privateSignalResolutionQueueKey(issuedAt, id),
  };
  return {
    ok: true,
    record: hydratePrivateSignalResearchRecord({
      record: pending,
      stockBars: input.stockBars,
      spyBars: input.spyBars,
      historicalEvents: input.historicalEvents,
      boundAt: input.issuedAt,
      config,
    }),
  };
}

/**
 * Resolve any newly available 10/15-session outcomes. The issuance-time beta
 * is frozen, so later methodology changes cannot rewrite observed performance.
 */
export function resolvePrivateSignalOutcomes(
  record: PrivateSignalResearchRecord,
  stockBars: ResearchPriceBar[],
  spyBars: ResearchPriceBar[],
  resolvedAt = Date.now(),
): PrivateSignalResearchRecord {
  if (
    record.schemaVersion !== PRIVATE_SIGNAL_SCHEMA_VERSION ||
    record.entryStatus !== "bound" || !record.entryBinding ||
    record.issuanceBetaStatus !== "available" || !record.issuanceBeta
  ) return record;
  const { aligned } = alignBars(stockBars, spyBars);
  const entryIndex = aligned.findIndex((point) => point.date === record.entryBinding!.sessionDate);
  if (entryIndex < 0) return record;
  const entry = aligned[entryIndex];
  // Adjusted-price vendors legitimately rewrite the historical entry basis
  // after a split or dividend. Resolve on one contemporaneous adjusted series,
  // but preserve the difference from the issuance snapshot in the audit.
  const stockBasisRevisionPct =
    (entry.stock / record.entryBinding.stockAdjustedClose - 1) * 100;
  const spyBasisRevisionPct =
    (entry.spy / record.entryBinding.spyAdjustedClose - 1) * 100;

  const outcomes = { ...record.outcomes };
  for (const horizon of PRIVATE_SIGNAL_HORIZONS) {
    if (outcomes[horizon]) continue;
    const exit = aligned[entryIndex + horizon];
    // Possessing a future-dated bar is not enough: its close must have become
    // observable by this resolution pass.
    if (!exit || exit.sessionClosedAt > resolvedAt) continue;
    const stockTotalReturnPct = (exit.stock / entry.stock - 1) * 100;
    const spyTotalReturnPct = (exit.spy / entry.spy - 1) * 100;
    const signedSpyRelativeReturnPct =
      stockTotalReturnPct - record.issuanceBeta.value * spyTotalReturnPct;
    const directionAdjustedReturnPct = record.direction === "UP"
      ? signedSpyRelativeReturnPct
      : -signedSpyRelativeReturnPct;
    const calibratedBand = record.calibration?.bands[horizon].signedSpyRelativeReturnPct;
    const outcomeBody = {
      resolutionVersion: PRIVATE_SIGNAL_RESOLUTION_VERSION,
      horizonSessions: horizon,
      entrySessionDate: record.entryBinding.sessionDate,
      exitSessionDate: exit.date,
      entryStockAdjustedClose: round(entry.stock, 6),
      exitStockAdjustedClose: round(exit.stock, 6),
      entrySpyAdjustedClose: round(entry.spy, 6),
      exitSpyAdjustedClose: round(exit.spy, 6),
      entryBasisRevision: {
        stockPct: round(stockBasisRevisionPct),
        spyPct: round(spyBasisRevisionPct),
        changed: Math.abs(stockBasisRevisionPct) > 0.0001 || Math.abs(spyBasisRevisionPct) > 0.0001,
      },
      stockTotalReturnPct: round(stockTotalReturnPct),
      spyTotalReturnPct: round(spyTotalReturnPct),
      signedSpyRelativeReturnPct: round(signedSpyRelativeReturnPct),
      directionAdjustedReturnPct: round(directionAdjustedReturnPct),
      predictedDirectionCorrect: directionAdjustedReturnPct > 0,
      insideCalibratedBand: calibratedBand
        ? signedSpyRelativeReturnPct >= calibratedBand.lower &&
          signedSpyRelativeReturnPct <= calibratedBand.upper
        : null,
      resolvedAt,
      sourceBarsSha256: researchHash({
        stock: [
          { date: entry.date, price: entry.stock },
          { date: exit.date, price: exit.stock },
        ],
        spy: [
          { date: entry.date, price: entry.spy },
          { date: exit.date, price: exit.spy },
        ],
        sources: {
          stock: [entry.stockSource, exit.stockSource],
          spy: [entry.spySource, exit.spySource],
        },
      }),
    };
    outcomes[horizon] = {
      ...outcomeBody,
      outcomeSha256: researchHash({ signalId: record.id, ...outcomeBody }),
    };
  }
  const resolvedCount = PRIVATE_SIGNAL_HORIZONS.filter((horizon) => outcomes[horizon]).length;
  const resolutionStatus = resolvedCount === 0 ? "pending" : resolvedCount === 2 ? "complete" : "partial";
  if (resolutionStatus === "complete") {
    const { resolutionQueueKey: _resolutionQueueKey, ...withoutQueueKey } = record;
    void _resolutionQueueKey;
    return {
      ...withoutQueueKey,
      outcomes,
      resolutionStatus,
    };
  }
  return {
    ...record,
    outcomes,
    resolutionStatus,
    resolutionQueueKey: privateSignalResolutionQueueKey(record.issuedAt, record.id),
  };
}

export type PrivateSignalIntegrityResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Recompute every append-only hash; never trust a stored digest by itself. */
export function verifyPrivateSignalRecordIntegrity(
  record: PrivateSignalResearchRecord,
): PrivateSignalIntegrityResult {
  const issuanceEtDate = newYorkDateAt(record.issuedAt);
  if (record.schemaVersion !== PRIVATE_SIGNAL_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported-schema" };
  }
  if (
    record.visibility !== "private-research-only" ||
    record.publicationStatus !== "withheld-pending-track-record-and-legal-review" ||
    record.publicUseProhibited !== true || !validTicker(record.ticker) ||
    !normalizedEventType(record.eventType) || normalizedEventType(record.eventType) !== record.eventType ||
    !["UP", "DOWN"].includes(record.direction) ||
    !["GENTLE", "MODERATE", "STRONG"].includes(record.strength)
  ) return { ok: false, reason: "record-policy-invalid" };
  if (!sameResearchHash(record.thesisSha256, researchHash(record.thesis))) {
    return { ok: false, reason: "thesis-hash-mismatch" };
  }
  if (!validResearchHash(record.sourceArtifact?.emailHookSha256)) {
    return { ok: false, reason: "source-artifact-hash-invalid" };
  }
  if (
    !Number.isInteger(record.sourceArtifact.dossierArtifactVersion) ||
    record.sourceArtifact.dossierArtifactVersion <= 0 ||
    !validSessionDate(record.sourceArtifact.dossierDate) ||
    !issuanceEtDate || record.sourceArtifact.dossierDate > issuanceEtDate ||
    !record.sourceArtifact.councilRunId || !record.sourceArtifact.briefAuditId
  ) return { ok: false, reason: "source-artifact-invalid" };
  if (
    record.entryContract.market !== "US-equities" ||
    record.entryContract.selectionRule !== "latest-aligned-close-observable-at-issuance" ||
    record.entryContract.selectionCutoffAt !== record.issuedAt ||
    record.entryContract.closeRule !== "explicit-or-conservative-1600-america-new-york" ||
    record.entryContract.sessionCloseMustNotExceedIssuedAt !== true ||
    !Number.isInteger(record.issuedAt) || record.issuedAt <= 0
  ) return { ok: false, reason: "entry-contract-invalid" };
  const immutableHash = researchHash(immutableRecordBody(record));
  if (!sameResearchHash(record.immutableRecordSha256, immutableHash)) {
    return { ok: false, reason: "immutable-record-hash-mismatch" };
  }
  if (record.id !== immutableHash.digest.slice(0, 48)) {
    return { ok: false, reason: "content-address-id-mismatch" };
  }
  if (record.tickerIssuedKey !== privateSignalTickerIssuedKey(record.ticker, record.issuedAt, record.id)) {
    return { ok: false, reason: "ticker-issued-key-mismatch" };
  }
  const expectedQueueKey = privateSignalResolutionQueueKey(record.issuedAt, record.id);
  if (
    (record.resolutionStatus === "complete" && record.resolutionQueueKey !== undefined) ||
    (record.resolutionStatus !== "complete" && record.resolutionQueueKey !== expectedQueueKey)
  ) return { ok: false, reason: "resolution-queue-key-mismatch" };
  if (record.entryStatus === "bound") {
    if (!record.entryBinding) return { ok: false, reason: "bound-entry-missing" };
    if (
      !validSessionDate(record.entryBinding.sessionDate) ||
      !Number.isFinite(record.entryBinding.sessionClosedAt) ||
      record.entryBinding.sessionClosedAt <= 0 ||
      record.entryBinding.sessionClosedAt > record.issuedAt ||
      !Number.isFinite(record.entryBinding.boundAt) ||
      record.entryBinding.boundAt < record.issuedAt ||
      !Number.isFinite(record.entryBinding.stockAdjustedClose) ||
      record.entryBinding.stockAdjustedClose <= 0 ||
      !Number.isFinite(record.entryBinding.spyAdjustedClose) ||
      record.entryBinding.spyAdjustedClose <= 0
    ) return { ok: false, reason: "entry-look-ahead" };
    const { bindingSha256: _bindingHash, ...bindingBody } = record.entryBinding;
    void _bindingHash;
    if (!sameResearchHash(
      record.entryBinding.bindingSha256,
      researchHash({ signalId: record.id, ...bindingBody }),
    )) return { ok: false, reason: "entry-binding-hash-mismatch" };
    if (record.entryPendingReason !== undefined) {
      return { ok: false, reason: "bound-entry-has-pending-reason" };
    }
  } else if (record.entryBinding) {
    return { ok: false, reason: "pending-entry-has-binding" };
  } else if (record.entryPendingReason !== "no-aligned-close-observable-at-issuance") {
    return { ok: false, reason: "pending-entry-reason-invalid" };
  }
  if (record.issuanceBetaStatus === "available") {
    if (!record.issuanceBeta || !record.entryBinding) {
      return { ok: false, reason: "available-beta-missing" };
    }
    const expectedBetaHash = researchHash({
      signalId: record.id,
      value: record.issuanceBeta.value,
      trainingSessions: record.issuanceBeta.trainingSessions,
      issueSessionDate: record.entryBinding?.sessionDate,
      methodVersion: PRIVATE_SIGNAL_METHOD_VERSION,
    });
    if (!sameResearchHash(record.issuanceBeta.betaSha256, expectedBetaHash)) {
      return { ok: false, reason: "issuance-beta-hash-mismatch" };
    }
  } else if (record.issuanceBeta) {
    return { ok: false, reason: "unavailable-beta-has-value" };
  }
  if (record.calibrationStatus === "calibrated") {
    if (!record.calibration || !record.calibrationSha256 || !record.calibrationAttemptSha256) {
      return { ok: false, reason: "calibration-missing" };
    }
    if (!sameResearchHash(
      record.calibrationSha256,
      researchHash({
        signalId: record.id,
        calibration: record.calibration,
        calibrationAttemptSha256: record.calibrationAttemptSha256,
      }),
    )) return { ok: false, reason: "calibration-hash-mismatch" };
  } else if (record.calibration || record.calibrationSha256) {
    return { ok: false, reason: "unavailable-calibration-has-band" };
  }
  if (
    record.calibrationAttemptSha256 && !validResearchHash(record.calibrationAttemptSha256)
  ) return { ok: false, reason: "calibration-attempt-hash-invalid" };
  if (
    record.calibrationStatus === "insufficient-sample" && !record.calibrationAttemptSha256
  ) return { ok: false, reason: "calibration-attempt-missing" };
  for (const horizon of PRIVATE_SIGNAL_HORIZONS) {
    const outcome = record.outcomes[horizon];
    if (!outcome) continue;
    const { outcomeSha256: _outcomeHash, ...outcomeBody } = outcome;
    void _outcomeHash;
    if (!validResearchHash(outcome.sourceBarsSha256) || !sameResearchHash(
      outcome.outcomeSha256,
      researchHash({ signalId: record.id, ...outcomeBody }),
    )) return { ok: false, reason: `outcome-${horizon}-hash-mismatch` };
    if (!record.entryBinding || outcome.entrySessionDate !== record.entryBinding.sessionDate ||
        outcome.horizonSessions !== horizon) {
      return { ok: false, reason: `outcome-${horizon}-entry-mismatch` };
    }
  }
  const settled = PRIVATE_SIGNAL_HORIZONS.filter((horizon) => record.outcomes[horizon]).length;
  const expectedStatus = settled === 0 ? "pending" : settled === 2 ? "complete" : "partial";
  if (record.resolutionStatus !== expectedStatus) {
    return { ok: false, reason: "resolution-status-mismatch" };
  }
  return { ok: true };
}
