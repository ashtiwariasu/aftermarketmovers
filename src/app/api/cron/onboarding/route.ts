import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  acceptOnboardingNudge,
  claimDueOnboardingNudges,
  failOnboardingNudge,
} from "@/lib/onboarding";
import { sendOnboardingNudge } from "@/lib/onboardingEmail";
import { captureServerAnalyticsEvent } from "@/lib/posthogServer";

export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_TOKEN?.trim();
  return Boolean(expected) && request.headers.get("x-cron-token") === expected;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (process.env.AMM_EMAILS_ENABLED !== "true" || !process.env.RESEND_API_KEY?.trim()) {
    return NextResponse.json({ error: "Lifecycle email is not configured" }, { status: 503 });
  }
  const claims = await claimDueOnboardingNudges(Date.now(), 50);
  let sent = 0;
  let failed = 0;
  for (const claim of claims) {
    const receipt = await sendOnboardingNudge(claim);
    if (receipt.accepted) {
      const providerEmailId = receipt.providerEmailId ?? `local-${createHash("sha256").update(claim.idempotencyKey).digest("hex").slice(0, 32)}`;
      const accepted = await acceptOnboardingNudge(claim, providerEmailId);
      if (accepted) {
        sent++;
        await captureServerAnalyticsEvent({
          distinctId: claim.user.id,
          event: "onboarding_nudge_sent",
          properties: {
            $insert_id: providerEmailId,
            stage: claim.stage + 1,
            provider_email_id: providerEmailId,
          },
        });
      }
    } else {
      failed++;
      await failOnboardingNudge(claim, `${receipt.reason}: ${receipt.detail ?? "send not accepted"}`);
    }
  }
  return NextResponse.json({ considered: claims.length, sent, failed });
}
