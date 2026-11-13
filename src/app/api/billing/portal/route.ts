import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getDesk } from "@/lib/desk";
import { stripe } from "@/lib/billing";
import { siteUrl } from "@/lib/environment";

const SITE = siteUrl();

/**
 * Stripe Customer Portal — plan changes, cancellation, invoices, payment
 * method. llmcouncil's lesson verbatim: the Portal owns downgrades and
 * cancellations; never rebuild a plan grid.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const s = stripe();
  if (!s) return NextResponse.json({ error: "Billing isn't configured yet" }, { status: 503 });

  const desk = await getDesk(userId);
  if (!desk?.stripeCustomerId) {
    return NextResponse.json({ error: "No billing on file for this desk" }, { status: 404 });
  }

  let flow = "";
  try {
    flow = String(((await req.json()) as { flow?: string }).flow ?? "");
  } catch {
    /* plain portal */
  }

  try {
    const session = await s.billingPortal.sessions.create({
      customer: desk.stripeCustomerId,
      return_url: `${SITE}/desk`,
      // "Cancel subscription" deep-links straight to Stripe's cancel
      // confirmation (llmcouncil's pattern — the Portal owns cancellation).
      ...(flow === "cancel" && desk.stripeSubscriptionId
        ? {
            flow_data: {
              type: "subscription_cancel" as const,
              subscription_cancel: { subscription: desk.stripeSubscriptionId },
            },
          }
        : {}),
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    console.error(`[billing] portal failed: ${String(e).slice(0, 200)}`);
    return NextResponse.json({ error: "Couldn't open billing — try again" }, { status: 500 });
  }
}
