import assert from "node:assert/strict";
import test from "node:test";
import {
  publishAfterCompleteBatches,
  researchCoverageIsComplete,
  researchSeriesCanReplace,
  setBoundedMapEntry,
  type CompanyProfile,
} from "../src/lib/companyStore";
import type { DailyBar } from "../src/lib/ticker";

test("an incomplete research-bar generation can never publish its active pointer", async () => {
  const written: number[][] = [];
  let published = false;
  await assert.rejects(
    publishAfterCompleteBatches({
      rows: [1, 2, 3, 4, 5],
      batchSize: 2,
      writeBatch: async (rows, batchIndex) => {
        if (batchIndex === 1) throw new Error("injected second-batch failure");
        written.push(rows);
      },
      publish: async () => { published = true; },
    }),
    /injected second-batch failure/,
  );
  assert.deepEqual(written, [[1, 2]]);
  assert.equal(published, false);
});

test("the research-bar pointer publishes only after every batch completes", async () => {
  const events: string[] = [];
  await publishAfterCompleteBatches({
    rows: [1, 2, 3, 4, 5],
    batchSize: 2,
    writeBatch: async (rows) => { events.push(`write:${rows.join(",")}`); },
    publish: async () => { events.push("publish"); },
  });
  assert.deepEqual(events, ["write:1,2", "write:3,4", "write:5", "publish"]);
});

function series(input: Partial<NonNullable<CompanyProfile["researchBarsSeries"]>> = {}): NonNullable<CompanyProfile["researchBarsSeries"]> {
  return {
    generationId: "tiingo-eod-a",
    source: "tiingo-eod",
    startDate: "2016-07-18",
    endDate: "2026-07-17",
    count: 2_515,
    chunkCount: 7,
    yearCoverage: { "2016": 115, "2025": 252, "2026": 137 },
    contentSha256: "a".repeat(64),
    requestedAt: 100,
    refreshedAt: 200,
    ...input,
  };
}

test("a later request cannot replace richer live adjusted coverage", () => {
  const current = series();
  assert.equal(researchSeriesCanReplace(current, series({
    generationId: "tiingo-eod-poor",
    startDate: "2026-04-20",
    endDate: "2026-07-10",
    count: 60,
    chunkCount: 1,
    yearCoverage: { "2026": 60 },
    requestedAt: 105,
  })), false);
  assert.equal(researchSeriesCanReplace(current, series({
    generationId: "tiingo-eod-new",
    endDate: "2026-07-20",
    count: 2_516,
    yearCoverage: { "2016": 114, "2025": 252, "2026": 139 },
    requestedAt: 105,
  })), true);
  assert.equal(researchSeriesCanReplace(current, series({
    generationId: "yahoo-downgrade",
    source: "yahoo-chart",
    requestedAt: 999,
  })), false);
});

function recentBars(count: number, start = "2026-04-20"): DailyBar[] {
  const rows: DailyBar[] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  while (rows.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      rows.push({
        date: cursor.toISOString().slice(0, 10),
        close: 100 + rows.length,
        adjustedClose: 100 + rows.length,
        changePct: rows.length ? 1 : null,
        volume: 1_000,
        source: "tiingo-eod",
      });
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return rows;
}

test("coverage metadata distinguishes a new listing from a partial decade", () => {
  const bars = recentBars(60);
  const endDate = bars.at(-1)!.date;
  assert.equal(researchCoverageIsComplete({
    bars,
    requestedStartDate: "2016-07-17",
    tiingoMetadata: { ticker: "ACME", startDate: "2010-01-01", endDate },
    nowEtDate: endDate,
  }), false, "an established issuer cannot publish a three-month partial response");
  assert.equal(researchCoverageIsComplete({
    bars,
    requestedStartDate: "2016-07-17",
    tiingoMetadata: { ticker: "IPO", startDate: bars[0].date, endDate },
    nowEtDate: endDate,
  }), true, "verified listing metadata permits a genuinely short IPO history");
  assert.equal(researchCoverageIsComplete({
    bars: [{ ...bars[10], date: "2026-02-30" }, ...bars.slice(1)],
    requestedStartDate: "2016-07-17",
    tiingoMetadata: { ticker: "IPO", startDate: bars[0].date, endDate },
    nowEtDate: endDate,
  }), false);
  assert.equal(researchCoverageIsComplete({
    bars: [...bars.slice(0, -1), { ...bars.at(-1)!, date: "2027-01-02" }],
    requestedStartDate: "2016-07-17",
    tiingoMetadata: { ticker: "IPO", startDate: bars[0].date, endDate: "2027-01-02" },
    nowEtDate: endDate,
  }), false);

  const sparseDecade = Array.from({ length: 60 }, (_, index): DailyBar => {
    const offset = Math.round(index * (3_652 / 59));
    const date = new Date(Date.parse("2016-07-18T00:00:00Z") + offset * 86_400_000)
      .toISOString().slice(0, 10);
    return {
      date,
      close: 100 + index,
      adjustedClose: 100 + index,
      changePct: index ? 0.1 : null,
      volume: 1_000,
      source: "tiingo-eod",
    };
  });
  sparseDecade[sparseDecade.length - 1] = {
    ...sparseDecade.at(-1)!,
    date: "2026-07-17",
  };
  assert.equal(researchCoverageIsComplete({
    bars: sparseDecade,
    requestedStartDate: "2016-07-17",
    tiingoMetadata: { ticker: "ACME", startDate: "2000-01-01", endDate: "2026-07-17" },
    nowEtDate: "2026-07-17",
  }), false, "sparse endpoints cannot masquerade as a complete decade");
});

test("research history cache eviction is bounded and LRU", () => {
  const cache = new Map<number, string>();
  for (let index = 0; index < 32; index += 1) setBoundedMapEntry(cache, index, String(index), 32);
  setBoundedMapEntry(cache, 0, "recent", 32);
  setBoundedMapEntry(cache, 32, "new", 32);
  assert.equal(cache.size, 32);
  assert.equal(cache.has(0), true);
  assert.equal(cache.has(1), false);
  assert.equal(cache.get(32), "new");
});
