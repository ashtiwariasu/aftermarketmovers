import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { listActiveCompanyTickers } from "@/lib/companyFleet";
import {
  dossierReleaseValidationError,
  ensureDossier,
  getCachedDossier,
  getDossierTerminalFailure,
  getRejectedDossierFactualUpdate,
} from "@/lib/dossier";
import { getProfile, refreshCompanySources } from "@/lib/companyStore";
import {
  getDailyThesisCheck,
  recordDailyThesisCheck,
  type DailyThesisCheck,
} from "@/lib/dailyThesisCheck";
import { buildEvidencePack } from "@/lib/evidenceRoom";
import { partitionResearchSupportedTickers } from "@/lib/researchSupport";
import {
  acquirePipelineLease,
  releasePipelineLease,
} from "@/lib/newsStore";
import { recordTickerResearchOutcome } from "@/lib/scoreboard";
import {
  dossierCronAuthorized,
  dossierCronStatus,
  dailyResearchLeaseId,
  selectDossierCandidates,
} from "@/lib/dossierCron";
import { isUsEquityTradingDay } from "@/lib/shortPublishing";

export const maxDuration = 1500;

// Once each trading day: generate today's dossier for each UNIQUE watched
// ticker (shared across desks — public-source content). Production Scheduler
// splits that single logical cycle into deterministic shards. Only an
// unfinished durable drain is retryable; a completed research rejection is
// recorded and stops.

function etDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function POST(req: NextRequest) {
  if (!dossierCronAuthorized(process.env.CRON_TOKEN, req.headers.get("x-cron-token"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Typical generation ≈150-250s; worst case (frontier reasoning + retries +
  // chair) ≈1000s. Service timeout is 1500s, so stop STARTING new tickers
  // after 400s. A 503 asks Cloud Scheduler to continue only that unfinished
  // durable drain; completed failures are reported without replaying models.
  const started = Date.now();
  const budgetMs = 400_000;
  const today = etDate();
  if (!isUsEquityTradingDay(today)) {
    return NextResponse.json({
      date: today,
      tickers: 0,
      generated: [],
      observed: [],
      completed: [],
      reused: [],
      skipped: "non-trading-day",
      errors: [],
    });
  }

  // A company runs while at least one active desk selects it. There is no
  // activity timeout: removing the final watcher pauses future work, and a
  // later add reactivates the same shared company history.
  const activeCandidates = await listActiveCompanyTickers();
  const requestedRaw = req.nextUrl.searchParams.get("ticker");
  const requestedTicker = requestedRaw?.trim().toUpperCase();
  const shardRaw = req.nextUrl.searchParams.get("shard");
  const shardCountRaw = req.nextUrl.searchParams.get("shards");
  const shard = shardRaw === null ? null : Number(shardRaw);
  const shardCount = shardCountRaw === null ? null : Number(shardCountRaw);
  const hasShardRequest = shard !== null || shardCount !== null;
  if (
    hasShardRequest &&
    (
      !Number.isInteger(shard) ||
      !Number.isInteger(shardCount) ||
      (shardCount ?? 0) < 1 ||
      (shardCount ?? 0) > 32 ||
      (shard ?? -1) < 0 ||
      (shard ?? 0) >= (shardCount ?? 0)
    )
  ) {
    return NextResponse.json({ error: "invalid dossier shard" }, { status: 400 });
  }
  if (requestedTicker && hasShardRequest) {
    return NextResponse.json(
      { error: "ticker and shard parameters cannot be combined" },
      { status: 400 },
    );
  }
  if (requestedTicker && !/^[A-Z][A-Z.\-]{0,9}$/.test(requestedTicker)) {
    return NextResponse.json({ error: "invalid ticker" }, { status: 400 });
  }
  if (requestedTicker && !activeCandidates.includes(requestedTicker)) {
    return NextResponse.json({ error: "ticker is not on an active desk" }, { status: 404 });
  }

  // Select this request's deterministic slice before provider-backed support
  // verification. Each scheduler shard must pay to verify only its own names,
  // not repeat the full active fleet's SEC and market-data reads.
  const candidateTickers = selectDossierCandidates({
    activeTickers: activeCandidates,
    requestedTicker,
    shard,
    shardCount,
  });
  const support = await partitionResearchSupportedTickers(candidateTickers);
  const tickers = support.supported;
  if (requestedTicker && !tickers.includes(requestedTicker)) {
    const excluded = support.excluded.find((item) => item.symbol === requestedTicker);
    if (excluded) {
      return NextResponse.json(
        { error: excluded.message, code: "STOCK_NOT_SUPPORTED", support: excluded },
        { status: excluded.code === "verification_unavailable" ? 503 : 422 },
      );
    }
    return NextResponse.json({ error: "stock support verification did not complete" }, { status: 503 });
  }
  // Authenticated operators can run one watched ticker without spending a
  // complete batch. Production Scheduler uses deterministic shards so every
  // supported active ticker gets the same full-quality run while the fleet
  // completes inside the pre-market window.
  const runTickers = [...tickers].sort((a, b) => a.localeCompare(b));

  const done: string[] = [];
  const generated: string[] = [];
  const observed: Array<{
    ticker: string;
    outcome: "no-directional-read";
    thesisStatus: string | null;
    votes: { support: number; oppose: number; uncertain: number; unavailable: number };
  }> = [];
  const completed: Array<Pick<
    DailyThesisCheck,
    "ticker" | "outcome" | "source" | "thesisStatus" | "scoreLabel"
  >> = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const sym of runTickers) {
    if (Date.now() - started > budgetMs) {
      skipped.push(...runTickers.filter((t) => !done.includes(t) && !skipped.includes(t)));
      break;
    }
    done.push(sym);
    const tickerStartedAt = Date.now();
    let leaseOwner: string | null = null;
    let sourceRefreshMs = 0;
    let evidenceMs = 0;
    let modelMs = 0;
    let councilInvoked = false;
    let operationalOutcome = "failed";
    let acceptedOutcome: "published" | "no-directional-read" | null = null;
    let rejectedObservation: (typeof observed)[number] | null = null;
    try {
      // A retry after a completed run must not repurchase the council. The
      // immutable daily receipt proves which accepted artifact was used.
      const priorCheck = await getDailyThesisCheck(sym, today);
      if (priorCheck) {
        operationalOutcome = "already-complete";
        completed.push({
          ticker: priorCheck.ticker,
          outcome: priorCheck.outcome,
          source: priorCheck.source,
          thesisStatus: priorCheck.thesisStatus,
          scoreLabel: priorCheck.scoreLabel,
        });
        continue;
      }

      // This wide per-stock/day lease prevents overlapping shard retries from
      // repurchasing source refreshes, evidence compilation, or model calls.
      leaseOwner = randomUUID();
      const acquired = await acquirePipelineLease(
        dailyResearchLeaseId(sym, today),
        leaseOwner,
        28 * 60_000,
      );
      if (!acquired) {
        operationalOutcome = "lease-busy";
        skipped.push(sym);
        continue;
      }

      // A prior worker can finish between the first receipt check and lease
      // acquisition. Recheck while holding ownership before doing any work.
      const completedWhileWaiting = await getDailyThesisCheck(sym, today);
      if (completedWhileWaiting) {
        operationalOutcome = "already-complete";
        completed.push({
          ticker: completedWhileWaiting.ticker,
          outcome: completedWhileWaiting.outcome,
          source: completedWhileWaiting.source,
          thesisStatus: completedWhileWaiting.thesisStatus,
          scoreLabel: completedWhileWaiting.scoreLabel,
        });
        continue;
      }
      // Write-through: keep the canonical company store fresh daily even
      // when today's dossier already exists.
      const sourceRefreshStartedAt = Date.now();
      const profile = await getProfile(sym);
      const newest = Math.max(...Object.values(profile?.lastRefreshed ?? { none: 0 }));
      if (Date.now() - newest > 6 * 3600_000) {
        try {
          await refreshCompanySources(sym);
        } catch (error) {
          throw new Error(`${sym}: source refresh failed; refusing stale research: ${String(error).slice(0, 300)}`);
        }
      }
      sourceRefreshMs = Date.now() - sourceRefreshStartedAt;
      const cached = await getCachedDossier(sym);
      const fullyCited = dossierReleaseValidationError(cached) === null;
      if (cached?.date === today && fullyCited) {
        // Idempotent catch-up: a completed dossier can outlive a transient
        // scorekeeping write failure without purchasing another council run.
        await recordTickerResearchOutcome(sym, today);
        const check = await recordDailyThesisCheck(sym, today);
        if (!check) throw new Error(`${sym}: accepted dossier has no daily completion receipt`);
        completed.push({
          ticker: check.ticker,
          outcome: check.outcome,
          source: check.source,
          thesisStatus: check.thesisStatus,
          scoreLabel: check.scoreLabel,
        });
        operationalOutcome = "recovered-existing-dossier";
        continue;
      }
      // Every scheduled research run is built from one complete, immutable
      // evidence packet. Never let the cron fall back to a thinner context.
      // A standing thesis is tested by the council every trading day: source
      // similarity is useful audit data, but it is not a substitute for the
      // daily strengthened/weakened/open decision promised to members.
      let preparedPack;
      const evidenceStartedAt = Date.now();
      try {
        preparedPack = await buildEvidencePack(sym, today);
      } catch (error) {
        throw new Error(`${sym}: evidence intake failed; refusing degraded research: ${String(error).slice(0, 300)}`);
      }
      if (!preparedPack) {
        throw new Error(`${sym}: evidence intake produced no complete packet; refusing degraded research`);
      }
      evidenceMs = Date.now() - evidenceStartedAt;

      councilInvoked = true;
      const modelStartedAt = Date.now();
      const d = await ensureDossier(sym, today, { evidencePack: preparedPack });
      modelMs = Date.now() - modelStartedAt;
      const generatedAndAdmissible = d?.date === today &&
        dossierReleaseValidationError(d) === null;
      if (generatedAndAdmissible) {
        acceptedOutcome = "published";
      }
      else {
        const failure = await getDossierTerminalFailure(sym, today).catch(() => null);
        const rejected = failure ? null : await getRejectedDossierFactualUpdate(sym, today).catch(() => null);
        if (rejected) {
          acceptedOutcome = "no-directional-read";
          rejectedObservation = {
            ticker: sym,
            outcome: "no-directional-read",
            thesisStatus: rejected.thesisObservation?.status ?? null,
            votes: {
              support: rejected.votesSupport,
              oppose: rejected.votesOppose,
              uncertain: rejected.votesUncertain,
              unavailable: rejected.votesUnavailable ?? Math.max(
                0,
                5 - rejected.votesSupport - rejected.votesOppose - rejected.votesUncertain,
              ),
            },
          };
        } else {
          throw new Error(failure
            ? `${failure.stage}: ${failure.error}`.slice(0, 1_000)
            : "generation ended without a dossier, rejection receipt, or terminal failure");
        }
      }
      // Successful and honestly rejected daily outcomes both advance the
      // same durable thesis movement record. The hourly resolver repeats this
      // idempotently, so a datastore blip cannot leave the card stranded.
      await recordTickerResearchOutcome(sym, today);
      const check = await recordDailyThesisCheck(sym, today);
      if (!check) {
        throw new Error(`${sym}: research ended without a daily completion receipt`);
      }
      if (acceptedOutcome === "published") generated.push(sym);
      if (rejectedObservation) observed.push(rejectedObservation);
      operationalOutcome = acceptedOutcome ?? "failed";
      completed.push({
        ticker: check.ticker,
        outcome: check.outcome,
        source: check.source,
        thesisStatus: check.thesisStatus,
        scoreLabel: check.scoreLabel,
      });
    } catch (e) {
      errors.push(`${sym}: ${String(e).slice(0, 100)}`);
    } finally {
      if (leaseOwner) {
        await releasePipelineLease(dailyResearchLeaseId(sym, today), leaseOwner)
          .catch((error) => console.error(`[dossier-cron] ${sym}: lease release failed`, error));
      }
      console.log(JSON.stringify({
        event: "daily_stock_research_completed",
        ticker: sym,
        date: today,
        outcome: operationalOutcome,
        councilInvoked,
        sourceRefreshMs,
        evidenceMs,
        modelMs,
        totalMs: Date.now() - tickerStartedAt,
      }));
    }
  }

  const response = {
    date: today,
    fleetTickers: activeCandidates.length,
    candidateTickers: candidateTickers.length,
    supportedCandidates: tickers.length,
    shard,
    shards: shardCount,
    unsupported: support.excluded.map((item) => ({
      ticker: item.symbol,
      code: item.code,
      message: item.message,
    })),
    tickers: runTickers.length,
    generated,
    observed,
    completed,
    // Retained as an empty compatibility field for existing operator tooling.
    // Daily runs no longer bypass the council on an evidence-similarity test.
    reused: [],
    skipped,
    errors,
    elapsedMs: Date.now() - started,
  };
  return NextResponse.json(response, {
    status: dossierCronStatus([
      ...skipped,
      ...errors,
    ]),
  });
}
