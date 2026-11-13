import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { Resend } from "resend";
import { getOnboardingUser, recordResendOnboardingEvent } from "@/lib/onboarding";
import { syncResendOnboardingContact } from "@/lib/resendContacts";
import { captureServerAnalyticsEvent } from "@/lib/posthogServer";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return new Response("Webhook not configured", { status: 503 });
  const payload = await request.text();
  let event: ReturnType<Resend["webhooks"]["verify"]>;
  try {
    event = new Resend(process.env.RESEND_API_KEY).webhooks.verify({
      payload,
      headers: {
        id: request.headers.get("svix-id") ?? "",
        timestamp: request.headers.get("svix-timestamp") ?? "",
        signature: request.headers.get("svix-signature") ?? "",
      },
      webhookSecret: secret,
    });
  } catch (error) {
    console.warn(`[resend-webhook] rejected: ${String(error).slice(0, 160)}`);
    return new Response("Invalid webhook", { status: 400 });
  }
  if (!event.type.startsWith("email.") || !("tags" in event.data) || event.data.tags?.category !== "onboarding") {
    return Response.json({ received: true, ignored: true });
  }
  const userId = event.data.tags.user_id ?? "";
  const stage = Number(event.data.tags.stage);
  if (!/^[0-9a-zA-Z_-]{10,64}$/.test(userId) || !Number.isInteger(stage) || stage < 0 || stage > 2) {
    return Response.json({ received: true, ignored: true });
  }
  const rawEventId = request.headers.get("svix-id") ?? `${event.type}:${event.data.email_id}:${event.created_at}`;
  const eventId = createHash("sha256").update(rawEventId).digest("hex");
  const eventAt = Date.parse(event.created_at) || Date.now();
  const result = await recordResendOnboardingEvent({
    eventId,
    eventType: event.type,
    eventAt,
    emailId: event.data.email_id,
    userId,
    stage,
  });
  if (result.suppressed) {
    const user = await getOnboardingUser(userId);
    if (user) await syncResendOnboardingContact(user, "suppressed");
  }
  if (result.processed && (event.type === "email.clicked" || event.type === "email.delivered")) {
    await captureServerAnalyticsEvent({
      distinctId: userId,
      event: event.type === "email.clicked" ? "onboarding_nudge_clicked" : "onboarding_nudge_delivered",
      properties: {
        $insert_id: rawEventId,
        stage: stage + 1,
        provider_email_id: event.data.email_id,
        ...(event.type === "email.clicked" ? { link: event.data.click.link } : {}),
      },
    });
  }
  return Response.json({ received: true, duplicate: !result.processed });
}
