/**
 * Isolated private-research orchestration.
 *
 * This module is intentionally not imported by public renderers. The dossier
 * pipeline can call the idempotent ensure helper after it has durably published
 * a v5 artifact; a settlement cron can drain the indexed queue page by page.
 */
import { randomUUID } from "node:crypto";
import { getResearchBarsStored } from "./companyStore";
import {
  claimPrivateSignalOutboxItem,
  completePrivateSignalOutboxItem,
  failPrivateSignalOutboxItem,
  listPrivateSignalOutboxPage,
  type PrivateSignalDossierProjection,
  type PrivateSignalOutboxCursor,
} from "./privateSignalOutbox";
import {
  createPrivateSignalResearchRecord,
  historicalEventsFromPrivateSignals,
  researchHash,
  verifyPrivateSignalRecordIntegrity,
  type HistoricalSignalEvent,
  type PrivateSignalResearchRecord,
  type ResearchPriceBar,
} from "./privateSignalResearch";
import {
  getPrivateSignalResearch,
  hydrateAndSavePrivateSignal,
  listPrivateSignalsByTicker,
  listUnresolvedPrivateSignalPage,
  resolveAndSavePrivateSignal,
  savePrivateSignalResearch,
  type PrivateSignalQueueCursor,
} from "./privateSignalStore";

function sameResearchHash(
  left: ReturnType<typeof researchHash>,
  right: ReturnType<typeof researchHash>,
): boolean {
  return left.algorithm === right.algorithm &&
    left.canonicalization === right.canonicalization &&
    left.digest === right.digest;
}

function isExactCurrentArtifact(
  record: PrivateSignalResearchRecord,
  dossier: PrivateSignalDossierProjection,
  emailHookSha256: ReturnType<typeof researchHash>,
): boolean {
  return record.ticker === dossier.ticker &&
    record.issuedAt === dossier.generatedAt &&
    record.sourceArtifact.dossierArtifactVersion === dossier.artifactVersion &&
    record.sourceArtifact.dossierDate === dossier.date &&
    record.sourceArtifact.councilRunId === dossier.councilRunId &&
    record.sourceArtifact.briefAuditId === dossier.briefAuditId &&
    sameResearchHash(record.sourceArtifact.emailHookSha256, emailHookSha256);
}

/**
 * Restore every earlier cold observation before the current signal freezes its
 * historical cohort. Each predecessor is hydrated oldest-first and receives
 * only already-hydrated earlier events; the immutable issuance cutoff inside
 * the research layer prevents later bars from introducing look-ahead.
 */
export async function hydratePrivateSignalPredecessors(input: {
  dossier: PrivateSignalDossierProjection;
  priorRecords: PrivateSignalResearchRecord[];
  stockBars: ResearchPriceBar[];
  spyBars: ResearchPriceBar[];
  boundAt?: number;
  hydrate?: typeof hydrateAndSavePrivateSignal;
}): Promise<{
  records: PrivateSignalResearchRecord[];
  historicalEvents: HistoricalSignalEvent[];
}> {
  const hookHash = researchHash(input.dossier.emailHook);
  const hydrate = input.hydrate ?? hydrateAndSavePrivateSignal;
  const predecessors = input.priorRecords
    .filter((record) =>
      record.ticker === input.dossier.ticker &&
      record.issuedAt <= input.dossier.generatedAt &&
      !isExactCurrentArtifact(record, input.dossier, hookHash))
    .sort((left, right) =>
      left.issuedAt - right.issuedAt || left.id.localeCompare(right.id));
  const hydrated: PrivateSignalResearchRecord[] = [];
  for (const predecessor of predecessors) {
    const record = await hydrate({
      record: predecessor,
      stockBars: input.stockBars,
      spyBars: input.spyBars,
      historicalEvents: historicalEventsFromPrivateSignals(hydrated),
      boundAt: input.boundAt ?? Date.now(),
    });
    hydrated.push(record);
  }
  return {
    records: hydrated,
    historicalEvents: historicalEventsFromPrivateSignals(hydrated),
  };
}

/** Idempotently create or hydrate the private observation for one exact hook. */
export async function ensurePrivateSignalResearchForDossier(
  dossier: PrivateSignalDossierProjection,
): Promise<PrivateSignalResearchRecord> {
  if (dossier.artifactVersion !== 5) {
    throw new Error(`private signal requires an exact v5 dossier projection`);
  }
  if (!dossier.briefAuditId || !dossier.councilRunId) {
    throw new Error(`dossier ${dossier.ticker}:${dossier.date} lacks immutable audit ids`);
  }
  const [stockBars, spyBars, priorRecords] = await Promise.all([
    getResearchBarsStored(dossier.ticker),
    getResearchBarsStored("SPY"),
    listPrivateSignalsByTicker(dossier.ticker),
  ]);
  const predecessorState = await hydratePrivateSignalPredecessors({
    dossier,
    priorRecords,
    stockBars,
    spyBars,
    boundAt: Date.now(),
  });
  const historicalEvents = predecessorState.historicalEvents;
  const created = createPrivateSignalResearchRecord({
    ticker: dossier.ticker,
    thesis: dossier.emailHook.thesis,
    eventType: dossier.emailHook.signal.eventType,
    direction: dossier.emailHook.signal.direction,
    strength: dossier.emailHook.signal.strength,
    issuedAt: dossier.generatedAt,
    sourceArtifact: {
      dossierArtifactVersion: dossier.artifactVersion,
      dossierDate: dossier.date,
      councilRunId: dossier.councilRunId,
      briefAuditId: dossier.briefAuditId,
      emailHookSha256: researchHash(dossier.emailHook),
    },
    stockBars,
    spyBars,
    historicalEvents,
  });
  if (!created.ok) {
    throw new Error(`private signal rejected for ${dossier.ticker}:${dossier.date}: ${created.reason}`);
  }
  await savePrivateSignalResearch(created.record);
  const persisted = await getPrivateSignalResearch(created.record.id);
  if (!persisted) throw new Error(`private signal ${created.record.id} disappeared after save`);
  return hydrateAndSavePrivateSignal({
    record: persisted,
    stockBars,
    spyBars,
    historicalEvents,
    boundAt: Date.now(),
  });
}

export type PrivateSignalOutboxProcessResult =
  | { status: "complete"; outboxId: string; privateSignalId: string }
  | { status: "busy" | "not_due" | "blocked_predecessor"; outboxId: string }
  | { status: "missing"; outboxId: string }
  | { status: "already_complete"; outboxId: string; privateSignalId: string };

/**
 * Completion is permitted only for the exact private record derived from this
 * compact artifact. This closes the gap between an idempotent ensure callback
 * and the outbox completion CAS: an accidental/stale record cannot acknowledge
 * a different thesis, ticker, issuance, or audit trail.
 */
export function assertPrivateSignalResearchMatchesDossier(
  record: PrivateSignalResearchRecord,
  dossier: PrivateSignalDossierProjection,
): void {
  const integrity = verifyPrivateSignalRecordIntegrity(record);
  if (!integrity.ok) {
    throw new Error(`private signal result integrity failure: ${integrity.reason}`);
  }
  const expectedHookHash = researchHash(dossier.emailHook);
  const actualHookHash = record.sourceArtifact.emailHookSha256;
  const mismatch =
    record.ticker !== dossier.ticker ||
    record.issuedAt !== dossier.generatedAt ||
    // The research schema stores the canonical trimmed thesis while the
    // source-artifact hash still binds the exact public hook bytes.
    record.thesis !== dossier.emailHook.thesis.trim() ||
    record.eventType !== dossier.emailHook.signal.eventType ||
    record.direction !== dossier.emailHook.signal.direction ||
    record.strength !== dossier.emailHook.signal.strength ||
    record.sourceArtifact.dossierArtifactVersion !== dossier.artifactVersion ||
    record.sourceArtifact.dossierDate !== dossier.date ||
    record.sourceArtifact.briefAuditId !== dossier.briefAuditId ||
    record.sourceArtifact.councilRunId !== dossier.councilRunId ||
    actualHookHash.algorithm !== expectedHookHash.algorithm ||
    actualHookHash.canonicalization !== expectedHookHash.canonicalization ||
    actualHookHash.digest !== expectedHookHash.digest;
  if (mismatch) {
    throw new Error(
      `private signal result does not bind exactly to outbox ${dossier.ticker}:${dossier.date}`,
    );
  }
}

/**
 * Claim and process one durable projection. At-least-once execution is safe:
 * private observations are content-addressed and their store is append-only.
 */
export async function processPrivateSignalOutboxItem(input: {
  id: string;
  workerId?: string;
  now?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  ensure?: typeof ensurePrivateSignalResearchForDossier;
}): Promise<PrivateSignalOutboxProcessResult> {
  const workerId = input.workerId?.trim() || randomUUID();
  const claim = await claimPrivateSignalOutboxItem({
    id: input.id,
    workerId,
    ...(input.now != null ? { now: input.now } : {}),
    ...(input.leaseMs != null ? { leaseMs: input.leaseMs } : {}),
  });
  if (claim.status === "missing") return { status: "missing", outboxId: input.id };
  if (claim.status === "busy" || claim.status === "not_due" ||
      claim.status === "blocked_predecessor") {
    return { status: claim.status, outboxId: input.id };
  }
  if (claim.status === "complete") {
    return {
      status: "already_complete",
      outboxId: input.id,
      privateSignalId: claim.item.privateSignalId!,
    };
  }
  try {
    const privateRecord = await (input.ensure ?? ensurePrivateSignalResearchForDossier)(
      claim.item.payload,
    );
    assertPrivateSignalResearchMatchesDossier(privateRecord, claim.item.payload);
    await completePrivateSignalOutboxItem({
      id: input.id,
      workerId,
      leaseToken: claim.item.leaseToken!,
      privateSignalId: privateRecord.id,
      completedAt: Date.now(),
    });
    return { status: "complete", outboxId: input.id, privateSignalId: privateRecord.id };
  } catch (error) {
    try {
      await failPrivateSignalOutboxItem({
        id: input.id,
        workerId,
        leaseToken: claim.item.leaseToken!,
        error,
        failedAt: Date.now(),
        ...(input.retryDelayMs != null ? { retryDelayMs: input.retryDelayMs } : {}),
      });
    } catch (queueError) {
      throw new Error(
        `private signal processing failed and lease recovery must requeue it: ${String(error).slice(0, 240)}; ` +
        `failure update: ${String(queueError).slice(0, 240)}`,
      );
    }
    throw error;
  }
}

export interface PrivateSignalOutboxPageResult {
  scanned: number;
  /** Pending projections retained for a company with no current watchers. */
  paused?: number;
  completed: number;
  busy: number;
  notDue: number;
  blockedPredecessor: number;
  alreadyComplete: number;
  missing: number;
  errors: Array<{ id: string; ticker: string; error: string }>;
  nextCursor: PrivateSignalOutboxCursor | null;
}

/** Process one complete immutable-key page; callers follow nextCursor to null. */
export async function processPrivateSignalOutboxPage(input: {
  after?: PrivateSignalOutboxCursor | null;
  pageSize?: number;
  workerId?: string;
  activeTickers?: ReadonlySet<string>;
  ensure?: typeof ensurePrivateSignalResearchForDossier;
} = {}): Promise<PrivateSignalOutboxPageResult> {
  const page = await listPrivateSignalOutboxPage({
    after: input.after ?? null,
    limit: input.pageSize ?? 50,
  });
  const workerId = input.workerId?.trim() || randomUUID();
  let paused = 0;
  let completed = 0;
  let busy = 0;
  let notDue = 0;
  let blockedPredecessor = 0;
  let alreadyComplete = 0;
  let missing = 0;
  const errors: PrivateSignalOutboxPageResult["errors"] = [];
  for (const queued of page.records) {
    if (input.activeTickers && !input.activeTickers.has(queued.payload.ticker.toUpperCase())) {
      // Keep the immutable projection pending. Re-adding the company makes a
      // future sweep eligible without reconstructing or deleting history.
      paused += 1;
      continue;
    }
    try {
      const result = await processPrivateSignalOutboxItem({
        id: queued.id,
        workerId,
        ...(input.ensure ? { ensure: input.ensure } : {}),
      });
      if (result.status === "complete") completed += 1;
      else if (result.status === "busy") busy += 1;
      else if (result.status === "not_due") notDue += 1;
      else if (result.status === "blocked_predecessor") blockedPredecessor += 1;
      else if (result.status === "already_complete") alreadyComplete += 1;
      else missing += 1;
    } catch (error) {
      errors.push({
        id: queued.id,
        ticker: queued.payload.ticker,
        error: String(error).slice(0, 300),
      });
    }
  }
  return {
    scanned: page.records.length,
    paused,
    completed,
    busy,
    notDue,
    blockedPredecessor,
    alreadyComplete,
    missing,
    errors,
    nextCursor: page.nextCursor,
  };
}

export interface PrivateSignalSettlementPageResult {
  attempted: number;
  completed: number;
  stillOpen: number;
  errors: Array<{ id: string; ticker: string; error: string }>;
  nextCursor: PrivateSignalQueueCursor | null;
}

/** Drain one indexed queue page. The caller follows nextCursor until null. */
export async function settlePrivateSignalResearchPage(input: {
  after?: PrivateSignalQueueCursor | null;
  pageSize?: number;
  resolvedAt?: number;
} = {}): Promise<PrivateSignalSettlementPageResult> {
  const page = await listUnresolvedPrivateSignalPage({
    after: input.after ?? null,
    limit: input.pageSize ?? 100,
  });
  const barCache = new Map<string, ReturnType<typeof getResearchBarsStored>>();
  const historyCache = new Map<string, ReturnType<typeof listPrivateSignalsByTicker>>();
  const barsFor = (ticker: string) => {
    const existing = barCache.get(ticker);
    if (existing) return existing;
    const requested = getResearchBarsStored(ticker);
    barCache.set(ticker, requested);
    return requested;
  };
  const historyFor = (ticker: string) => {
    const existing = historyCache.get(ticker);
    if (existing) return existing;
    const requested = listPrivateSignalsByTicker(ticker);
    historyCache.set(ticker, requested);
    return requested;
  };
  const spyBars = await barsFor("SPY");
  let completed = 0;
  let stillOpen = 0;
  const errors: PrivateSignalSettlementPageResult["errors"] = [];

  for (const queued of page.records) {
    try {
      const [stockBars, tickerHistory] = await Promise.all([
        barsFor(queued.ticker),
        historyFor(queued.ticker),
      ]);
      const current = await getPrivateSignalResearch(queued.id);
      if (!current) throw new Error("queued record is missing");
      const hydrated = await hydrateAndSavePrivateSignal({
        record: current,
        stockBars,
        spyBars,
        historicalEvents: historicalEventsFromPrivateSignals(tickerHistory),
        boundAt: input.resolvedAt ?? Date.now(),
      });
      const resolved = await resolveAndSavePrivateSignal({
        record: hydrated,
        stockBars,
        spyBars,
        resolvedAt: input.resolvedAt,
      });
      historyCache.set(
        queued.ticker,
        Promise.resolve(tickerHistory.map((record) => record.id === resolved.id ? resolved : record)),
      );
      if (resolved.resolutionStatus === "complete") completed += 1;
      else stillOpen += 1;
    } catch (error) {
      errors.push({ id: queued.id, ticker: queued.ticker, error: String(error).slice(0, 300) });
    }
  }
  return {
    attempted: page.records.length,
    completed,
    stillOpen,
    errors,
    nextCursor: page.nextCursor,
  };
}

export interface PrivateSignalDrainResult {
  completeSweep: boolean;
  stoppedPhase: "outbox" | "settlement" | null;
  outbox: {
    pages: number;
    scanned: number;
    paused: number;
    completed: number;
    busy: number;
    notDue: number;
    blockedPredecessor: number;
    alreadyComplete: number;
    missing: number;
    errors: PrivateSignalOutboxPageResult["errors"];
    nextCursor: PrivateSignalOutboxCursor | null;
    /** True means this invocation has not proven the phase exhausted. */
    hasMore: boolean;
  };
  settlement: {
    pages: number;
    attempted: number;
    completed: number;
    stillOpen: number;
    errors: PrivateSignalSettlementPageResult["errors"];
    nextCursor: PrivateSignalQueueCursor | null;
    /** True means this invocation has not proven the phase exhausted. */
    hasMore: boolean;
  };
}

/**
 * Exhaustively sweep the publication outbox first, then the outcome queue.
 * The deadline is checked only between bounded pages so a fetched page is
 * never half-consumed and its cursor can never skip unattempted records.
 */
export async function drainPrivateSignalWork(input: {
  deadlineAt: number;
  outboxPageSize?: number;
  settlementPageSize?: number;
  workerId?: string;
  activeTickers?: ReadonlySet<string>;
  now?: () => number;
  processOutboxPage?: typeof processPrivateSignalOutboxPage;
  settlePage?: typeof settlePrivateSignalResearchPage;
}): Promise<PrivateSignalDrainResult> {
  const now = input.now ?? Date.now;
  const processOutboxPage = input.processOutboxPage ?? processPrivateSignalOutboxPage;
  const settlePage = input.settlePage ?? settlePrivateSignalResearchPage;
  const workerId = input.workerId?.trim() || randomUUID();
  const result: PrivateSignalDrainResult = {
    completeSweep: false,
    stoppedPhase: null,
    outbox: {
      pages: 0, scanned: 0, paused: 0, completed: 0, busy: 0, notDue: 0,
      blockedPredecessor: 0, alreadyComplete: 0, missing: 0,
      errors: [], nextCursor: null, hasMore: true,
    },
    settlement: {
      pages: 0, attempted: 0, completed: 0, stillOpen: 0,
      errors: [], nextCursor: null, hasMore: true,
    },
  };

  let outboxCursor: PrivateSignalOutboxCursor | null = null;
  do {
    if (now() >= input.deadlineAt) {
      result.stoppedPhase = "outbox";
      result.outbox.nextCursor = outboxCursor;
      return result;
    }
    const page = await processOutboxPage({
      after: outboxCursor,
      pageSize: input.outboxPageSize ?? 50,
      workerId,
      ...(input.activeTickers ? { activeTickers: input.activeTickers } : {}),
    });
    result.outbox.pages += 1;
    result.outbox.scanned += page.scanned;
    result.outbox.paused += page.paused ?? 0;
    result.outbox.completed += page.completed;
    result.outbox.busy += page.busy;
    result.outbox.notDue += page.notDue;
    result.outbox.blockedPredecessor += page.blockedPredecessor;
    result.outbox.alreadyComplete += page.alreadyComplete;
    result.outbox.missing += page.missing;
    result.outbox.errors.push(...page.errors);
    outboxCursor = page.nextCursor;
    result.outbox.nextCursor = outboxCursor;
    result.outbox.hasMore = outboxCursor !== null;
  } while (outboxCursor);

  let settlementCursor: PrivateSignalQueueCursor | null = null;
  do {
    if (now() >= input.deadlineAt) {
      result.stoppedPhase = "settlement";
      result.settlement.nextCursor = settlementCursor;
      return result;
    }
    const page = await settlePage({
      after: settlementCursor,
      pageSize: input.settlementPageSize ?? 100,
    });
    result.settlement.pages += 1;
    result.settlement.attempted += page.attempted;
    result.settlement.completed += page.completed;
    result.settlement.stillOpen += page.stillOpen;
    result.settlement.errors.push(...page.errors);
    settlementCursor = page.nextCursor;
    result.settlement.nextCursor = settlementCursor;
    result.settlement.hasMore = settlementCursor !== null;
  } while (settlementCursor);

  result.completeSweep = true;
  return result;
}
