import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { captureServerAnalyticsEvent } from "@/lib/posthogServer";
import {
  getOnboardingUser,
  markOnboardingDeleted,
  upsertOnboardingUser,
} from "@/lib/onboarding";
import { syncResendOnboardingContact } from "@/lib/resendContacts";
import { getDesk, setDeskResearchActive } from "@/lib/desk";
import { syncDeskFleetMembership } from "@/lib/companyFleet";

export const dynamic = "force-dynamic";

type ClerkEmail = { id?: string; email_address?: string };

function identity(data: Record<string, unknown>) {
  const emails = Array.isArray(data.email_addresses) ? data.email_addresses as ClerkEmail[] : [];
  const primaryId = String(data.primary_email_address_id ?? "");
  const email = emails.find((item) => item.id === primaryId)?.email_address ?? emails[0]?.email_address ?? "";
  return {
    id: String(data.id ?? ""),
    email,
    firstName: typeof data.first_name === "string" ? data.first_name : "",
    lastName: typeof data.last_name === "string" ? data.last_name : "",
    createdAt: typeof data.created_at === "number" ? data.created_at : undefined,
  };
}

export async function POST(request: NextRequest) {
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(request);
  } catch (error) {
    console.warn(`[clerk-webhook] rejected: ${String(error).slice(0, 160)}`);
    return new Response("Invalid webhook", { status: 400 });
  }

  const data = event.data as unknown as Record<string, unknown>;
  const item = identity(data);
  const webhookId = request.headers.get("svix-id") ?? `${event.type}:${item.id}`;
  if (event.type === "user.created" || event.type === "user.updated") {
    if (!item.id || !item.email) return new Response("Missing user email", { status: 400 });
    const result = await upsertOnboardingUser(item);
    await syncResendOnboardingContact(result.user, result.user.status === "completed" ? "completed" : "pending");
    if (event.type === "user.created" && result.created) {
      await captureServerAnalyticsEvent({
        distinctId: item.id,
        event: "account_created",
        properties: { $insert_id: webhookId, source: "clerk_webhook" },
      });
    }
  } else if (event.type === "user.deleted" && item.id) {
    const existing = await getOnboardingUser(item.id);
    const desk = await getDesk(item.id);
    // Keep the desk and all historical research, but stop deleted accounts
    // contributing watchers to the shared company fleet.
    if (desk) {
      await setDeskResearchActive(item.id, false);
      try {
        await syncDeskFleetMembership(item.id, desk.tickers, []);
      } catch (error) {
        // The next scheduled fleet read derives from exhaustive desks and
        // repairs this mirror, so webhook delivery remains retry-safe.
        console.error(`[company-fleet] deleted-user sync failed for ${item.id}: ${String(error).slice(0, 300)}`);
      }
    }
    await markOnboardingDeleted(item.id);
    if (existing) await syncResendOnboardingContact(existing, "deleted");
  }
  return Response.json({ received: true });
}
