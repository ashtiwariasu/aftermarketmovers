import assert from "node:assert/strict";
import test from "node:test";

import {
  projectSignalTrack,
  signalTrackScore,
  toPublicSignalTrackView,
  type SignalTrackBar,
} from "../src/lib/signalTrack";

function bars(
  values: ReadonlyArray<[date: string, adjustedClose: number]>,
): SignalTrackBar[] {
  return values.map(([date, adjustedClose]) => ({ date, adjustedClose }));
}

test("freezes the start and volatility packet at the publication instant", () => {
  const prior = bars([
    ["2026-01-05", 98],
    ["2026-01-06", 99],
    ["2026-01-07", 100],
  ]);
  const base = {
    direction: "UP" as const,
    strength: "GENTLE" as const,
    horizon: { min: 2, max: 3 },
    issueDate: "2026-01-08",
    generatedAt: Date.UTC(2026, 0, 8, 12),
  };

  const withoutFutureOutlier = projectSignalTrack({
    ...base,
    bars: [...prior, ...bars([["2026-01-08", 101]])],
  });
  const withFutureOutlier = projectSignalTrack({
    ...base,
    bars: [
      ...prior,
      ...bars([
        ["2026-01-08", 101],
        ["2026-01-09", 500],
      ]),
    ],
  });

  assert.deepEqual(withFutureOutlier.start, {
    date: "2026-01-07",
    adjustedClose: 100,
  });
  assert.equal(withFutureOutlier.volatilityObservationCount, 2);
  assert.equal(
    withFutureOutlier.volatility,
    withoutFutureOutlier.volatility,
  );
  assert.deepEqual(
    withFutureOutlier.points[0],
    withoutFutureOutlier.points[0],
  );
});

test("aligns the baseline before and after the New York close", () => {
  const marketBars = bars([
    ["2026-07-22", 100],
    ["2026-07-23", 101],
    ["2026-07-24", 102],
    ["2026-07-27", 103],
  ]);
  const common = {
    direction: "UP" as const,
    strength: "GENTLE" as const,
    horizon: { min: 2, max: 3 },
    issueDate: "2026-07-24",
    bars: marketBars,
  };

  const premarket = projectSignalTrack({
    ...common,
    generatedAt: Date.UTC(2026, 6, 24, 13),
  });
  const afterClose = projectSignalTrack({
    ...common,
    generatedAt: Date.UTC(2026, 6, 24, 21),
  });

  assert.equal(premarket.start?.date, "2026-07-23");
  assert.deepEqual(
    premarket.points.map(({ date, session }) => ({ date, session })),
    [
      { date: "2026-07-24", session: 1 },
      { date: "2026-07-27", session: 2 },
    ],
  );
  assert.equal(afterClose.start?.date, "2026-07-24");
  assert.deepEqual(
    afterClose.points.map(({ date, session }) => ({ date, session })),
    [{ date: "2026-07-27", session: 1 }],
  );
});

test("honors an explicit close timestamp when a session does not close at 4 PM", () => {
  const projection = projectSignalTrack({
    direction: "DOWN",
    strength: "GENTLE",
    horizon: { min: 1, max: 2 },
    issueDate: "2026-11-27",
    generatedAt: Date.UTC(2026, 10, 27, 19),
    bars: [
      { date: "2026-11-25", adjustedClose: 100 },
      {
        date: "2026-11-27",
        adjustedClose: 99,
        sessionClosedAt: Date.UTC(2026, 10, 27, 18),
      },
      { date: "2026-11-30", adjustedClose: 98 },
    ],
  });

  assert.equal(projection.start?.date, "2026-11-27");
  assert.equal(projection.points[0].date, "2026-11-30");
});

test("counts exchange bars as sessions without consuming weekends", () => {
  const projection = projectSignalTrack({
    direction: "UP",
    strength: "MODERATE",
    horizon: { min: 2, max: 3 },
    issueDate: "2026-01-09",
    generatedAt: Date.UTC(2026, 0, 9, 12),
    bars: bars([
      ["2026-01-07", 99],
      ["2026-01-08", 100],
      ["2026-01-09", 100.5],
      ["2026-01-12", 101],
      ["2026-01-13", 102],
      ["2026-01-14", 300],
    ]),
  });

  assert.equal(projection.status, "final");
  assert.equal(projection.sessionCount, 3);
  assert.deepEqual(
    projection.points.map(({ date, session }) => ({ date, session })),
    [
      { date: "2026-01-09", session: 1 },
      { date: "2026-01-12", session: 2 },
      { date: "2026-01-13", session: 3 },
    ],
  );
  assert.equal(projection.last?.date, "2026-01-13");
});

test("exposes an awaiting-first-close public state before any later close", () => {
  const projection = projectSignalTrack({
    direction: "UP",
    strength: "GENTLE",
    horizon: { min: 2, max: 3 },
    issueDate: "2026-07-24",
    generatedAt: Date.UTC(2026, 6, 24, 13),
    bars: bars([
      ["2026-07-22", 99],
      ["2026-07-23", 100],
    ]),
  });
  const publicView = toPublicSignalTrackView(projection);

  assert.equal(projection.status, "provisional");
  assert.equal(projection.sessionCount, 0);
  assert.equal(publicView.state, "AWAITING_FIRST_CLOSE");
  assert.equal(publicView.observedMovePct, null);
  assert.equal(publicView.asOfDate, null);
  assert.deepEqual(publicView.points, []);
});

test("public projection sanitizer exposes only descriptive market receipts", () => {
  const projection = projectSignalTrack({
    direction: "UP",
    strength: "MODERATE",
    horizon: { min: 1, max: 2 },
    issueDate: "2026-07-24",
    generatedAt: Date.UTC(2026, 6, 24, 13),
    bars: bars([
      ["2026-07-22", 99],
      ["2026-07-23", 100],
      ["2026-07-24", 101],
    ]),
  });
  const publicView = toPublicSignalTrackView(projection);
  const forbiddenKeys = new Set([
    "generatedAt",
    "volatility",
    "volatilityObservationCount",
    "price",
    "prices",
    "adjustedClose",
    "cumulativeReturn",
    "logReturn",
    "zScore",
    "score",
    "forecastScore",
    "actualScore",
    "alignment",
    "move",
    "verdict",
  ]);

  function collectKeys(value: unknown, collected = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, collected);
      return collected;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        collected.add(key);
        collectKeys(child, collected);
      }
    }
    return collected;
  }

  const publicKeys = collectKeys(publicView);
  assert.deepEqual(
    [...publicKeys].filter((key) => forbiddenKeys.has(key)),
    [],
  );
  assert.deepEqual(Object.keys(publicView.points[0]).sort(), [
    "cumulativeReturnPct",
    "date",
    "session",
    "xPercent",
    "yPercent",
  ]);
  assert.deepEqual(Object.keys(publicView).sort(), [
    "asOfDate",
    "direction",
    "forecastYPercent",
    "horizon",
    "issueDate",
    "observedMovePct",
    "points",
    "sessionCount",
    "state",
    "strength",
  ]);
});

test("reports upside and downside bands and alignment symmetrically", () => {
  const common = {
    strength: "STRONG" as const,
    horizon: { min: 1, max: 2 },
    issueDate: "2026-02-03",
    generatedAt: Date.UTC(2026, 1, 3, 12),
  };
  const history = bars([
    ["2026-01-30", 100],
    ["2026-02-02", 100],
  ]);
  const upside = projectSignalTrack({
    ...common,
    direction: "UP",
    bars: [...history, ...bars([["2026-02-03", 101]])],
  });
  const downside = projectSignalTrack({
    ...common,
    direction: "DOWN",
    bars: [...history, ...bars([["2026-02-03", 99]])],
  });
  const contrary = projectSignalTrack({
    ...common,
    direction: "DOWN",
    bars: [...history, ...bars([["2026-02-03", 101]])],
  });

  assert.equal(upside.status, "provisional");
  assert.equal(upside.actualBand, "STRONG_UPSIDE");
  assert.equal(upside.alignment, "SUPPORTS");
  assert.equal(downside.actualBand, "STRONG_DOWNSIDE");
  assert.equal(downside.alignment, "SUPPORTS");
  assert.equal(contrary.actualBand, "STRONG_UPSIDE");
  assert.equal(contrary.alignment, "OPPOSES");
});

test("uses the average score across the full resolution window when final", () => {
  const projection = projectSignalTrack({
    direction: "UP",
    strength: "GENTLE",
    horizon: { min: 2, max: 3 },
    issueDate: "2026-03-03",
    generatedAt: Date.UTC(2026, 2, 3, 12),
    bars: bars([
      ["2026-02-27", 100],
      ["2026-03-02", 100],
      ["2026-03-03", 105],
      ["2026-03-04", 99],
      ["2026-03-05", 101],
    ]),
  });

  const expected =
    (projection.points[1].score + projection.points[2].score) / 2;
  assert.equal(projection.status, "final");
  assert.equal(projection.actualScore, expected);
  assert.notEqual(projection.actualScore, projection.points[0].score);
});

test("returns an explicit incomplete projection when no valid start exists", () => {
  const projection = projectSignalTrack({
    direction: "DOWN",
    strength: "GENTLE",
    horizon: { min: 2, max: 3 },
    issueDate: "2026-04-06",
    generatedAt: Date.UTC(2026, 3, 6, 12),
    bars: [
      { date: "2026-04-03", adjustedClose: null },
      { date: "2026-04-06", adjustedClose: 100 },
      { date: "not-a-date", adjustedClose: 99 },
    ],
  });

  assert.equal(projection.status, "incomplete");
  assert.equal(projection.incompleteReason, "missing_start_bar");
  assert.equal(projection.start, null);
  assert.equal(projection.actualBand, null);
  assert.deepEqual(projection.points, []);
});

test("uses the volatility floor and preserves continuous band boundaries", () => {
  const projection = projectSignalTrack({
    direction: "UP",
    strength: "GENTLE",
    horizon: { min: 1, max: 2 },
    issueDate: "2026-05-05",
    generatedAt: Date.UTC(2026, 4, 5, 12),
    bars: bars([
      ["2026-05-01", 100],
      ["2026-05-04", 100],
      ["2026-05-05", 100],
    ]),
  });

  assert.equal(projection.volatility, 0.005);
  assert.equal(signalTrackScore(0.25), 0.5);
  assert.equal(signalTrackScore(1), 1.5);
  assert.equal(signalTrackScore(2), 2);
  assert.equal(signalTrackScore(-2), -2);
});
