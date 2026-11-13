import { Firestore } from "@google-cloud/firestore";
import {
  hydratePrivateSignalResearchRecord,
  privateSignalResolutionQueueKey,
  privateSignalTickerIssuedKey,
  resolvePrivateSignalOutcomes,
  verifyPrivateSignalRecordIntegrity,
  type HistoricalSignalEvent,
  type PrivateSignalCalibrationConfig,
  type PrivateSignalResearchRecord,
  type ResearchPriceBar,
} from "./privateSignalResearch";

const COLLECTION = "private_signal_research";
const useMemory = process.env.DESK_STORE === "memory";
const globalStore = globalThis as unknown as {
  __privateSignalResearchStore?: Map<string, PrivateSignalResearchRecord>;
};
const memoryStore = (globalStore.__privateSignalResearchStore ??=
  new Map<string, PrivateSignalResearchRecord>());

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

function assertIntegrity(record: PrivateSignalResearchRecord): void {
  const verified = verifyPrivateSignalRecordIntegrity(record);
  if (!verified.ok) {
    throw new Error(`private signal ${record.id || "<missing-id>"} integrity failure: ${verified.reason}`);
  }
}

function recordFromDocument(document: { id: string; data(): unknown }): PrivateSignalResearchRecord {
  const record = document.data() as PrivateSignalResearchRecord;
  if (record.id !== document.id) {
    throw new Error(`private signal document/id mismatch: ${document.id}`);
  }
  assertIntegrity(record);
  return record;
}

function sameImmutableRecord(
  left: PrivateSignalResearchRecord,
  right: PrivateSignalResearchRecord,
): boolean {
  assertIntegrity(left);
  assertIntegrity(right);
  return left.id === right.id &&
    left.immutableRecordSha256.digest === right.immutableRecordSha256.digest;
}

function assertAppendOnly(
  previous: PrivateSignalResearchRecord,
  next: PrivateSignalResearchRecord,
): void {
  if (!sameImmutableRecord(previous, next)) {
    throw new Error(`private signal ${previous.id} immutable hash conflict`);
  }
  if (previous.tickerIssuedKey !== next.tickerIssuedKey) {
    throw new Error(`private signal ${previous.id} attempted to rewrite ticker history key`);
  }
  if (previous.resolutionStatus === "complete" && next.resolutionStatus !== "complete") {
    throw new Error(`private signal ${previous.id} attempted to reopen completed resolution`);
  }
  if (
    previous.resolutionQueueKey && next.resolutionStatus !== "complete" &&
    previous.resolutionQueueKey !== next.resolutionQueueKey
  ) throw new Error(`private signal ${previous.id} attempted to rewrite resolution queue key`);
  if (
    previous.entryBinding &&
    previous.entryBinding.bindingSha256.digest !== next.entryBinding?.bindingSha256.digest
  ) throw new Error(`private signal ${previous.id} attempted to rewrite entry binding`);
  if (
    previous.issuanceBeta &&
    previous.issuanceBeta.betaSha256.digest !== next.issuanceBeta?.betaSha256.digest
  ) throw new Error(`private signal ${previous.id} attempted to rewrite issuance beta`);
  if (
    previous.calibration &&
    previous.calibrationSha256?.digest !== next.calibrationSha256?.digest
  ) throw new Error(`private signal ${previous.id} attempted to rewrite calibration`);
  for (const horizon of [10, 15] as const) {
    if (
      previous.outcomes[horizon] &&
      previous.outcomes[horizon]?.outcomeSha256.digest !== next.outcomes[horizon]?.outcomeSha256.digest
    ) throw new Error(`private signal ${previous.id} attempted to rewrite ${horizon}-session outcome`);
  }
}

/** Immutable, idempotent creation. Stored hashes are recomputed, never trusted. */
export async function savePrivateSignalResearch(
  record: PrivateSignalResearchRecord,
): Promise<"created" | "exists"> {
  assertIntegrity(record);
  if (useMemory) {
    const existing = memoryStore.get(record.id);
    if (existing) {
      if (!sameImmutableRecord(existing, record)) {
        throw new Error(`private signal ${record.id} immutable hash conflict`);
      }
      return "exists";
    }
    memoryStore.set(record.id, structuredClone(record));
    return "created";
  }
  const ref = firestore().collection(COLLECTION).doc(record.id);
  try {
    await ref.create(record);
    return "created";
  } catch (error) {
    const code = (error as { code?: number | string } | null)?.code;
    if (code !== 6 && code !== "6" && code !== "already-exists") throw error;
    const existing = await ref.get();
    if (!existing.exists || !sameImmutableRecord(existing.data() as PrivateSignalResearchRecord, record)) {
      throw new Error(`private signal ${record.id} immutable hash conflict`);
    }
    return "exists";
  }
}

export async function getPrivateSignalResearch(
  id: string,
): Promise<PrivateSignalResearchRecord | null> {
  const record = useMemory
    ? (() => {
        const stored = memoryStore.get(id) ?? null;
        if (stored && stored.id !== id) throw new Error(`private signal document/id mismatch: ${id}`);
        return stored;
      })()
    : await (async () => {
        const snapshot = await firestore().collection(COLLECTION).doc(id).get();
        return snapshot.exists ? recordFromDocument(snapshot) : null;
      })();
  if (!record) return null;
  assertIntegrity(record);
  return structuredClone(record);
}

function oldestFirst(records: PrivateSignalResearchRecord[]): PrivateSignalResearchRecord[] {
  return records.sort((left, right) =>
    left.issuedAt - right.issuedAt || left.id.localeCompare(right.id));
}

function allMemoryRecords(): PrivateSignalResearchRecord[] {
  const records = [...memoryStore.entries()].map(([id, record]) => {
    if (id !== record.id) throw new Error(`private signal document/id mismatch: ${id}`);
    return record;
  });
  records.forEach(assertIntegrity);
  return records;
}

export interface PrivateSignalQueueCursor {
  issuedAt: number;
  id: string;
}

/**
 * Cursor page for workers. A worker must follow nextCursor to null in each
 * sweep; permanently pending old observations then cannot starve newer ones.
 */
export async function listUnresolvedPrivateSignalPage(input?: {
  limit?: number;
  after?: PrivateSignalQueueCursor | null;
}): Promise<{
  records: PrivateSignalResearchRecord[];
  nextCursor: PrivateSignalQueueCursor | null;
}> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(input?.limit ?? 100)));
  const after = input?.after ?? null;
  if (!useMemory) {
    let query = firestore().collection(COLLECTION)
      .orderBy("resolutionQueueKey", "asc")
      .limit(safeLimit);
    if (after) query = query.startAfter(privateSignalResolutionQueueKey(after.issuedAt, after.id));
    const page = await query.get();
    const records = page.docs.map(recordFromDocument);
    const last = records.at(-1);
    return {
      records: records.map((record) => structuredClone(record)),
      nextCursor: page.size === safeLimit && last
        ? { issuedAt: last.issuedAt, id: last.id }
        : null,
    };
  }
  const unresolved = oldestFirst(
    allMemoryRecords().filter((record) => record.resolutionStatus !== "complete"),
  ).filter((record) => !after ||
    record.issuedAt > after.issuedAt ||
    (record.issuedAt === after.issuedAt && record.id > after.id));
  const records = unresolved.slice(0, safeLimit);
  const last = records.at(-1);
  return {
    records: records.map((record) => structuredClone(record)),
    nextCursor: records.length < unresolved.length && last
      ? { issuedAt: last.issuedAt, id: last.id }
      : null,
  };
}

/**
 * First-page convenience. Production paging uses the derived, unique
 * resolutionQueueKey. Completed records omit that field, so Firestore's
 * automatic single-field index never scans settled history.
 */
export async function listUnresolvedPrivateSignals(
  limit = 100,
): Promise<PrivateSignalResearchRecord[]> {
  return (await listUnresolvedPrivateSignalPage({ limit })).records;
}

export interface PrivateSignalTickerCursor {
  issuedAt: number;
  id: string;
}

/** One deterministic ticker-history page on an automatic single-field index. */
export async function listPrivateSignalsByTickerPage(input: {
  ticker: string;
  pageSize?: number;
  after?: PrivateSignalTickerCursor | null;
}): Promise<{
  records: PrivateSignalResearchRecord[];
  nextCursor: PrivateSignalTickerCursor | null;
}> {
  const symbol = input.ticker.trim().toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(symbol)) return { records: [], nextCursor: null };
  const pageSize = Math.max(1, Math.min(500, Math.floor(input.pageSize ?? 250)));
  const after = input.after ?? null;
  if (!useMemory) {
    const prefix = `${symbol}|`;
    let query = firestore().collection(COLLECTION)
      .orderBy("tickerIssuedKey", "asc")
      .endAt(`${prefix}\uf8ff`)
      .limit(pageSize);
    query = after
      ? query.startAfter(privateSignalTickerIssuedKey(symbol, after.issuedAt, after.id))
      : query.startAt(prefix);
    const page = await query.get();
    const records = page.docs.map(recordFromDocument);
    const last = records.at(-1);
    return {
      records: records.map((record) => structuredClone(record)),
      nextCursor: page.size === pageSize && last
        ? { issuedAt: last.issuedAt, id: last.id }
        : null,
    };
  }
  const records = oldestFirst(
    allMemoryRecords().filter((record) => record.ticker === symbol),
  ).filter((record) => !after ||
    record.issuedAt > after.issuedAt ||
    (record.issuedAt === after.issuedAt && record.id > after.id));
  const page = records.slice(0, pageSize);
  const last = page.at(-1);
  return {
    records: page.map((record) => structuredClone(record)),
    nextCursor: page.length < records.length && last
      ? { issuedAt: last.issuedAt, id: last.id }
      : null,
  };
}

/** Exhaustive convenience for calibration; never silently drops recent signals. */
export async function listPrivateSignalsByTicker(
  ticker: string,
): Promise<PrivateSignalResearchRecord[]> {
  const records: PrivateSignalResearchRecord[] = [];
  let after: PrivateSignalTickerCursor | null = null;
  do {
    const page = await listPrivateSignalsByTickerPage({ ticker, pageSize: 500, after });
    records.push(...page.records);
    after = page.nextCursor;
  } while (after);
  return records;
}

/** Resolve from transactional stored state so stale callers cannot overwrite. */
export async function resolveAndSavePrivateSignal(input: {
  record: PrivateSignalResearchRecord;
  stockBars: ResearchPriceBar[];
  spyBars: ResearchPriceBar[];
  resolvedAt?: number;
}): Promise<PrivateSignalResearchRecord> {
  assertIntegrity(input.record);
  if (useMemory) {
    const existing = memoryStore.get(input.record.id);
    if (!existing || !sameImmutableRecord(existing, input.record)) {
      throw new Error(`private signal ${input.record.id} changed during resolution`);
    }
    const resolved = resolvePrivateSignalOutcomes(
      existing,
      input.stockBars,
      input.spyBars,
      input.resolvedAt,
    );
    assertAppendOnly(existing, resolved);
    memoryStore.set(existing.id, structuredClone(resolved));
    return structuredClone(resolved);
  }
  const ref = firestore().collection(COLLECTION).doc(input.record.id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error(`private signal ${input.record.id} not found`);
    const existing = snapshot.data() as PrivateSignalResearchRecord;
    if (!sameImmutableRecord(existing, input.record)) {
      throw new Error(`private signal ${input.record.id} changed during resolution`);
    }
    const resolved = resolvePrivateSignalOutcomes(
      existing,
      input.stockBars,
      input.spyBars,
      input.resolvedAt,
    );
    assertAppendOnly(existing, resolved);
    transaction.set(ref, resolved);
    return resolved;
  });
}

/** Bind/retry entry and calibration append-only, using transactional state. */
export async function hydrateAndSavePrivateSignal(input: {
  record: PrivateSignalResearchRecord;
  stockBars: ResearchPriceBar[];
  spyBars: ResearchPriceBar[];
  historicalEvents: HistoricalSignalEvent[];
  boundAt?: number;
  config?: Partial<PrivateSignalCalibrationConfig>;
}): Promise<PrivateSignalResearchRecord> {
  assertIntegrity(input.record);
  const hydrate = (existing: PrivateSignalResearchRecord) =>
    hydratePrivateSignalResearchRecord({
      record: existing,
      stockBars: input.stockBars,
      spyBars: input.spyBars,
      historicalEvents: input.historicalEvents,
      boundAt: input.boundAt,
      config: input.config,
    });
  if (useMemory) {
    const existing = memoryStore.get(input.record.id);
    if (!existing || !sameImmutableRecord(existing, input.record)) {
      throw new Error(`private signal ${input.record.id} changed during hydration`);
    }
    const hydrated = hydrate(existing);
    assertAppendOnly(existing, hydrated);
    memoryStore.set(existing.id, structuredClone(hydrated));
    return structuredClone(hydrated);
  }
  const ref = firestore().collection(COLLECTION).doc(input.record.id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error(`private signal ${input.record.id} not found`);
    const existing = snapshot.data() as PrivateSignalResearchRecord;
    if (!sameImmutableRecord(existing, input.record)) {
      throw new Error(`private signal ${input.record.id} changed during hydration`);
    }
    const hydrated = hydrate(existing);
    assertAppendOnly(existing, hydrated);
    transaction.set(ref, hydrated);
    return hydrated;
  });
}
