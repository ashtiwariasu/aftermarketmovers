import { NextRequest, NextResponse } from "next/server";
import { runNewsPipeline } from "@/lib/newsPipeline";

export const maxDuration = 900;

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_TOKEN ?? "";
  const received = request.headers.get("x-cron-token") ?? "";
  if (!expected || received !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Twelve-hour schedule plus one hour of overlap prevents collection gaps.
  const result = await runNewsPipeline({ mode: "scheduled", lookbackHours: 13, concurrency: 3 });
  if (!result.acquired) {
    return NextResponse.json(
      { skipped: true, reason: "active-run", run: result.run },
      { status: 202 },
    );
  }
  const status = result.run.status === "failed" ? 503 : 200;
  return NextResponse.json({ skipped: false, run: result.run }, { status });
}
