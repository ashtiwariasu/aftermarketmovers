import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type Stripe from "stripe";
import { getDesk, tierOf } from "@/lib/desk";
import { TIERS } from "@/lib/tiers";
import { stripe, tierForPrice } from "@/lib/billing";

/**
 * Everything the billing modal shows: current plan (from Stripe when a
 * subscription exists, else the desk's tier), renewal state, and the
 * invoice ledger. Mirrors llmcouncil's SubscriptionModal data shape.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const desk = await getDesk(userId);
  if (!desk) return NextResponse.json({ error: "No desk" }, { status: 404 });
  const deskTier = tierOf(desk);

  const s = stripe();
  if (!s || !desk.stripeCustomerId) {
    // Unpaid or legacy manual desks: plan card only, no Stripe-backed controls.
    return NextResponse.json({
      tier: deskTier,
      label: TIERS[deskTier].label,
      price: TIERS[deskTier].price,
      blurb: TIERS[deskTier].blurb,
      stripeBacked: false,
      invoices: [],
    });
  }

  try {
    let renewsAt: number | null = null;
    let cancelAtPeriodEnd = false;
    let subTier = deskTier;
    if (desk.stripeSubscriptionId) {
      const sub = await s.subscriptions.retrieve(desk.stripeSubscriptionId).catch(() => null);
      if (sub) {
        const item = sub.items.data[0];
        subTier = tierForPrice(item?.price.id) ?? deskTier;
        const periodEnd =
          (item as unknown as { current_period_end?: number })?.current_period_end ??
          (sub as unknown as { current_period_end?: number }).current_period_end ??
          null;
        renewsAt = periodEnd ? periodEnd * 1000 : null;
        cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
      }
    }

    const invoices = await s.invoices.list({ customer: desk.stripeCustomerId, limit: 12 });
    const rows = invoices.data.map((inv: Stripe.Invoice) => {
      const period = inv.lines.data[0]?.period;
      return {
        number: inv.number ?? inv.id,
        createdAt: inv.created * 1000,
        periodStart: period?.start ? period.start * 1000 : null,
        periodEnd: period?.end ? period.end * 1000 : null,
        amount: (inv.amount_paid || inv.amount_due) / 100,
        currency: inv.currency?.toUpperCase() ?? "USD",
        status: inv.status,
        viewUrl: inv.hosted_invoice_url ?? null,
        pdfUrl: inv.invoice_pdf ?? null,
      };
    });

    return NextResponse.json({
      tier: subTier,
      label: TIERS[subTier].label,
      price: TIERS[subTier].price,
      blurb: TIERS[subTier].blurb,
      stripeBacked: true,
      renewsAt,
      cancelAtPeriodEnd,
      invoices: rows,
    });
  } catch (e) {
    console.error(`[billing] summary failed: ${String(e).slice(0, 200)}`);
    return NextResponse.json({ error: "Couldn't load billing" }, { status: 500 });
  }
}
