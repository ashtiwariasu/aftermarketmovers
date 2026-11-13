import type { DossierQualitativeSignal, DossierPriorStatus, DossierThesisObservationStatus } from "@/lib/dossier";
import type { SecFiling } from "@/lib/sec";

export type ThesisMovementStatus = DossierThesisObservationStatus | DossierPriorStatus;

export interface ThesisMovementObservation {
  schemaVersion: 1;
  date: string;
  observedAt: number;
  index: number;
  status: ThesisMovementStatus;
  /**
   * AMM's qualitative five-point scale:
   * -2 strong downside, -1 gentle downside, 0 neutral,
   * +1 gentle upside, +2 strong upside.
   *
   * Legacy MODERATE artifacts are conservatively folded into GENTLE when
   * they enter this public time series. There are no hidden half-stops.
   */
  score: number;
  support: number;
  oppose: number;
  uncertain: number;
  unavailable: number;
  auditId?: string;
}

export interface ThesisMovementWindow {
  startDate: string;
  startLabel: string;
  endDate: string;
  endLabel: string;
}

export interface ThesisMovementView {
  observations: ThesisMovementObservation[];
  window: ThesisMovementWindow;
  currentScore: number;
  currentLabel: string;
  currentSupport: number;
  currentTotal: number;
}

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shortDate(value: string): string {
  if (!validDate(value)) return value.toUpperCase();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`)).toUpperCase();
}

export function signalScore(signal: Pick<DossierQualitativeSignal, "direction" | "strength">): number {
  const magnitude = signal.strength === "STRONG" ? 2 : 1;
  return signal.direction === "UP" ? magnitude : -magnitude;
}

export function fivePointThesisScore(score: number): number {
  const bounded = Math.max(-2, Math.min(2, score));
  if (bounded >= 1.75) return 2;
  if (bounded > 0.25) return 1;
  if (bounded <= -1.75) return -2;
  if (bounded < -0.25) return -1;
  return 0;
}

export function shiftedThesisScore(score: number, status: ThesisMovementStatus): number {
  const bounded = fivePointThesisScore(score);
  if (status === "strengthened") {
    if (bounded > 0) return Math.min(2, bounded + 1);
    if (bounded < 0) return Math.max(-2, bounded - 1);
  }
  if (status === "weakened") {
    if (bounded > 0) return Math.max(0, bounded - 1);
    if (bounded < 0) return Math.min(0, bounded + 1);
  }
  if (status === "invalidated" || status === "resolved" || status === "replaced") return 0;
  return bounded;
}

export function thesisScoreLabel(score: number): string {
  const fivePointScore = fivePointThesisScore(score);
  if (fivePointScore === 2) return "STRONG UPSIDE";
  if (fivePointScore === 1) return "GENTLE UPSIDE";
  if (fivePointScore === -2) return "STRONG DOWNSIDE";
  if (fivePointScore === -1) return "GENTLE DOWNSIDE";
  return "NEUTRAL";
}

export function signalFromThesisScore(score: number): {
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "GENTLE" | "STRONG" | "NEUTRAL";
} {
  const label = thesisScoreLabel(score);
  if (label === "NEUTRAL") return { direction: "NEUTRAL", strength: "NEUTRAL" };
  const [strength, direction] = label.split(" ") as [
    "GENTLE" | "STRONG",
    "UPSIDE" | "DOWNSIDE",
  ];
  return { direction: direction === "UPSIDE" ? "UP" : "DOWN", strength };
}

export function mergeThesisMovementObservations(
  ...groups: Array<readonly ThesisMovementObservation[]>
): ThesisMovementObservation[] {
  const byDate = new Map<string, ThesisMovementObservation>();
  for (const group of groups) {
    for (const item of group) {
      if (!validDate(item.date) || !Number.isFinite(item.score)) continue;
      const current = byDate.get(item.date);
      if (!current || item.observedAt >= current.observedAt) {
        byDate.set(item.date, {
          ...item,
          schemaVersion: 1,
          score: fivePointThesisScore(item.score),
          support: Math.max(0, Math.min(5, Math.floor(item.support))),
          oppose: Math.max(0, Math.min(5, Math.floor(item.oppose))),
          uncertain: Math.max(0, Math.min(5, Math.floor(item.uncertain))),
          unavailable: Math.max(0, Math.min(5, Math.floor(item.unavailable))),
        });
      }
    }
  }
  return [...byDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date) || left.observedAt - right.observedAt)
    .slice(-130)
    .map((item, index) => ({ ...item, index: index + 1 }));
}

export function nextObservationFromReview(input: {
  date: string;
  observedAt: number;
  status: ThesisMovementStatus;
  signal: DossierQualitativeSignal;
  votes: { support: number; oppose: number; uncertain: number; unavailable?: number };
  prior?: ThesisMovementObservation | null;
  index: number;
  auditId?: string;
  /** A release-valid dossier already carries the admitted latest strength. */
  admittedSignal?: boolean;
}): ThesisMovementObservation {
  const baseScore = input.prior?.score ?? signalScore(input.signal);
  const score = input.admittedSignal
    ? signalScore(input.signal)
    : input.prior
    ? shiftedThesisScore(baseScore, input.status)
    : input.status === "opened"
      ? baseScore
      : shiftedThesisScore(baseScore, input.status);
  return {
    schemaVersion: 1,
    date: input.date,
    observedAt: input.observedAt,
    index: Math.max(1, Math.floor(input.index)),
    status: input.status,
    score,
    support: input.votes.support,
    oppose: input.votes.oppose,
    uncertain: input.votes.uncertain,
    unavailable: input.votes.unavailable ?? Math.max(
      0,
      5 - input.votes.support - input.votes.oppose - input.votes.uncertain,
    ),
    ...(input.auditId ? { auditId: input.auditId } : {}),
  };
}

function parseNextEventDate(nextEvent: string | null, referenceDate: string): string | null {
  if (!nextEvent || !validDate(referenceDate)) return null;
  const match = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/i.exec(nextEvent);
  if (!match) return null;
  const month = MONTHS[match[1].slice(0, 3).toUpperCase()];
  const day = Number(match[2]);
  const referenceYear = Number(referenceDate.slice(0, 4));
  const calendarYear = /\bQ[1-4]\s+(?!FY\b)(\d{4})\b/i.exec(nextEvent)?.[1];
  if (calendarYear) {
    const value = `${calendarYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return validDate(value) && value >= referenceDate ? value : null;
  }
  for (const year of [referenceYear, referenceYear + 1]) {
    const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (validDate(value) && value >= referenceDate) return value;
  }
  return null;
}

function previousQuarterLabel(nextEvent: string | null): string | null {
  const match = /\bQ([1-4])\s+(FY)?(\d{2,4})\b/i.exec(nextEvent ?? "");
  if (!match) return null;
  const quarter = Number(match[1]);
  const fiscalPrefix = match[2] ? "FY" : "";
  const rawYear = match[3];
  const previousQuarter = quarter === 1 ? 4 : quarter - 1;
  const previousYear = quarter === 1
    ? String(Number(rawYear) - 1).padStart(rawYear.length, "0")
    : rawYear;
  return `Q${previousQuarter} ${fiscalPrefix}${previousYear} RESULTS`;
}

function nextEventLabel(nextEvent: string | null, endDate: string): string {
  if (!nextEvent) return "NEXT RESULTS · DATE PENDING";
  const quarter = /\bQ[1-4]\s+(?:FY)?\d{2,4}\s+earnings\b/i.exec(nextEvent ?? "")?.[0];
  return `${quarter ? quarter.toUpperCase() : "NEXT RESULTS"} · ${shortDate(endDate)}`;
}

export function thesisMovementWindow(input: {
  openedDate: string;
  filings: readonly Pick<SecFiling, "form" | "date">[];
  nextEvent: string | null;
}): ThesisMovementWindow {
  const filing = [...input.filings]
    .filter((item) =>
      (item.form === "10-Q" || item.form === "10-K") &&
      validDate(item.date) &&
      item.date <= input.openedDate,
    )
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  const startDate = filing?.date ?? input.openedDate;
  const parsedEnd = parseNextEventDate(input.nextEvent, input.openedDate);
  const fallbackEnd = new Date(`${startDate}T12:00:00Z`);
  fallbackEnd.setUTCDate(fallbackEnd.getUTCDate() + 98);
  const endDate = parsedEnd ?? fallbackEnd.toISOString().slice(0, 10);
  const priorQuarter = filing ? previousQuarterLabel(input.nextEvent) : null;
  return {
    startDate,
    startLabel: `${priorQuarter ?? (filing ? "LAST RESULTS" : "THESIS OPENED")} · ${shortDate(startDate)}`,
    endDate,
    endLabel: nextEventLabel(parsedEnd ? input.nextEvent : null, endDate),
  };
}

export function buildThesisMovementView(input: {
  observations: readonly ThesisMovementObservation[];
  fallbackSignal: DossierQualitativeSignal;
  fallbackVotes: { support: number; oppose: number; uncertain: number; unavailable?: number };
  window: ThesisMovementWindow;
}): ThesisMovementView {
  const observations = mergeThesisMovementObservations(input.observations);
  const latest = observations.at(-1);
  const fallbackScore = signalScore(input.fallbackSignal);
  const currentScore = latest?.score ?? fallbackScore;
  const support = latest?.support ?? input.fallbackVotes.support;
  const total = latest
    ? latest.support + latest.oppose + latest.uncertain + latest.unavailable
    : input.fallbackVotes.support +
      input.fallbackVotes.oppose +
      input.fallbackVotes.uncertain +
      (input.fallbackVotes.unavailable ?? 0);
  return {
    observations,
    window: input.window,
    currentScore,
    currentLabel: thesisScoreLabel(currentScore),
    currentSupport: support,
    currentTotal: Math.max(1, total),
  };
}
