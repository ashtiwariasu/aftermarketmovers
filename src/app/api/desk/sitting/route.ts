import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { consumeSittings } from "@/lib/desk";
import { MAX_SITTING_COST, TIERS, nextTier } from "@/lib/tiers";

/**
 * Consume sittings from the member's monthly meter before a council run.
 * Body: { effort?: "max" } — a MAX run costs MAX_SITTING_COST, else 1.
 * Refusals are free (never charge a member for hitting the wall).
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  let effort = "";
  try {
    effort = String(((await req.json()) as { effort?: string }).effort ?? "");
  } catch {
    // empty body → standard sitting
  }
  const cost = effort === "max" ? MAX_SITTING_COST : 1;

  const verdict = await consumeSittings(userId, cost);
  if (!verdict) return NextResponse.json({ error: "No desk found" }, { status: 404 });

  const up = nextTier(verdict.tier);
  return NextResponse.json({
    ...verdict,
    cost,
    wall:
      verdict.allowed || !up
        ? null
        : {
            tier: up,
            label: TIERS[up].label,
            price: TIERS[up].price,
            blurb: TIERS[up].blurb,
          },
  });
}
