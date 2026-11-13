import assert from "node:assert/strict";
import test from "node:test";
import {
  buildYouTubeWeeklyShortMetadata,
  buildYouTubeShortMetadata,
  isUsEquityTradingDay,
  plannedPublicationSlots,
  previousUsEquityTradingDay,
  publicationSlots,
  weekendRecapPublicationSlot,
  zonedDateTimeToUtc,
} from "../src/lib/shortPublishing";
import type { ShortEpisodePackage } from "../src/lib/shortEpisode";
import type { WeeklyShortEpisodePackage } from "../src/lib/weeklyShortEpisode";

function episode(): ShortEpisodePackage {
  return {
    schema: "amm-short-episode-v1",
    episodeId: "a".repeat(48),
    createdAt: Date.parse("2026-07-23T00:00:00Z"),
    identity: { companyName: "Meta Platforms", source: "market-metadata" },
    dossier: {
      artifactVersion: 5,
      artifactKey: "dossier-v5:META:2026-07-22:1784770000000",
      ticker: "META",
      date: "2026-07-22",
      generatedAt: 1_784_770_000_000,
      briefAuditId: "b".repeat(48),
      councilRunId: "c".repeat(48),
      sha256: "d".repeat(64),
    },
    editorial: {
      templateVersion: "amm-weekday-locked-v3",
      words: 160,
      estimatedSeconds: 53.3,
      targetSeconds: { min: 50, max: 70 },
      script: "Audited script",
      beats: {
        hook: { text: "Hook", claimIds: ["C1"] },
        change: { text: "Change", claimIds: ["C1"] },
        thesis: { text: "Thesis", claimIds: ["C1"] },
        evidence: { text: "Evidence", claimIds: ["C1"] },
        council: { text: "Council", claimIds: ["C1"] },
        close: { text: "See aftermarketmovers dot com.", claimIds: [] },
      },
      claims: [{
        id: "C1",
        statement: "Statement",
        support: [{ sourceId: "D1", quote: "A sufficiently long quote." }],
      }],
    },
    signal: {
      direction: "UP",
      strength: "GENTLE",
      horizonSessions: { min: 10, max: 15 },
      votes: { support: 4, oppose: 0, uncertain: 1 },
      label: "GENTLE UPSIDE",
    },
    lifecycle: {
      id: "f".repeat(48),
      openedDate: "2026-07-20",
      observationDate: "2026-07-22",
      observationIndex: 3,
      status: "open",
      canonicalSubjectPunchline: "Filed cash flow covers the AI spending plan",
      canonicalLabel: "GENTLE UPSIDE",
      currentLabel: "GENTLE UPSIDE",
      reviewDueBy: "2026-10-28",
    },
    provenance: {
      sourceBundleSha256: "e".repeat(64),
      excerpts: [{
        id: "D1",
        path: "emailHook.thesis",
        text: "A sufficiently long quote.",
        citationIds: ["S1"],
      }],
      citations: [{
        id: "S1",
        title: "10-Q",
        url: "https://www.sec.gov/filing",
        publisher: "SEC",
        authority: "primary",
        publishedDate: "2026-07-22",
        sourceDocumentId: "sec",
      }],
    },
    publication: {
      traceUrl: "https://aftermarketmovers.com/stock/meta?dossier=example",
      sourceDescription: "AMM dossier example\nAudit example\n\nSources used in this episode\nSEC filing",
    },
  };
}

test("New York wall-clock publication slots survive timezone conversion", () => {
  assert.equal(
    zonedDateTimeToUtc({
      date: "2026-07-23",
      hour: 7,
      minute: 30,
      timeZone: "America/New_York",
    }).toISOString(),
    "2026-07-23T11:30:00.000Z",
  );
  const slots = publicationSlots({
    publicationDate: "2026-07-23",
    count: 2,
    now: new Date("2026-07-23T08:00:00.000Z"),
  });
  assert.deepEqual(
    slots.map((slot) => slot.toISOString()),
    ["2026-07-23T12:30:00.000Z", "2026-07-23T12:45:00.000Z"],
  );
});

test("a missed pre-market window fails closed instead of publishing stale research later", () => {
  assert.throws(
    () => publicationSlots({
      publicationDate: "2026-07-23",
      count: 2,
      now: new Date("2026-07-23T13:00:00.000Z"),
    }),
    /stale rollover is forbidden/,
  );
});

test("render-only validation can use the planned slots after publication closes", () => {
  const slots = plannedPublicationSlots({
    publicationDate: "2026-07-23",
    count: 2,
  });
  assert.deepEqual(
    slots.map((slot) => slot.toISOString()),
    ["2026-07-23T12:30:00.000Z", "2026-07-23T12:45:00.000Z"],
  );
});

test("Friday research is never held over for Monday", () => {
  assert.throws(
    () => publicationSlots({
      publicationDate: "2026-07-24",
      count: 2,
      now: new Date("2026-07-24T13:00:00.000Z"),
    }),
    /stale rollover is forbidden/,
  );
});

test("publication slots refuse full-day NYSE holidays instead of rolling forward", () => {
  assert.throws(
    () => publicationSlots({
      publicationDate: "2026-07-03",
      count: 2,
      now: new Date("2026-07-03T08:00:00.000Z"),
    }),
    /publish only on US equity trading days/,
  );
  assert.throws(
    () => publicationSlots({
      publicationDate: "2026-11-26",
      count: 2,
      now: new Date("2026-11-26T08:00:00.000Z"),
    }),
    /publish only on US equity trading days/,
  );
});

test("NYSE calendar covers movable, observed and Saturday New Year rules", () => {
  assert.equal(isUsEquityTradingDay("2026-04-03"), false); // Good Friday
  assert.equal(isUsEquityTradingDay("2026-06-19"), false); // Juneteenth
  assert.equal(isUsEquityTradingDay("2026-07-03"), false); // Independence Day observed
  assert.equal(isUsEquityTradingDay("2026-11-27"), true); // early close, still a trading day
  assert.equal(isUsEquityTradingDay("2027-12-31"), true); // Jan 1 2028 is Saturday; no observance
  assert.equal(isUsEquityTradingDay("not-a-date"), false);
});

test("non-trading recaps resolve to the prior completed US session", () => {
  assert.equal(previousUsEquityTradingDay("2026-07-25"), "2026-07-24");
  assert.equal(previousUsEquityTradingDay("2026-07-26"), "2026-07-24");
  assert.equal(previousUsEquityTradingDay("2026-09-07"), "2026-09-04");
});

test("non-trading recaps receive one same-day morning slot and fail closed after it", () => {
  assert.equal(
    weekendRecapPublicationSlot({
      publicationDate: "2026-07-25",
      now: new Date("2026-07-25T08:00:00.000Z"),
    }).toISOString(),
    "2026-07-25T13:00:00.000Z",
  );
  assert.throws(
    () => weekendRecapPublicationSlot({
      publicationDate: "2026-07-25",
      now: new Date("2026-07-25T14:00:00.000Z"),
    }),
    /stale rollover is forbidden/,
  );
  assert.throws(
    () => weekendRecapPublicationSlot({
      publicationDate: "2026-07-24",
      now: new Date("2026-07-24T08:00:00.000Z"),
    }),
    /only on a non-trading day/,
  );
});

test("weekend recap metadata is visibly distinct and reporting-cycle based", () => {
  const value = episode();
  value.format = "weekend-recap";
  value.reportingCycle = {
    publicationDate: "2026-07-25",
    sourceDate: "2026-07-24",
    startDate: "2026-04-30",
    startLabel: "LAST RESULTS · APR 30",
    endDate: "2026-07-30",
    endLabel: "NEXT RESULTS · JUL 30",
  };
  const metadata = buildYouTubeShortMetadata(
    value,
    new Date("2026-07-25T13:00:00.000Z"),
  );
  assert.match(metadata.snippet.title, /^META Weekend Recap:/);
  assert.match(metadata.snippet.description, /LAST RESULTS · APR 30 → NEXT RESULTS · JUL 30/);
  assert.equal(metadata.status.publishAt, "2026-07-25T13:00:00.000Z");
});

test("YouTube metadata carries the answer, trace and mandatory AI disclosure", () => {
  const metadata = buildYouTubeShortMetadata(
    episode(),
    new Date("2026-07-23T11:30:00.000Z"),
  );
  assert.match(metadata.snippet.title, /^META: Gentle Upside/);
  assert.match(metadata.snippet.title, /4\/5 AI Analysts/);
  assert.match(metadata.snippet.description, /AMM-EPISODE-ID: a{48}/);
  assert.match(metadata.snippet.description, /Full dossier:/);
  assert.match(metadata.snippet.description, /AI-generated presenter/);
  assert.equal(metadata.status.containsSyntheticMedia, true);
  assert.equal(metadata.status.selfDeclaredMadeForKids, false);
  assert.equal(metadata.status.privacyStatus, "private");
  assert.equal(metadata.status.publishAt, "2026-07-23T11:30:00.000Z");
});

test("operator recovery metadata publishes immediately without altering the scheduled default", () => {
  const metadata = buildYouTubeShortMetadata(
    episode(),
    new Date("2026-07-23T15:30:00.000Z"),
    { publishImmediately: true },
  );
  assert.equal(metadata.status.privacyStatus, "public");
  assert.equal(metadata.status.publishAt, undefined);
  assert.equal(metadata.status.containsSyntheticMedia, true);
  assert.match(metadata.snippet.description, /AMM-EPISODE-ID: a{48}/);
});

test("multi-stock non-trading metadata carries the edition, all tickers and AI disclosure", () => {
  const stocks = ["NVDA", "META", "AMZN", "MSFT", "TSLA"].map((ticker) => ({
    ticker,
    artifactKey: `dossier-v5:${ticker}:2026-07-24:1`,
    date: "2026-07-24",
    generatedAt: 1,
    activeThesis: `${ticker} standing thesis`,
    lifecycleStatus: "open" as const,
    signal: {
      eventType: "other" as const,
      direction: "UP" as const,
      strength: "GENTLE" as const,
      horizonSessions: { min: 10 as const, max: 15 as const },
    },
    votes: { support: 4, oppose: 0, uncertain: 1 },
    reportingCycle: {
      publicationDate: "2026-07-25",
      sourceDate: "2026-07-24",
      startDate: "2026-04-30",
      startLabel: "LAST RESULTS · APR 30",
      endDate: "2026-07-30",
      endLabel: "NEXT RESULTS · JUL 30",
    },
  }));
  const weekly = {
    schema: "amm-weekly-short-episode-v1",
    episodeId: "amm-weekly-1234567890abcdef12345678",
    createdAt: 1,
    targetDate: "2026-07-24",
    publicationDate: "2026-07-25",
    edition: "weekly-review",
    editorial: {
      words: 160,
      estimatedSeconds: 53,
      script: "script",
      intro: "intro",
      stocks: [],
      close: "close",
      claims: [],
    },
    stocks,
    provenance: {
      sourceBundleSha256: "a".repeat(64),
      excerpts: [],
      citations: [{
        id: "NVDA:S1",
        title: "10-Q",
        url: "https://www.sec.gov/example",
        publisher: "SEC",
        authority: "primary",
        publishedDate: "2026-07-24",
        sourceDocumentId: "sec-example",
      }],
    },
  } satisfies WeeklyShortEpisodePackage;
  const metadata = buildYouTubeWeeklyShortMetadata(
    weekly,
    new Date("2026-07-25T13:00:00.000Z"),
  );
  assert.equal(metadata.snippet.title, "5 Stock Theses That Matter This Week | AMM");
  assert.match(metadata.snippet.description, /NVDA · GENTLE UPSIDE · OPEN · 4\/5 agree/);
  assert.match(metadata.snippet.description, /META · GENTLE UPSIDE · OPEN · 4\/5 agree/);
  assert.match(metadata.snippet.description, /AI-generated presenter/);
  assert.equal(metadata.status.containsSyntheticMedia, true);
});
