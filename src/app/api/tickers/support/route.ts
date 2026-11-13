import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { assessResearchSupport } from "@/lib/researchSupport";

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const ticker = request.nextUrl.searchParams.get("ticker") ?? "";
  const decision = await assessResearchSupport(ticker);
  const status = decision.supported
    ? 200
    : decision.code === "verification_unavailable"
      ? 503
      : 422;
  return NextResponse.json(decision, {
    status,
    headers: { "Cache-Control": "private, max-age=0, no-store" },
  });
}
