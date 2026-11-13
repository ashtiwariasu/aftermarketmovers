import { NextRequest, NextResponse } from "next/server";
import { runNewsPipeline } from "@/lib/newsPipeline";

export const maxDuration = 1200;

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_TOKEN ?? "";
  const received = request.headers.get("x-cron-token") ?? "";
  if (!expected || received !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await runNewsPipeline({ mode: "backfill", lookbackHours: 48, concurrency: 2 });
  if (!result.acquired) {
    return NextResponse.json({ skipped: true, reason: "active-run", run: result.run }, { status: 202 });
  }
  return NextResponse.json(
    { skipped: false, run: result.run },
    { status: result.run.status === "failed" ? 503 : 200 },
  );
}
