import { NextRequest, NextResponse } from "next/server";
import { listDesks } from "@/lib/desk";

export const dynamic = "force-dynamic";

/** Signups per acquisition source/content — the sponsorship-experiment scoreboard.
 *  Guarded by the shared cron token; read-only. */
export async function GET(req: NextRequest) {
  const token = process.env.CRON_TOKEN;
  if (!token || req.headers.get("x-cron-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const desks = await listDesks();
  const rows = desks.map((d) => ({
    createdAt: new Date(d.createdAt).toISOString().slice(0, 10),
    tier: d.tier ?? "free",
    tickers: d.tickers.length,
    paid: Boolean(d.paidSince),
    source: d.acquisition?.utm_source ?? (d.acquisition?.referrer ? "referral" : "organic"),
    content: d.acquisition?.utm_content ?? null,
    campaign: d.acquisition?.utm_campaign ?? null,
    referrer: d.acquisition?.referrer ?? null,
  }));
  const byContent: Record<string, { signups: number; paid: number }> = {};
  for (const r of rows) {
    const key = `${r.source}${r.content ? `/${r.content}` : ""}`;
    byContent[key] ??= { signups: 0, paid: 0 };
    byContent[key].signups += 1;
    if (r.paid) byContent[key].paid += 1;
  }
  return NextResponse.json({ desks: rows.length, byContent, rows });
}
