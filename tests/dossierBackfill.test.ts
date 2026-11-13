import assert from "node:assert/strict";
import test from "node:test";
import { dossierBackfillFailed, planWatchedTickerBackfill } from "../src/lib/dossierBackfill";

test("v5 migration planning includes every watched ticker and deduplicates desks", () => {
  const plan = planWatchedTickerBackfill([
    { tickers: ["googl", "NVDA", "BRK.B"], tier: "pro", stripeSubscriptionId: "sub_1" },
    { tickers: ["NVDA", " msft ", "bad ticker"], tier: "pro", stripeSubscriptionId: "sub_2" },
    { tickers: [], tier: "pro", stripeSubscriptionId: "sub_3" },
  ]);
  assert.deepEqual(plan.tickers, ["BRK.B", "GOOGL", "MSFT", "NVDA"]);
  assert.deepEqual(plan.invalidTickers, ["bad ticker"]);
  assert.equal(plan.deskCount, 3);
});

test("migration planning never truncates a watched universe above 500 tickers", () => {
  const tickers = Array.from({ length: 750 }, (_, index) => {
    let value = index;
    let suffix = "";
    do {
      suffix = String.fromCharCode(65 + (value % 26)) + suffix;
      value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return `T${suffix}`;
  });
  const plan = planWatchedTickerBackfill([{ tickers, tier: "pro", stripeSubscriptionId: "sub_large" }]);
  assert.equal(plan.tickers.length, 750);
});

test("migration planning excludes inactive and coverage-paused desk selections", () => {
  const plan = planWatchedTickerBackfill([
    {
      tickers: ["AAPL", "TSLA"],
      tier: "pro",
      stripeSubscriptionId: "sub_aapl",
      supportPaused: {
        TSLA: {
          code: "coverage_paused",
          message: "Coverage is paused.",
          policyVersion: "us-v1",
          pausedAt: 1,
        },
      },
    },
    { tickers: ["MSFT"], tier: "pro", stripeSubscriptionId: "sub_msft", researchActive: false },
    { tickers: ["NVDA"], tier: "pro", stripeSubscriptionId: "sub_nvda" },
    { tickers: ["AMD"], tier: "free", stripeSubscriptionId: "" },
  ]);
  assert.deepEqual(plan.tickers, ["AAPL", "NVDA"]);
  assert.equal(plan.deskCount, 4);
});

test("verify and execute fail closed until every selected dossier is ready", () => {
  assert.equal(dossierBackfillFailed({
    mode: "verify",
    needsBackfill: ["GOOGL"],
    generated: [],
    failed: [],
  }), true);
  assert.equal(dossierBackfillFailed({
    mode: "execute",
    needsBackfill: ["GOOGL", "NVDA"],
    generated: ["GOOGL"],
    failed: [],
  }), true);
  assert.equal(dossierBackfillFailed({
    mode: "execute",
    needsBackfill: ["GOOGL", "NVDA"],
    generated: ["NVDA", "GOOGL"],
    failed: [],
  }), false);
  assert.equal(dossierBackfillFailed({
    mode: "verify",
    needsBackfill: [],
    generated: [],
    failed: [],
    invalidTickers: ["bad ticker"],
  }), true, "invalid watched symbols make exhaustive verification impossible");
  assert.equal(dossierBackfillFailed({
    mode: "execute",
    needsBackfill: [],
    generated: [],
    failed: [],
    invalidTickers: ["bad ticker"],
  }), true, "execute cannot claim complete coverage while a watched symbol is invalid");
  assert.equal(dossierBackfillFailed({
    mode: "verify",
    needsBackfill: [],
    generated: [],
    failed: [],
    outboxNeedsBackfill: ["GOOGL:2026-07-17:abc"],
  }), true, "verification fails until every published v5 hook has an outbox record");
  assert.equal(dossierBackfillFailed({
    mode: "execute",
    needsBackfill: [],
    generated: [],
    failed: [],
    outboxNeedsBackfill: ["GOOGL:2026-07-17:abc", "NVDA:2026-07-17:def"],
    outboxCreated: ["GOOGL:2026-07-17:abc"],
  }), true, "execute cannot leave a discovered outbox candidate unwritten");
  assert.equal(dossierBackfillFailed({
    mode: "execute",
    needsBackfill: [],
    generated: [],
    failed: [],
    outboxNeedsBackfill: ["GOOGL:2026-07-17:abc"],
    outboxCreated: ["GOOGL:2026-07-17:abc"],
  }), false);
  assert.equal(dossierBackfillFailed({
    mode: "verify",
    needsBackfill: [],
    generated: [],
    failed: [],
    invalidPublishedV5: ["GOOGL:2026-07-17: invalid hook"],
  }), true, "a malformed already-published v5 artifact fails closed");
});
