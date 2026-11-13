import { NextRequest, NextResponse } from "next/server";
import { drainPrivateSignalWork } from "@/lib/privateSignalRuntime";
import { requestCronTokenAuthorized } from "@/lib/cronAuth";
import { listActiveCompanyTickers } from "@/lib/companyFleet";

export const maxDuration = 300;

const WORK_BUDGET_MS = 240_000;

/**
 * Every 12 hours: first materialize every durable v5 hook, then advance every
 * unresolved private observation. Both queues use immutable cursors and are
 * swept to null unless the explicit runtime budget is reached.
 */
export async function POST(request: NextRequest) {
  if (!requestCronTokenAuthorized(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const startedAt = Date.now();
  try {
    const activeTickers = new Set(await listActiveCompanyTickers());
    const result = await drainPrivateSignalWork({
      deadlineAt: startedAt + WORK_BUDGET_MS,
      // Small pages bound the interval between deadline checks; the runtime
      // still follows every cursor to null while budget remains.
      outboxPageSize: 5,
      settlementPageSize: 20,
      activeTickers,
    });
    const errorCount = result.outbox.errors.length + result.settlement.errors.length;
    const body = {
      ok: result.completeSweep && errorCount === 0,
      completeSweep: result.completeSweep,
      stoppedPhase: result.stoppedPhase,
      elapsedMs: Date.now() - startedAt,
      outbox: {
        pages: result.outbox.pages,
        scanned: result.outbox.scanned,
        paused: result.outbox.paused,
        completed: result.outbox.completed,
        busy: result.outbox.busy,
        notDue: result.outbox.notDue,
        blockedPredecessor: result.outbox.blockedPredecessor,
        alreadyComplete: result.outbox.alreadyComplete,
        missing: result.outbox.missing,
        errors: result.outbox.errors,
        hasMore: result.outbox.hasMore,
      },
      settlement: {
        pages: result.settlement.pages,
        attempted: result.settlement.attempted,
        completed: result.settlement.completed,
        stillOpen: result.settlement.stillOpen,
        errors: result.settlement.errors,
        hasMore: result.settlement.hasMore,
      },
    };
    // Partial sweeps and item errors are safe but incomplete: surface 503 so
    // Cloud Scheduler applies its bounded retries. Per-record backoff prevents
    // the retry from turning one failing observation into a hot loop.
    return NextResponse.json(body, {
      status: !result.completeSweep || errorCount > 0 ? 503 : 200,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: String(error).slice(0, 500),
      elapsedMs: Date.now() - startedAt,
    }, { status: 500 });
  }
}
