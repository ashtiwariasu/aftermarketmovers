import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { getDesk, isDeskServiceActive, tierOf } from "@/lib/desk";
import { getVoiceAllowance } from "@/lib/voiceStore";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in first" }, { status: 401 });
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").toUpperCase().trim();
  if (!/^[A-Z.\-]{1,6}$/.test(ticker)) {
    return Response.json({ error: "A valid ticker is required" }, { status: 400 });
  }
  const desk = await getDesk(userId);
  if (!desk || !desk.tickers.includes(ticker)) {
    return Response.json({ error: "This company is not in AMM Desk" }, { status: 403 });
  }
  const tier = tierOf(desk);
  const allowance = await getVoiceAllowance(desk, tier);
  return Response.json({
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    active: isDeskServiceActive(desk),
    tier,
    allowance,
  }, { headers: { "Cache-Control": "no-store" } });
}

