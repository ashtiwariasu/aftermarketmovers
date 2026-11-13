import { NextRequest, NextResponse } from "next/server";
import { searchCompanies } from "@/lib/sec";

/** Public typeahead over every US-listed company (SEC's official map). */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const hits = await searchCompanies(q, 8);
  return NextResponse.json(
    { hits },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } }
  );
}
