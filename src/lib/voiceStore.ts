import { Firestore } from "@google-cloud/firestore";
import { randomUUID } from "crypto";
import type { Desk } from "@/lib/desk";
import { dayKey, TIERS, type Tier } from "@/lib/tiers";

const LEASE_MS = 25_000;
const useMemory = process.env.DESK_STORE === "memory";

export interface VoiceSourceSummary {
  sources: string[];
  stats: string[];
  retrieval: {
    intent: string;
    eligibleSources: number;
    readableSources: number;
    matchedSources: number;
    matchedPassages: number;
  };
}

export interface VoiceTurn {
  at: number;
  question: string;
  answer: string;
  spokenAnswer: string;
  citations: Array<{ label: string; href?: string }>;
}

export interface VoiceSession {
  id: string;
  deskId: string;
  ticker: string;
  day: string;
  tier: Tier;
  quotaMs: number;
  startedAt: number;
  lastHeartbeatAt: number;
  leaseUntil: number;
  endedAt?: number;
  endReason?: "member" | "quota" | "replaced" | "connection";
  context: string;
  sourceSummary: VoiceSourceSummary;
  turns: VoiceTurn[];
}

interface VoiceDay {
  day: string;
  tier: Tier;
  quotaMs: number;
  usedMs: number;
  activeSessionId?: string;
  activeLastChargedAt?: number;
  activeLeaseUntil?: number;
  updatedAt: number;
}

export interface VoiceAllowance {
  allowed: boolean;
  sessionId?: string;
  usedSeconds: number;
  quotaSeconds: number;
  remainingSeconds: number;
  reason?: "not_in_plan" | "quota_exhausted" | "already_active";
}

const memory = globalThis as unknown as {
  __ammVoiceDays?: Map<string, VoiceDay>;
  __ammVoiceSessions?: Map<string, VoiceSession>;
};
const memoryDays = (memory.__ammVoiceDays ??= new Map<string, VoiceDay>());
const memorySessions = (memory.__ammVoiceSessions ??= new Map<string, VoiceSession>());

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

function dayPath(deskId: string, day: string): string {
  return `${deskId}/${day}`;
}

function sessionPath(deskId: string, sessionId: string): string {
  return `${deskId}/${sessionId}`;
}

function normalizeDay(current: Partial<VoiceDay> | undefined, day: string, tier: Tier, now: number): VoiceDay {
  const quotaMs = TIERS[tier].voiceSecondsPerDay * 1000;
  const base: VoiceDay = {
    day,
    tier,
    quotaMs,
    usedMs: Math.max(0, Number(current?.usedMs) || 0),
    updatedAt: now,
  };
  if (
    current?.activeSessionId &&
    Number.isFinite(current.activeLastChargedAt) &&
    Number.isFinite(current.activeLeaseUntil)
  ) {
    base.activeSessionId = current.activeSessionId;
    base.activeLastChargedAt = current.activeLastChargedAt;
    base.activeLeaseUntil = current.activeLeaseUntil;
  }
  return base;
}

function withoutActive(day: VoiceDay): VoiceDay {
  const clean = { ...day };
  delete clean.activeSessionId;
  delete clean.activeLastChargedAt;
  delete clean.activeLeaseUntil;
  return clean;
}

function reconcileExpired(day: VoiceDay, now: number): VoiceDay {
  if (!day.activeSessionId || !day.activeLastChargedAt || !day.activeLeaseUntil) return day;
  if (day.activeLeaseUntil > now) return day;
  const chargeUntil = Math.min(now, day.activeLeaseUntil);
  const elapsed = Math.max(0, chargeUntil - day.activeLastChargedAt);
  const inactive = withoutActive(day);
  return {
    ...inactive,
    usedMs: Math.min(day.quotaMs, day.usedMs + elapsed),
    updatedAt: now,
  };
}

function allowance(day: VoiceDay, sessionId?: string, reason?: VoiceAllowance["reason"]): VoiceAllowance {
  const usedSeconds = Math.ceil(day.usedMs / 1000);
  const quotaSeconds = Math.floor(day.quotaMs / 1000);
  return {
    allowed: !reason && day.usedMs < day.quotaMs,
    ...(sessionId ? { sessionId } : {}),
    usedSeconds,
    quotaSeconds,
    remainingSeconds: Math.max(0, quotaSeconds - usedSeconds),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Atomically opens one metered voice lease. Only one voice connection may
 * charge a desk at a time; abandoned browser sessions expire automatically.
 */
export async function beginVoiceSession(
  desk: Desk,
  ticker: string,
  tier: Tier,
  context: string,
  sourceSummary: VoiceSourceSummary,
  now = Date.now(),
): Promise<VoiceAllowance> {
  const quotaMs = TIERS[tier].voiceSecondsPerDay * 1000;
  const day = dayKey(desk.tz, new Date(now));
  if (quotaMs <= 0) {
    return {
      allowed: false,
      usedSeconds: 0,
      quotaSeconds: 0,
      remainingSeconds: 0,
      reason: "not_in_plan",
    };
  }
  const sessionId = `voice-${randomUUID()}`;
  const session: VoiceSession = {
    id: sessionId,
    deskId: desk.id,
    ticker,
    day,
    tier,
    quotaMs,
    startedAt: now,
    lastHeartbeatAt: now,
    leaseUntil: now + LEASE_MS,
    context,
    sourceSummary,
    turns: [],
  };

  if (useMemory) {
    const key = dayPath(desk.id, day);
    const current = reconcileExpired(normalizeDay(memoryDays.get(key), day, tier, now), now);
    if (current.activeSessionId) return allowance(current, undefined, "already_active");
    if (current.usedMs >= current.quotaMs) return allowance(current, undefined, "quota_exhausted");
    const next: VoiceDay = {
      ...current,
      activeSessionId: sessionId,
      activeLastChargedAt: now,
      activeLeaseUntil: session.leaseUntil,
      updatedAt: now,
    };
    memoryDays.set(key, next);
    memorySessions.set(sessionPath(desk.id, sessionId), session);
    return allowance(next, sessionId);
  }

  const dayRef = firestore().collection("desks").doc(desk.id).collection("voiceDays").doc(day);
  const sessionRef = firestore().collection("desks").doc(desk.id).collection("voiceSessions").doc(sessionId);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(dayRef);
    const current = reconcileExpired(
      normalizeDay(snapshot.exists ? snapshot.data() as Partial<VoiceDay> : undefined, day, tier, now),
      now,
    );
    if (current.activeSessionId) return allowance(current, undefined, "already_active");
    if (current.usedMs >= current.quotaMs) return allowance(current, undefined, "quota_exhausted");
    const next: VoiceDay = {
      ...current,
      activeSessionId: sessionId,
      activeLastChargedAt: now,
      activeLeaseUntil: session.leaseUntil,
      updatedAt: now,
    };
    tx.set(dayRef, next);
    tx.create(sessionRef, session);
    return allowance(next, sessionId);
  });
}

export async function getVoiceAllowance(
  desk: Desk,
  tier: Tier,
  now = Date.now(),
): Promise<VoiceAllowance> {
  const day = dayKey(desk.tz, new Date(now));
  const quotaMs = TIERS[tier].voiceSecondsPerDay * 1000;
  if (quotaMs <= 0) {
    return {
      allowed: false,
      usedSeconds: 0,
      quotaSeconds: 0,
      remainingSeconds: 0,
      reason: "not_in_plan",
    };
  }
  if (useMemory) {
    const key = dayPath(desk.id, day);
    const current = reconcileExpired(normalizeDay(memoryDays.get(key), day, tier, now), now);
    memoryDays.set(key, current);
    if (current.activeSessionId) return allowance(current, undefined, "already_active");
    if (current.usedMs >= current.quotaMs) return allowance(current, undefined, "quota_exhausted");
    return allowance(current);
  }
  const ref = firestore().collection("desks").doc(desk.id).collection("voiceDays").doc(day);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const current = reconcileExpired(
      normalizeDay(snapshot.exists ? snapshot.data() as Partial<VoiceDay> : undefined, day, tier, now),
      now,
    );
    tx.set(ref, current);
    if (current.activeSessionId) return allowance(current, undefined, "already_active");
    if (current.usedMs >= current.quotaMs) return allowance(current, undefined, "quota_exhausted");
    return allowance(current);
  });
}

export async function getVoiceSession(deskId: string, sessionId: string): Promise<VoiceSession | null> {
  if (!/^voice-[0-9a-f-]{20,80}$/.test(sessionId)) return null;
  if (useMemory) return memorySessions.get(sessionPath(deskId, sessionId)) ?? null;
  const snapshot = await firestore()
    .collection("desks")
    .doc(deskId)
    .collection("voiceSessions")
    .doc(sessionId)
    .get();
  return snapshot.exists ? snapshot.data() as VoiceSession : null;
}

/**
 * Charges elapsed wall time through the active lease and renews it. The
 * server clock is authoritative; browser-supplied duration is never trusted.
 */
export async function heartbeatVoiceSession(
  deskId: string,
  sessionId: string,
  finish = false,
  now = Date.now(),
): Promise<VoiceAllowance | null> {
  const session = await getVoiceSession(deskId, sessionId);
  if (!session) return null;
  if (session.endedAt) return null;

  const apply = (currentInput: Partial<VoiceDay> | undefined) => {
    const current = normalizeDay(currentInput, session.day, session.tier, now);
    if (current.activeSessionId !== sessionId || !current.activeLastChargedAt) return null;
    const elapsed = Math.max(0, Math.min(now, current.activeLeaseUntil ?? now) - current.activeLastChargedAt);
    const usedMs = Math.min(current.quotaMs, current.usedMs + elapsed);
    const exhausted = usedMs >= current.quotaMs;
    const ended = finish || exhausted;
    const inactive = withoutActive(current);
    const next: VoiceDay = ended
      ? { ...inactive, usedMs, updatedAt: now }
      : {
          ...inactive,
          usedMs,
          activeSessionId: sessionId,
          activeLastChargedAt: now,
          activeLeaseUntil: now + LEASE_MS,
          updatedAt: now,
        };
    return { next, ended, exhausted };
  };

  if (useMemory) {
    const key = dayPath(deskId, session.day);
    const result = apply(memoryDays.get(key));
    if (!result) return null;
    memoryDays.set(key, result.next);
    const stored = memorySessions.get(sessionPath(deskId, sessionId));
    if (stored) {
      memorySessions.set(sessionPath(deskId, sessionId), {
        ...stored,
        lastHeartbeatAt: now,
        leaseUntil: result.ended ? now : now + LEASE_MS,
        ...(result.ended
          ? { endedAt: now, endReason: result.exhausted ? "quota" : "member" }
          : {}),
      });
    }
    return allowance(
      result.next,
      result.ended ? undefined : sessionId,
      result.exhausted ? "quota_exhausted" : undefined,
    );
  }

  const dayRef = firestore().collection("desks").doc(deskId).collection("voiceDays").doc(session.day);
  const sessionRef = firestore().collection("desks").doc(deskId).collection("voiceSessions").doc(sessionId);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(dayRef);
    const result = apply(snapshot.exists ? snapshot.data() as Partial<VoiceDay> : undefined);
    if (!result) return null;
    tx.set(dayRef, result.next);
    tx.set(sessionRef, {
      lastHeartbeatAt: now,
      leaseUntil: result.ended ? now : now + LEASE_MS,
      ...(result.ended
        ? { endedAt: now, endReason: result.exhausted ? "quota" : "member" }
        : {}),
    }, { merge: true });
    return allowance(
      result.next,
      result.ended ? undefined : sessionId,
      result.exhausted ? "quota_exhausted" : undefined,
    );
  });
}

export async function appendVoiceTurn(
  deskId: string,
  sessionId: string,
  turn: VoiceTurn,
): Promise<void> {
  const session = await getVoiceSession(deskId, sessionId);
  if (!session || session.endedAt) return;
  const turns = [...(session.turns ?? []), turn].slice(-20);
  if (useMemory) {
    memorySessions.set(sessionPath(deskId, sessionId), { ...session, turns });
    return;
  }
  await firestore()
    .collection("desks")
    .doc(deskId)
    .collection("voiceSessions")
    .doc(sessionId)
    .set({ turns }, { merge: true });
}
