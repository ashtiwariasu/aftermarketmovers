import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { captureServerAnalyticsEvent } from "@/lib/posthogServer";
import { recordOnboardingProgress, upsertOnboardingUser } from "@/lib/onboarding";
import { syncResendOnboardingContact } from "@/lib/resendContacts";

const ACQUISITION_KEYS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "ref", "gclid", "fbclid", "referrer", "landing", "at",
]);

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress ?? clerkUser?.emailAddresses?.[0]?.emailAddress ?? "";
  if (!email) return NextResponse.json({ error: "Account email unavailable" }, { status: 400 });
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch {}
  const result = await upsertOnboardingUser({
    id: userId,
    email,
    firstName: clerkUser?.firstName ?? "",
    lastName: clerkUser?.lastName ?? "",
    createdAt: clerkUser?.createdAt,
  });
  const acquisition = body.acquisition && typeof body.acquisition === "object"
    ? Object.fromEntries(Object.entries(body.acquisition as Record<string, unknown>)
      .filter(([key, value]) => ACQUISITION_KEYS.has(key) && typeof value === "string")
      .map(([key, value]) => [key, String(value)]))
    : undefined;
  const updated = await recordOnboardingProgress(userId, {
    timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    intendedPlan: typeof body.intendedPlan === "string" ? body.intendedPlan : undefined,
    intendedTickers: Array.isArray(body.intendedTickers)
      ? body.intendedTickers.filter((value): value is string => typeof value === "string")
      : undefined,
    acquisition,
  });
  if (result.created) {
    await Promise.all([
      syncResendOnboardingContact(result.user, "pending"),
      captureServerAnalyticsEvent({
        distinctId: userId,
        event: "account_created",
        properties: { $insert_id: `account-created/${userId}`, source: "authenticated_onboarding" },
      }),
    ]);
  }
  return NextResponse.json({ ok: true, created: result.created, status: updated?.status ?? result.user.status });
}
