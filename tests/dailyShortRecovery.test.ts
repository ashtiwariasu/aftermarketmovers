import assert from "node:assert/strict";
import test from "node:test";
import { dailyShortRecoveryDecision } from "../src/lib/dailyShortRecovery";

const now = Date.parse("2026-07-29T11:00:00Z");

test("recovery skips a complete daily pair", () => {
  assert.deepEqual(dailyShortRecoveryDecision({
    runStatus: "scheduled",
    resultCount: 2,
    requiredCount: 2,
    now,
  }), { action: "skip", reason: "run-complete" });
});

test("recovery reconciles two scheduled publication receipts", () => {
  assert.deepEqual(dailyShortRecoveryDecision({
    runStatus: "failed",
    resultCount: 1,
    requiredCount: 2,
    now,
    publications: [
      { status: "scheduled" },
      { status: "published" },
    ],
  }), { action: "skip", reason: "publication-pair-complete" });
});

test("recovery does not race primary readiness or active rendering", () => {
  assert.equal(dailyShortRecoveryDecision({
    runStatus: "readiness",
    readinessDeadlineAt: now + 60_000,
    requiredCount: 2,
    now,
  }).reason, "primary-readiness-active");
  assert.equal(dailyShortRecoveryDecision({
    runStatus: "selected",
    selectedCount: 2,
    requiredCount: 2,
    now,
    publications: [
      { status: "processing", leaseExpiresAt: now + 60_000 },
    ],
  }).reason, "publication-work-active");
});

test("recovery reruns a failed or expired incomplete attempt", () => {
  assert.deepEqual(dailyShortRecoveryDecision({
    runStatus: "failed",
    readinessDeadlineAt: now + 60_000,
    selectedCount: 0,
    requiredCount: 2,
    now,
  }), { action: "run", reason: "recovery-required" });
  assert.deepEqual(dailyShortRecoveryDecision({
    runStatus: "readiness",
    readinessDeadlineAt: now - 1,
    selectedCount: 0,
    requiredCount: 2,
    now,
  }), { action: "run", reason: "recovery-required" });
});
