import { NextRequest, NextResponse } from "next/server";
import {
  EvidenceReconciliationRequestError,
  runEvidenceReconciliation,
} from "@/lib/evidenceReconciliation";
import { requestCronTokenAuthorized } from "@/lib/cronAuth";

export const maxDuration = 300;

/** Weekly deterministic integrity check for the existing Evidence Room lineage. */
export async function POST(request: NextRequest) {
  if (!requestCronTokenAuthorized(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const tickerValues = request.nextUrl.searchParams.getAll("ticker");
  if (tickerValues.length > 1 || (tickerValues.length === 1 && tickerValues[0].trim().length === 0)) {
    return NextResponse.json({ error: "invalid ticker" }, { status: 400 });
  }
  const startedAt = Date.now();
  try {
    const result = await runEvidenceReconciliation({ ticker: tickerValues[0] ?? null });
    return NextResponse.json({
      ok: result.errors.length === 0,
      ...result,
      elapsedMs: Date.now() - startedAt,
    }, { status: result.errors.length > 0 ? 503 : 200 });
  } catch (error) {
    if (error instanceof EvidenceReconciliationRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({
      error: String(error instanceof Error ? error.message : error).slice(0, 500),
      elapsedMs: Date.now() - startedAt,
    }, { status: 500 });
  }
}
