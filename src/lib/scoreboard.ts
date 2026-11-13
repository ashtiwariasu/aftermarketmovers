/**
 * The record — every published thesis becomes an ActiveQuestion that an
 * external oracle resolves. Misses render like wins. Price never resolves a
 * fundamentals question. See docs/SPRINT.md contracts.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  Firestore,
  type DocumentReference,
  type Transaction,
} from "@google-cloud/firestore";
import {
  dossierReleaseValidationError,
  getCachedDossier,
  getRejectedDossierFactualUpdate,
  type Dossier,
  type DossierCitation,
  type RejectedDossierFactualUpdate,
} from "@/lib/dossier";
import type { EvidenceMaterialityAssessment } from "@/lib/evidenceRoom";
import { MODEL_POLICY_VERSION, RESEARCH_MODELS } from "@/lib/modelPolicy";
import { getTickerSnapshot } from "@/lib/ticker";
import {
  mergeThesisMovementObservations,
  nextObservationFromReview,
  type ThesisMovementObservation,
} from "@/lib/thesisMovement";

export type QuestionStatus =
  | "open" | "strengthened" | "weakened" | "resolved" | "resolved_yes" | "resolved_no" | "reframed";

export interface ResolverEvidenceDocument {
  sourceDocumentId: string;
  url: string;
  title: string;
  publisher: string;
  authority: "primary" | "company";
  publishedAt: number;
  publishedDate: string;
  contentSha256?: string;
  evidenceState?: DossierCitation["evidenceState"];
}

export interface QuestionResolverState {
  schemaVersion: 1;
  adjudicatorVersion: string;
  evidenceDocuments: ResolverEvidenceDocument[];
  lastEvidenceFingerprint?: string;
  lastCouncilReceiptDossierDate?: string;
  lastCouncilReceiptAt?: number;
  lastCouncilReceiptStatus?: QuestionStatus;
  lastCouncilReceiptAuditId?: string;
  lastRuledDossierDate?: string;
  lastRuledAt?: number;
  lastRulingStatus?: QuestionStatus;
  lastRulingAuditId?: string;
  lastRulingSummary?: string;
  lastRulingSources?: string[];
  lastAttemptFingerprint?: string;
  lastAttemptAt?: number;
  lastAttemptOutcome?: "succeeded" | "failed";
  failureCount?: number;
  nextRetryAt?: number;
  lastErrorCode?: string;
  lastFullReconciliationAt?: number;
  inFlightFingerprint?: string;
  leaseUntil?: number;
  leaseToken?: string;
}

export interface ActiveQuestion {
  id: string; // lifecycle-aware `${ticker}:${lifecycleId}`; legacy records retain `${ticker}:${publishedDate}`
  ticker: string;
  lifecycleId?: string;
  question: string;
  thesis: string;
  votesYes: number;
  votesTotal: number;
  publishedAt: number;
  publishedDate: string; // YYYY-MM-DD ET
  auditId?: string;
  oracle: { type: "filing" | "tape"; trigger: string; dueBy: string };
  status: QuestionStatus;
  resolvedAt?: number;
  resolution?: string; // one plain sentence, cited
  resolutionSources?: string[];
  priceAtPublish?: number;
  lastObservedAt?: number;
  lastObservedDate?: string;
  observationCount?: number;
  latestAuditId?: string;
  resolver?: QuestionResolverState;
}

const useMemory = process.env.DESK_STORE === "memory";
const mem = ((globalThis as Record<string, unknown>).__scoreboard ??= new Map<string, ActiveQuestion>()) as Map<string, ActiveQuestion>;
const movementMem = ((globalThis as Record<string, unknown>).__scoreboardMovement ??=
  new Map<string, ThesisMovementObservation>()) as Map<string, ThesisMovementObservation>;
let db: Firestore | null = null;
const fs = () => (db ??= new Firestore());
const COL = "activeQuestions";
const OBS_COL = "observations";
const RESOLVER_RUN_COL = "scoreboardResolverRuns";
const RESOLVER_SCHEMA_VERSION = 1 as const;
export const RESOLVER_ADJUDICATOR_VERSION =
  `${MODEL_POLICY_VERSION}:${RESEARCH_MODELS.scoreboardResolver}:primary-evidence-v3`;
const RESOLVER_MODEL = RESEARCH_MODELS.scoreboardResolver;
const RESOLVER_LEASE_MS = 5 * 60_000;
const RESOLVER_RETRY_BASE_MS = 6 * 60 * 60_000;
const RESOLVER_RETRY_MAX_MS = 24 * 60 * 60_000;
const RESOLVER_RECONCILIATION_MS = 7 * 24 * 60 * 60_000;

type ResolverRunReason =
  | "material_authoritative_evidence"
  | "lifecycle_milestone"
  | "scheduled_reconciliation";

interface ResolverTelemetry {
  id: string;
  questionId: string;
  ticker: string;
  model: string;
  adjudicatorVersion: string;
  evidenceFingerprint: string;
  attemptFingerprint: string;
  reason: ResolverRunReason;
  startedAt: number;
  completedAt: number;
  outcome: "succeeded" | "failed";
  status?: QuestionStatus;
  errorCode?: string;
  httpStatus?: number;
  openRouterRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

const resolverTelemetryMem = ((globalThis as Record<string, unknown>).__scoreboardResolverTelemetry ??=
  new Map<string, ResolverTelemetry>()) as Map<string, ResolverTelemetry>;

export async function getQuestion(id: string): Promise<ActiveQuestion | null> {
  if (useMemory) return mem.get(id) ?? null;
  const d = await fs().collection(COL).doc(id).get();
  return d.exists ? (d.data() as ActiveQuestion) : null;
}

async function save(q: ActiveQuestion): Promise<void> {
  if (useMemory) { mem.set(q.id, q); return; }
  await fs().collection(COL).doc(q.id).set(JSON.parse(JSON.stringify(q)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function authoritativeEvidenceDocuments(
  citations: DossierCitation[] | undefined,
): ResolverEvidenceDocument[] {
  return (citations ?? [])
    .filter((citation): citation is DossierCitation & { authority: "primary" | "company" } =>
      citation.authority === "primary" || citation.authority === "company")
    .map((citation) => ({
      sourceDocumentId: citation.sourceDocumentId,
      url: citation.url,
      title: citation.title,
      publisher: citation.publisher,
      authority: citation.authority,
      publishedAt: citation.publishedAt,
      publishedDate: citation.publishedDate,
      ...(citation.contentSha256 ? { contentSha256: citation.contentSha256 } : {}),
      ...(citation.evidenceState ? { evidenceState: citation.evidenceState } : {}),
    }));
}

function evidenceDocumentKey(document: ResolverEvidenceDocument): string {
  return document.sourceDocumentId || document.url;
}

function mergeEvidenceDocuments(
  existing: ResolverEvidenceDocument[] | undefined,
  incoming: ResolverEvidenceDocument[],
): ResolverEvidenceDocument[] {
  const merged = new Map<string, ResolverEvidenceDocument>();
  for (const document of [...(existing ?? []), ...incoming]) {
    merged.set(evidenceDocumentKey(document), document);
  }
  return [...merged.values()].sort((left, right) =>
    left.publishedAt - right.publishedAt ||
    evidenceDocumentKey(left).localeCompare(evidenceDocumentKey(right)));
}

function evidenceFingerprint(documents: ResolverEvidenceDocument[]): string {
  return sha256(stableJson({
    schemaVersion: RESOLVER_SCHEMA_VERSION,
    documents,
  }));
}

function resolverStateFromAdmittedReview(input: {
  previous?: QuestionResolverState;
  citations?: DossierCitation[];
  dossierDate: string;
  ruledAt: number;
  status: QuestionStatus;
  auditId?: string;
}): QuestionResolverState {
  const evidenceDocuments = mergeEvidenceDocuments(
    input.previous?.evidenceDocuments,
    authoritativeEvidenceDocuments(input.citations),
  );
  return {
    ...(input.previous ?? {}),
    schemaVersion: RESOLVER_SCHEMA_VERSION,
    adjudicatorVersion: RESOLVER_ADJUDICATOR_VERSION,
    evidenceDocuments,
    lastEvidenceFingerprint: evidenceFingerprint(evidenceDocuments),
    lastCouncilReceiptDossierDate: input.dossierDate,
    lastCouncilReceiptAt: input.ruledAt,
    lastCouncilReceiptStatus: input.status,
    ...(input.auditId ? { lastCouncilReceiptAuditId: input.auditId } : {}),
  };
}

function activeQuestionStatus(status: QuestionStatus): boolean {
  return status === "open" || status === "strengthened" || status === "weakened";
}

function resolverAttemptFingerprint(
  evidence: string,
  reason: ResolverRunReason,
  q: ActiveQuestion,
  now: number,
): string {
  const bucket = reason === "scheduled_reconciliation"
    ? Math.floor(now / RESOLVER_RECONCILIATION_MS)
    : reason === "lifecycle_milestone"
      ? q.oracle.dueBy
      : "material";
  return sha256(`${RESOLVER_ADJUDICATOR_VERSION}:${reason}:${bucket}:${evidence}`);
}

function resolverErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[^a-zA-Z0-9:_-]+/g, "_").slice(0, 120) || "unknown_error";
}

function resolverRetryDelay(failureCount: number): number {
  return Math.min(
    RESOLVER_RETRY_MAX_MS,
    RESOLVER_RETRY_BASE_MS * Math.max(1, 2 ** Math.max(0, failureCount - 1)),
  );
}

async function saveResolverTelemetry(telemetry: ResolverTelemetry): Promise<void> {
  if (useMemory) {
    resolverTelemetryMem.set(telemetry.id, structuredClone(telemetry));
    return;
  }
  await fs().collection(RESOLVER_RUN_COL).doc(telemetry.id).set(telemetry);
}

async function initializeLegacyResolverBaseline(
  q: ActiveQuestion,
  dossier: Dossier,
  now: number,
): Promise<void> {
  const next: ActiveQuestion = {
    ...q,
    resolver: {
      ...resolverStateFromAdmittedReview({
        previous: q.resolver,
        citations: dossier.citations,
        dossierDate: dossier.date,
        ruledAt: now,
        status: q.status,
        auditId: dossier.briefAuditId,
      }),
      // A migration baseline prevents a sudden fleet-wide resolver run. It is not
      // refreshed by daily council receipts, so every open thesis still earns
      // an independent frontier reconciliation at the configured cadence.
      lastFullReconciliationAt: now,
    },
  };
  await save(next);
}

async function claimResolverRun(input: {
  q: ActiveQuestion;
  documents: ResolverEvidenceDocument[];
  evidenceFingerprint: string;
  attemptFingerprint: string;
  now: number;
}): Promise<{ question: ActiveQuestion; leaseToken: string } | null> {
  const leaseToken = randomUUID();
  const applyClaim = (current: ActiveQuestion): ActiveQuestion | null => {
    if (!activeQuestionStatus(current.status)) return null;
    const resolver = current.resolver;
    if (resolver?.lastAttemptFingerprint === input.attemptFingerprint &&
        resolver.lastAttemptOutcome === "succeeded") return null;
    if (resolver?.lastAttemptFingerprint === input.attemptFingerprint &&
        resolver.lastAttemptOutcome === "failed" &&
        (resolver.nextRetryAt ?? 0) > input.now) return null;
    if ((resolver?.leaseUntil ?? 0) > input.now) return null;
    return {
      ...current,
      resolver: {
        ...(resolver ?? {}),
        schemaVersion: RESOLVER_SCHEMA_VERSION,
        adjudicatorVersion: RESOLVER_ADJUDICATOR_VERSION,
        evidenceDocuments: input.documents,
        lastAttemptFingerprint: input.attemptFingerprint,
        lastAttemptAt: input.now,
        inFlightFingerprint: input.attemptFingerprint,
        leaseUntil: input.now + RESOLVER_LEASE_MS,
        leaseToken,
      },
    };
  };

  if (useMemory) {
    const current = mem.get(input.q.id) ?? input.q;
    const claimed = applyClaim(current);
    if (!claimed) return null;
    mem.set(claimed.id, claimed);
    return { question: claimed, leaseToken };
  }

  const reference = fs().collection(COL).doc(input.q.id);
  return fs().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const claimed = applyClaim(snapshot.data() as ActiveQuestion);
    if (!claimed) return null;
    transaction.set(reference, JSON.parse(JSON.stringify(claimed)));
    return { question: claimed, leaseToken };
  });
}

async function finishResolverRun(input: {
  q: ActiveQuestion;
  leaseToken: string;
  evidenceFingerprint: string;
  attemptFingerprint: string;
  dossierDate: string;
  now: number;
  ruling?: ResolverRuling;
  errorCode?: string;
}): Promise<{ saved: boolean; question: ActiveQuestion | null }> {
  const applyFinish = (current: ActiveQuestion): ActiveQuestion | null => {
    if (current.resolver?.leaseToken !== input.leaseToken) return null;
    const prior = { ...current.resolver };
    delete prior.inFlightFingerprint;
    delete prior.leaseUntil;
    delete prior.leaseToken;
    if (!input.ruling) {
      const failureCount = (prior.failureCount ?? 0) + 1;
      return {
        ...current,
        resolver: {
          ...prior,
          evidenceDocuments: current.resolver?.evidenceDocuments ?? [],
          lastAttemptFingerprint: input.attemptFingerprint,
          lastAttemptAt: input.now,
          lastAttemptOutcome: "failed",
          failureCount,
          nextRetryAt: input.now + resolverRetryDelay(failureCount),
          lastErrorCode: input.errorCode ?? "unknown_error",
        },
      };
    }

    const terminal = input.ruling.status === "resolved_yes" ||
      input.ruling.status === "resolved_no" ||
      input.ruling.status === "reframed";
    const nextStatus = input.ruling.status === "open" ? current.status : input.ruling.status;
    return {
      ...current,
      status: nextStatus,
      ...(terminal
        ? {
            resolution: input.ruling.resolution,
            resolutionSources: input.ruling.resolutionSources,
          }
        : {}),
      ...(terminal ? { resolvedAt: input.now } : {}),
      resolver: {
        ...prior,
        evidenceDocuments: current.resolver?.evidenceDocuments ?? [],
        lastEvidenceFingerprint: input.evidenceFingerprint,
        lastRuledDossierDate: input.dossierDate,
        lastRuledAt: input.now,
        lastRulingStatus: input.ruling.status,
        lastRulingSummary: input.ruling.resolution,
        lastRulingSources: input.ruling.resolutionSources,
        lastAttemptFingerprint: input.attemptFingerprint,
        lastAttemptAt: input.now,
        lastAttemptOutcome: "succeeded",
        failureCount: 0,
        nextRetryAt: 0,
        lastErrorCode: "",
        lastFullReconciliationAt: input.now,
      },
    };
  };

  if (useMemory) {
    const current = mem.get(input.q.id);
    if (!current) return { saved: false, question: null };
    const finished = applyFinish(current);
    if (!finished) return { saved: false, question: current };
    mem.set(finished.id, finished);
    return { saved: true, question: finished };
  }

  const reference = fs().collection(COL).doc(input.q.id);
  return fs().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return { saved: false, question: null };
    const current = snapshot.data() as ActiveQuestion;
    const finished = applyFinish(current);
    if (!finished) return { saved: false, question: current };
    transaction.set(reference, JSON.parse(JSON.stringify(finished)));
    return { saved: true, question: finished };
  });
}

function observationMemoryKey(questionId: string, date: string): string {
  return `${questionId}:${date}`;
}

async function getMovementObservation(
  questionId: string,
  date: string,
): Promise<ThesisMovementObservation | null> {
  if (useMemory) return movementMem.get(observationMemoryKey(questionId, date)) ?? null;
  const snapshot = await fs().collection(COL).doc(questionId).collection(OBS_COL).doc(date).get();
  return snapshot.exists ? (snapshot.data() as ThesisMovementObservation) : null;
}

async function saveMovementObservation(
  questionId: string,
  observation: ThesisMovementObservation,
): Promise<void> {
  if (useMemory) {
    movementMem.set(observationMemoryKey(questionId, observation.date), structuredClone(observation));
    return;
  }
  await fs()
    .collection(COL)
    .doc(questionId)
    .collection(OBS_COL)
    .doc(observation.date)
    .set(JSON.parse(JSON.stringify(observation)));
}

function rejectedMovementWritePlan(
  existingMovement: ThesisMovementObservation | null,
  normalizedMovement: ThesisMovementObservation,
  rejectionAuditId: string,
): { operation: "create" | "set"; movement: ThesisMovementObservation } | null {
  if (!existingMovement) return { operation: "create", movement: normalizedMovement };
  if (existingMovement.auditId === rejectionAuditId) {
    return { operation: "set", movement: normalizedMovement };
  }
  // A different immutable audit already owns this ticker/lifecycle/date slot.
  return null;
}

/** @internal Stages the observation write in the same transaction as its parent update. */
export function stageRejectedMovementWrite(
  transaction: Pick<Transaction, "create" | "set">,
  movementRef: DocumentReference,
  existingMovement: ThesisMovementObservation | null,
  normalizedMovement: ThesisMovementObservation,
  rejectionAuditId: string,
): "create" | "set" | null {
  const write = rejectedMovementWritePlan(
    existingMovement,
    normalizedMovement,
    rejectionAuditId,
  );
  if (!write) return null;
  const stored = JSON.parse(JSON.stringify(write.movement));
  if (write.operation === "create") transaction.create(movementRef, stored);
  else transaction.set(movementRef, stored);
  return write.operation;
}

/** Atomically retain a rejected review without allowing it to reopen or close a lifecycle. */
async function saveRejectedReviewIfActive(
  questionId: string,
  proposedMovement: ThesisMovementObservation,
  update: RejectedDossierFactualUpdate,
  admittedStatus: QuestionStatus | null,
): Promise<boolean> {
  const apply = (
    current: ActiveQuestion,
    existingMovement: ThesisMovementObservation | null,
  ): { question: ActiveQuestion; movement: ThesisMovementObservation } | null => {
    // The observation date is an immutable audit slot. If an admitted or
    // otherwise different audit already owns it, the rejected receipt cannot
    // update either that movement or the parent lifecycle cursor.
    if (existingMovement && existingMovement.auditId !== update.rejectionAuditId) {
      return null;
    }
    const noLaterIndependentRuling = (current.resolver?.lastRuledAt ?? 0) <= update.generatedAt;
    const rejectedReviewOwnsCurrentState =
      current.latestAuditId === update.rejectionAuditId &&
      !current.resolvedAt &&
      noLaterIndependentRuling;
    const effectiveStatus = rejectedReviewOwnsCurrentState && admittedStatus
      ? admittedStatus
      : current.status;
    if (!activeQuestionStatus(effectiveStatus)) return null;
    const movement = existingMovement?.auditId === update.rejectionAuditId
      ? { ...proposedMovement, index: existingMovement.index }
      : existingMovement ?? {
          ...proposedMovement,
          index: Math.max(
            proposedMovement.index,
            (current.observationCount ?? 0) + 1,
          ),
        };
    const isLatest = !current.lastObservedDate || update.date >= current.lastObservedDate;
    return {
      movement,
      question: {
        ...current,
        status: effectiveStatus,
        observationCount: Math.max(current.observationCount ?? 1, movement.index),
        ...(isLatest
          ? {
              lastObservedAt: update.generatedAt,
              lastObservedDate: update.date,
              latestAuditId: update.rejectionAuditId,
              resolver: resolverStateFromAdmittedReview({
                previous: current.resolver,
                citations: update.citations,
                dossierDate: update.date,
                ruledAt: update.generatedAt,
                status: effectiveStatus,
                auditId: update.rejectionAuditId,
              }),
            }
          : {}),
      },
    };
  };

  if (useMemory) {
    const current = mem.get(questionId);
    if (!current) return false;
    const key = observationMemoryKey(questionId, proposedMovement.date);
    const result = apply(current, movementMem.get(key) ?? null);
    if (!result) return false;
    movementMem.set(key, structuredClone(result.movement));
    mem.set(questionId, structuredClone(result.question));
    return true;
  }

  const questionRef = fs().collection(COL).doc(questionId);
  const movementRef = questionRef.collection(OBS_COL).doc(proposedMovement.date);
  return fs().runTransaction(async (transaction) => {
    const [questionSnapshot, movementSnapshot] = await Promise.all([
      transaction.get(questionRef),
      transaction.get(movementRef),
    ]);
    if (!questionSnapshot.exists) return false;
    const existingMovement = movementSnapshot.exists
      ? movementSnapshot.data() as ThesisMovementObservation
      : null;
    const result = apply(
      questionSnapshot.data() as ActiveQuestion,
      existingMovement,
    );
    if (!result) return false;
    stageRejectedMovementWrite(
      transaction,
      movementRef,
      existingMovement,
      result.movement,
      update.rejectionAuditId,
    );
    transaction.set(questionRef, JSON.parse(JSON.stringify(result.question)));
    return true;
  });
}

async function listMovementForQuestion(
  questionId: string,
  limit = 130,
): Promise<ThesisMovementObservation[]> {
  if (useMemory) {
    const prefix = `${questionId}:`;
    return mergeThesisMovementObservations(
      [...movementMem.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value),
    ).slice(-limit);
  }
  const snapshot = await fs()
    .collection(COL)
    .doc(questionId)
    .collection(OBS_COL)
    .orderBy("date", "asc")
    .limit(Math.max(1, Math.min(180, limit)))
    .get();
  return mergeThesisMovementObservations(
    snapshot.docs.map((document) => document.data() as ThesisMovementObservation),
  );
}

export async function getThesisMovementObservations(input: {
  ticker: string;
  lifecycleId: string;
  openedDate: string;
  limit?: number;
}): Promise<ThesisMovementObservation[]> {
  const ticker = input.ticker.toUpperCase();
  const canonicalId = lifecycleQuestionId(ticker, input.lifecycleId);
  const canonical = await listMovementForQuestion(canonicalId, input.limit);
  if (canonical.length > 0) return canonical;
  const legacyId = `${ticker}:${input.openedDate}`;
  return legacyId === canonicalId ? [] : listMovementForQuestion(legacyId, input.limit);
}

export async function listQuestions(opts?: { status?: "open" | "closed"; ticker?: string; limit?: number }): Promise<ActiveQuestion[]> {
  const all: ActiveQuestion[] = useMemory
    ? [...mem.values()]
    : (await fs().collection(COL).orderBy("publishedAt", "desc").limit(opts?.limit ?? 200).get()).docs.map((d) => d.data() as ActiveQuestion);
  const activeStatuses = new Set<QuestionStatus>(["open", "strengthened", "weakened"]);
  return all.filter((q) =>
    (!opts?.ticker || q.ticker === opts.ticker) &&
    (opts?.status !== "open" || activeStatuses.has(q.status)) &&
    (opts?.status !== "closed" || !activeStatuses.has(q.status))
  );
}

const strip = (v: string) =>
  v.replace(/\[(\d+ · \d{4}-\d{2}-\d{2})\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g, "").replace(/\s+/g, " ").trim();

const urls = (value: string): string[] =>
  [...value.matchAll(/\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1])
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, 8);

function lifecycleQuestionId(ticker: string, lifecycleId: string): string {
  return `${ticker}:${lifecycleId}`;
}

async function recordPublishedDossier(t: string, d: Dossier): Promise<boolean> {
  const hook = d.emailHook;
  const support = hook.votes.support;
  const lifecycle = d.thesisLifecycle;
  if (lifecycle?.previousLifecycle) {
    const previousId = lifecycleQuestionId(t, lifecycle.previousLifecycle.id);
    const previous = await getQuestion(previousId) ??
      await getQuestion(`${t}:${lifecycle.previousLifecycle.openedDate}`);
    if (previous && ["open", "strengthened", "weakened"].includes(previous.status)) {
      const terminalStatus: QuestionStatus = lifecycle.previousLifecycle.status === "invalidated"
        ? "resolved_no"
        : lifecycle.previousLifecycle.status === "replaced"
          ? "reframed"
          : "resolved";
      await save({
        ...previous,
        status: terminalStatus,
        resolvedAt: d.generatedAt,
        resolution: strip(lifecycle.previousLifecycle.text),
        resolutionSources: urls(lifecycle.previousLifecycle.text),
        lastObservedAt: d.generatedAt,
        lastObservedDate: d.date,
        latestAuditId: d.briefAuditId ?? previous.latestAuditId,
        resolver: resolverStateFromAdmittedReview({
          previous: previous.resolver,
          citations: d.citations,
          dossierDate: d.date,
          ruledAt: d.generatedAt,
          status: terminalStatus,
          auditId: d.briefAuditId,
        }),
      });
    }
  }
  let id = lifecycle ? lifecycleQuestionId(t, lifecycle.id) : `${t}:${d.date}`;
  let existing = await getQuestion(id);
  if (!existing && lifecycle) {
    const legacy = await getQuestion(`${t}:${lifecycle.openedDate}`);
    if (legacy && (!legacy.lifecycleId || legacy.lifecycleId === lifecycle.id)) {
      id = legacy.id;
      existing = legacy;
    }
  }
  if (existing) {
    const recoverableRejectedTerminal = Boolean(
      lifecycle &&
      existing.lifecycleId === lifecycle.id &&
      !activeQuestionStatus(existing.status) &&
      !existing.resolvedAt &&
      !existing.resolution,
    );
    if (lifecycle && (activeQuestionStatus(existing.status) || recoverableRejectedTerminal)) {
      const nextStatus: QuestionStatus = lifecycle.observationStatus === "opened"
        ? "open"
        : lifecycle.observationStatus;
      await save({
        ...existing,
        lifecycleId: lifecycle.id,
        status: nextStatus,
        lastObservedAt: d.generatedAt,
        lastObservedDate: d.date,
        observationCount: Math.max(existing.observationCount ?? 1, lifecycle.observationIndex),
        latestAuditId: d.briefAuditId ?? existing.latestAuditId,
        resolver: resolverStateFromAdmittedReview({
          previous: existing.resolver,
          citations: d.citations,
          dossierDate: d.date,
          ruledAt: d.generatedAt,
          status: nextStatus,
          auditId: d.briefAuditId,
        }),
      });
    } else if (activeQuestionStatus(existing.status)) {
      await save({
        ...existing,
        lastObservedAt: d.generatedAt,
        lastObservedDate: d.date,
        latestAuditId: d.briefAuditId ?? existing.latestAuditId,
        resolver: resolverStateFromAdmittedReview({
          previous: existing.resolver,
          citations: d.citations,
          dossierDate: d.date,
          ruledAt: d.generatedAt,
          status: existing.status,
          auditId: d.briefAuditId,
        }),
      });
    }
    const prior = (await listMovementForQuestion(id, 130)).at(-1) ?? null;
    const existingObservation = await getMovementObservation(id, d.date);
    await saveMovementObservation(id, existingObservation ?? nextObservationFromReview({
      date: d.date,
      observedAt: d.generatedAt,
      status: lifecycle?.observationStatus ?? "opened",
      signal: lifecycle?.latestSignal ?? hook.signal,
      votes: hook.votes,
      prior,
      index: lifecycle?.observationIndex ?? Math.max(1, (existing.observationCount ?? 0) + 1),
      auditId: d.briefAuditId,
      admittedSignal: true,
    }));
    return false;
  }
  const snap = await getTickerSnapshot(t).catch(() => null);
  // Oracle: codex's hook field when present; else derive — next dated event
  // (filing oracle) or a 15-session tape horizon.
  const due = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const oracle = lifecycle?.canonicalOracle ?? hook.oracle ??
    (snap?.nextEvent
      ? { type: "filing" as const, trigger: snap.nextEvent, dueBy: due }
      : { type: "tape" as const, trigger: "15 trading sessions", dueBy: due });
  await save({
    id, ticker: t,
    ...(lifecycle ? { lifecycleId: lifecycle.id } : {}),
    question: strip(lifecycle?.canonicalQuestion ?? hook.question),
    thesis: strip(lifecycle?.canonicalThesis ?? hook.thesis),
    votesYes: lifecycle?.canonicalVotes.support ?? support,
    votesTotal: lifecycle?.canonicalVotes.total ??
      ((hook.votes!.support + hook.votes!.oppose + hook.votes!.uncertain) || 5),
    publishedAt: lifecycle?.openedAt ?? d.generatedAt,
    publishedDate: lifecycle?.openedDate ?? d.date,
    ...(d.briefAuditId ? { auditId: d.briefAuditId } : {}),
    oracle, status: "open",
    lastObservedAt: d.generatedAt,
    lastObservedDate: d.date,
    observationCount: lifecycle?.observationIndex ?? 1,
    ...(d.briefAuditId ? { latestAuditId: d.briefAuditId } : {}),
    resolver: resolverStateFromAdmittedReview({
      citations: d.citations,
      dossierDate: d.date,
      ruledAt: d.generatedAt,
      status: "open",
      auditId: d.briefAuditId,
    }),
    ...((!lifecycle || lifecycle.observationIndex === 1) && snap?.price != null
      ? { priceAtPublish: snap.price }
      : {}),
  });
  await saveMovementObservation(id, nextObservationFromReview({
    date: d.date,
    observedAt: d.generatedAt,
    status: lifecycle?.observationStatus ?? "opened",
    signal: lifecycle?.latestSignal ?? hook.signal,
    votes: hook.votes,
    prior: null,
    index: lifecycle?.observationIndex ?? 1,
    auditId: d.briefAuditId,
    admittedSignal: true,
  }));
  return true;
}

async function recordRejectedObservation(
  t: string,
  update: RejectedDossierFactualUpdate,
  latestAdmittedDossier: Dossier | null,
): Promise<boolean> {
  const observation = update.thesisObservation;
  if (!observation) return false;
  const canonicalId = lifecycleQuestionId(t, observation.lifecycleId);
  const question = await getQuestion(canonicalId) ?? await getQuestion(`${t}:${observation.openedDate}`);
  // A rejected directional proposition is useful review evidence, but it is
  // not authority to reopen, close, replace, strengthen, or weaken the last
  // release-valid thesis. Terminal state changes happen only through an
  // admitted dossier (or the independent resolver).
  if (!question) return false;
  const admittedLifecycle = latestAdmittedDossier?.thesisLifecycle;
  const admittedStatus: QuestionStatus | null =
    dossierReleaseValidationError(latestAdmittedDossier) === null &&
    admittedLifecycle?.id === observation.lifecycleId
      ? admittedLifecycle.observationStatus === "opened"
        ? "open"
        : admittedLifecycle.observationStatus
      : null;
  const existingObservation = await getMovementObservation(question.id, update.date);
  const history = await listMovementForQuestion(question.id, 130);
  const prior = history.filter((item) => item.date < update.date).at(-1) ?? history.at(-1) ?? null;
  const index = existingObservation?.index ?? Math.max(
    observation.observationIndex,
    (question.observationCount ?? history.length) + 1,
  );
  const movement = nextObservationFromReview({
    date: update.date,
    observedAt: update.generatedAt,
    status: "open",
    signal: observation.signal,
    votes: {
      support: update.votesSupport,
      oppose: update.votesOppose,
      uncertain: update.votesUncertain,
      unavailable: update.votesUnavailable,
    },
    prior,
    index,
    auditId: update.rejectionAuditId,
  });
  await saveRejectedReviewIfActive(question.id, movement, update, admittedStatus);
  return false;
}

/**
 * Carry the last admitted thesis through a completed no-change evidence pass.
 * This advances the public movement history without inventing a new council
 * vote, lifecycle transition, or resolver ruling.
 */
export async function recordUnchangedThesisObservation(input: {
  ticker: string;
  date: string;
  dossier: Dossier;
  assessment: EvidenceMaterialityAssessment;
}): Promise<boolean> {
  const ticker = input.ticker.toUpperCase();
  if (input.assessment.needsCouncil) {
    throw new Error(`${ticker}: material evidence cannot be carried forward unchanged`);
  }
  const lifecycle = input.dossier.thesisLifecycle;
  const canonicalId = lifecycle
    ? lifecycleQuestionId(ticker, lifecycle.id)
    : `${ticker}:${input.dossier.date}`;
  const question = await getQuestion(canonicalId) ??
    (lifecycle ? await getQuestion(`${ticker}:${lifecycle.openedDate}`) : null);
  if (!question || !activeQuestionStatus(question.status)) return false;

  const existingObservation = await getMovementObservation(question.id, input.date);
  if (existingObservation) return false;
  const history = await listMovementForQuestion(question.id, 130);
  const prior = history.filter((item) => item.date < input.date).at(-1) ?? history.at(-1) ?? null;
  const hook = input.dossier.emailHook;
  const movement = nextObservationFromReview({
    date: input.date,
    observedAt: input.assessment.checkedAt,
    status: "open",
    signal: lifecycle?.latestSignal ?? hook.signal,
    votes: hook.votes,
    prior,
    index: Math.max(question.observationCount ?? history.length, history.length) + 1,
    auditId: input.assessment.auditId,
    admittedSignal: true,
  });
  await saveMovementObservation(question.id, movement);
  await save({
    ...question,
    lastObservedAt: input.assessment.checkedAt,
    lastObservedDate: input.date,
    observationCount: Math.max(question.observationCount ?? 1, movement.index),
    latestAuditId: input.assessment.auditId,
  });
  return true;
}

/**
 * Record one terminal research outcome immediately after the dossier route.
 * The hourly resolver calls the same idempotent function as a catch-up path.
 */
export async function recordTickerResearchOutcome(ticker: string, todayEt: string): Promise<boolean> {
  const t = ticker.toUpperCase();
  const [d, rejected] = await Promise.all([
    getCachedDossier(t).catch(() => null),
    getRejectedDossierFactualUpdate(t, todayEt).catch(() => null),
  ]);
  if (d?.date === todayEt && d.emailHook?.question && typeof d.emailHook.votes?.support === "number") {
    return recordPublishedDossier(t, d);
  }
  if (rejected?.date === todayEt) return recordRejectedObservation(t, rejected, d);
  return false;
}

/** Pull-based catch-up: one question per thesis lifecycle, updated by daily observations. */
export async function recordFromDossiers(tickers: string[], todayEt: string): Promise<number> {
  let recorded = 0;
  for (const t of [...new Set(tickers.map((x) => x.toUpperCase()))]) {
    if (await recordTickerResearchOutcome(t, todayEt)) recorded++;
  }
  return recorded;
}

interface ResolverRuling {
  status: Exclude<QuestionStatus, "resolved">;
  resolution: string;
  resolutionSources: string[];
}

interface FilingRulingResult {
  ok: boolean;
  ruling?: ResolverRuling;
  errorCode?: string;
  httpStatus?: number;
  openRouterRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

function resolverEvidencePacket(input: {
  question: ActiveQuestion;
  dossier: Dossier;
  allDocuments: ResolverEvidenceDocument[];
  newDocuments: ResolverEvidenceDocument[];
}): string {
  const documentLines = input.allDocuments.map((document) => {
    const changed = input.newDocuments.some((candidate) =>
      evidenceDocumentKey(candidate) === evidenceDocumentKey(document));
    return [
      changed ? "NEW_OR_CHANGED" : "PREVIOUSLY_ADMITTED",
      document.authority.toUpperCase(),
      document.publishedDate,
      document.publisher,
      document.title,
      document.url,
      document.contentSha256 ? `sha256=${document.contentSha256}` : "",
      document.evidenceState ? `state=${document.evidenceState}` : "",
    ].filter(Boolean).join(" · ");
  });
  const dossier = input.dossier;
  return [
    `QUESTION (opened ${input.question.publishedDate}; original vote ${input.question.votesYes}/${input.question.votesTotal}):`,
    input.question.question,
    "",
    "STANDING THESIS:",
    input.question.thesis,
    "",
    `ORACLE: ${input.question.oracle.trigger} · review by ${input.question.oracle.dueBy}`,
    "",
    "AUTHORITATIVE SOURCE MANIFEST:",
    documentLines.length > 0 ? documentLines.join("\n") : "NONE",
    "",
    `LATEST AUDITED DOSSIER · ${dossier.date} · audit ${dossier.briefAuditId ?? "unavailable"}`,
    "HEADLINE:",
    dossier.headline,
    "",
    "STORY:",
    dossier.story,
    "",
    "NUMBERS:",
    dossier.numbersRead,
    "",
    "BULL CASE:",
    dossier.bulls.join("\n"),
    "",
    "BEAR CASE:",
    dossier.bears.join("\n"),
    "",
    "RISK:",
    dossier.risk,
    "",
    "SOURCE NOTES:",
    dossier.sources,
  ].join("\n");
}

function resolverUsage(json: Record<string, unknown>): Pick<
  FilingRulingResult,
  "inputTokens" | "outputTokens" | "totalTokens" | "costUsd"
> {
  const raw = json.usage as Record<string, unknown> | undefined;
  if (!raw) return {};
  return {
    ...(Number.isFinite(raw.prompt_tokens) ? { inputTokens: Number(raw.prompt_tokens) } : {}),
    ...(Number.isFinite(raw.completion_tokens) ? { outputTokens: Number(raw.completion_tokens) } : {}),
    ...(Number.isFinite(raw.total_tokens) ? { totalTokens: Number(raw.total_tokens) } : {}),
    ...(Number.isFinite(raw.cost) ? { costUsd: Number(raw.cost) } : {}),
  };
}

function newAuthoritativeDocuments(
  prior: ResolverEvidenceDocument[] | undefined,
  current: ResolverEvidenceDocument[],
): ResolverEvidenceDocument[] {
  const previous = new Map((prior ?? []).map((document) => [
    evidenceDocumentKey(document),
    stableJson(document),
  ]));
  return current.filter((document) =>
    previous.get(evidenceDocumentKey(document)) !== stableJson(document));
}

/** Resolve due questions. Daily five-model reviews are authoritative receipts.
 *  The registered adjudicator handles new authoritative evidence and periodic catch-up. */
export async function resolveDue(todayEt: string): Promise<{ checked: number; moved: number }> {
  const open = await listQuestions({ status: "open" });
  let moved = 0;
  for (const q of open) {
    try {
      if (q.oracle.type === "tape") {
        if (todayEt < q.oracle.dueBy) continue;
        const snap = await getTickerSnapshot(q.ticker);
        if (!snap?.price || q.priceAtPublish == null) continue;
        const chg = ((snap.price - q.priceAtPublish) / q.priceAtPublish) * 100;
        const yes = chg > 0; // tape question convention: yes == move held
        Object.assign(q, {
          status: yes ? "resolved_yes" : "resolved_no",
          resolvedAt: Date.now(),
          resolution: `Tape verdict at horizon: ${chg > 0 ? "+" : ""}${chg.toFixed(1)}% from publish — the move ${yes ? "held" : "faded"}.`,
          resolutionSources: ["market data"],
        } satisfies Partial<ActiveQuestion>);
        await save(q); moved++;
        continue;
      }

      const d = await getCachedDossier(q.ticker);
      if (!d) continue;

      const now = Date.now();
      const dossierDocuments = authoritativeEvidenceDocuments(d.citations);
      const documents = mergeEvidenceDocuments(q.resolver?.evidenceDocuments, dossierDocuments);
      const fingerprint = evidenceFingerprint(documents);
      const changedDocuments = newAuthoritativeDocuments(q.resolver?.evidenceDocuments, dossierDocuments);
      const hasPostPublicationEvidence = changedDocuments.some((document) =>
        document.publishedAt > q.publishedAt || document.publishedDate > q.publishedDate);

      let reason: ResolverRunReason | null = null;
      if (!q.resolver) {
        if (hasPostPublicationEvidence) {
          reason = "material_authoritative_evidence";
        } else if (todayEt >= q.oracle.dueBy && documents.length > 0) {
          reason = "lifecycle_milestone";
        } else {
          await initializeLegacyResolverBaseline(q, d, now);
          continue;
        }
      } else if (fingerprint !== q.resolver.lastEvidenceFingerprint) {
        reason = "material_authoritative_evidence";
      } else if (
        todayEt >= q.oracle.dueBy &&
        (
          q.resolver.lastCouncilReceiptDossierDate ??
          q.resolver.lastRuledDossierDate ??
          ""
        ) < q.oracle.dueBy &&
        documents.length > 0
      ) {
        reason = "lifecycle_milestone";
      } else if (
        documents.length > 0 &&
        now - (q.resolver.lastFullReconciliationAt ?? q.publishedAt) >= RESOLVER_RECONCILIATION_MS
      ) {
        reason = "scheduled_reconciliation";
      }
      if (!reason) continue;

      const attemptFingerprint = resolverAttemptFingerprint(fingerprint, reason, q, now);
      const claim = await claimResolverRun({
        q,
        documents,
        evidenceFingerprint: fingerprint,
        attemptFingerprint,
        now,
      });
      if (!claim) continue;

      const runId = randomUUID();
      const startedAt = Date.now();
      const result = await filingRuling({
        question: claim.question,
        dossier: d,
        allDocuments: documents,
        newDocuments: changedDocuments,
      });
      const completedAt = Date.now();

      if (!result.ok || !result.ruling) {
        const errorCode = result.errorCode ?? "resolver_failed";
        await finishResolverRun({
          q: claim.question,
          leaseToken: claim.leaseToken,
          evidenceFingerprint: fingerprint,
          attemptFingerprint,
          dossierDate: d.date,
          now: completedAt,
          errorCode,
        });
        await saveResolverTelemetry({
          id: runId,
          questionId: q.id,
          ticker: q.ticker,
          model: RESOLVER_MODEL,
          adjudicatorVersion: RESOLVER_ADJUDICATOR_VERSION,
          evidenceFingerprint: fingerprint,
          attemptFingerprint,
          reason,
          startedAt,
          completedAt,
          outcome: "failed",
          errorCode,
          ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
          ...(result.openRouterRequestId ? { openRouterRequestId: result.openRouterRequestId } : {}),
          ...(result.inputTokens != null ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens != null ? { outputTokens: result.outputTokens } : {}),
          ...(result.totalTokens != null ? { totalTokens: result.totalTokens } : {}),
          ...(result.costUsd != null ? { costUsd: result.costUsd } : {}),
        });
        continue;
      }

      const finished = await finishResolverRun({
        q: claim.question,
        leaseToken: claim.leaseToken,
        evidenceFingerprint: fingerprint,
        attemptFingerprint,
        dossierDate: d.date,
        now: completedAt,
        ruling: result.ruling,
      });
      await saveResolverTelemetry({
        id: runId,
        questionId: q.id,
        ticker: q.ticker,
        model: RESOLVER_MODEL,
        adjudicatorVersion: RESOLVER_ADJUDICATOR_VERSION,
        evidenceFingerprint: fingerprint,
        attemptFingerprint,
        reason,
        startedAt,
        completedAt,
        outcome: "succeeded",
        status: result.ruling.status,
        ...(result.openRouterRequestId ? { openRouterRequestId: result.openRouterRequestId } : {}),
        ...(result.inputTokens != null ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens != null ? { outputTokens: result.outputTokens } : {}),
        ...(result.totalTokens != null ? { totalTokens: result.totalTokens } : {}),
        ...(result.costUsd != null ? { costUsd: result.costUsd } : {}),
      });
      if (finished.saved && finished.question && finished.question.status !== q.status) moved++;
    } catch (e) {
      console.error(`[scoreboard] resolve ${q.id} failed: ${String(e).slice(0, 120)}`);
    }
  }
  return { checked: open.length, moved };
}

async function filingRuling(input: {
  question: ActiveQuestion;
  dossier: Dossier;
  allDocuments: ResolverEvidenceDocument[];
  newDocuments: ResolverEvidenceDocument[];
}): Promise<FilingRulingResult> {
  const key = process.env.OPENROUTER_API_KEY_AMM ?? process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, errorCode: "missing_openrouter_key" };
  const timeoutMs = Math.max(
    60_000,
    Math.min(15 * 60_000, Number(process.env.SCOREBOARD_RESOLVER_TIMEOUT_MS ?? 300_000)),
  );
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aftermarketmovers.com",
        "X-Title": "AMM Thesis Resolver",
      },
      body: JSON.stringify({
        model: RESOLVER_MODEL,
        usage: { include: true },
        messages: [
          {
            role: "system",
            content: [
              "You are the frontier adjudicator for a traceable equity-research thesis.",
              "Return STRICT JSON only:",
              '{"status":"resolved_yes|resolved_no|strengthened|weakened|reframed|open","resolution":"one plain sentence naming the deciding evidence and date","sources":["exact admitted source URLs"]}',
              "Use only facts attributable to PRIMARY or COMPANY documents in the authoritative source manifest.",
              "The complete dossier is supplied for context, but news, social commentary and price moves may identify a question; they NEVER resolve a fundamentals thesis.",
              "Recompute any arithmetic before relying on it. Do not infer a causal mechanism that the documents do not establish.",
              "If the authoritative documents do not materially change the answer, return open.",
              "Strengthened or weakened requires a concrete change in authoritative evidence.",
              "Resolved_yes or resolved_no requires the oracle to be answered by authoritative evidence.",
              "Reframed requires authoritative evidence that makes the original proposition materially incomplete.",
              "A wrong past call must be recorded plainly. Never soften it and never manufacture certainty.",
            ].join("\n"),
          },
          {
            role: "user",
            content: resolverEvidencePacket(input),
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const requestId = res.headers.get("x-request-id") ?? undefined;
    if (!res.ok) {
      return {
        ok: false,
        errorCode: `openrouter_http_${res.status}`,
        httpStatus: res.status,
        ...(requestId ? { openRouterRequestId: requestId } : {}),
      };
    }
    const j = await res.json() as Record<string, unknown>;
    const usage = resolverUsage(j);
    const choices = j.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const raw = String(choices?.[0]?.message?.content ?? "").replace(/```json?|```/g, "");
    const p = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      status?: unknown;
      resolution?: unknown;
      sources?: unknown[];
    };
    const status = String(p.status) as ResolverRuling["status"];
    const ok = ["resolved_yes", "resolved_no", "strengthened", "weakened", "reframed", "open"].includes(status);
    const resolution = String(p.resolution ?? "");
    const admittedUrls = new Set(input.allDocuments.map((document) => document.url));
    const resolutionSources = Array.isArray(p.sources)
      ? p.sources.map(String).filter((url: string) => admittedUrls.has(url)).slice(0, 8)
      : [];
    if (!ok || resolution.length < 15) {
      return {
        ok: false,
        errorCode: "invalid_resolver_output",
        ...(requestId ? { openRouterRequestId: requestId } : {}),
        ...usage,
      };
    }
    if (status !== "open" && resolutionSources.length === 0) {
      return {
        ok: false,
        errorCode: "resolver_output_missing_admitted_source",
        ...(requestId ? { openRouterRequestId: requestId } : {}),
        ...usage,
      };
    }
    return {
      ok: true,
      ruling: { status, resolution, resolutionSources },
      ...(String(j.id ?? requestId ?? "") ? {
        openRouterRequestId: String(j.id ?? requestId ?? ""),
      } : {}),
      ...usage,
    };
  } catch (error) {
    return { ok: false, errorCode: resolverErrorCode(error) };
  }
}

/** Resolutions in the last 24h touching the given tickers — the PRIOR THESIS line. */
export async function recentResolutions(tickers: string[], sinceMs: number): Promise<ActiveQuestion[]> {
  const closed = await listQuestions({ status: "closed", limit: 100 });
  const set = new Set(tickers.map((t) => t.toUpperCase()));
  return closed.filter((q) => set.has(q.ticker) && (q.resolvedAt ?? 0) >= sinceMs);
}
