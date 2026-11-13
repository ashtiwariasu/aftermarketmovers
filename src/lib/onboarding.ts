import { FieldValue, Firestore } from "@google-cloud/firestore";
import { randomUUID } from "crypto";

export type OnboardingStatus =
  | "pending"
  | "completed"
  | "unsubscribed"
  | "suppressed"
  | "deleted";

export type OnboardingNudgeStage = 0 | 1 | 2;

export interface OnboardingDelivery {
  stage: OnboardingNudgeStage;
  idempotencyKey: string;
  status: "claimed" | "accepted" | "failed" | "delivered" | "clicked" | "suppressed";
  claimedAt: number;
  acceptedAt?: number;
  providerEmailId?: string;
  lastEventAt?: number;
  lastEventType?: string;
  failure?: string;
}

export interface OnboardingUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  status: OnboardingStatus;
  timezone: string;
  intendedTickers: string[];
  intendedPlan?: string;
  acquisition?: Record<string, string>;
  nextNudgeAt?: number;
  nudgeStage: number;
  nudgeLease?: {
    token: string;
    stage: OnboardingNudgeStage;
    claimedAt: number;
    expiresAt: number;
  };
  deliveries: Record<string, OnboardingDelivery>;
  completedAt?: number;
  emailOptOutAt?: number;
  suppressedAt?: number;
  suppressionReason?: string;
  deletedAt?: number;
}

export interface OnboardingIdentity {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  createdAt?: number;
}

export interface OnboardingProgress {
  timezone?: string;
  intendedTickers?: string[];
  intendedPlan?: string;
  acquisition?: Record<string, string>;
}

export interface ClaimedOnboardingNudge {
  user: OnboardingUser;
  stage: OnboardingNudgeStage;
  leaseToken: string;
  idempotencyKey: string;
}

const FIRST_NUDGE_DELAY_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const FINAL_NUDGE_FROM_SIGNUP_MS = 72 * 60 * 60 * 1000;
const FINAL_NUDGE_AFTER_SECOND_MS = 24 * 60 * 60 * 1000;

const useMemory = process.env.DESK_STORE === "memory";
const globalStore = globalThis as unknown as {
  __onboardingStore?: Map<string, OnboardingUser>;
  __onboardingDeskIds?: Set<string>;
  __onboardingWebhookEvents?: Set<string>;
};
const memoryStore = (globalStore.__onboardingStore ??= new Map());
const memoryDeskIds = (globalStore.__onboardingDeskIds ??= new Set());
const memoryWebhookEvents = (globalStore.__onboardingWebhookEvents ??= new Set());

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

function validTimezone(value: string | undefined): string {
  if (!value || value.length > 64) return "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "America/New_York";
  }
}

function cleanTickers(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => String(value).toUpperCase().trim())
    .filter((value) => /^[A-Z.]{1,6}$/.test(value)))]
    .slice(0, 30);
}

function cleanAcquisition(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const allowed = new Set([
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "ref", "gclid", "fbclid", "referrer", "landing", "at",
  ]);
  const clean = Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => allowed.has(key) && typeof item === "string" && item.length > 0)
    .map(([key, item]) => [key, item.slice(0, 300)]));
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function localParts(at: number, timezone: string): { year: number; month: number; day: number; hour: number } {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const read = (type: string) => Number(values.find((part) => part.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") };
}

/** Convert a wall-clock time in an IANA zone to UTC without adding a date library. */
function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string,
): number {
  const desiredPseudoUtc = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let guess = desiredPseudoUtc;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = localParts(guess, timezone);
    const actualPseudoUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, 0, 0, 0);
    guess += desiredPseudoUtc - actualPseudoUtc;
  }
  return guess;
}

/** The next day's 5 PM in the member's timezone. */
export function nextLocalRecoveryTime(after: number, timezone: string): number {
  const parts = localParts(after, timezone);
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return zonedWallTimeToUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    17,
    timezone,
  );
}

export function nextNudgeAfterAccepted(
  user: Pick<OnboardingUser, "createdAt" | "timezone">,
  stage: OnboardingNudgeStage,
  acceptedAt: number,
): number | null {
  if (stage === 0) return nextLocalRecoveryTime(acceptedAt, user.timezone);
  if (stage === 1) {
    return Math.max(
      user.createdAt + FINAL_NUDGE_FROM_SIGNUP_MS,
      acceptedAt + FINAL_NUDGE_AFTER_SECOND_MS,
    );
  }
  return null;
}

function initialUser(identity: OnboardingIdentity, now: number): OnboardingUser {
  const createdAt = identity.createdAt && identity.createdAt > 0 ? identity.createdAt : now;
  return {
    id: identity.id,
    email: identity.email.toLowerCase().trim(),
    firstName: identity.firstName?.trim().slice(0, 80) ?? "",
    lastName: identity.lastName?.trim().slice(0, 80) ?? "",
    createdAt,
    updatedAt: now,
    lastActivityAt: now,
    status: "pending",
    timezone: "America/New_York",
    intendedTickers: [],
    nextNudgeAt: now + FIRST_NUDGE_DELAY_MS,
    nudgeStage: 0,
    deliveries: {},
  };
}

export async function upsertOnboardingUser(
  identity: OnboardingIdentity,
  now = Date.now(),
): Promise<{ user: OnboardingUser; created: boolean }> {
  if (!/^[0-9a-zA-Z_-]{10,64}$/.test(identity.id) || !identity.email.includes("@")) {
    throw new Error("invalid onboarding identity");
  }
  if (useMemory) {
    const existing = memoryStore.get(identity.id);
    if (existing) {
      existing.email = identity.email.toLowerCase().trim();
      existing.firstName = identity.firstName?.trim().slice(0, 80) ?? existing.firstName;
      existing.lastName = identity.lastName?.trim().slice(0, 80) ?? existing.lastName;
      existing.updatedAt = now;
      return { user: structuredClone(existing), created: false };
    }
    const user = initialUser(identity, now);
    memoryStore.set(identity.id, user);
    return { user: structuredClone(user), created: true };
  }

  const ref = firestore().collection("onboarding_users").doc(identity.id);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) {
      const existing = snapshot.data() as OnboardingUser;
      const patch = {
        email: identity.email.toLowerCase().trim(),
        firstName: identity.firstName?.trim().slice(0, 80) ?? existing.firstName ?? "",
        lastName: identity.lastName?.trim().slice(0, 80) ?? existing.lastName ?? "",
        updatedAt: now,
      };
      tx.update(ref, patch);
      return { user: { ...existing, ...patch }, created: false };
    }
    const user = initialUser(identity, now);
    tx.create(ref, user);
    return { user, created: true };
  });
}

export async function recordOnboardingProgress(
  id: string,
  progress: OnboardingProgress,
  now = Date.now(),
): Promise<OnboardingUser | null> {
  const acquisition = cleanAcquisition(progress.acquisition);
  const apply = (user: OnboardingUser): OnboardingUser => {
    const pendingFirstNudge = user.status === "pending" && user.nudgeStage === 0;
    return {
      ...user,
      updatedAt: now,
      lastActivityAt: now,
      timezone: progress.timezone ? validTimezone(progress.timezone) : user.timezone,
      intendedTickers: progress.intendedTickers
        ? cleanTickers(progress.intendedTickers)
        : user.intendedTickers,
      ...(progress.intendedPlan
        ? { intendedPlan: progress.intendedPlan.toLowerCase().slice(0, 20) }
        : {}),
      ...(user.acquisition ? {} : acquisition ? { acquisition } : {}),
      ...(pendingFirstNudge ? { nextNudgeAt: now + FIRST_NUDGE_DELAY_MS } : {}),
    };
  };

  if (useMemory) {
    const user = memoryStore.get(id);
    if (!user) return null;
    const updated = apply(user);
    memoryStore.set(id, updated);
    return structuredClone(updated);
  }
  const ref = firestore().collection("onboarding_users").doc(id);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const updated = apply(snapshot.data() as OnboardingUser);
    tx.set(ref, updated);
    return updated;
  });
}

export async function completeOnboardingUser(id: string, now = Date.now()): Promise<boolean> {
  if (useMemory) {
    memoryDeskIds.add(id);
    const user = memoryStore.get(id);
    if (!user) return false;
    Object.assign(user, {
      status: "completed" as const,
      completedAt: now,
      updatedAt: now,
    });
    delete user.nextNudgeAt;
    delete user.nudgeLease;
    return true;
  }
  const ref = firestore().collection("onboarding_users").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  await ref.update({
    status: "completed",
    completedAt: now,
    updatedAt: now,
    nextNudgeAt: FieldValue.delete(),
    nudgeLease: FieldValue.delete(),
  });
  return true;
}

export async function setOnboardingEmailOptOut(id: string, now = Date.now()): Promise<boolean> {
  if (useMemory) {
    const user = memoryStore.get(id);
    if (!user) return false;
    user.status = "unsubscribed";
    user.emailOptOutAt = now;
    user.updatedAt = now;
    delete user.nextNudgeAt;
    delete user.nudgeLease;
    return true;
  }
  const ref = firestore().collection("onboarding_users").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  await ref.update({
    status: "unsubscribed",
    emailOptOutAt: now,
    updatedAt: now,
    nextNudgeAt: FieldValue.delete(),
    nudgeLease: FieldValue.delete(),
  });
  return true;
}

export async function markOnboardingDeleted(id: string, now = Date.now()): Promise<boolean> {
  if (useMemory) {
    const user = memoryStore.get(id);
    if (!user) return false;
    user.status = "deleted";
    user.deletedAt = now;
    user.updatedAt = now;
    delete user.nextNudgeAt;
    delete user.nudgeLease;
    return true;
  }
  const ref = firestore().collection("onboarding_users").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  await ref.update({
    status: "deleted",
    deletedAt: now,
    updatedAt: now,
    nextNudgeAt: FieldValue.delete(),
    nudgeLease: FieldValue.delete(),
  });
  return true;
}

function isClaimable(user: OnboardingUser, now: number): user is OnboardingUser & { nextNudgeAt: number } {
  return user.status === "pending" &&
    user.nudgeStage >= 0 && user.nudgeStage < 3 &&
    typeof user.nextNudgeAt === "number" && user.nextNudgeAt <= now &&
    (!user.nudgeLease || user.nudgeLease.expiresAt <= now);
}

function makeClaim(user: OnboardingUser): ClaimedOnboardingNudge {
  const stage = user.nudgeStage as OnboardingNudgeStage;
  const leaseToken = randomUUID();
  return {
    user,
    stage,
    leaseToken,
    idempotencyKey: `onboarding/${user.id}/stage-${stage}`,
  };
}

export async function claimDueOnboardingNudges(
  now = Date.now(),
  limit = 50,
): Promise<ClaimedOnboardingNudge[]> {
  const claimed: ClaimedOnboardingNudge[] = [];
  if (useMemory) {
    const due = [...memoryStore.values()]
      .filter((user) => isClaimable(user, now))
      .sort((a, b) => (a.nextNudgeAt ?? 0) - (b.nextNudgeAt ?? 0))
      .slice(0, limit);
    for (const user of due) {
      if (memoryDeskIds.has(user.id)) {
        await completeOnboardingUser(user.id, now);
        continue;
      }
      const claim = makeClaim(structuredClone(user));
      user.nudgeLease = {
        token: claim.leaseToken,
        stage: claim.stage,
        claimedAt: now,
        expiresAt: now + LEASE_MS,
      };
      user.deliveries[String(claim.stage)] = {
        stage: claim.stage,
        idempotencyKey: claim.idempotencyKey,
        status: "claimed",
        claimedAt: now,
      };
      claimed.push(claim);
    }
    return claimed;
  }

  const snapshots = await firestore().collection("onboarding_users")
    .where("nextNudgeAt", "<=", now)
    .orderBy("nextNudgeAt", "asc")
    .limit(Math.min(200, Math.max(limit * 3, limit)))
    .get();

  for (const candidate of snapshots.docs) {
    if (claimed.length >= limit) break;
    const result = await firestore().runTransaction(async (tx) => {
      const userRef = candidate.ref;
      const deskRef = firestore().collection("desks").doc(candidate.id);
      const [userSnapshot, deskSnapshot] = await Promise.all([tx.get(userRef), tx.get(deskRef)]);
      if (!userSnapshot.exists) return null;
      const user = userSnapshot.data() as OnboardingUser;
      const deskTickers = deskSnapshot.exists
        ? (deskSnapshot.data()?.tickers as unknown)
        : null;
      if (Array.isArray(deskTickers) && deskTickers.length > 0) {
        tx.update(userRef, {
          status: "completed",
          completedAt: now,
          updatedAt: now,
          nextNudgeAt: FieldValue.delete(),
          nudgeLease: FieldValue.delete(),
        });
        return null;
      }
      if (!isClaimable(user, now)) return null;
      const claim = makeClaim(user);
      const delivery: OnboardingDelivery = {
        stage: claim.stage,
        idempotencyKey: claim.idempotencyKey,
        status: "claimed",
        claimedAt: now,
      };
      tx.update(userRef, {
        nudgeLease: {
          token: claim.leaseToken,
          stage: claim.stage,
          claimedAt: now,
          expiresAt: now + LEASE_MS,
        },
        [`deliveries.${claim.stage}`]: delivery,
        updatedAt: now,
      });
      return claim;
    });
    if (result) claimed.push(result);
  }
  return claimed;
}

export async function acceptOnboardingNudge(
  claim: ClaimedOnboardingNudge,
  providerEmailId: string,
  acceptedAt = Date.now(),
): Promise<boolean> {
  const nextNudgeAt = nextNudgeAfterAccepted(claim.user, claim.stage, acceptedAt);
  const apply = (user: OnboardingUser): boolean => {
    if (user.status !== "pending" || user.nudgeLease?.token !== claim.leaseToken) return false;
    user.deliveries[String(claim.stage)] = {
      ...(user.deliveries[String(claim.stage)] ?? {
        stage: claim.stage,
        idempotencyKey: claim.idempotencyKey,
        claimedAt: acceptedAt,
      }),
      status: "accepted",
      acceptedAt,
      providerEmailId,
    };
    user.nudgeStage = claim.stage + 1;
    user.updatedAt = acceptedAt;
    delete user.nudgeLease;
    if (nextNudgeAt == null) delete user.nextNudgeAt;
    else user.nextNudgeAt = nextNudgeAt;
    return true;
  };
  if (useMemory) {
    const user = memoryStore.get(claim.user.id);
    return user ? apply(user) : false;
  }
  const userRef = firestore().collection("onboarding_users").doc(claim.user.id);
  const emailRef = firestore().collection("onboarding_email_index").doc(providerEmailId);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(userRef);
    if (!snapshot.exists) return false;
    const user = snapshot.data() as OnboardingUser;
    if (user.status !== "pending" || user.nudgeLease?.token !== claim.leaseToken) return false;
    const delivery: OnboardingDelivery = {
      ...(user.deliveries?.[String(claim.stage)] ?? {
        stage: claim.stage,
        idempotencyKey: claim.idempotencyKey,
        claimedAt: acceptedAt,
      }),
      status: "accepted",
      acceptedAt,
      providerEmailId,
    };
    tx.update(userRef, {
      [`deliveries.${claim.stage}`]: delivery,
      nudgeStage: claim.stage + 1,
      updatedAt: acceptedAt,
      nudgeLease: FieldValue.delete(),
      nextNudgeAt: nextNudgeAt == null ? FieldValue.delete() : nextNudgeAt,
    });
    tx.set(emailRef, {
      emailId: providerEmailId,
      userId: claim.user.id,
      stage: claim.stage,
      category: "onboarding",
      acceptedAt,
    });
    return true;
  });
}

export async function failOnboardingNudge(
  claim: ClaimedOnboardingNudge,
  failure: string,
  now = Date.now(),
): Promise<boolean> {
  if (useMemory) {
    const user = memoryStore.get(claim.user.id);
    if (!user || user.nudgeLease?.token !== claim.leaseToken) return false;
    user.deliveries[String(claim.stage)] = {
      ...(user.deliveries[String(claim.stage)] ?? {
        stage: claim.stage,
        idempotencyKey: claim.idempotencyKey,
        claimedAt: now,
      }),
      status: "failed",
      failure: failure.slice(0, 300),
    };
    user.nextNudgeAt = now + RETRY_DELAY_MS;
    user.updatedAt = now;
    delete user.nudgeLease;
    return true;
  }
  const ref = firestore().collection("onboarding_users").doc(claim.user.id);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return false;
    const user = snapshot.data() as OnboardingUser;
    if (user.nudgeLease?.token !== claim.leaseToken) return false;
    const delivery: OnboardingDelivery = {
      ...(user.deliveries?.[String(claim.stage)] ?? {
        stage: claim.stage,
        idempotencyKey: claim.idempotencyKey,
        claimedAt: now,
      }),
      status: "failed",
      failure: failure.slice(0, 300),
    };
    tx.update(ref, {
      [`deliveries.${claim.stage}`]: delivery,
      nextNudgeAt: now + RETRY_DELAY_MS,
      updatedAt: now,
      nudgeLease: FieldValue.delete(),
    });
    return true;
  });
}

const SUPPRESSING_EVENTS = new Set(["email.bounced", "email.complained", "email.suppressed"]);

export async function recordResendOnboardingEvent({
  eventId,
  eventType,
  eventAt,
  emailId,
  userId,
  stage,
}: {
  eventId: string;
  eventType: string;
  eventAt: number;
  emailId: string;
  userId: string;
  stage: number;
}): Promise<{ processed: boolean; suppressed: boolean }> {
  const suppress = SUPPRESSING_EVENTS.has(eventType);
  if (useMemory) {
    if (memoryWebhookEvents.has(eventId)) return { processed: false, suppressed: false };
    memoryWebhookEvents.add(eventId);
    const user = memoryStore.get(userId);
    if (!user) return { processed: true, suppressed: false };
    const key = String(stage);
    const delivery = user.deliveries[key];
    if (delivery && eventAt >= (delivery.lastEventAt ?? 0)) {
      delivery.lastEventAt = eventAt;
      delivery.lastEventType = eventType;
      if (eventType === "email.delivered") delivery.status = "delivered";
      else if (eventType === "email.clicked") delivery.status = "clicked";
      else if (suppress) delivery.status = "suppressed";
    }
    if (suppress) {
      user.status = "suppressed";
      user.suppressedAt = eventAt;
      user.suppressionReason = eventType;
      delete user.nextNudgeAt;
      delete user.nudgeLease;
    }
    return { processed: true, suppressed: suppress };
  }

  const eventRef = firestore().collection("resend_webhook_events").doc(eventId);
  const userRef = firestore().collection("onboarding_users").doc(userId);
  return firestore().runTransaction(async (tx) => {
    const [eventSnapshot, userSnapshot] = await Promise.all([tx.get(eventRef), tx.get(userRef)]);
    if (eventSnapshot.exists) return { processed: false, suppressed: false };
    tx.create(eventRef, { eventId, eventType, eventAt, emailId, userId, stage, receivedAt: Date.now() });
    if (!userSnapshot.exists) return { processed: true, suppressed: false };
    const user = userSnapshot.data() as OnboardingUser;
    const key = String(stage);
    const existing = user.deliveries?.[key];
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (existing && eventAt >= (existing.lastEventAt ?? 0)) {
      const status = eventType === "email.delivered"
        ? "delivered"
        : eventType === "email.clicked"
          ? "clicked"
          : suppress
            ? "suppressed"
            : existing.status;
      patch[`deliveries.${key}`] = {
        ...existing,
        status,
        lastEventAt: eventAt,
        lastEventType: eventType,
      };
    }
    if (suppress) {
      Object.assign(patch, {
        status: "suppressed",
        suppressedAt: eventAt,
        suppressionReason: eventType,
        nextNudgeAt: FieldValue.delete(),
        nudgeLease: FieldValue.delete(),
      });
    }
    tx.update(userRef, patch);
    return { processed: true, suppressed: suppress };
  });
}

export async function getOnboardingUser(id: string): Promise<OnboardingUser | null> {
  if (useMemory) return memoryStore.has(id) ? structuredClone(memoryStore.get(id)!) : null;
  const snapshot = await firestore().collection("onboarding_users").doc(id).get();
  return snapshot.exists ? snapshot.data() as OnboardingUser : null;
}

/** Test-only helper; production code never calls this. */
export function resetOnboardingMemoryStore(): void {
  if (!useMemory) return;
  memoryStore.clear();
  memoryDeskIds.clear();
  memoryWebhookEvents.clear();
}
