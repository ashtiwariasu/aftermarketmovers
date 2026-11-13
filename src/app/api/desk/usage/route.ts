import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import { auth } from "@clerk/nextjs/server";
import { getDesk, usageOf } from "@/lib/desk";
import { TIERS, MAX_SITTING_COST } from "@/lib/tiers";

/** Current tier + meters for the signed-in member's desk. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const desk = await getDesk(userId);
  if (!desk) {
    // No desk yet — paid-only means the picker must render the checkout wall.
    return NextResponse.json({
      tier: "free",
      label: TIERS.free.label,
      companies: { used: 0, cap: TIERS.free.companies },
      sittings: { used: 0, cap: TIERS.free.sittings },
      maxCost: MAX_SITTING_COST,
      trial: { access: "payment_required", active: false, startedAt: null, endsAt: null, daysRemaining: null },
    });
  }
  const u = usageOf(desk);
  return NextResponse.json({
    tier: u.tier,
    label: TIERS[u.tier].label,
    companies: { used: u.companiesUsed, cap: u.companiesCap },
    sittings: { used: u.used, cap: u.cap },
    maxCost: MAX_SITTING_COST,
    trial: u.trial,
  });
}
