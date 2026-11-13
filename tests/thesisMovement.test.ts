import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThesisMovementView,
  mergeThesisMovementObservations,
  nextObservationFromReview,
  shiftedThesisScore,
  signalFromThesisScore,
  signalScore,
  thesisMovementWindow,
  thesisScoreLabel,
  type ThesisMovementObservation,
} from "../src/lib/thesisMovement";

const gentleUp = {
  eventType: "earnings" as const,
  direction: "UP" as const,
  strength: "GENTLE" as const,
  horizonSessions: { min: 10 as const, max: 15 as const },
};

function observation(
  date: string,
  score: number,
  observedAt = Date.parse(`${date}T21:00:00Z`),
): ThesisMovementObservation {
  return {
    schemaVersion: 1,
    date,
    observedAt,
    index: 1,
    status: "open",
    score,
    support: 4,
    oppose: 0,
    uncertain: 1,
    unavailable: 0,
  };
}

test("the thesis movement scale remains the five public AMM states", () => {
  assert.equal(signalScore(gentleUp), 1);
  assert.equal(signalScore({ ...gentleUp, direction: "DOWN", strength: "MODERATE" }), -1);
  assert.equal(shiftedThesisScore(1, "strengthened"), 2);
  assert.equal(shiftedThesisScore(1, "weakened"), 0);
  assert.equal(shiftedThesisScore(0.5, "weakened"), 0);
  assert.equal(shiftedThesisScore(-1.5, "invalidated"), 0);
  assert.equal(thesisScoreLabel(1.5), "GENTLE UPSIDE");
  assert.equal(thesisScoreLabel(0), "NEUTRAL");
  assert.deepEqual(signalFromThesisScore(-2), { direction: "DOWN", strength: "STRONG" });
});

test("admitted signals use the council state while rejected reviews move the standing thesis", () => {
  const first = nextObservationFromReview({
    date: "2026-07-23",
    observedAt: Date.parse("2026-07-23T21:00:00Z"),
    status: "opened",
    signal: gentleUp,
    votes: { support: 4, oppose: 0, uncertain: 1 },
    prior: null,
    index: 1,
    admittedSignal: true,
  });
  const admitted = nextObservationFromReview({
    date: "2026-07-24",
    observedAt: Date.parse("2026-07-24T21:00:00Z"),
    status: "strengthened",
    signal: { ...gentleUp, strength: "MODERATE" },
    votes: { support: 4, oppose: 0, uncertain: 1 },
    prior: first,
    index: 2,
    admittedSignal: true,
  });
  const rejected = nextObservationFromReview({
    date: "2026-07-25",
    observedAt: Date.parse("2026-07-25T21:00:00Z"),
    status: "weakened",
    signal: { ...gentleUp, strength: "MODERATE" },
    votes: { support: 1, oppose: 0, uncertain: 3, unavailable: 1 },
    prior: admitted,
    index: 3,
  });
  assert.equal(first.score, 1);
  assert.equal(admitted.score, 1);
  assert.equal(rejected.score, 0);
  assert.equal(rejected.unavailable, 1);
});

test("movement merges retries by date and preserves the newest audited observation", () => {
  const older = observation("2026-07-24", 1, 100);
  const repaired = { ...older, score: 1.5, observedAt: 200, support: 5 };
  const merged = mergeThesisMovementObservations(
    [observation("2026-07-23", 1)],
    [older, repaired],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[1].date, "2026-07-24");
  assert.equal(merged[1].score, 1);
  assert.equal(merged[1].support, 5);
  assert.deepEqual(merged.map((item) => item.index), [1, 2]);
});

test("the reporting-cycle window uses the last filed results and next dated earnings", () => {
  const window = thesisMovementWindow({
    openedDate: "2026-07-23",
    filings: [
      { form: "8-K", date: "2026-07-20" },
      { form: "10-Q", date: "2026-04-26" },
      { form: "10-K", date: "2026-01-28" },
    ],
    nextEvent: "Q2 FY27 earnings — Aug 26 after close",
  });
  assert.deepEqual(window, {
    startDate: "2026-04-26",
    startLabel: "Q1 FY27 RESULTS · APR 26",
    endDate: "2026-08-26",
    endLabel: "Q2 FY27 EARNINGS · AUG 26",
  });

  const view = buildThesisMovementView({
    observations: [observation("2026-07-23", 1), observation("2026-07-24", 1.5)],
    fallbackSignal: gentleUp,
    fallbackVotes: { support: 4, oppose: 0, uncertain: 1 },
    window,
  });
  assert.equal(view.currentLabel, "GENTLE UPSIDE");
  assert.equal(view.currentScore, 1);
  assert.equal(view.currentSupport, 4);
  assert.equal(view.currentTotal, 5);
});

test("the reporting-cycle window never rolls an expired calendar-year event forward", () => {
  const window = thesisMovementWindow({
    openedDate: "2026-07-25",
    filings: [
      { form: "10-Q", date: "2026-07-23" },
      { form: "8-K", date: "2026-07-22" },
    ],
    nextEvent: "Q2 2026 earnings — Jul 22 after close",
  });

  assert.deepEqual(window, {
    startDate: "2026-07-23",
    startLabel: "Q1 2026 RESULTS · JUL 23",
    endDate: "2026-10-29",
    endLabel: "NEXT RESULTS · DATE PENDING",
  });
  assert.ok(window.endDate > window.startDate);
});
