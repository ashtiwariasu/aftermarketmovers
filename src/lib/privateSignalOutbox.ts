import { randomUUID } from "node:crypto";
import {
  Firestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from "@google-cloud/firestore";
import {
  researchHash,
  type VersionedResearchHash,
} from "./privateSignalResearch";

/**
 * Durable bridge from an admitted public dossier to private-only research.
 *
 * The payload deliberately contains no website cards, evidence corpus, model
 * transcripts, or other dossier fields. The exact gated v5 email hook is the
 * proposition being measured; the audit identifiers bind it back to the
 * immutable generation record.
 */

export const PRIVATE_SIGNAL_OUTBOX_COLLECTION = "private_signal_outbox";
export const PRIVATE_SIGNAL_OUTBOX_SCHEMA_VERSION = 1 as const;
export const PRIVATE_SIGNAL_OUTBOX_LEASE_MS = 10 * 60_000;

export interface PrivateSignalV5EmailHook {
  subjectPunchline: string;
  priorUpdate: {
    status: "strengthened" | "weakened" | "resolved" | "invalidated" | "replaced" | "open";
    text: string;
  } | null;
  whatChanged: string;
  thesis: string;
  question: string;
  primaryEvidence: string;
  secondaryEvidence: string[];
  signal: {
    eventType:
      | "earnings" | "guidance" | "regulatory" | "product" | "legal"
      | "capital" | "leadership" | "macro" | "other";
    direction: "UP" | "DOWN";
    strength: "GENTLE" | "MODERATE" | "STRONG";
    horizonSessions: { min: 10; max: 15 };
  };
  votesSupport: number;
  votesOppose: number;
  votesUncertain: number;
  votesTotal: 5;
  votes: { support: number; oppose: number; uncertain: number };
  confidence: {
    majorityReason: string;
    dissentReason: string | null;
    uncertaintyReason: string | null;
    flipCondition: string;
  };
  oracle: {
    type: "filing" | "tape";
    trigger: string;
    dueBy: string;
  };
  editorialStrength: {
    novelty: number;
    materiality: number;
    evidence: number;
    asymmetry: number;
    score: number;
  };
}

export interface PrivateSignalDossierProjection {
  ticker: string;
  date: string;
  generatedAt: number;
  artifactVersion: 5;
  briefAuditId: string;
  councilRunId: string;
  emailHook: PrivateSignalV5EmailHook;
}

export type PrivateSignalOutboxStatus = "queued" | "leased" | "complete";

export interface PrivateSignalOutboxItem {
  id: string;
  schemaVersion: typeof PRIVATE_SIGNAL_OUTBOX_SCHEMA_VERSION;
  payload: PrivateSignalDossierProjection;
  payloadSha256: VersionedResearchHash;
  emailHookSha256: VersionedResearchHash;
  status: PrivateSignalOutboxStatus;
  createdAt: number;
  availableAt: number;
  attempts: number;
  /** Stable, immutable single-field index. Completed items omit it. */
  queueKey?: string;
  /**
   * Stable per-ticker chronological index. A worker may materialize an item
   * only when no smaller incomplete key exists for the same ticker.
   * Completed items omit it so the predecessor query scans pending work only.
   */
  tickerOrderKey?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  completedAt?: number;
  privateSignalId?: string;
}

export interface PrivateSignalOutboxCursor {
  createdAt: number;
  id: string;
}

export type PrivateSignalOutboxClaim =
  | { status: "claimed"; item: PrivateSignalOutboxItem }
  | {
      status: "busy" | "not_due" | "blocked_predecessor" | "complete";
      item: PrivateSignalOutboxItem;
    }
  | { status: "missing"; item: null };

const useMemory = process.env.DESK_STORE === "memory";
const globalStore = globalThis as unknown as {
  __privateSignalOutboxStore?: Map<string, PrivateSignalOutboxItem>;
};
const memoryStore = (globalStore.__privateSignalOutboxStore ??=
  new Map<string, PrivateSignalOutboxItem>());

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function expectedQuestion(subjectPunchline: string): string {
  const cleaned = subjectPunchline.trim().replace(/[.!?;:\s]+$/g, "");
  return `Is it true that ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}?`;
}

function addOracleDays(value: string, days: number, businessDays: boolean): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (!businessDays || (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return keys.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function exactKeysWithOptional(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function newYorkDateAt(timestamp: number): string | null {
  if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return value.year && value.month && value.day
    ? `${value.year}-${value.month}-${value.day}`
    : null;
}

function validExactV5EmailHook(value: unknown, asOfDate: string): value is PrivateSignalV5EmailHook {
  if (!isRecord(value) || !exactKeys(value, [
    "subjectPunchline", "priorUpdate", "whatChanged", "thesis", "question", "primaryEvidence",
    "secondaryEvidence", "signal", "votesSupport", "votesOppose", "votesUncertain",
    "votesTotal", "votes", "confidence", "oracle", "editorialStrength",
  ])) return false;
  for (const field of ["subjectPunchline", "whatChanged", "thesis", "primaryEvidence"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) return false;
  }
  if (value.question !== expectedQuestion(value.subjectPunchline as string)) return false;
  if (!Array.isArray(value.secondaryEvidence) || value.secondaryEvidence.length < 2 ||
      value.secondaryEvidence.length > 3 ||
      !value.secondaryEvidence.every((entry) => typeof entry === "string" && entry.trim())) {
    return false;
  }
  if (value.priorUpdate !== null) {
    if (!isRecord(value.priorUpdate) || !exactKeys(value.priorUpdate, ["status", "text"]) ||
        !["strengthened", "weakened", "resolved", "invalidated", "replaced", "open"].includes(String(value.priorUpdate.status)) ||
        typeof value.priorUpdate.text !== "string" || !value.priorUpdate.text.trim()) return false;
  }
  if (!isRecord(value.signal) || !exactKeys(value.signal, [
    "eventType", "direction", "strength", "horizonSessions",
  ]) || ![
    "earnings", "guidance", "regulatory", "product", "legal",
    "capital", "leadership", "macro", "other",
  ].includes(String(value.signal.eventType)) ||
      !["UP", "DOWN"].includes(String(value.signal.direction)) ||
      !["GENTLE", "MODERATE", "STRONG"].includes(String(value.signal.strength)) ||
      !isRecord(value.signal.horizonSessions) ||
      !exactKeys(value.signal.horizonSessions, ["min", "max"]) ||
      value.signal.horizonSessions.min !== 10 || value.signal.horizonSessions.max !== 15) return false;

  const votes: unknown[] = [value.votesSupport, value.votesOppose, value.votesUncertain];
  const voteTotal = Number(value.votesSupport) + Number(value.votesOppose) + Number(value.votesUncertain);
  if (value.votesTotal !== 5 || votes.some((vote) => !Number.isInteger(vote) || Number(vote) < 0) ||
      Number(value.votesSupport) < 3 || voteTotal !== 5) {
    return false;
  }
  if (!isRecord(value.votes) || !exactKeys(value.votes, ["support", "oppose", "uncertain"]) ||
      value.votes.support !== value.votesSupport || value.votes.oppose !== value.votesOppose ||
      value.votes.uncertain !== value.votesUncertain) return false;
  if (!isRecord(value.confidence) || !exactKeys(value.confidence, [
    "majorityReason", "dissentReason", "uncertaintyReason", "flipCondition",
  ]) || typeof value.confidence.majorityReason !== "string" || !value.confidence.majorityReason.trim() ||
      typeof value.confidence.flipCondition !== "string" || !value.confidence.flipCondition.trim() ||
      !(value.confidence.dissentReason === null || typeof value.confidence.dissentReason === "string") ||
      !(value.confidence.uncertaintyReason === null || typeof value.confidence.uncertaintyReason === "string")) {
    return false;
  }
  if ((Number(value.votesOppose) > 0) !== Boolean(value.confidence.dissentReason?.trim()) ||
      (Number(value.votesUncertain) > 0) !== Boolean(value.confidence.uncertaintyReason?.trim())) {
    return false;
  }
  const filingLike = ["earnings", "guidance", "capital"].includes(String(value.signal.eventType)) ||
    /\b(?:filing|10-[kq]|quarter(?:ly)?|earnings|results|cash flow|margin|revenue|income|guidance)\b/i.test(
      String(value.confidence.flipCondition).replace(/\[S\d+\]/g, ""),
    );
  const expectedOracle = {
    type: filingLike ? "filing" : "tape",
    trigger: value.confidence.flipCondition,
    dueBy: addOracleDays(asOfDate, filingLike ? 120 : 15, !filingLike),
  };
  if (!isRecord(value.oracle) || !exactKeys(value.oracle, ["type", "trigger", "dueBy"]) ||
      JSON.stringify(value.oracle) !== JSON.stringify(expectedOracle)) return false;
  if (!isRecord(value.editorialStrength) || !exactKeys(value.editorialStrength, [
    "novelty", "materiality", "evidence", "asymmetry", "score",
  ])) return false;
  const dimensions = [
    value.editorialStrength.novelty,
    value.editorialStrength.materiality,
    value.editorialStrength.evidence,
    value.editorialStrength.asymmetry,
  ].map(Number);
  if (dimensions.some((dimension) => !Number.isInteger(dimension) || dimension < 1 || dimension > 5)) {
    return false;
  }
  const expectedScore = Math.round((
    dimensions[0] * 0.30 + dimensions[1] * 0.25 +
    dimensions[2] * 0.25 + dimensions[3] * 0.20
  ) / 5 * 100);
  return Number.isInteger(value.editorialStrength.score) &&
    value.editorialStrength.score === expectedScore;
}

function issuedAtKey(value: number): string {
  return String(Math.floor(value)).padStart(16, "0");
}

export function privateSignalOutboxQueueKey(createdAt: number, id: string): string {
  return `${issuedAtKey(createdAt)}|${id}`;
}

export function privateSignalOutboxTickerOrderKey(
  ticker: string,
  createdAt: number,
  id: string,
): string {
  return `${ticker.toUpperCase()}|${issuedAtKey(createdAt)}|${id}`;
}

function exactProjection(input: {
  ticker: string;
  date: string;
  generatedAt: number;
  artifactVersion: number;
  briefAuditId?: string;
  councilRunId?: string;
  emailHook: PrivateSignalV5EmailHook;
}): PrivateSignalDossierProjection {
  const ticker = input.ticker.trim().toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) {
    throw new Error("private signal outbox rejected invalid ticker");
  }
  if (!validDate(input.date)) {
    throw new Error("private signal outbox rejected invalid dossier date");
  }
  if (!Number.isInteger(input.generatedAt) || input.generatedAt <= 0) {
    throw new Error("private signal outbox rejected invalid generation timestamp");
  }
  if (newYorkDateAt(input.generatedAt) !== input.date) {
    throw new Error("private signal outbox dossier date must equal its America/New_York generation date");
  }
  if (input.artifactVersion !== 5) {
    throw new Error("private signal outbox accepts only exact v5 dossiers");
  }
  const briefAuditId = input.briefAuditId?.trim() ?? "";
  const councilRunId = input.councilRunId?.trim() ?? "";
  if (!briefAuditId || !councilRunId) {
    throw new Error("private signal outbox requires immutable audit ids");
  }
  if (!validExactV5EmailHook(input.emailHook, input.date)) {
    throw new Error("private signal outbox requires the exact nested v5 email hook schema");
  }
  return structuredClone({
    ticker,
    date: input.date,
    generatedAt: input.generatedAt,
    artifactVersion: 5 as const,
    briefAuditId,
    councilRunId,
    emailHook: input.emailHook,
  });
}

/** Build the deterministic record staged beside the final dossier write. */
export function buildPrivateSignalOutboxItem(input: {
  ticker: string;
  date: string;
  generatedAt: number;
  artifactVersion: number;
  briefAuditId?: string;
  councilRunId?: string;
  emailHook: PrivateSignalV5EmailHook;
}): PrivateSignalOutboxItem {
  const payload = exactProjection(input);
  const payloadSha256 = researchHash(payload);
  const emailHookSha256 = researchHash(payload.emailHook);
  const id = payloadSha256.digest.slice(0, 48);
  return {
    id,
    schemaVersion: PRIVATE_SIGNAL_OUTBOX_SCHEMA_VERSION,
    payload,
    payloadSha256,
    emailHookSha256,
    status: "queued",
    createdAt: payload.generatedAt,
    availableAt: payload.generatedAt,
    attempts: 0,
    queueKey: privateSignalOutboxQueueKey(payload.generatedAt, id),
    tickerOrderKey: privateSignalOutboxTickerOrderKey(payload.ticker, payload.generatedAt, id),
  };
}

function assertItemIntegrity(item: PrivateSignalOutboxItem): void {
  if (!isRecord(item)) {
    throw new Error("private signal outbox <missing-id> is not an object");
  }
  const baseKeys = [
    "id", "schemaVersion", "payload", "payloadSha256", "emailHookSha256",
    "status", "createdAt", "availableAt", "attempts",
  ];
  const status = String(item.status);
  const exactTopLevel = status === "queued"
    ? exactKeysWithOptional(item, [...baseKeys, "queueKey", "tickerOrderKey"], ["lastError"])
    : status === "leased"
      ? exactKeysWithOptional(
          item,
          [...baseKeys, "queueKey", "tickerOrderKey", "leaseOwner", "leaseToken", "leaseExpiresAt"],
          ["lastError"],
        )
      : status === "complete"
        ? exactKeysWithOptional(item, [...baseKeys, "completedAt", "privateSignalId"])
        : false;
  if (!exactTopLevel) {
    throw new Error(`private signal outbox ${item.id || "<missing-id>"} has invalid status-specific keys`);
  }
  if (!isRecord(item?.payload) || !exactKeys(item.payload, [
    "ticker", "date", "generatedAt", "artifactVersion", "briefAuditId", "councilRunId", "emailHook",
  ])) {
    throw new Error(`private signal outbox ${item?.id || "<missing-id>"} payload is not the compact exact projection`);
  }
  exactProjection(item.payload);
  const expectedHash = researchHash(item.payload);
  const expectedHookHash = researchHash(item.payload.emailHook);
  const expectedId = expectedHash.digest.slice(0, 48);
  if (
    item.schemaVersion !== PRIVATE_SIGNAL_OUTBOX_SCHEMA_VERSION ||
    item.id !== expectedId ||
    item.payloadSha256.digest !== expectedHash.digest ||
    item.payloadSha256.algorithm !== expectedHash.algorithm ||
    item.payloadSha256.canonicalization !== expectedHash.canonicalization
  ) {
    throw new Error(`private signal outbox ${item.id || "<missing-id>"} integrity failure`);
  }
  if (item.emailHookSha256.digest !== expectedHookHash.digest ||
      item.emailHookSha256.algorithm !== expectedHookHash.algorithm ||
      item.emailHookSha256.canonicalization !== expectedHookHash.canonicalization) {
    throw new Error(`private signal outbox ${item.id} email hook hash mismatch`);
  }
  if (
    item.createdAt !== item.payload.generatedAt ||
    !Number.isInteger(item.availableAt) || item.availableAt <= 0 ||
    !Number.isInteger(item.attempts) || item.attempts < 0 ||
    !["queued", "leased", "complete"].includes(String(item.status))
  ) {
    throw new Error(`private signal outbox ${item.id} invalid queue metadata`);
  }
  const expectedQueueKey = privateSignalOutboxQueueKey(item.createdAt, item.id);
  const expectedTickerOrderKey = privateSignalOutboxTickerOrderKey(
    item.payload.ticker,
    item.createdAt,
    item.id,
  );
  if (item.status === "complete") {
    if (item.queueKey !== undefined || item.tickerOrderKey !== undefined ||
        !item.completedAt || !item.privateSignalId) {
      throw new Error(`private signal outbox ${item.id} invalid completion state`);
    }
    return;
  }
  if (item.queueKey !== expectedQueueKey || item.tickerOrderKey !== expectedTickerOrderKey) {
    throw new Error(`private signal outbox ${item.id} invalid queue ordering keys`);
  }
  if (item.lastError !== undefined &&
      (typeof item.lastError !== "string" || !item.lastError.trim() || item.lastError.length > 500)) {
    throw new Error(`private signal outbox ${item.id} invalid last error`);
  }
  if (item.status === "leased") {
    if (!item.leaseOwner || !item.leaseToken || !Number.isInteger(item.leaseExpiresAt) || Number(item.leaseExpiresAt) <= 0) {
      throw new Error(`private signal outbox ${item.id} invalid lease`);
    }
  } else if (item.leaseOwner !== undefined || item.leaseToken !== undefined || item.leaseExpiresAt !== undefined) {
    throw new Error(`private signal outbox ${item.id} queued with a lease`);
  }
}

function itemFromDocument(document: { id: string; data(): unknown }): PrivateSignalOutboxItem {
  const item = document.data() as PrivateSignalOutboxItem;
  if (item.id !== document.id) {
    throw new Error(`private signal outbox document/id mismatch: ${document.id}`);
  }
  assertItemIntegrity(item);
  return item;
}

function sameImmutablePayload(
  existing: PrivateSignalOutboxItem,
  proposed: PrivateSignalOutboxItem,
): boolean {
  assertItemIntegrity(existing);
  assertItemIntegrity(proposed);
  return existing.id === proposed.id &&
    existing.payloadSha256.digest === proposed.payloadSha256.digest;
}

/**
 * Memory equivalent of the Firestore publication transaction. This performs
 * every validation before mutating the map, so the caller can set the dossier
 * in the same synchronous critical section without a partial queue record.
 */
export function enqueuePrivateSignalOutboxInMemory(
  item: PrivateSignalOutboxItem,
): "created" | "exists" {
  assertItemIntegrity(item);
  const existing = memoryStore.get(item.id);
  if (existing) {
    if (!sameImmutablePayload(existing, item)) {
      throw new Error(`private signal outbox ${item.id} immutable payload conflict`);
    }
    return "exists";
  }
  memoryStore.set(item.id, structuredClone(item));
  return "created";
}

/** Stage an idempotent outbox create inside the caller's Firestore transaction. */
export function enqueuePrivateSignalOutboxInTransaction(
  transaction: Transaction,
  reference: DocumentReference,
  snapshot: DocumentSnapshot,
  item: PrivateSignalOutboxItem,
): "created" | "exists" {
  assertItemIntegrity(item);
  if (snapshot.exists) {
    const existing = itemFromDocument({ id: snapshot.id, data: () => snapshot.data() });
    if (!sameImmutablePayload(existing, item)) {
      throw new Error(`private signal outbox ${item.id} immutable payload conflict`);
    }
    return "exists";
  }
  transaction.set(reference, item);
  return "created";
}

/** Standalone enqueue is reserved for explicit migrations/backfills. */
export async function enqueuePrivateSignalOutbox(
  item: PrivateSignalOutboxItem,
): Promise<"created" | "exists"> {
  if (useMemory) return enqueuePrivateSignalOutboxInMemory(item);
  const ref = firestore().collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION).doc(item.id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    return enqueuePrivateSignalOutboxInTransaction(transaction, ref, snapshot, item);
  });
}

export async function getPrivateSignalOutboxItem(
  id: string,
): Promise<PrivateSignalOutboxItem | null> {
  const item = useMemory
    ? memoryStore.get(id) ?? null
    : await (async () => {
        const snapshot = await firestore()
          .collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION)
          .doc(id)
          .get();
        return snapshot.exists ? itemFromDocument(snapshot) : null;
      })();
  if (!item) return null;
  assertItemIntegrity(item);
  return structuredClone(item);
}

export async function listPrivateSignalOutboxPage(input: {
  after?: PrivateSignalOutboxCursor | null;
  limit?: number;
} = {}): Promise<{
  records: PrivateSignalOutboxItem[];
  nextCursor: PrivateSignalOutboxCursor | null;
}> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
  const after = input.after ?? null;
  if (!useMemory) {
    let query = firestore()
      .collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION)
      .orderBy("queueKey", "asc")
      .limit(limit);
    if (after) query = query.startAfter(privateSignalOutboxQueueKey(after.createdAt, after.id));
    const page = await query.get();
    const records = page.docs.map(itemFromDocument);
    const last = records.at(-1);
    return {
      records: records.map((record) => structuredClone(record)),
      nextCursor: page.size === limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
    };
  }
  const records = [...memoryStore.values()]
    .filter((item) => item.status !== "complete")
    .map((item) => {
      assertItemIntegrity(item);
      return item;
    })
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .filter((item) => !after || item.createdAt > after.createdAt ||
      (item.createdAt === after.createdAt && item.id > after.id));
  const page = records.slice(0, limit);
  const last = page.at(-1);
  return {
    records: page.map((record) => structuredClone(record)),
    nextCursor: page.length < records.length && last
      ? { createdAt: last.createdAt, id: last.id }
      : null,
  };
}

function claimState(
  existing: PrivateSignalOutboxItem,
  workerId: string,
  leaseToken: string,
  now: number,
  leaseMs: number,
  hasIncompletePredecessor: boolean,
): PrivateSignalOutboxClaim {
  assertItemIntegrity(existing);
  if (existing.status === "complete") {
    return { status: "complete", item: structuredClone(existing) };
  }
  if (hasIncompletePredecessor) {
    return { status: "blocked_predecessor", item: structuredClone(existing) };
  }
  if (existing.status === "leased" && Number(existing.leaseExpiresAt) > now) {
    return { status: "busy", item: structuredClone(existing) };
  }
  if (existing.status === "queued" && existing.availableAt > now) {
    return { status: "not_due", item: structuredClone(existing) };
  }
  const claimed: PrivateSignalOutboxItem = {
    ...existing,
    status: "leased",
    attempts: existing.attempts + 1,
    leaseOwner: workerId,
    leaseToken,
    leaseExpiresAt: now + leaseMs,
  };
  assertItemIntegrity(claimed);
  return { status: "claimed", item: claimed };
}

export async function claimPrivateSignalOutboxItem(input: {
  id: string;
  workerId: string;
  now?: number;
  leaseMs?: number;
  leaseToken?: string;
}): Promise<PrivateSignalOutboxClaim> {
  const workerId = input.workerId.trim();
  if (!workerId) throw new Error("private signal outbox claim requires worker id");
  const now = Math.floor(input.now ?? Date.now());
  const leaseMs = Math.max(1_000, Math.floor(input.leaseMs ?? PRIVATE_SIGNAL_OUTBOX_LEASE_MS));
  const leaseToken = input.leaseToken?.trim() || randomUUID();
  if (useMemory) {
    const existing = memoryStore.get(input.id);
    if (!existing) return { status: "missing", item: null };
    assertItemIntegrity(existing);
    const hasIncompletePredecessor = existing.status !== "complete" &&
      [...memoryStore.values()].some((candidate) => {
        assertItemIntegrity(candidate);
        return candidate.status !== "complete" &&
          candidate.payload.ticker === existing.payload.ticker &&
          candidate.tickerOrderKey! < existing.tickerOrderKey!;
      });
    const result = claimState(
      existing,
      workerId,
      leaseToken,
      now,
      leaseMs,
      hasIncompletePredecessor,
    );
    if (result.status === "claimed") memoryStore.set(input.id, structuredClone(result.item));
    return result;
  }
  const ref = firestore().collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION).doc(input.id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { status: "missing", item: null } as const;
    const existing = itemFromDocument(snapshot);
    let hasIncompletePredecessor = false;
    if (existing.status !== "complete") {
      const predecessorQuery = firestore()
        .collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION)
        .where("tickerOrderKey", ">=", `${existing.payload.ticker}|`)
        .where("tickerOrderKey", "<", existing.tickerOrderKey!)
        .orderBy("tickerOrderKey", "asc")
        .limit(1);
      const predecessors = await transaction.get(predecessorQuery);
      hasIncompletePredecessor = !predecessors.empty;
      if (!predecessors.empty) itemFromDocument(predecessors.docs[0]);
    }
    const result = claimState(
      existing,
      workerId,
      leaseToken,
      now,
      leaseMs,
      hasIncompletePredecessor,
    );
    if (result.status === "claimed") transaction.set(ref, result.item);
    return result;
  });
}

function requireOwnedLease(item: PrivateSignalOutboxItem, workerId: string, leaseToken: string): void {
  if (item.status !== "leased" || item.leaseOwner !== workerId || item.leaseToken !== leaseToken) {
    throw new Error(`private signal outbox ${item.id} lease is not owned by ${workerId}`);
  }
}

export async function completePrivateSignalOutboxItem(input: {
  id: string;
  workerId: string;
  leaseToken: string;
  privateSignalId: string;
  completedAt?: number;
}): Promise<PrivateSignalOutboxItem> {
  const completedAt = Math.floor(input.completedAt ?? Date.now());
  const privateSignalId = input.privateSignalId.trim();
  if (!privateSignalId) throw new Error("private signal outbox completion requires research id");
  const complete = (existing: PrivateSignalOutboxItem): PrivateSignalOutboxItem => {
    assertItemIntegrity(existing);
    if (existing.status === "complete") {
      if (existing.privateSignalId !== privateSignalId) {
        throw new Error(`private signal outbox ${existing.id} completion conflict`);
      }
      return existing;
    }
    requireOwnedLease(existing, input.workerId, input.leaseToken);
    const next: PrivateSignalOutboxItem = {
      id: existing.id,
      schemaVersion: existing.schemaVersion,
      payload: existing.payload,
      payloadSha256: existing.payloadSha256,
      emailHookSha256: existing.emailHookSha256,
      status: "complete",
      createdAt: existing.createdAt,
      availableAt: existing.availableAt,
      attempts: existing.attempts,
      completedAt,
      privateSignalId,
    };
    assertItemIntegrity(next);
    return next;
  };
  if (useMemory) {
    const existing = memoryStore.get(input.id);
    if (!existing) throw new Error(`private signal outbox ${input.id} not found`);
    const completed = complete(existing);
    memoryStore.set(input.id, structuredClone(completed));
    return structuredClone(completed);
  }
  const ref = firestore().collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION).doc(input.id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error(`private signal outbox ${input.id} not found`);
    const completed = complete(itemFromDocument(snapshot));
    transaction.set(ref, completed);
    return completed;
  });
}

export function privateSignalRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(8, Math.floor(attempts) - 1));
  return Math.min(6 * 60 * 60_000, 60_000 * (2 ** exponent));
}

export async function failPrivateSignalOutboxItem(input: {
  id: string;
  workerId: string;
  leaseToken: string;
  error: unknown;
  failedAt?: number;
  retryDelayMs?: number;
}): Promise<PrivateSignalOutboxItem> {
  const failedAt = Math.floor(input.failedAt ?? Date.now());
  const fail = (existing: PrivateSignalOutboxItem): PrivateSignalOutboxItem => {
    assertItemIntegrity(existing);
    if (existing.status === "complete") return existing;
    requireOwnedLease(existing, input.workerId, input.leaseToken);
    const retryDelayMs = Math.max(1_000, Math.floor(
      input.retryDelayMs ?? privateSignalRetryDelayMs(existing.attempts),
    ));
    const next: PrivateSignalOutboxItem = {
      id: existing.id,
      schemaVersion: existing.schemaVersion,
      payload: existing.payload,
      payloadSha256: existing.payloadSha256,
      emailHookSha256: existing.emailHookSha256,
      status: "queued",
      createdAt: existing.createdAt,
      availableAt: failedAt + retryDelayMs,
      attempts: existing.attempts,
      queueKey: privateSignalOutboxQueueKey(existing.createdAt, existing.id),
      tickerOrderKey: privateSignalOutboxTickerOrderKey(
        existing.payload.ticker,
        existing.createdAt,
        existing.id,
      ),
      lastError: String(input.error).slice(0, 500),
    };
    assertItemIntegrity(next);
    return next;
  };
  if (useMemory) {
    const existing = memoryStore.get(input.id);
    if (!existing) throw new Error(`private signal outbox ${input.id} not found`);
    const failed = fail(existing);
    memoryStore.set(input.id, structuredClone(failed));
    return structuredClone(failed);
  }
  const ref = firestore().collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION).doc(input.id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error(`private signal outbox ${input.id} not found`);
    const failed = fail(itemFromDocument(snapshot));
    transaction.set(ref, failed);
    return failed;
  });
}
