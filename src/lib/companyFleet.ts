import {
  type CollectionReference,
  FieldPath,
  Firestore,
  type DocumentData,
  type QueryDocumentSnapshot,
  type WriteBatch,
} from "@google-cloud/firestore";
import { isDeskServiceActive, listAllDesks, type Desk } from "@/lib/desk";

export const COMPANY_FLEET_SCHEMA = "company-fleet-v1" as const;
export const COMPANY_FLEET_COLLECTION = "company_fleet";

export interface CompanyFleetRecord {
  symbol: string;
  schema: typeof COMPANY_FLEET_SCHEMA;
  active: boolean;
  watcherCount: number;
  createdAt: number;
  activatedAt: number;
  pausedAt?: number;
  updatedAt: number;
}

export interface CompanyFleetMembership {
  deskId: string;
  symbol: string;
  schema: typeof COMPANY_FLEET_SCHEMA;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyFleetSnapshot {
  tickers: string[];
  watchersByTicker: Map<string, Set<string>>;
}

export interface CompanyFleetReconciliation {
  active: string[];
  paused: string[];
  membershipsAdded: number;
  membershipsRemoved: number;
}

const useMemory = process.env.DESK_STORE === "memory";
const globalStore = globalThis as unknown as {
  __companyFleetRecords?: Map<string, CompanyFleetRecord>;
  __companyFleetMemberships?: Map<string, Map<string, CompanyFleetMembership>>;
};
const memoryRecords = (globalStore.__companyFleetRecords ??= new Map());
const memoryMemberships = (globalStore.__companyFleetMemberships ??= new Map());

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

function normalizeTicker(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : null;
}

function normalizedTickers(tickers: readonly string[]): string[] {
  return [...new Set(tickers.flatMap((ticker) => {
    const normalized = normalizeTicker(ticker);
    return normalized ? [normalized] : [];
  }))].sort((left, right) => left.localeCompare(right));
}

/**
 * Build the one canonical active-company fleet from desk membership.
 *
 * Desk membership—not recent activity—is the lifecycle authority. A selected
 * supported ticker remains active until every active desk removes it. Coverage
 * policy pauses are excluded without deleting any company artifacts.
 */
export function companyFleetSnapshot(desks: readonly Desk[]): CompanyFleetSnapshot {
  const watchersByTicker = new Map<string, Set<string>>();
  for (const desk of desks) {
    if (desk.researchActive === false || !isDeskServiceActive(desk)) continue;
    for (const symbol of normalizedTickers(desk.tickers)) {
      if (desk.supportPaused?.[symbol]) continue;
      const watchers = watchersByTicker.get(symbol) ?? new Set<string>();
      watchers.add(desk.id);
      watchersByTicker.set(symbol, watchers);
    }
  }
  return {
    tickers: [...watchersByTicker.keys()].sort((left, right) => left.localeCompare(right)),
    watchersByTicker,
  };
}

function activeRecord(
  symbol: string,
  watcherCount: number,
  now: number,
  existing?: CompanyFleetRecord,
): CompanyFleetRecord {
  const wasActive = existing?.active === true;
  return {
    symbol,
    schema: COMPANY_FLEET_SCHEMA,
    active: true,
    watcherCount,
    createdAt: existing?.createdAt ?? now,
    activatedAt: wasActive ? existing.activatedAt : now,
    updatedAt: now,
  };
}

function pausedRecord(
  symbol: string,
  now: number,
  existing?: CompanyFleetRecord,
): CompanyFleetRecord {
  return {
    symbol,
    schema: COMPANY_FLEET_SCHEMA,
    active: false,
    watcherCount: 0,
    createdAt: existing?.createdAt ?? now,
    activatedAt: existing?.activatedAt ?? now,
    pausedAt: existing?.active === false ? existing.pausedAt ?? now : now,
    updatedAt: now,
  };
}

function membership(deskId: string, symbol: string, now: number): CompanyFleetMembership {
  return {
    deskId,
    symbol,
    schema: COMPANY_FLEET_SCHEMA,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Immediately mirror one desk edit into the shared fleet. The watcher document
 * is the idempotency key, so retries cannot inflate counts.
 */
export async function syncDeskFleetMembership(
  deskId: string,
  beforeTickers: readonly string[],
  afterTickers: readonly string[],
  now = Date.now(),
): Promise<void> {
  if (!/^[0-9a-zA-Z_-]{10,128}$/.test(deskId)) throw new Error("invalid desk id");
  const before = normalizedTickers(beforeTickers);
  const after = new Set(normalizedTickers(afterTickers));
  const symbols = [...new Set([...before, ...after])].sort((left, right) => left.localeCompare(right));

  if (useMemory) {
    for (const symbol of symbols) {
      const watchers = memoryMemberships.get(symbol) ?? new Map<string, CompanyFleetMembership>();
      const existingMembership = watchers.get(deskId);
      if (after.has(symbol) && !existingMembership) {
        watchers.set(deskId, membership(deskId, symbol, now));
      } else if (!after.has(symbol) && existingMembership) {
        watchers.delete(deskId);
      }
      memoryMemberships.set(symbol, watchers);
      const existing = memoryRecords.get(symbol);
      memoryRecords.set(
        symbol,
        watchers.size > 0
          ? activeRecord(symbol, watchers.size, now, existing)
          : pausedRecord(symbol, now, existing),
      );
    }
    return;
  }

  for (const symbol of symbols) {
    const fleetRef = firestore().collection(COMPANY_FLEET_COLLECTION).doc(symbol);
    const watcherRef = fleetRef.collection("watchers").doc(deskId);
    await firestore().runTransaction(async (tx) => {
      const [fleetSnapshot, watcherSnapshot] = await Promise.all([
        tx.get(fleetRef),
        tx.get(watcherRef),
      ]);
      const existing = fleetSnapshot.exists
        ? fleetSnapshot.data() as CompanyFleetRecord
        : undefined;
      const wantsMembership = after.has(symbol);
      let watcherCount = Math.max(0, Number(existing?.watcherCount ?? 0));

      if (wantsMembership && !watcherSnapshot.exists) {
        tx.create(watcherRef, membership(deskId, symbol, now));
        watcherCount += 1;
      } else if (wantsMembership && watcherSnapshot.exists) {
        // A watcher document is the idempotency authority. If an interrupted
        // repair left the materialized parent missing or at zero, never pause
        // a company that still has a durable watcher.
        watcherCount = Math.max(1, watcherCount);
      } else if (!wantsMembership && watcherSnapshot.exists) {
        tx.delete(watcherRef);
        watcherCount = Math.max(0, watcherCount - 1);
      }

      const next = watcherCount > 0
        ? activeRecord(symbol, watcherCount, now, existing)
        : pausedRecord(symbol, now, existing);
      tx.set(fleetRef, next);
    });
  }
}

async function allDocuments(
  collection: CollectionReference,
  pageSize = 400,
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const documents: QueryDocumentSnapshot<DocumentData>[] = [];
  let afterId: string | null = null;
  for (;;) {
    let query = collection.orderBy(FieldPath.documentId()).limit(pageSize);
    if (afterId) query = query.startAfter(afterId);
    const page = await query.get();
    documents.push(...page.docs);
    if (page.size < pageSize) break;
    afterId = page.docs.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return documents;
}

/**
 * Rebuild the materialized fleet registry from authoritative desk membership.
 * Existing company research is never touched; zero-watcher symbols are paused.
 */
export async function reconcileCompanyFleetFromDesks(
  desks: readonly Desk[],
  now = Date.now(),
): Promise<CompanyFleetReconciliation> {
  const expected = companyFleetSnapshot(desks);
  let membershipsAdded = 0;
  let membershipsRemoved = 0;

  if (useMemory) {
    const symbols = [...new Set([
      ...expected.watchersByTicker.keys(),
      ...memoryRecords.keys(),
      ...memoryMemberships.keys(),
    ])].sort((left, right) => left.localeCompare(right));
    for (const symbol of symbols) {
      const expectedDeskIds = expected.watchersByTicker.get(symbol) ?? new Set<string>();
      const current = memoryMemberships.get(symbol) ?? new Map<string, CompanyFleetMembership>();
      for (const deskId of expectedDeskIds) {
        if (!current.has(deskId)) {
          current.set(deskId, membership(deskId, symbol, now));
          membershipsAdded += 1;
        }
      }
      for (const deskId of [...current.keys()]) {
        if (!expectedDeskIds.has(deskId)) {
          current.delete(deskId);
          membershipsRemoved += 1;
        }
      }
      memoryMemberships.set(symbol, current);
      const existing = memoryRecords.get(symbol);
      memoryRecords.set(
        symbol,
        current.size > 0
          ? activeRecord(symbol, current.size, now, existing)
          : pausedRecord(symbol, now, existing),
      );
    }
    return {
      active: expected.tickers,
      paused: symbols.filter((symbol) => !expected.watchersByTicker.has(symbol)),
      membershipsAdded,
      membershipsRemoved,
    };
  }

  const fleetCollection = firestore().collection(COMPANY_FLEET_COLLECTION);
  const fleetDocuments = await allDocuments(fleetCollection);
  const existingBySymbol = new Map(
    fleetDocuments.map((document) => [
      document.id,
      document.data() as CompanyFleetRecord,
    ]),
  );
  const symbols = [...new Set([
    ...expected.watchersByTicker.keys(),
    ...existingBySymbol.keys(),
  ])].sort((left, right) => left.localeCompare(right));

  let batch: WriteBatch = firestore().batch();
  let batchSize = 0;
  const flush = async () => {
    if (batchSize === 0) return;
    await batch.commit();
    batch = firestore().batch();
    batchSize = 0;
  };
  const queue = async (operation: () => void) => {
    if (batchSize >= 400) await flush();
    operation();
    batchSize += 1;
  };

  for (const symbol of symbols) {
    const fleetRef = fleetCollection.doc(symbol);
    const watcherDocuments = await allDocuments(fleetRef.collection("watchers"));
    const currentDeskIds = new Set(watcherDocuments.map((document) => document.id));
    const expectedDeskIds = expected.watchersByTicker.get(symbol) ?? new Set<string>();

    for (const deskId of expectedDeskIds) {
      if (currentDeskIds.has(deskId)) continue;
      await queue(() => batch.create(
        fleetRef.collection("watchers").doc(deskId),
        membership(deskId, symbol, now),
      ));
      membershipsAdded += 1;
    }
    for (const document of watcherDocuments) {
      if (expectedDeskIds.has(document.id)) continue;
      await queue(() => batch.delete(document.ref));
      membershipsRemoved += 1;
    }

    const existing = existingBySymbol.get(symbol);
    const next = expectedDeskIds.size > 0
      ? activeRecord(symbol, expectedDeskIds.size, now, existing)
      : pausedRecord(symbol, now, existing);
    const unchanged =
      existing?.schema === next.schema &&
      existing.active === next.active &&
      existing.watcherCount === next.watcherCount;
    if (!unchanged) await queue(() => batch.set(fleetRef, next));
  }
  await queue(() => batch.set(firestore().collection("company_fleet_meta").doc("state"), {
    schema: COMPANY_FLEET_SCHEMA,
    lastReconciledAt: now,
    activeCompanies: expected.tickers.length,
  }, { merge: true }));
  await flush();

  return {
    active: expected.tickers,
    paused: symbols.filter((symbol) => !expected.watchersByTicker.has(symbol)),
    membershipsAdded,
    membershipsRemoved,
  };
}

/**
 * Canonical scheduler entrypoint. It returns the exhaustive desk-derived fleet
 * first and treats registry reconciliation as an observable, self-healing
 * mirror—not as a stale gate that could suppress or waste a daily run.
 */
export async function listActiveCompanyTickers(): Promise<string[]> {
  const desks = await listAllDesks();
  const snapshot = companyFleetSnapshot(desks);
  try {
    await reconcileCompanyFleetFromDesks(desks);
  } catch (error) {
    console.error(`[company-fleet] reconciliation failed: ${String(error).slice(0, 500)}`);
  }
  return snapshot.tickers;
}

export async function getCompanyFleetRecord(symbol: string): Promise<CompanyFleetRecord | null> {
  const normalized = normalizeTicker(symbol);
  if (!normalized) return null;
  if (useMemory) return memoryRecords.get(normalized) ?? null;
  const snapshot = await firestore().collection(COMPANY_FLEET_COLLECTION).doc(normalized).get();
  return snapshot.exists ? snapshot.data() as CompanyFleetRecord : null;
}

/** Test-only state reset; production callers never need to delete fleet history. */
export function resetCompanyFleetMemoryForTests(): void {
  if (!useMemory) throw new Error("memory fleet is not enabled");
  memoryRecords.clear();
  memoryMemberships.clear();
}
