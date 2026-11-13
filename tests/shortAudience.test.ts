import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyShortAudienceContext } from "../src/lib/shortAudience";

test("audience context preserves publication history and normalizes measured performance", () => {
  const context = buildDailyShortAudienceContext([
    {
      ticker: "nvda",
      publicationDate: "2026-07-21",
      status: "published",
      videoId: "nvda-1",
      youtubeMetrics: {
        views: 10_000,
        engagedViews: 8_000,
        averageViewPercentage: 78,
        capturedAt: 100,
      },
      conversionMetrics: { dossierVisits: 100, trialStarts: 10 },
    },
    {
      ticker: "XYZ",
      publicationDate: "2026-07-22",
      status: "scheduled",
      videoId: "xyz-1",
      youtubeMetrics: {
        views: 1_000,
        engagedViews: 500,
        averageViewPercentage: 42,
        capturedAt: 200,
      },
      conversionMetrics: { dossierVisits: 1, trialStarts: 0 },
    },
    {
      ticker: "META",
      publicationDate: "2026-07-22",
      status: "failed",
      videoId: "failed",
      youtubeMetrics: { views: 1_000_000 },
    },
  ], "2026-07-23");

  assert.deepEqual(context.publicationHistory, [
    { ticker: "NVDA", publicationDate: "2026-07-21" },
    { ticker: "XYZ", publicationDate: "2026-07-22" },
  ]);
  assert.equal(context.audienceSignals.get("NVDA")?.currentInterest, 100);
  assert.equal(context.audienceSignals.get("NVDA")?.historicalEngagement, 100);
  assert.equal(context.audienceSignals.get("XYZ")?.currentInterest, 0);
  assert.equal(context.audienceSignals.has("META"), false);
});

test("missing analytics remain neutral instead of manufacturing an audience winner", () => {
  const context = buildDailyShortAudienceContext([
    {
      ticker: "AAPL",
      publishAt: "2026-07-22T12:00:00.000Z",
      status: "published",
      videoId: "aapl-1",
    },
  ], "2026-07-23");

  assert.deepEqual(context.publicationHistory, [
    { ticker: "AAPL", publicationDate: "2026-07-22" },
  ]);
  assert.equal(context.audienceSignals.get("AAPL")?.sampleSize, 0);
  assert.equal(context.audienceSignals.get("AAPL")?.currentInterest, 50);
  assert.equal(context.audienceSignals.get("AAPL")?.historicalEngagement, 50);
  assert.equal(context.audienceSignals.get("AAPL")?.conversionIntent, 50);
});
