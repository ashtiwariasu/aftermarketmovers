import { FieldPath, Firestore } from "@google-cloud/firestore";
import { randomUUID } from "crypto";
import { normalizeContextExclusions } from "@/lib/contextSources";
import {
  TIERS,
  monthKey,
  isTier,
  type Tier,
} from "@/lib/tiers";

/** One market-wide delivery clock; research and email share this NY cutoff. */
export const MORNING_NOTE_SEND_TIME = "09:00";
export const MORNING_NOTE_SEND_TIME_ZONE = "America/New_York";

export interface DeskActivity {
  at: number;
  text: string;
}

export interface DeskMessage {
  at: number;
  role: "desk" | "user";
  kind: "info" | "note" | "alert" | "question" | "reply" | "council";
  text: string;
  /** JSON payload for structured renders (council results). */
  data?: string;
  /** Stock room this message belongs to; absent = the home desk thread. */
  ticker?: string;
}

export interface NoteDeliveryState {
  slotDate: string;
  attemptId: string;
  status: "claimed" | "failed" | "sent";
  claimedAt: number;
  failedAt?: number;
  sentAt?: number;
  artifactKey?: string;
  publishedDossierKey?: string;
  error?: string;
}

export interface Desk {
  id: string;
  email: string;
  tickers: string[];
  createdAt: number;
  activity: DeskActivity[];
  messages?: DeskMessage[];
  /** Lifetime council runs consumed (legacy metering). */
  councils?: number;
  /** Subscription tier — a desk field until Stripe provisioning lands. */
  tier?: Tier;
  /** Sittings consumed in the current meter month. */
  sittingsUsed?: number;
  /** Meter month ("YYYY-MM" in the desk tz) — used counter resets when it rolls. */
  sittingsMonth?: string;
  /** Stripe linkage — written by the billing webhook. */
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** First time this desk went paid (ms). Stamped once, never overwritten. */
  paidSince?: number;
  /** Historical trial fields retained only for backward-compatible records. */
  trialStartedAt?: number;
  trialEndsAt?: number;
  /** Legacy schedule field. New writes are fixed to the global 09:00 ET run. */
  noteTime?: string;
  /** Member timezone used by local product meters; not a delivery scheduler. */
  tz?: string;
  /** Member clicked unsubscribe — no more Morning Notes. */
  emailOptOut?: boolean;
  /** First-touch acquisition (utm_*, ref, referrer) — written once at first desk create, never overwritten. */
  acquisition?: Record<string, string>;
  /** Last New York trading date (YYYY-MM-DD) a Morning Note was sent — dedupe. */
  lastNoteDate?: string;
  /** Last dossier presented as a new thesis; prevents re-announcing it. */
  lastNoteArtifactKey?: string;
  /** Retryable, leased delivery state for the current New York market-date slot. */
  noteDelivery?: NoteDeliveryState;
  /** Latest llmcouncil session id per stock room, keyed by ticker (legacy + fast path). */
  rooms?: Record<string, string>;
  /** All named sessions per stock room, newest first. */
  roomList?: Record<string, Array<{ id: string; title: string; at: number }>>;
  /** llmcouncil library folder per company — the company file, keyed by ticker. */
  folders?: Record<string, string>;
  /** Document ids excluded from council context, keyed by ticker. */
  contextExclude?: Record<string, string[]>;
  /**
   * Symbols removed from active research by a versioned coverage policy.
   * Company artifacts remain intact; this audit trail explains why the fleet
   * no longer spends collection or council work on the symbol.
   */
  supportPaused?: Record<string, {
    code: string;
    message: string;
    policyVersion: string;
    pausedAt: number;
  }>;
  /** False only after account deletion; selected stocks otherwise remain active. */
  researchActive?: boolean;
}

// Firestore in prod (Cloud Run service account); in-memory fallback for local dev
// when DESK_STORE=memory is set.
const useMemory = process.env.DESK_STORE === "memory";
const globalStore = globalThis as unknown as { __deskStore?: Map<string, Desk> };
const memoryStore = (globalStore.__deskStore ??= new Map<string, Desk>());

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

export async function createDesk(
  email: string,
  tickers: string[],
  activity: DeskActivity[],
  id?: string,
  _noteTime?: string,
  tz?: string,
  acquisition?: Record<string, string>
): Promise<Desk> {
  // Upsert: keep chat history and original start date across ticker changes.
  const existing = id ? await getDesk(id) : null;
  const now = Date.now();
  const tier = existing?.tier ?? "free";
  const desk: Desk = {
    id: id ?? randomUUID(),
    email,
    tickers,
    createdAt: existing?.createdAt ?? now,
    activity,
    messages: existing?.messages ?? [],
    councils: existing?.councils ?? 0,
    tier,
    sittingsUsed: existing?.sittingsUsed ?? 0,
    sittingsMonth: existing?.sittingsMonth ?? "",
    // The argument remains for source compatibility with older callers, but
    // per-member delivery preferences no longer control Morning Note timing.
    noteTime: MORNING_NOTE_SEND_TIME,
    tz: tz ?? existing?.tz ?? MORNING_NOTE_SEND_TIME_ZONE,
    lastNoteDate: existing?.lastNoteDate ?? "",
    rooms: existing?.rooms ?? {},
    folders: existing?.folders ?? {},
    researchActive: true,
    // Billing linkage survives ticker changes (Firestore rejects undefined —
    // spread-omit absent fields).
    ...(existing?.paidSince ? { paidSince: existing.paidSince } : {}),
    ...(existing?.trialStartedAt ? { trialStartedAt: existing.trialStartedAt } : {}),
    ...(existing?.trialEndsAt ? { trialEndsAt: existing.trialEndsAt } : {}),
    ...(existing?.stripeCustomerId ? { stripeCustomerId: existing.stripeCustomerId } : {}),
    ...(existing?.stripeSubscriptionId ? { stripeSubscriptionId: existing.stripeSubscriptionId } : {}),
    ...(existing?.emailOptOut ? { emailOptOut: existing.emailOptOut } : {}),
    // First touch is write-once: an existing record always wins.
    ...(existing?.acquisition
      ? { acquisition: existing.acquisition }
      : acquisition && Object.keys(acquisition).length > 0
        ? { acquisition }
        : {}),
    ...(existing?.lastNoteArtifactKey
      ? { lastNoteArtifactKey: existing.lastNoteArtifactKey }
      : {}),
    ...(existing?.noteDelivery ? { noteDelivery: existing.noteDelivery } : {}),
    ...(existing?.supportPaused
      ? {
          supportPaused: Object.fromEntries(
            // A retained legacy selection stays paused until it passes the
            // current coverage contract. Removing it clears the stale audit
            // entry; merely saving the desk must never reactivate it.
            Object.entries(existing.supportPaused).filter(([ticker]) => tickers.includes(ticker)),
          ),
        }
      : {}),
  };
  if (useMemory) {
    memoryStore.set(desk.id, desk);
  } else {
    await firestore().collection("desks").doc(desk.id).set(desk);
  }
  return desk;
}

export async function getDesk(id: string): Promise<Desk | null> {
  // Accept legacy UUIDs and Clerk user ids (user_...)
  if (!/^[0-9a-zA-Z_-]{10,64}$/.test(id)) return null;
  if (useMemory) return memoryStore.get(id) ?? null;
  const doc = await firestore().collection("desks").doc(id).get();
  return doc.exists ? (doc.data() as Desk) : null;
}

export async function appendMessages(
  id: string,
  msgs: DeskMessage[]
): Promise<void> {
  if (useMemory) {
    const d = memoryStore.get(id);
    if (d) d.messages = [...(d.messages ?? []), ...msgs];
    return;
  }
  const ref = firestore().collection("desks").doc(id);
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const existing = (snap.data() as Desk).messages ?? [];
    tx.update(ref, { messages: [...existing, ...msgs] });
  });
}

export async function listDesks(limit = 500): Promise<Desk[]> {
  if (useMemory) return [...memoryStore.values()].slice(0, limit);
  const snap = await firestore().collection("desks").limit(limit).get();
  return snap.docs.map((d) => d.data() as Desk);
}

/** Exhaustive, deterministic pagination for crons and migrations (>500 desks). */
export async function listAllDesks(pageSize = 250): Promise<Desk[]> {
  const safePageSize = Math.max(1, Math.min(500, Math.floor(pageSize)));
  if (useMemory) {
    return [...memoryStore.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
  const result: Desk[] = [];
  let afterId: string | null = null;
  for (;;) {
    let query = firestore()
      .collection("desks")
      .orderBy(FieldPath.documentId())
      .limit(safePageSize);
    if (afterId) query = query.startAfter(afterId);
    const page = await query.get();
    result.push(...page.docs.map((document) => document.data() as Desk));
    if (page.size < safePageSize) break;
    afterId = page.docs.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return result;
}

/** Account lifecycle hook: stop this desk contributing to the shared company fleet. */
export async function setDeskResearchActive(id: string, active: boolean): Promise<boolean> {
  if (!/^[0-9a-zA-Z_-]{10,64}$/.test(id)) return false;
  if (useMemory) {
    const desk = memoryStore.get(id);
    if (!desk) return false;
    desk.researchActive = active;
    return true;
  }
  const ref = firestore().collection("desks").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  await ref.update({ researchActive: active });
  return true;
}

/** Unsubscribe: Morning Notes stop; the desk itself is untouched. */
export async function setEmailOptOut(id: string): Promise<boolean> {
  if (useMemory) {
    const d = memoryStore.get(id);
    if (!d) return false;
    d.emailOptOut = true;
    return true;
  }
  const ref = firestore().collection("desks").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({ emailOptOut: true });
  return true;
}

export async function markNoteSent(id: string, localDate: string): Promise<void> {
  if (useMemory) {
    const d = memoryStore.get(id);
    if (d) d.lastNoteDate = localDate;
    return;
  }
  await firestore().collection("desks").doc(id).update({ lastNoteDate: localDate });
}

const NOTE_CLAIM_LEASE_MS = 20 * 60_000;

/** Atomically lease one desk/date delivery. Failed and stale claims are retryable. */
export async function claimNoteDelivery(
  id: string,
  slotDate: string,
  attemptId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !/^[0-9a-zA-Z_-]{8,80}$/.test(attemptId)) {
    return false;
  }
  const canClaim = (desk: Desk): boolean => {
    if (!isDeskServiceActive(desk, now) || desk.emailOptOut || desk.lastNoteDate === slotDate) return false;
    const delivery = desk.noteDelivery;
    return !(
      delivery?.slotDate === slotDate &&
      delivery.status === "claimed" &&
      now - delivery.claimedAt < NOTE_CLAIM_LEASE_MS
    );
  };
  const next: NoteDeliveryState = {
    slotDate,
    attemptId,
    status: "claimed",
    claimedAt: now,
  };
  if (useMemory) {
    const desk = memoryStore.get(id);
    if (!desk || !canClaim(desk)) return false;
    desk.noteDelivery = next;
    return true;
  }
  const ref = firestore().collection("desks").doc(id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const desk = snapshot.data() as Desk;
    if (!canClaim(desk)) return false;
    transaction.update(ref, { noteDelivery: next });
    return true;
  });
}

/** Release a matching claim after a transient compose/provider failure. */
export async function failNoteDelivery(
  id: string,
  slotDate: string,
  attemptId: string,
  error: string,
  now = Date.now(),
): Promise<boolean> {
  const update = (desk: Desk): boolean => {
    const delivery = desk.noteDelivery;
    if (
      !delivery ||
      delivery.slotDate !== slotDate ||
      delivery.attemptId !== attemptId ||
      delivery.status !== "claimed"
    ) {
      return false;
    }
    desk.noteDelivery = {
      ...delivery,
      status: "failed",
      failedAt: now,
      error: error.replace(/\s+/g, " ").trim().slice(0, 240),
    };
    return true;
  };
  if (useMemory) {
    const desk = memoryStore.get(id);
    return desk ? update(desk) : false;
  }
  const ref = firestore().collection("desks").doc(id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const desk = snapshot.data() as Desk;
    if (!update(desk)) return false;
    transaction.update(ref, { noteDelivery: desk.noteDelivery });
    return true;
  });
}

/** Commit sent state only for the matching lease; optionally advance dossier watermark. */
export async function completeNoteDelivery(
  id: string,
  slotDate: string,
  attemptId: string,
  artifactKey: string,
  publishedDossierKey: string | null,
  now = Date.now(),
): Promise<boolean> {
  const patchFor = (desk: Desk): Record<string, unknown> | null => {
    const delivery = desk.noteDelivery;
    if (
      !delivery ||
      delivery.slotDate !== slotDate ||
      delivery.attemptId !== attemptId ||
      delivery.status !== "claimed"
    ) {
      return null;
    }
    const sent: NoteDeliveryState = {
      ...delivery,
      status: "sent",
      sentAt: now,
      artifactKey: artifactKey.slice(0, 240),
      ...(publishedDossierKey
        ? { publishedDossierKey: publishedDossierKey.slice(0, 240) }
        : {}),
    };
    return {
      lastNoteDate: slotDate,
      noteDelivery: sent,
      ...(publishedDossierKey
        ? { lastNoteArtifactKey: publishedDossierKey.slice(0, 240) }
        : {}),
    };
  };
  if (useMemory) {
    const desk = memoryStore.get(id);
    if (!desk) return false;
    const patch = patchFor(desk);
    if (!patch) return false;
    Object.assign(desk, patch);
    return true;
  }
  const ref = firestore().collection("desks").doc(id);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const patch = patchFor(snapshot.data() as Desk);
    if (!patch) return false;
    transaction.update(ref, patch);
    return true;
  });
}

/** Record a room session: sets the latest pointer and upserts the named list. */
export async function setRoomSession(
  id: string,
  ticker: string,
  sessionId: string,
  title?: string
): Promise<void> {
  const sym = ticker.toUpperCase();
  if (!/^[A-Z.\-]{1,6}$/.test(sym) || !/^[0-9a-zA-Z_-]{6,80}$/.test(sessionId)) return;
  const cleanTitle = (title ?? "").trim().slice(0, 90);

  function upsert(list: Array<{ id: string; title: string; at: number }>) {
    const existing = list.find((s) => s.id === sessionId);
    if (existing) {
      if (cleanTitle) existing.title = cleanTitle;
      return [...list];
    }
    return [
      { id: sessionId, title: cleanTitle || "New session", at: Date.now() },
      ...list,
    ].slice(0, 50);
  }

  if (useMemory) {
    const d = memoryStore.get(id);
    if (d) {
      d.rooms = { ...(d.rooms ?? {}), [sym]: sessionId };
      d.roomList = { ...(d.roomList ?? {}), [sym]: upsert(d.roomList?.[sym] ?? []) };
    }
    return;
  }
  const ref = firestore().collection("desks").doc(id);
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const desk = snap.data() as Desk;
    tx.update(ref, {
      [`rooms.${sym}`]: sessionId,
      [`roomList.${sym}`]: upsert(desk.roomList?.[sym] ?? []),
    });
  });
}

export async function setContextExclude(
  id: string,
  ticker: string,
  excluded: string[]
): Promise<void> {
  const sym = ticker.toUpperCase();
  if (!/^[A-Z.\-]{1,6}$/.test(sym)) return;
  const clean = normalizeContextExclusions(excluded);
  if (useMemory) {
    const d = memoryStore.get(id);
    if (d) d.contextExclude = { ...(d.contextExclude ?? {}), [sym]: clean };
    return;
  }
  await firestore()
    .collection("desks")
    .doc(id)
    .update({ [`contextExclude.${sym}`]: clean });
}

export async function setCompanyFolder(
  id: string,
  ticker: string,
  folderId: string
): Promise<void> {
  const sym = ticker.toUpperCase();
  if (!/^[A-Z.\-]{1,6}$/.test(sym) || !/^[0-9a-fA-F-]{10,40}$/.test(folderId)) return;
  if (useMemory) {
    const d = memoryStore.get(id);
    if (d) d.folders = { ...(d.folders ?? {}), [sym]: folderId };
    return;
  }
  await firestore()
    .collection("desks")
    .doc(id)
    .update({ [`folders.${sym}`]: folderId });
}

/**
 * The billing webhook's single write: tier + Stripe linkage. Returns the
 * previous tier (for the audit trail) or null if the desk doesn't exist.
 * paidSince is stamped once and never overwritten (llmcouncil's pro_since
 * COALESCE lesson).
 */
export async function setDeskBilling(
  deskId: string,
  patch: { tier: Tier; stripeCustomerId?: string; stripeSubscriptionId?: string }
): Promise<Tier | null> {
  const stamp = patch.tier !== "free";
  if (useMemory) {
    const d = memoryStore.get(deskId);
    if (!d) return null;
    const prev = tierOf(d);
    Object.assign(d, patch);
    if (stamp && !d.paidSince) d.paidSince = Date.now();
    if (stamp && prev === "free") {
      d.sittingsUsed = 0;
      d.sittingsMonth = "";
    }
    if (!stamp) {
      d.trialEndsAt = Math.min(d.trialEndsAt ?? Date.now(), Date.now());
    }
    return prev;
  }
  const ref = firestore().collection("desks").doc(deskId);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      // Pay-before-desk onboarding: the member chose a plan before picking
      // stocks. Seed a stub so the tier survives; createDesk upserts over it.
      tx.set(ref, {
        id: deskId,
        email: "",
        tickers: [],
        createdAt: Date.now(),
        activity: [],
        messages: [],
        councils: 0,
        sittingsUsed: 0,
        sittingsMonth: "",
        ...patch,
        ...(stamp ? { paidSince: Date.now() } : {}),
      });
      return "free";
    }
    const desk = snap.data() as Desk;
    const prev = tierOf(desk);
    tx.update(ref, {
      ...patch,
      ...(stamp && !desk.paidSince ? { paidSince: Date.now() } : {}),
      ...(stamp && prev === "free" ? { sittingsUsed: 0, sittingsMonth: "" } : {}),
      ...(!stamp
        ? {
            trialEndsAt: Math.min(desk.trialEndsAt ?? Date.now(), Date.now()),
          }
        : {}),
    });
    return prev;
  });
}

// ---- sitting transcripts (the audited room's sessions) ----

export interface SittingTurn {
  at: number;
  role: "member" | "desk";
  text: string;
  /** Desk turns keep the audit trail for the transcript chip. */
  lead?: string;
  chair?: string;
  draft?: string;
  audits?: Array<{ role: string; model: string; text: string }>;
}

const sittingMemory = ((globalThis as Record<string, unknown>).__sittingStore ??=
  new Map<string, SittingTurn[]>()) as Map<string, SittingTurn[]>;

export async function appendSittingTurns(
  deskId: string,
  sessionId: string,
  ticker: string,
  turns: SittingTurn[]
): Promise<void> {
  if (!/^[0-9a-zA-Z_-]{6,80}$/.test(sessionId)) return;
  if (useMemory) {
    const key = `${deskId}/${sessionId}`;
    sittingMemory.set(key, [...(sittingMemory.get(key) ?? []), ...turns]);
    return;
  }
  const ref = firestore().collection("desks").doc(deskId).collection("sittings").doc(sessionId);
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? ((snap.data()?.turns ?? []) as SittingTurn[]) : [];
    tx.set(ref, { ticker, updatedAt: Date.now(), turns: [...existing, ...turns].slice(-80) });
  });
}

export async function getSittingTurns(deskId: string, sessionId: string): Promise<SittingTurn[]> {
  if (!/^[0-9a-zA-Z_-]{6,80}$/.test(sessionId)) return [];
  if (useMemory) return sittingMemory.get(`${deskId}/${sessionId}`) ?? [];
  const doc = await firestore()
    .collection("desks")
    .doc(deskId)
    .collection("sittings")
    .doc(sessionId)
    .get();
  return doc.exists ? ((doc.data()?.turns ?? []) as SittingTurn[]) : [];
}

// ---- tier metering ----

export function tierOf(desk: Desk): Tier {
  return isTier(desk.tier) ? desk.tier : "free";
}

export interface SittingVerdict {
  allowed: boolean;
  used: number;
  cap: number;
  tier: Tier;
}

export type DeskAccess = "payment_required" | "paid";

export interface TrialState {
  access: DeskAccess;
  active: boolean;
  startedAt: number | null;
  endsAt: number | null;
  daysRemaining: number | null;
}

/** One source of truth for UI, API gates, council metering, and email delivery. */
export function trialStateOf(desk: Desk, now = Date.now()): TrialState {
  void now;
  if (tierOf(desk) !== "free" && Boolean(desk.stripeSubscriptionId)) {
    return { access: "paid", active: true, startedAt: null, endsAt: null, daysRemaining: null };
  }
  return {
    access: "payment_required",
    active: false,
    startedAt: null,
    endsAt: null,
    daysRemaining: null,
  };
}

export function isDeskServiceActive(desk: Desk, now = Date.now()): boolean {
  return trialStateOf(desk, now).active;
}

/** Read-only usage view with the lazy monthly reset applied. */
export function usageOf(desk: Desk): SittingVerdict & {
  companiesUsed: number;
  companiesCap: number;
  trial: TrialState;
} {
  const tier = tierOf(desk);
  const spec = TIERS[tier];
  const month = monthKey(desk.tz);
  const used = tier === "free" ? 0 : desk.sittingsMonth === month ? desk.sittingsUsed ?? 0 : 0;
  const trial = trialStateOf(desk);
  return {
    allowed: trial.active && used < spec.sittings,
    used,
    cap: spec.sittings,
    tier,
    companiesUsed: desk.tickers.length,
    companiesCap: spec.companies,
    trial,
  };
}

/**
 * Atomically consume `cost` sittings (1 standard, 3 MAX). Resets the counter
 * when the meter month rolls. Refuses without charging when the cap is short.
 */
export async function consumeSittings(id: string, cost: number): Promise<SittingVerdict | null> {
  const charge = Math.max(1, Math.min(10, Math.floor(cost)));
  function apply(desk: Desk): { verdict: SittingVerdict; write?: { sittingsUsed: number; sittingsMonth: string } } {
    const tier = tierOf(desk);
    const cap = TIERS[tier].sittings;
    const month = monthKey(desk.tz);
    const used = tier === "free" ? 0 : desk.sittingsMonth === month ? desk.sittingsUsed ?? 0 : 0;
    if (!isDeskServiceActive(desk)) {
      return { verdict: { allowed: false, used, cap, tier } };
    }
    if (used + charge > cap) return { verdict: { allowed: false, used, cap, tier } };
    return {
      verdict: { allowed: true, used: used + charge, cap, tier },
      write: { sittingsUsed: used + charge, sittingsMonth: month },
    };
  }
  if (useMemory) {
    const d = memoryStore.get(id);
    if (!d) return null;
    const { verdict, write } = apply(d);
    if (write) Object.assign(d, write);
    return verdict;
  }
  const ref = firestore().collection("desks").doc(id);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const { verdict, write } = apply(snap.data() as Desk);
    if (write) tx.update(ref, write);
    return verdict;
  });
}

export async function incrementCouncils(id: string): Promise<void> {
  if (useMemory) {
    const d = memoryStore.get(id);
    if (d) d.councils = (d.councils ?? 0) + 1;
    return;
  }
  const ref = firestore().collection("desks").doc(id);
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.update(ref, { councils: ((snap.data() as Desk).councils ?? 0) + 1 });
  });
}
