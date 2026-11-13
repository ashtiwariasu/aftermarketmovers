import { NextRequest, NextResponse } from "next/server";
import { runSocialIntel } from "@/lib/socialIntel";
import { listActiveCompanyTickers } from "@/lib/companyFleet";
import { partitionResearchSupportedTickers } from "@/lib/researchSupport";

export const dynamic = "force-dynamic";
export const maxDuration = 1500;

/** Daily social evidence: exhaustive delta ingest → quality filter → normal dossiers. */
export async function POST(req: NextRequest) {
  const token = process.env.CRON_TOKEN;
  if (!token || req.headers.get("x-cron-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dateEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const candidates = await listActiveCompanyTickers();
  const support = await partitionResearchSupportedTickers(candidates);
  const result = await runSocialIntel(dateEt, support.supported);
  console.log(`[social-intel] ${JSON.stringify(result)}`);
  return NextResponse.json(
    {
      ...result,
      fleet: support.supported.length,
      excluded: support.excluded.map(({ symbol, code }) => ({ symbol, code })),
    },
    { status: result.skipped ? 202 : result.complete ? 200 : 503 },
  );
}
