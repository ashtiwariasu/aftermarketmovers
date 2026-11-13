/**
 * Client-safe, deterministic projection of a published qualitative signal onto
 * subsequent adjusted-close observations.
 *
 * This module deliberately has no datastore, model, or private-research
 * dependencies. It only consumes the already-published signal and daily bars.
 */

export type SignalTrackDirection = "UP" | "DOWN";
export type SignalTrackStrength = "GENTLE" | "MODERATE" | "STRONG";

export type SignalTrackBand =
  | "STRONG_DOWNSIDE"
  | "GENTLE_DOWNSIDE"
  | "NEUTRAL"
  | "GENTLE_UPSIDE"
  | "STRONG_UPSIDE";

export type SignalTrackStatus = "incomplete" | "provisional" | "final";
export type SignalTrackAlignment = "SUPPORTS" | "OPPOSES" | "NEUTRAL";

export interface SignalTrackBar {
  /** Exchange-local calendar date, YYYY-MM-DD. */
  date: string;
  close?: number | null;
  /** Preferred over close when supplied. */
  adjustedClose?: number | null;
  /**
   * Epoch milliseconds when this session close became observable. When absent,
   * the conservative fallback is 4:00 PM America/New_York on `date`.
   */
  sessionClosedAt?: number;
  /** Explicitly false bars are ignored as incomplete. */
  complete?: boolean;
}

export interface SignalTrackInput {
  direction: SignalTrackDirection;
  strength: SignalTrackStrength;
  horizon: {
    min: number;
    max: number;
  };
  /** Exchange-local issue date, YYYY-MM-DD. */
  issueDate: string;
  /** Immutable publication timestamp used to freeze the observable baseline. */
  generatedAt: number;
  bars: readonly SignalTrackBar[];
}

export interface SignalTrackObservation {
  date: string;
  adjustedClose: number;
}

export interface SignalTrackMove {
  cumulativeReturn: number;
  cumulativeReturnPct: number;
  logReturn: number;
}

export interface SignalTrackPoint extends SignalTrackMove {
  date: string;
  session: number;
  adjustedClose: number;
  zScore: number;
  score: number;
  band: SignalTrackBand;
}

export interface SignalTrackProjection {
  direction: SignalTrackDirection;
  strength: SignalTrackStrength;
  issueDate: string;
  generatedAt: number;
  horizon: {
    min: number;
    max: number;
  };
  status: SignalTrackStatus;
  incompleteReason: "missing_start_bar" | null;
  forecastScore: number;
  volatility: number;
  volatilityObservationCount: number;
  start: SignalTrackObservation | null;
  last: SignalTrackObservation | null;
  move: SignalTrackMove | null;
  sessionCount: number;
  points: SignalTrackPoint[];
  actualScore: number | null;
  actualBand: SignalTrackBand | null;
  alignment: SignalTrackAlignment | null;
}

export type PublicSignalTrackState =
  | "INCOMPLETE"
  | "AWAITING_FIRST_CLOSE"
  | "TRACKING"
  | "REVIEW_WINDOW"
  | "FINAL";

export interface PublicSignalTrackPoint {
  date: string;
  session: number;
  /** Public market-data receipt, expressed from the frozen publication close. */
  cumulativeReturnPct: number;
  /** Horizontal chart coordinate on a 0..100 display scale. */
  xPercent: number;
  /** Vertical chart coordinate on a 0..100 display scale. */
  yPercent: number;
}

/**
 * The complete client boundary for the signal track. It contains display
 * descriptions, public percentage movement and normalized coordinates only—
 * never prices, publication timestamps, volatility inputs, scores, model
 * internals, or research verdicts.
 */
export interface PublicSignalTrackView {
  direction: SignalTrackDirection;
  strength: SignalTrackStrength;
  issueDate: string;
  horizon: {
    min: number;
    max: number;
  };
  state: PublicSignalTrackState;
  forecastYPercent: number;
  sessionCount: number;
  observedMovePct: number | null;
  asOfDate: string | null;
  points: PublicSignalTrackPoint[];
}

const MIN_DAILY_VOLATILITY = 0.005;
const MAX_VOLATILITY_RETURNS = 20;
const NEW_YORK_CLOSE_HOURS_UTC = [20, 21] as const;

interface TimedSignalTrackObservation extends SignalTrackObservation {
  sessionClosedAt: number;
}

function assertInput(input: SignalTrackInput): void {
  if (!isCalendarDate(input.issueDate)) {
    throw new Error("issueDate must be a valid YYYY-MM-DD calendar date");
  }
  if (!Number.isFinite(input.generatedAt)) {
    throw new Error("generatedAt must be a finite timestamp");
  }
  if (
    !Number.isInteger(input.horizon.min) ||
    !Number.isInteger(input.horizon.max) ||
    input.horizon.min < 1 ||
    input.horizon.max < input.horizon.min
  ) {
    throw new Error("horizon must contain positive integer min/max values");
  }
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function barPrice(bar: SignalTrackBar): number | null {
  if (bar.complete === false) return null;
  const value = bar.adjustedClose ?? bar.close;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

const newYorkDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function localParts(timestamp: number): Record<string, string> {
  return Object.fromEntries(
    newYorkDateTime
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/**
 * Daily bars do not carry an availability timestamp today. Trying both valid
 * New York UTC offsets avoids host-timezone assumptions and handles DST. The
 * 4 PM fallback is deliberately later than early-market closes, so a close is
 * never treated as observable prematurely.
 */
function fallbackSessionClosedAt(date: string): number {
  const [year, month, day] = date.split("-").map(Number);

  for (const utcHour of NEW_YORK_CLOSE_HOURS_UTC) {
    const candidate = Date.UTC(year, month - 1, day, utcHour);
    const parts = localParts(candidate);
    if (
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      Number(parts.hour) === 16
    ) {
      return candidate;
    }
  }

  throw new Error(`Could not resolve New York session close for ${date}`);
}

function barSessionClosedAt(bar: SignalTrackBar): number {
  return typeof bar.sessionClosedAt === "number" &&
    Number.isFinite(bar.sessionClosedAt)
    ? bar.sessionClosedAt
    : fallbackSessionClosedAt(bar.date);
}

function normalizedBars(
  bars: readonly SignalTrackBar[],
): TimedSignalTrackObservation[] {
  const byDate = new Map<string, TimedSignalTrackObservation>();

  for (const bar of bars) {
    if (!isCalendarDate(bar.date)) continue;
    const adjustedClose = barPrice(bar);
    if (adjustedClose === null) continue;
    byDate.set(bar.date, {
      date: bar.date,
      adjustedClose,
      sessionClosedAt: barSessionClosedAt(bar),
    });
  }

  return [...byDate.values()].sort(
    (left, right) =>
      left.sessionClosedAt - right.sessionClosedAt ||
      left.date.localeCompare(right.date),
  );
}

function sampleVolatility(prices: readonly number[]): {
  volatility: number;
  observationCount: number;
} {
  const returns: number[] = [];
  const firstPriceIndex = Math.max(
    0,
    prices.length - (MAX_VOLATILITY_RETURNS + 1),
  );

  for (let index = firstPriceIndex + 1; index < prices.length; index += 1) {
    returns.push(Math.log(prices[index] / prices[index - 1]));
  }

  if (returns.length < 2) {
    return {
      volatility: MIN_DAILY_VOLATILITY,
      observationCount: returns.length,
    };
  }

  const mean =
    returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance =
    returns.reduce((total, value) => total + (value - mean) ** 2, 0) /
    (returns.length - 1);

  return {
    volatility: Math.max(Math.sqrt(variance), MIN_DAILY_VOLATILITY),
    observationCount: returns.length,
  };
}

/**
 * Converts a standardized move to a continuous five-band score.
 *
 * Neutral occupies -0.25σ..+0.25σ and maps to -0.5..+0.5. Gentle
 * occupies 0.25σ..1σ and maps to 0.5..1.5 on either side. Strong starts
 * at 1σ and approaches the score cap of 2 at 2σ.
 */
export function signalTrackScore(zScore: number): number {
  if (!Number.isFinite(zScore) || zScore === 0) return 0;

  const sign = Math.sign(zScore);
  const magnitude = Math.abs(zScore);
  let scoreMagnitude: number;

  if (magnitude <= 0.25) {
    scoreMagnitude = magnitude * 2;
  } else if (magnitude < 1) {
    scoreMagnitude = 0.5 + (magnitude - 0.25) / 0.75;
  } else {
    scoreMagnitude = Math.min(2, 1.5 + (magnitude - 1) * 0.5);
  }

  return sign * scoreMagnitude;
}

function bandFromZScore(zScore: number): SignalTrackBand {
  const magnitude = Math.abs(zScore);
  if (magnitude <= 0.25) return "NEUTRAL";
  if (zScore <= -1) return "STRONG_DOWNSIDE";
  if (zScore < -0.25) return "GENTLE_DOWNSIDE";
  if (zScore >= 1) return "STRONG_UPSIDE";
  return "GENTLE_UPSIDE";
}

function bandFromAverageScore(score: number): SignalTrackBand {
  const magnitude = Math.abs(score);
  if (magnitude <= 0.5) return "NEUTRAL";
  if (score <= -1.5) return "STRONG_DOWNSIDE";
  if (score < -0.5) return "GENTLE_DOWNSIDE";
  if (score >= 1.5) return "STRONG_UPSIDE";
  return "GENTLE_UPSIDE";
}

function publishedScore(
  direction: SignalTrackDirection,
  strength: SignalTrackStrength,
): number {
  const magnitude =
    strength === "GENTLE" ? 1 : strength === "MODERATE" ? 1.5 : 2;
  return direction === "UP" ? magnitude : -magnitude;
}

function alignmentFor(
  direction: SignalTrackDirection,
  band: SignalTrackBand,
): SignalTrackAlignment {
  if (band === "NEUTRAL") return "NEUTRAL";
  const actualDirection = band.endsWith("UPSIDE") ? "UP" : "DOWN";
  return actualDirection === direction ? "SUPPORTS" : "OPPOSES";
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Projects one already-published signal against the available subsequent bars.
 *
 * The entry price and volatility packet are frozen at the last close observable
 * at publication. Later closes become sessions 1..max; calendar weekends and
 * holidays do not consume a session.
 */
export function projectSignalTrack(
  input: SignalTrackInput,
): SignalTrackProjection {
  assertInput(input);

  const bars = normalizedBars(input.bars);
  const history = bars.filter(
    (bar) => bar.sessionClosedAt <= input.generatedAt,
  );
  const start = history.at(-1) ?? null;
  const { volatility, observationCount } = sampleVolatility(
    history.map((bar) => bar.adjustedClose),
  );
  const forecastScore = publishedScore(input.direction, input.strength);

  if (!start) {
    return {
      direction: input.direction,
      strength: input.strength,
      issueDate: input.issueDate,
      generatedAt: input.generatedAt,
      horizon: { ...input.horizon },
      status: "incomplete",
      incompleteReason: "missing_start_bar",
      forecastScore,
      volatility,
      volatilityObservationCount: observationCount,
      start: null,
      last: null,
      move: null,
      sessionCount: 0,
      points: [],
      actualScore: null,
      actualBand: null,
      alignment: null,
    };
  }

  const observedBars = bars
    .filter((bar) => bar.sessionClosedAt > input.generatedAt)
    .slice(0, input.horizon.max);

  const points = observedBars.map<SignalTrackPoint>((bar, index) => {
    const session = index + 1;
    const logReturn = Math.log(bar.adjustedClose / start.adjustedClose);
    const cumulativeReturn = bar.adjustedClose / start.adjustedClose - 1;
    const zScore = logReturn / (volatility * Math.sqrt(session));

    return {
      date: bar.date,
      session,
      adjustedClose: bar.adjustedClose,
      cumulativeReturn,
      cumulativeReturnPct: cumulativeReturn * 100,
      logReturn,
      zScore,
      score: signalTrackScore(zScore),
      band: bandFromZScore(zScore),
    };
  });

  const lastPoint = points.at(-1) ?? null;
  const status: SignalTrackStatus =
    points.length >= input.horizon.max ? "final" : "provisional";
  const finalScores = points
    .filter(
      (point) =>
        point.session >= input.horizon.min &&
        point.session <= input.horizon.max,
    )
    .map((point) => point.score);
  const actualScore =
    status === "final"
      ? average(finalScores)
      : lastPoint
        ? lastPoint.score
        : null;
  const actualBand =
    actualScore === null
      ? null
      : status === "final"
        ? bandFromAverageScore(actualScore)
        : lastPoint?.band ?? null;

  return {
    direction: input.direction,
    strength: input.strength,
    issueDate: input.issueDate,
    generatedAt: input.generatedAt,
    horizon: { ...input.horizon },
    status,
    incompleteReason: null,
    forecastScore,
    volatility,
    volatilityObservationCount: observationCount,
    start: {
      date: start.date,
      adjustedClose: start.adjustedClose,
    },
    last: lastPoint
      ? {
          date: lastPoint.date,
          adjustedClose: lastPoint.adjustedClose,
        }
      : {
          date: start.date,
          adjustedClose: start.adjustedClose,
        },
    move: lastPoint
      ? {
          cumulativeReturn: lastPoint.cumulativeReturn,
          cumulativeReturnPct: lastPoint.cumulativeReturnPct,
          logReturn: lastPoint.logReturn,
        }
      : {
          cumulativeReturn: 0,
          cumulativeReturnPct: 0,
          logReturn: 0,
        },
    sessionCount: points.length,
    points,
    actualScore,
    actualBand,
    alignment:
      actualBand === null ? null : alignmentFor(input.direction, actualBand),
  };
}

function publicState(
  projection: SignalTrackProjection,
): PublicSignalTrackState {
  if (projection.status === "incomplete") return "INCOMPLETE";
  if (projection.status === "final") return "FINAL";
  if (projection.sessionCount === 0) return "AWAITING_FIRST_CLOSE";
  if (projection.sessionCount >= projection.horizon.min) return "REVIEW_WINDOW";
  return "TRACKING";
}

/**
 * Strips the internal research/outcome packet down to the exact display DTO.
 * Keep this explicit rather than spreading the projection: newly added
 * internals must never cross the client boundary by accident.
 */
export function toPublicSignalTrackView(
  projection: SignalTrackProjection,
): PublicSignalTrackView {
  return {
    direction: projection.direction,
    strength: projection.strength,
    issueDate: projection.issueDate,
    horizon: { ...projection.horizon },
    state: publicState(projection),
    forecastYPercent:
      50 - Math.max(-2, Math.min(2, projection.forecastScore)) * 20,
    sessionCount: projection.sessionCount,
    observedMovePct:
      projection.sessionCount > 0
        ? projection.move?.cumulativeReturnPct ?? null
        : null,
    asOfDate: projection.points.at(-1)?.date ?? null,
    points: projection.points.map((point) => ({
      date: point.date,
      session: point.session,
      cumulativeReturnPct: point.cumulativeReturnPct,
      xPercent: (point.session / projection.horizon.max) * 100,
      yPercent: 50 - Math.max(-2, Math.min(2, point.score)) * 20,
    })),
  };
}
