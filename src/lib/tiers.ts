/**
 * Entitlements.
 * Unpaid (internal tier "free"): saved account only; no product access
 * AMM   $25/mo:      3 companies · 30 sittings/mo · 15 voice minutes/day
 * Ultra $399/mo:     legacy/internal plan; not offered to new members
 * A MAX-effort run costs 3 sittings at any tier (priced in the meter).
 * Tier is a desk field for now; Stripe provisioning lands later.
 */

export type Tier = "free" | "pro" | "ultra";
export type PaidTier = Exclude<Tier, "free">;

export const AMM_MONTHLY_PRICE_USD = 25;

export function paidPlanStartsWithTrial(tier: PaidTier): boolean {
  void tier;
  return false;
}

export function paidPlanEntryPath(tier: PaidTier): string {
  return `/desk/new?purchase=${tier}`;
}

export interface TierSpec {
  label: string;
  companies: number;
  sittings: number;
  voiceSecondsPerDay: number;
  price: string;
  blurb: string;
}

export const TIERS: Record<Tier, TierSpec> = {
  free: {
    label: "PAYMENT REQUIRED",
    companies: 0,
    sittings: 0,
    voiceSecondsPerDay: 0,
    price: "$25/mo",
    blurb: "Subscribe to activate 3 companies and 30 research questions",
  },
  pro: {
    label: "AMM",
    companies: 3,
    sittings: 30,
    voiceSecondsPerDay: 15 * 60,
    price: "$25/mo",
    blurb: "3 companies · 30 research questions",
  },
  ultra: {
    label: "AMM ULTRA",
    companies: 30,
    sittings: 300,
    voiceSecondsPerDay: 60 * 60,
    price: "$399/mo",
    blurb: "30 companies · 300 research questions",
  },
};

/** A MAX-effort council run draws this many sittings from the meter. */
export const MAX_SITTING_COST = 3;

export function isTier(v: unknown): v is Tier {
  return v === "free" || v === "pro" || v === "ultra";
}

/** The next tier up, for wall copy. */
export function nextTier(t: Tier): Tier | null {
  return t === "free" ? "pro" : null;
}

/** Current month key ("YYYY-MM") in the desk's timezone — sitting meters reset on it. */
export function monthKey(tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "America/New_York",
      year: "numeric",
      month: "2-digit",
    })
      .format(new Date())
      .slice(0, 7);
  } catch {
    return new Date().toISOString().slice(0, 7);
  }
}

/** Current local date key ("YYYY-MM-DD") for daily voice allowances. */
export function dayKey(tz?: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
