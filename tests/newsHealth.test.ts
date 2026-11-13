import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateNewsPipelineHealth,
  scopeNewsPipelineHealth,
} from "../src/app/api/cron/news/health/route";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 28, 3, 30);
type HealthInput = Parameters<typeof scopeNewsPipelineHealth>[0];
type NewsRun = HealthInput["runs"][number];

function completedRun(finishedAt = NOW - HOUR): NewsRun {
  return {
    id: "run-1",
    pipelineVersion: "test",
    mode: "scheduled",
    startedAt: finishedAt - 10_000,
    finishedAt,
    status: "completed",
    providerResults: [],
    requestedTickers: ["MSFT"],
    candidates: 1,
    observations: 1,
    accepted: 1,
    rejected: 0,
    deduplicated: 0,
    persisted: 1,
    eventsUpdated: 1,
    recoveredDeadLetters: 0,
    failedDeadLetterReplays: 0,
    errors: [],
    warnings: [],
  };
}

function health(overrides: Partial<{
  runs: NewsRun[];
  checkpoints: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  pendingDeadLetters: Record<string, unknown>[];
}> = {}) {
  return {
    checkedAt: NOW,
    runs: overrides.runs ?? [completedRun()],
    checkpoints: overrides.checkpoints ?? [],
    sources: overrides.sources ?? [],
    pendingDeadLetters: overrides.pendingDeadLetters ?? [],
  };
}

test("news health ignores stale records and dead letters for paused companies", () => {
  const scoped = scopeNewsPipelineHealth(
    health({
      checkpoints: [
        { id: "MSFT", ticker: "MSFT", successfulAt: NOW - HOUR },
        { id: "SKHY", ticker: "skhy", successfulAt: NOW - 48 * HOUR },
      ],
      sources: [
        { ticker: "MSFT", provider: "sec", tier: "authoritative", lastSuccessAt: NOW - HOUR },
        { ticker: "NBIS", provider: "tiingo", tier: "licensed", lastSuccessAt: 0 },
      ],
      pendingDeadLetters: [
        { id: "active", ticker: "MSFT", status: "pending", createdAt: NOW - 10_000 },
        { id: "paused", ticker: "SKHY", status: "abandoned", createdAt: NOW - 48 * HOUR },
      ],
    }),
    ["MSFT"],
  );

  assert.deepEqual(scoped.checkpoints.map((record) => record.ticker), ["MSFT"]);
  assert.deepEqual(scoped.sources.map((record) => record.ticker), ["MSFT"]);
  assert.deepEqual(scoped.pendingDeadLetters.map((record) => record.id), ["active"]);
  assert.deepEqual(evaluateNewsPipelineHealth(scoped, ["MSFT"], true), {
    alerts: [],
    warnings: [],
  });
});

test("news health still alerts on stale active-company evidence", () => {
  const scoped = scopeNewsPipelineHealth(
    health({
      checkpoints: [{ id: "MSFT", ticker: "MSFT", successfulAt: NOW - 48 * HOUR }],
      sources: [
        { ticker: "MSFT", provider: "sec", tier: "authoritative", lastSuccessAt: 0 },
        { ticker: "MSFT", provider: "yahoo", tier: "discovery", lastSuccessAt: 0 },
      ],
      pendingDeadLetters: [
        { id: "active-failure", ticker: "MSFT", status: "abandoned", createdAt: NOW - 48 * HOUR },
      ],
    }),
    ["MSFT"],
  );

  const result = evaluateNewsPipelineHealth(scoped, ["MSFT"], true);
  assert.deepEqual(result.alerts, [
    "stale successful ticker checkpoint: MSFT",
    "stale source: sec/MSFT",
    "unrecovered dead letter: active-failure",
  ]);
  assert.deepEqual(result.warnings, ["stale source: yahoo/MSFT"]);
});

test("an empty active fleet is a healthy paused state", () => {
  const result = evaluateNewsPipelineHealth(
    scopeNewsPipelineHealth(
      health({
        runs: [],
        checkpoints: [{ ticker: "SKHY", successfulAt: 0 }],
        sources: [{ ticker: "SKHY", provider: "sec", lastSuccessAt: 0 }],
      }),
      [],
    ),
    [],
    true,
  );

  assert.deepEqual(result, { alerts: [], warnings: [] });
});

test("provider configuration remains monitored when the fleet is empty", () => {
  assert.deepEqual(evaluateNewsPipelineHealth(health({ runs: [] }), [], false), {
    alerts: ["no licensed scheduled news provider is configured"],
    warnings: [],
  });
});
