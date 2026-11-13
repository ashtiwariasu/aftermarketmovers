import { createHash } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import {
  dossierReleaseValidationError,
  getCachedDossier,
  getRejectedDossierFactualUpdate,
  type Dossier,
} from "@/lib/dossier";
import type {
  EvidenceMaterialityAssessment,
  EvidencePack,
} from "@/lib/evidenceRoom";
import { signalScore, thesisScoreLabel } from "@/lib/thesisMovement";

export const DAILY_THESIS_CHECK_SCHEMA = "daily-thesis-check-v1" as const;

export type DailyThesisCheckOutcome =
  | "published"
  | "no-directional-read"
  | "evidence-unchanged";
export type DailyThesisCheckSource =
  | "dossier"
  | "rejected-update"
  | "evidence-check";

/**
 * Immutable proof that one actively followed company completed its daily
 * research pass. It references the accepted research artifact; it never
 * substitutes for the dossier, rejected update, or thesis movement ledger.
 */
export interface DailyThesisCheck {
  schema: typeof DAILY_THESIS_CHECK_SCHEMA;
  id: string;
  ticker: string;
  date: string;
  checkedAt: number;
  outcome: DailyThesisCheckOutcome;
  source: DailyThesisCheckSource;
  sourceGeneratedAt: number;
  sourceFingerprint: string;
  auditId: string;
  lifecycleId: string | null;
  thesisStatus: string | null;
  score: number | null;
  scoreLabel: string | null;
  votes: {
    support: number;
    oppose: number;
    uncertain: number;
    unavailable: number;
  };
  evidenceCount: number;
  receiptSha256: string;
}

export interface DailyThesisCoverage {
  date: string;
  complete: boolean;
  checks: DailyThesisCheck[];
  missingTickers: string[];
}

const useMemory = process.env.DESK_STORE === "memory";
const memoryStore = ((globalThis as Record<string, unknown>).__dailyThesisChecks ??=
  new Map<string, DailyThesisCheck>()) as Map<string, DailyThesisCheck>;

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function dailyThesisCheckId(ticker: string, date: string): string {
  return `${normalizedTicker(ticker)}_${date}`;
}

function validVotes(value: DailyThesisCheck["votes"]): boolean {
  const values = [value.support, value.oppose, value.uncertain, value.unavailable];
  return values.every((item) => Number.isInteger(item) && item >= 0 && item <= 5) &&
    values.reduce((sum, item) => sum + item, 0) === 5;
}

function receiptHash(value: Omit<DailyThesisCheck, "receiptSha256">): string {
  return sha256(stableJson(value));
}

export function isDailyThesisCheck(value: unknown): value is DailyThesisCheck {
  if (!value || typeof value !== "object") return false;
  const record = value as DailyThesisCheck;
  if (
    record.schema !== DAILY_THESIS_CHECK_SCHEMA ||
    record.id !== dailyThesisCheckId(record.ticker, record.date) ||
    !/^[A-Z][A-Z0-9.-]{0,9}$/.test(record.ticker) ||
    !/^20\d{2}-\d{2}-\d{2}$/.test(record.date) ||
    !Number.isFinite(record.checkedAt) ||
    !Number.isFinite(record.sourceGeneratedAt) ||
    !["published", "no-directional-read", "evidence-unchanged"].includes(record.outcome) ||
    !["dossier", "rejected-update", "evidence-check"].includes(record.source) ||
    !/^[a-f0-9]{64}$/.test(record.sourceFingerprint) ||
    typeof record.auditId !== "string" ||
    record.auditId.length < 1 ||
    (record.lifecycleId !== null && typeof record.lifecycleId !== "string") ||
    (record.thesisStatus !== null && typeof record.thesisStatus !== "string") ||
    (record.score !== null && (!Number.isInteger(record.score) || record.score < -2 || record.score > 2)) ||
    (record.scoreLabel !== null && typeof record.scoreLabel !== "string") ||
    !validVotes(record.votes) ||
    !Number.isInteger(record.evidenceCount) ||
    record.evidenceCount < 0 ||
    !/^[a-f0-9]{64}$/.test(record.receiptSha256)
  ) return false;
  const { receiptSha256, ...payload } = record;
  return receiptHash(payload) === receiptSha256;
}

export async function getDailyThesisCheck(
  ticker: string,
  date: string,
): Promise<DailyThesisCheck | null> {
  const id = dailyThesisCheckId(ticker, date);
  const value = useMemory
    ? memoryStore.get(id)
    : (await firestore().collection("dailyThesisChecks").doc(id).get()).data();
  return isDailyThesisCheck(value) ? value : null;
}

async function saveDailyThesisCheck(check: DailyThesisCheck): Promise<DailyThesisCheck> {
  if (!isDailyThesisCheck(check)) throw new Error("invalid daily thesis check");
  const existing = await getDailyThesisCheck(check.ticker, check.date);
  if (existing) {
    if (
      existing.source !== check.source ||
      existing.sourceFingerprint !== check.sourceFingerprint
    ) {
      throw new Error(
        `daily thesis check ${check.id} already references a different accepted artifact`,
      );
    }
    return existing;
  }
  if (useMemory) {
    memoryStore.set(check.id, check);
    return check;
  }
  const ref = firestore().collection("dailyThesisChecks").doc(check.id);
  await firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) {
      const stored = snapshot.data();
      if (
        !isDailyThesisCheck(stored) ||
        stored.source !== check.source ||
        stored.sourceFingerprint !== check.sourceFingerprint
      ) {
        throw new Error(
          `daily thesis check ${check.id} already references a different accepted artifact`,
        );
      }
      return;
    }
    transaction.create(ref, check);
  });
  return check;
}

function buildCheck(
  value: Omit<DailyThesisCheck, "schema" | "id" | "receiptSha256">,
): DailyThesisCheck {
  const payload: Omit<DailyThesisCheck, "receiptSha256"> = {
    schema: DAILY_THESIS_CHECK_SCHEMA,
    id: dailyThesisCheckId(value.ticker, value.date),
    ...value,
  };
  return { ...payload, receiptSha256: receiptHash(payload) };
}

/**
 * Record that today's complete source intake found no material change against
 * the last release-valid dossier. This is a first-class daily research result,
 * not a cache hit: the evidence fingerprint and tape thresholds were checked
 * today, while the last admitted council read remains the canonical thesis.
 */
export async function recordUnchangedDailyThesisCheck(input: {
  ticker: string;
  date: string;
  dossier: Dossier;
  evidencePack: EvidencePack;
  assessment: EvidenceMaterialityAssessment;
}): Promise<DailyThesisCheck> {
  const sym = normalizedTicker(input.ticker);
  if (dossierReleaseValidationError(input.dossier) !== null) {
    throw new Error(`${sym}: cannot carry forward an invalid dossier`);
  }
  if (input.assessment.needsCouncil) {
    throw new Error(`${sym}: material evidence cannot be recorded as unchanged`);
  }
  const hook = input.dossier.emailHook;
  const support = hook.votesSupport;
  const oppose = hook.votesOppose;
  const uncertain = hook.votesUncertain;
  const unavailable = Math.max(0, 5 - support - oppose - uncertain);
  const lifecycle = input.dossier.thesisLifecycle;
  const score = signalScore(lifecycle?.latestSignal ?? hook.signal);
  return saveDailyThesisCheck(buildCheck({
    ticker: sym,
    date: input.date,
    checkedAt: input.assessment.checkedAt,
    outcome: "evidence-unchanged",
    source: "evidence-check",
    sourceGeneratedAt: input.assessment.checkedAt,
    sourceFingerprint: input.assessment.auditId,
    auditId: input.assessment.auditId,
    lifecycleId: lifecycle?.id ?? null,
    thesisStatus: lifecycle?.observationStatus ?? "open",
    score,
    scoreLabel: thesisScoreLabel(score),
    votes: { support, oppose, uncertain, unavailable },
    evidenceCount: input.evidencePack.evidence.length,
  }));
}

/**
 * Materializes the daily completion receipt from an already accepted source
 * artifact. Returns null when research has not completed; callers must retry
 * rather than interpreting absence as an unchanged thesis.
 */
export async function recordDailyThesisCheck(
  ticker: string,
  date: string,
): Promise<DailyThesisCheck | null> {
  const sym = normalizedTicker(ticker);
  const existing = await getDailyThesisCheck(sym, date);
  if (existing) return existing;

  const [dossier, rejected] = await Promise.all([
    getCachedDossier(sym),
    getRejectedDossierFactualUpdate(sym, date),
  ]);

  if (
    dossier?.date === date &&
    dossierReleaseValidationError(dossier) === null
  ) {
    const support = dossier.emailHook.votesSupport;
    const oppose = dossier.emailHook.votesOppose;
    const uncertain = dossier.emailHook.votesUncertain;
    const unavailable = Math.max(0, 5 - support - oppose - uncertain);
    const score = signalScore(dossier.emailHook.signal);
    const lifecycle = dossier.thesisLifecycle;
    const sourceFingerprint = sha256(stableJson({
      ticker: dossier.ticker,
      date: dossier.date,
      generatedAt: dossier.generatedAt,
      briefAuditId: dossier.briefAuditId ?? null,
      councilRunId: dossier.councilRunId ?? null,
      lifecycleId: lifecycle?.id ?? null,
      observationIndex: lifecycle?.observationIndex ?? null,
      hook: dossier.emailHook,
      citations: dossier.citations ?? [],
    }));
    return saveDailyThesisCheck(buildCheck({
      ticker: sym,
      date,
      checkedAt: Date.now(),
      outcome: "published",
      source: "dossier",
      sourceGeneratedAt: dossier.generatedAt,
      sourceFingerprint,
      auditId: dossier.briefAuditId ?? dossier.councilRunId ?? sourceFingerprint,
      lifecycleId: lifecycle?.id ?? null,
      thesisStatus: lifecycle?.observationStatus ?? "opened",
      score,
      scoreLabel: thesisScoreLabel(score),
      votes: { support, oppose, uncertain, unavailable },
      evidenceCount: dossier.citations?.length ?? 0,
    }));
  }

  if (rejected) {
    const support = rejected.votesSupport;
    const oppose = rejected.votesOppose;
    const uncertain = rejected.votesUncertain;
    const unavailable = rejected.votesUnavailable ??
      Math.max(0, 5 - support - oppose - uncertain);
    return saveDailyThesisCheck(buildCheck({
      ticker: sym,
      date,
      checkedAt: Date.now(),
      outcome: "no-directional-read",
      source: "rejected-update",
      sourceGeneratedAt: rejected.generatedAt,
      sourceFingerprint: rejected.contentSha256,
      auditId: rejected.rejectionAuditId,
      lifecycleId: rejected.thesisObservation?.lifecycleId ?? null,
      // The receipt proves that research finished, not that the rejected
      // chair proposal became a council-admitted lifecycle state.
      thesisStatus: null,
      score: null,
      scoreLabel: null,
      votes: { support, oppose, uncertain, unavailable },
      evidenceCount: rejected.citations.length,
    }));
  }

  return null;
}

export async function listDailyThesisChecks(
  date: string,
  tickers?: readonly string[],
): Promise<DailyThesisCheck[]> {
  if (useMemory) {
    const allowed = tickers
      ? new Set(tickers.map(normalizedTicker))
      : null;
    return [...memoryStore.values()]
      .filter((item) => item.date === date && (!allowed || allowed.has(item.ticker)))
      .filter(isDailyThesisCheck)
      .sort((left, right) => left.ticker.localeCompare(right.ticker));
  }
  const snapshot = await firestore()
    .collection("dailyThesisChecks")
    .where("date", "==", date)
    .get();
  const allowed = tickers
    ? new Set(tickers.map(normalizedTicker))
    : null;
  return snapshot.docs
    .map((doc) => doc.data())
    .filter(isDailyThesisCheck)
    .filter((item) => !allowed || allowed.has(item.ticker))
    .sort((left, right) => left.ticker.localeCompare(right.ticker));
}

export async function getDailyThesisCoverage(
  tickers: readonly string[],
  date: string,
): Promise<DailyThesisCoverage> {
  const expected = [...new Set(tickers.map(normalizedTicker).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const checks = await listDailyThesisChecks(date, expected);
  const completed = new Set(checks.map((item) => item.ticker));
  const missingTickers = expected.filter((ticker) => !completed.has(ticker));
  return {
    date,
    complete: expected.length > 0 && missingTickers.length === 0,
    checks,
    missingTickers,
  };
}

export async function latestCompleteDailyThesisCoverage(
  tickers: readonly string[],
  candidateDates: readonly string[],
): Promise<DailyThesisCoverage | null> {
  const dates = [...new Set(candidateDates)]
    .filter((date) => /^20\d{2}-\d{2}-\d{2}$/.test(date))
    .sort((left, right) => right.localeCompare(left));
  for (const date of dates) {
    const coverage = await getDailyThesisCoverage(tickers, date);
    if (coverage.complete) return coverage;
  }
  return null;
}
