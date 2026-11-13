import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getDesk } from "@/lib/desk";
import { isTier } from "@/lib/tiers";
import { priceForTier, stripe } from "@/lib/billing";
import { siteUrl } from "@/lib/environment";

const SITE = siteUrl();

/**
 * Start payment for a tier. llmcouncil's discipline, mirrored:
 * - no existing subscription → Stripe Checkout (creates the subscription)
 * - existing subscription → Customer Portal's subscription_update_confirm
 *   flow (Stripe shows prorations; never creates a duplicate subscription)
 * Downgrades and cancellations always go through the Portal (/api/billing/portal).
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const s = stripe();
  if (!s) return NextResponse.json({ error: "Billing isn't configured yet" }, { status: 503 });

  let tier = "";
  let fromOnboarding = false;
  let pendingTicker = "";
  try {
    const body = (await req.json()) as { tier?: string; returnTo?: string; pendingTicker?: string };
    tier = String(body.tier ?? "");
    fromOnboarding = body.returnTo === "onboarding";
    // The stock whose add hit the tier cap — it rides through Stripe and
    // lands pre-picked so the upgrade finishes the exact task that caused it.
    const p = String(body.pendingTicker ?? "").toUpperCase();
    if (/^[A-Z.]{1,6}$/.test(p)) pendingTicker = p;
  } catch {
    /* no body */
  }
  if (!isTier(tier) || tier === "free") {
    return NextResponse.json({ error: "tier must be pro or ultra" }, { status: 400 });
  }
  // Onboarding pays before the desk exists — land back on the picker, not the desk.
  const successUrl = fromOnboarding
    ? `${SITE}/desk/new?upgraded=${tier}${pendingTicker ? `&add=${pendingTicker}` : ""}`
    : `${SITE}/desk?upgraded=${tier}`;
  const cancelUrl = fromOnboarding ? `${SITE}/desk/new` : `${SITE}/desk`;
  const price = priceForTier(tier);
  if (!price) return NextResponse.json({ error: "Price not configured" }, { status: 503 });

  const desk = await getDesk(userId);

  try {
    // Existing subscription → hosted upgrade confirmation, not a new Checkout.
    if (desk?.stripeSubscriptionId && desk.stripeCustomerId) {
      const sub = await s.subscriptions.retrieve(desk.stripeSubscriptionId).catch(() => null);
      if (sub && (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due")) {
        if (sub.items.data[0]?.price.id === price) {
          return NextResponse.json({ error: "Already on this plan" }, { status: 400 });
        }
        const portal = await s.billingPortal.sessions.create({
          customer: desk.stripeCustomerId,
          return_url: successUrl,
          flow_data: {
            type: "subscription_update_confirm",
            subscription_update_confirm: {
              subscription: sub.id,
              items: [{ id: sub.items.data[0].id, price, quantity: 1 }],
            },
          },
        });
        return NextResponse.json({ url: portal.url });
      }
    }

    const user = await currentUser();
    const email =
      desk?.email ||
      user?.primaryEmailAddress?.emailAddress ||
      user?.emailAddresses?.[0]?.emailAddress ||
      undefined;

    const session = await s.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      client_reference_id: userId,
      ...(desk?.stripeCustomerId ? { customer: desk.stripeCustomerId } : { customer_email: email }),
      allow_promotion_codes: true,
      // The subscription carries the desk id so every later webhook event
      // (upgrades, cancellations, invoices) maps back without reverse lookups.
      subscription_data: { metadata: { deskId: userId, tier } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    console.error(`[billing] checkout failed: ${String(e).slice(0, 200)}`);
    return NextResponse.json({ error: "Couldn't start checkout — try again" }, { status: 500 });
  }
}
