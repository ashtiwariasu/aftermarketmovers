import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getDesk, setDeskBilling, usageOf } from "@/lib/desk";
import { stripe, tierForPrice } from "@/lib/billing";
import { sendPaymentFailedEmail, sendRenewalSummaryEmail } from "@/lib/notifications";
import {
  claimStripeEvent,
  failStripeEvent,
  finishStripeEvent,
  recordBillingEvent,
} from "@/lib/billingLedger";
import { captureServerAnalyticsEvent } from "@/lib/posthogServer";

/**
 * Stripe → desk.tier. The only writer of billing state, mirrored from
 * llmcouncil's pattern: signature-verified, exactly-once (claim/finish/fail
 * ledger so Stripe retries heal instead of double-applying), every tier
 * transition audited, paidSince stamped once.
 */
export async function POST(req: NextRequest) {
  const s = stripe();
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !whsec) return NextResponse.json({ error: "not configured" }, { status: 503 });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(await req.text(), sig, whsec);
  } catch (e) {
    console.error(`[billing] bad webhook signature: ${String(e).slice(0, 120)}`);
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  // Exactly-once: claim the event; a duplicate delivery exits clean.
  if (!(await claimStripeEvent(event.id, event.type))) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const audit = async (deskId: string, previousTier: string | null, newTier: string | null, note?: string) =>
    recordBillingEvent({ eventId: event.id, eventType: event.type, deskId, previousTier, newTier, note });

  /** deskId for subscription-shaped events lives in the sub's metadata. */
  const deskIdFromSub = async (subOrId: string | Stripe.Subscription | null | undefined) => {
    if (!subOrId) return { deskId: null as string | null, sub: null as Stripe.Subscription | null };
    const sub = typeof subOrId === "string" ? await s.subscriptions.retrieve(subOrId) : subOrId;
    return { deskId: sub.metadata?.deskId ?? null, sub };
  };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const deskId = session.client_reference_id;
        if (!deskId || session.mode !== "subscription") break;
        const { sub } = await deskIdFromSub(
          typeof session.subscription === "string" ? session.subscription : session.subscription?.id
        );
        const tier = tierForPrice(sub?.items.data[0]?.price.id);
        if (tier) {
          const prev = await setDeskBilling(deskId, {
            tier,
            stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id,
            stripeSubscriptionId: sub?.id,
          });
          await audit(deskId, prev, tier, "checkout completed");
          await captureServerAnalyticsEvent({
            distinctId: deskId,
            event: "purchase",
            properties: {
              $insert_id: event.id,
              transaction_id: session.id,
              plan: tier,
              currency: (session.currency ?? "usd").toUpperCase(),
              value: (session.amount_total ?? 0) / 100,
            },
          });
          console.log(`[billing] ${deskId} ${prev} → ${tier} (checkout)`);
        }
        break;
      }
      case "customer.subscription.updated": {
        const { deskId, sub } = await deskIdFromSub(event.data.object as Stripe.Subscription);
        if (!deskId || !sub) break;
        const active = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
        const tier = active ? tierForPrice(sub.items.data[0]?.price.id) : "free";
        if (tier) {
          const prev = await setDeskBilling(deskId, {
            tier,
            stripeSubscriptionId: sub.id,
            stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          });
          await audit(deskId, prev, tier, `subscription ${sub.status}`);
          console.log(`[billing] ${deskId} ${prev} → ${tier} (subscription ${sub.status})`);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const { deskId } = await deskIdFromSub(event.data.object as Stripe.Subscription);
        if (!deskId) break;
        const prev = await setDeskBilling(deskId, { tier: "free" });
        await audit(deskId, prev, "free", "subscription deleted");
        console.log(`[billing] ${deskId} ${prev} → free (subscription deleted)`);
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
        const { deskId } = await deskIdFromSub(subRef);
        if (deskId) await audit(deskId, null, null, `invoice paid ${invoice.amount_paid / 100} ${invoice.currency}`);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
        const { deskId } = await deskIdFromSub(subRef);
        // Tier holds through past_due (grace); subscription.updated handles the
        // final lapse. This is the dunning signal — audited for follow-up.
        if (deskId) {
          await audit(deskId, null, null, `invoice payment FAILED (attempt ${invoice.attempt_count})`);
          console.warn(`[billing] ${deskId} invoice payment failed (attempt ${invoice.attempt_count})`);
          // Churn-save: most involuntary churn is an expired card nobody
          // noticed until Stripe gave up. Best-effort nudge with a fix link;
          // the turn must never fail on email problems.
          try {
            const email = invoice.customer_email || (await getDesk(deskId))?.email;
            if (email) await sendPaymentFailedEmail(email);
          } catch (e) {
            console.error(`[billing] payment-failed email skipped: ${String(e).slice(0, 120)}`);
          }
        }
        break;
      }
      case "invoice.upcoming": {
        // Churn-save: pre-renewal value summary. Stripe fires this a few days
        // before each renewal when enabled on the endpoint. Record-only +
        // best-effort email; no tier change.
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
        const { deskId } = await deskIdFromSub(subRef);
        if (!deskId) break;
        await audit(deskId, null, null, "renewal upcoming");
        try {
          const desk = await getDesk(deskId);
          const email = invoice.customer_email || desk?.email;
          if (desk && email) {
            const u = usageOf(desk);
            const renewSec = invoice.next_payment_attempt ?? invoice.period_end;
            await sendRenewalSummaryEmail(email, {
              sittings: u.used,
              companies: u.companiesUsed,
              renewsAt: new Date(renewSec * 1000).toLocaleDateString("en-US", {
                day: "numeric",
                month: "short",
                year: "numeric",
              }),
            });
          }
        } catch (e) {
          console.error(`[billing] renewal summary email skipped: ${String(e).slice(0, 120)}`);
        }
        break;
      }
    }
    await finishStripeEvent(event.id);
  } catch (e) {
    console.error(`[billing] webhook handler error (${event.type}): ${String(e).slice(0, 200)}`);
    await failStripeEvent(event.id, String(e));
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
