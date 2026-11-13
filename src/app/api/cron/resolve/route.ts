import { NextRequest, NextResponse } from "next/server";
import { listActiveCompanyTickers } from "@/lib/companyFleet";
import { recordFromDossiers, resolveDue } from "@/lib/scoreboard";

export const maxDuration = 600;

/** Hourly: file new questions from fresh voted dossiers, resolve due ones. */
export async function POST(req: NextRequest) {
  const expected = process.env.CRON_TOKEN ?? "";
  if (!expected || req.headers.get("x-cron-token") !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const todayEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const tickers = await listActiveCompanyTickers();
  const recorded = await recordFromDossiers(tickers, todayEt);
  const { checked, moved } = await resolveDue(todayEt);
  return NextResponse.json({ todayEt, tickers: tickers.length, recorded, checked, moved });
}
