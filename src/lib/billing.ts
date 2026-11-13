/**
 * Stripe billing — the one wire between money and the meter.
 * A subscription's price maps to a tier; the webhook writes desk.tier and
 * the meters (companies, sittings) follow automatically from TIERS.
 * Secrets: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Secret Manager);
 * price ids: STRIPE_PRICE_PRO / STRIPE_PRICE_ULTRA (plain env).
 */

import Stripe from "stripe";
import type { Tier } from "@/lib/tiers";
import { billingMode } from "@/lib/environment";

let client: Stripe | null = null;

export function stripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  const mode = billingMode();
  if (!key || mode === "disabled") return null;
  if (mode === "test" && !key.startsWith("sk_test_")) {
    throw new Error("AMM_BILLING_MODE=test requires a Stripe test secret key");
  }
  if (mode === "live" && !key.startsWith("sk_live_")) {
    throw new Error("AMM_BILLING_MODE=live requires a Stripe live secret key");
  }
  if (!client) client = new Stripe(key);
  return client;
}

export function tierForPrice(priceId: string | null | undefined): Tier | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === process.env.STRIPE_PRICE_ULTRA) return "ultra";
  return null;
}

export function priceForTier(tier: Tier): string | null {
  if (tier === "pro") return process.env.STRIPE_PRICE_PRO ?? null;
  if (tier === "ultra") return process.env.STRIPE_PRICE_ULTRA ?? null;
  return null;
}
