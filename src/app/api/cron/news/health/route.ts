import { NextRequest, NextResponse } from "next/server";
import { listActiveCompanyTickers } from "@/lib/companyFleet";
import { getNewsPipelineHealth } from "@/lib/newsStore";

export const dynamic = "force-dynamic";

const SCHEDULE_INTERVAL_MS = 12 * 3_600_000;
const SCHEDULE_GRACE_MS = 2 * 3_600_000;
const SCHEDULE_STALE_MS = SCHEDULE_INTERVAL_MS + SCHEDULE_GRACE_MS;

function authorised(req: NextRequest): boolean {
  const expected = process.env.CRON_TOKEN ?? "";
  return Boolean(expected) && req.headers.get("x-cron-token") === expected;
}

function numberField(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

type NewsPipelineHealth = Awaited<ReturnType<typeof getNewsPipelineHealth>>;

function tickerField(record: Record<string, unknown>): string | null {
  const raw = typeof record.ticker === "string"
    ? record.ticker
    : typeof (record.decision as Record<string, unknown> | undefined)?.ticker === "string"
      ? String((record.decision as Record<string, unknown>).ticker)
      : "";
  const ticker = raw.trim().toUpperCase();
  return ticker || null;
}

function belongsToActiveFleet(
  record: Record<string, unknown>,
  activeTickers: ReadonlySet<string>,
): boolean {
  const ticker = tickerField(record);
  return ticker == null || activeTickers.has(ticker);
}

export function scopeNewsPipelineHealth(
  health: NewsPipelineHealth,
  activeTickers: readonly string[],
): NewsPipelineHealth {
  const active = new Set(activeTickers.map((ticker) => ticker.trim().toUpperCase()));
  return {
    ...health,
    checkpoints: health.checkpoints.filter((record) => belongsToActiveFleet(record, active)),
    sources: health.sources.filter((record) => belongsToActiveFleet(record, active)),
    pendingDeadLetters: health.pendingDeadLetters.filter((record) => belongsToActiveFleet(record, active)),
  };
}

export function evaluateNewsPipelineHealth(
  health: NewsPipelineHealth,
  activeTickers: readonly string[],
  licensedProviderConfigured: boolean,
): { alerts: string[]; warnings: string[] } {
  const now = health.checkedAt;
  const alerts: string[] = [];
  const warnings: string[] = [];
  const activeCompanyCount = activeTickers.length;

  if (!licensedProviderConfigured) {
    alerts.push("no licensed scheduled news provider is configured");
  }
  if (activeCompanyCount > 0) {
    const latestAdmissibleRun = health.runs.find(
      (run) => run.status === "completed" || run.status === "partial",
    );
    if (!latestAdmissibleRun?.finishedAt || now - latestAdmissibleRun.finishedAt > SCHEDULE_STALE_MS) {
      alerts.push("no completed or partial news run in the last 14 hours");
    }
    for (const latest of health.runs[0]?.providerResults ?? []) {
      if (!latest.active || (latest.tier !== "licensed" && latest.provider !== "sec")) continue;
      let consecutiveEmptyRuns = 0;
      for (const run of health.runs) {
        const result = run.providerResults.find((item) => item.provider === latest.provider);
        if (!result?.active || result.failures > 0 || result.fetched > 0) break;
        consecutiveEmptyRuns++;
      }
      if (consecutiveEmptyRuns >= 3) {
        alerts.push(`${latest.provider} returned zero observations in ${consecutiveEmptyRuns} consecutive runs`);
      }
    }
  }
  for (const checkpoint of health.checkpoints) {
    const successfulAt = numberField(checkpoint.successfulAt);
    if (!successfulAt || now - successfulAt > SCHEDULE_STALE_MS) {
      alerts.push(`stale successful ticker checkpoint: ${String(checkpoint.ticker ?? checkpoint.id ?? "unknown")}`);
    }
  }
  for (const source of health.sources) {
    const lastSuccessAt = numberField(source.lastSuccessAt);
    if (!lastSuccessAt || now - lastSuccessAt > SCHEDULE_STALE_MS) {
      const message =
        `stale source: ${String(source.provider ?? "unknown")}/${String(source.ticker ?? "unknown")}`;
      if (source.tier === "discovery") warnings.push(message);
      else alerts.push(message);
    }
  }
  for (const letter of health.pendingDeadLetters) {
    const createdAt = numberField(letter.createdAt);
    if (letter.status === "abandoned" || (createdAt && now - createdAt > 60 * 60_000)) {
      alerts.push(`unrecovered dead letter: ${String(letter.id ?? "unknown")}`);
    }
  }

  return { alerts, warnings };
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [rawHealth, activeTickers] = await Promise.all([
    getNewsPipelineHealth(),
    listActiveCompanyTickers(),
  ]);
  const health = scopeNewsPipelineHealth(rawHealth, activeTickers);
  const licensedProviderConfigured = Boolean(
    process.env.BENZINGA_API_KEY ||
      process.env.TIINGO_API_TOKEN ||
      process.env.MASSIVE_API_KEY ||
      process.env.POLYGON_API_KEY ||
      (process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY),
  );
  const { alerts, warnings } = evaluateNewsPipelineHealth(
    health,
    activeTickers,
    licensedProviderConfigured,
  );

  return NextResponse.json(
    {
      ok: alerts.length === 0,
      alerts,
      warnings,
      configuration: { licensedProviderConfigured },
      fleet: {
        activeCompanyCount: activeTickers.length,
        activeTickers,
      },
      ...health,
    },
    { status: alerts.length === 0 ? 200 : 503 },
  );
}
