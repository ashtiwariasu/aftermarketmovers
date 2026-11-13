/**
 * Billing ledgers — mirrored from llmcouncil's battle-tested pattern:
 *  - stripeEvents/{eventId}: exactly-once webhook processing (claim →
 *    processed/failed; failed and orphaned-processing events are reclaimable
 *    so Stripe's retries heal transient errors instead of double-applying).
 *  - billingEvents: an append-only audit trail of every tier transition.
 */

import { Firestore } from "@google-cloud/firestore";

const useMemory = process.env.DESK_STORE === "memory";
const memEvents = ((globalThis as Record<string, unknown>).__stripeEvents ??= new Map<
  string,
  { status: string; at: number }
>()) as Map<string, { status: string; at: number }>;

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

const ORPHAN_MS = 5 * 60_000; // processing older than this is reclaimable

/** True = we own this event; false = already processed (or being processed). */
export async function claimStripeEvent(eventId: string, eventType: string): Promise<boolean> {
  if (useMemory) {
    const e = memEvents.get(eventId);
    if (e && e.status === "processed") return false;
    if (e && e.status === "processing" && Date.now() - e.at < ORPHAN_MS) return false;
    memEvents.set(eventId, { status: "processing", at: Date.now() });
    return true;
  }
  const ref = firestore().collection("stripeEvents").doc(eventId);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data() as { status?: string; updatedAt?: number };
      if (d.status === "processed") return false;
      if (d.status === "processing" && Date.now() - (d.updatedAt ?? 0) < ORPHAN_MS) return false;
      // failed or orphaned → reclaim
    }
    tx.set(ref, { eventType, status: "processing", receivedAt: Date.now(), updatedAt: Date.now() });
    return true;
  });
}

export async function finishStripeEvent(eventId: string): Promise<void> {
  if (useMemory) {
    memEvents.set(eventId, { status: "processed", at: Date.now() });
    return;
  }
  await firestore()
    .collection("stripeEvents")
    .doc(eventId)
    .set({ status: "processed", processedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
}

export async function failStripeEvent(eventId: string, error: string): Promise<void> {
  if (useMemory) {
    memEvents.set(eventId, { status: "failed", at: Date.now() });
    return;
  }
  await firestore()
    .collection("stripeEvents")
    .doc(eventId)
    .set({ status: "failed", error: error.slice(0, 400), updatedAt: Date.now() }, { merge: true });
}

/** Append-only audit line for every billing transition. */
export async function recordBillingEvent(entry: {
  eventId: string;
  eventType: string;
  deskId: string;
  previousTier?: string | null;
  newTier?: string | null;
  note?: string;
}): Promise<void> {
  if (useMemory) return;
  await firestore()
    .collection("billingEvents")
    .add({ ...entry, at: Date.now() })
    .then(() => {})
    .catch((e) => console.error(`[billing] audit write failed: ${String(e).slice(0, 120)}`));
}
