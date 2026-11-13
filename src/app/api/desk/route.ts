import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getTickerSnapshot, type TickerSnapshot } from "@/lib/ticker";
import {
  createDesk,
  getDesk,
  MORNING_NOTE_SEND_TIME,
  MORNING_NOTE_SEND_TIME_ZONE,
  isDeskServiceActive,
  tierOf,
  trialStateOf,
  type DeskActivity,
} from "@/lib/desk";
import { TIERS, nextTier } from "@/lib/tiers";
import { completeOnboardingUser, getOnboardingUser } from "@/lib/onboarding";
import { syncResendOnboardingContact } from "@/lib/resendContacts";
import { captureServerAnalyticsEvent } from "@/lib/posthogServer";
import { assessResearchSupport } from "@/lib/researchSupport";
import { syncDeskFleetMembership } from "@/lib/companyFleet";

function researchEligibleTickers(
  desk: { tickers: string[]; researchActive?: boolean; supportPaused?: Record<string, unknown> } | null,
): string[] {
  if (!desk || desk.researchActive === false) return [];
  return desk.tickers.filter((ticker) => !desk.supportPaused?.[ticker.toUpperCase()]);
}

/** The signed-in member's desk as the picker needs it — for preloading. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const desk = await getDesk(userId);
  if (!desk) return NextResponse.json({ error: "No desk yet" }, { status: 404 });
  return NextResponse.json({
    tickers: desk.tickers,
    noteTime: MORNING_NOTE_SEND_TIME,
    tz: MORNING_NOTE_SEND_TIME_ZONE,
  });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }
  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  let body: { tickers?: string[]; tz?: string; acquisition?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const tz =
    typeof body.tz === "string" && body.tz.length < 64 && body.tz.includes("/")
      ? body.tz
      : undefined;

  const ACQ_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "gclid", "fbclid", "referrer", "landing", "at"];
  const acquisition: Record<string, string> = {};
  if (body.acquisition && typeof body.acquisition === "object") {
    for (const k of ACQ_KEYS) {
      const v = (body.acquisition as Record<string, unknown>)[k];
      if (typeof v === "string" && v.length > 0) acquisition[k] = v.slice(0, 300);
    }
  }

  const raw = (body.tickers ?? [])
    .map((t) => t.toUpperCase().trim())
    .filter(Boolean);
  const unique = [...new Set(raw)];
  if (unique.length === 0) {
    return NextResponse.json(
      { error: "Pick at least one ticker" },
      { status: 400 }
    );
  }

  const existing = await getDesk(userId);

  // Tier cap on companies. Grandfather over-cap desks: they may keep or
  // shrink their current list, never grow past max(cap, current count).
  if (!existing || !isDeskServiceActive(existing)) {
    return NextResponse.json(
      {
        error: "AMM is $25/month. Subscribe to create or resume your desk; any existing research remains saved.",
        wall: { tier: "pro", label: TIERS.pro.label, price: TIERS.pro.price, blurb: TIERS.pro.blurb },
      },
      { status: 402 },
    );
  }
  const tier = tierOf(existing);
  const cap = TIERS[tier].companies;
  const allowedCount = Math.max(cap, existing?.tickers.length ?? 0);
  if (unique.length > allowedCount) {
    const up = nextTier(tier);
    return NextResponse.json(
      {
        error: `Your desk holds ${cap} ${cap === 1 ? "file" : "files"} on ${TIERS[tier].label}.`,
        wall: up
          ? { tier: up, label: TIERS[up].label, price: TIERS[up].price, blurb: TIERS[up].blurb }
          : null,
      },
      { status: 402 }
    );
  }

  // Coverage is an explicit product boundary, not an LLM failure discovered
  // after the member has spent a slot. Existing legacy selections may be
  // removed or retained while their scheduled research is paused; every new
  // selection must pass the current evidence-and-market-data contract.
  const existingTickers = new Set(existing?.tickers ?? []);
  const additions = unique.filter((ticker) => !existingTickers.has(ticker));
  const support = await Promise.all(additions.map((ticker) => assessResearchSupport(ticker)));
  const unsupported = support.filter((item) => !item.supported);
  if (unsupported.length > 0) {
    const verificationUnavailable = unsupported.some((item) => item.code === "verification_unavailable");
    return NextResponse.json(
      {
        error: unsupported[0].message,
        code: "STOCK_NOT_SUPPORTED",
        unsupported,
      },
      { status: verificationUnavailable ? 503 : 422 },
    );
  }

  const snapshots = (
    await Promise.all(unique.map((t) => getTickerSnapshot(t)))
  ).filter((s): s is TickerSnapshot => s !== null);

  if (snapshots.length !== unique.length) {
    return NextResponse.json(
      { error: "AMM could not verify complete US market data for every selection. Nothing was changed — please try again." },
      { status: 503 }
    );
  }

  const now = Date.now();
  const activity: DeskActivity[] = [
    { at: now, text: "Desk provisioned" },
    ...snapshots.map((s) => ({
      at: now,
      text: `${s.symbol} baseline built — price, range, volume and extended-hours state captured`,
    })),
    ...snapshots
      .filter((s) => s.nextEvent)
      .map((s) => ({
        at: now,
        text: `${s.symbol} next company event scheduled: ${s.nextEvent}`,
      })),
    { at: now, text: "Night shift armed — after-hours & premarket scans active" },
  ];

  // One desk per user — the Clerk userId is the desk id (idempotent upsert).
  const desk = await createDesk(
    email,
    snapshots.map((s) => s.symbol),
    activity,
    userId,
    undefined,
    tz,
    acquisition
  );
  // Desk membership is authoritative. Mirror it into the materialized shared
  // fleet immediately for observability; scheduled jobs also reconcile from
  // all desks, so a transient mirror failure never loses or invents coverage.
  try {
    await syncDeskFleetMembership(
      userId,
      researchEligibleTickers(existing),
      researchEligibleTickers(desk),
    );
  } catch (error) {
    console.error(`[company-fleet] desk sync failed for ${userId}: ${String(error).slice(0, 300)}`);
  }

  // Desk existence is the hard suppression check used by the recovery cron;
  // this explicit state change makes the lifecycle record and Resend segment
  // converge immediately as well.
  await completeOnboardingUser(userId);
  const onboarding = await getOnboardingUser(userId);
  if (onboarding) await syncResendOnboardingContact(onboarding, "completed");
  const created = existing.tickers.length === 0;
  if (created) {
    await captureServerAnalyticsEvent({
      distinctId: userId,
      event: "desk_created",
      properties: {
        $insert_id: `desk-created/${userId}`,
        ticker_count: desk.tickers.length,
        first_ticker: desk.tickers[0] ?? "",
        subscription_price_usd: 25,
      },
    });
  }

  return NextResponse.json({
    id: desk.id,
    created,
    tickers: desk.tickers,
    // The client must provision only genuinely new companies. Returning the
    // authoritative server-side diff prevents an existing desk save from
    // fanning out a full research run across every company already on file.
    additions,
    snapshots,
    trial: trialStateOf(desk),
  });
}
