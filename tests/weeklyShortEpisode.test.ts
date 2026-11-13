import assert from "node:assert/strict";
import test from "node:test";
import { dossier } from "./dailyShorts.test";
import {
  buildWeeklyShortEpisodePackage,
  validateWeeklyShortDraft,
  weeklyShortPackageValidationError,
  weeklySourceBundle,
  type WeeklyShortDraft,
} from "../src/lib/weeklyShortEpisode";

function weeklyFixture() {
  const dossiers = ["NVDA", "META", "AMZN", "MSFT", "TSLA"].map((ticker) =>
    dossier(ticker));
  const excerpts = weeklySourceBundle(dossiers);
  const stocks = dossiers.map((value, index) => {
    const sources = excerpts.filter((excerpt) => excerpt.id.startsWith(`${value.ticker}:`));
    const line1 = `${value.ticker}'s standing thesis held as its admitted operating evidence remained intact`;
    const line2 = `${value.ticker}'s next company filing remains the clearest test of that thesis.`;
    return {
      ticker: value.ticker,
      line1,
      line2,
      claimIds: [`W${index * 2 + 1}`, `W${index * 2 + 2}`],
      sources,
    };
  });
  const claims = stocks.flatMap((stock, index) => [
    {
      id: `W${index * 2 + 1}`,
      ticker: stock.ticker,
      statement: stock.line1,
      support: [{
        sourceId: stock.sources[0]!.id,
        quote: stock.sources[0]!.text.slice(0, 80),
      }],
    },
    {
      id: `W${index * 2 + 2}`,
      ticker: stock.ticker,
      statement: stock.line2,
      support: [{
        sourceId: stock.sources.at(-1)!.id,
        quote: stock.sources.at(-1)!.text.slice(0, 80),
      }],
    },
  ]);
  const draft: WeeklyShortDraft = {
    schema: "amm-weekly-short-draft-v1",
    intro: "Five big stocks moved most in AMM's research this week. Here is what changed and what could matter next.",
    stocks: stocks.map((stock) => ({
      ticker: stock.ticker,
      line1: stock.line1,
      line2: stock.line2,
      claimIds: stock.claimIds,
    })),
    close: "Track every thesis and source at aftermarketmovers dot com.",
    claims,
  };
  // Keep the structural test deterministic while satisfying the locked
  // 150–175-word narration range with source-bound, non-factual connective copy.
  draft.stocks[0]!.line1 +=
    ", with the important point being whether the standing evidence meaningfully changed rather than one isolated headline.";
  draft.claims[0]!.statement = draft.stocks[0]!.line1;
  return { dossiers, draft };
}

test("weekly episode binds two sentences per stock to same-company evidence", () => {
  const { dossiers, draft } = weeklyFixture();
  const issues = validateWeeklyShortDraft(dossiers, draft, "weekly-review");
  assert.deepEqual(issues, []);
  const episode = buildWeeklyShortEpisodePackage({
    dossiers,
    draft,
    targetDate: "2026-07-23",
    publicationDate: "2026-07-25",
    edition: "weekly-review",
    now: 1,
  });
  assert.equal(episode.stocks.length, 5);
  assert.match(episode.episodeId, /^amm-weekly-[a-f0-9]{24}$/);
  assert.match(episode.provenance.sourceBundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(episode.stocks[0]!.reportingCycle.startLabel, "LAST RESULTS · JUL 23");
  assert.equal(episode.stocks[0]!.reportingCycle.endLabel, "NEXT RESULTS · DATE PENDING");
  assert.equal(weeklyShortPackageValidationError(dossiers, episode), null);
});

test("weekly episode rejects cross-company evidence", () => {
  const { dossiers, draft } = weeklyFixture();
  draft.claims[0]!.support[0]!.sourceId =
    draft.claims[2]!.support[0]!.sourceId;
  const issues = validateWeeklyShortDraft(dossiers, draft, "weekly-review");
  assert.match(issues.join(" "), /crosses evidence between companies/);
});

test("weekly episode rejects short-window predictions and advice language", () => {
  const { dossiers, draft } = weeklyFixture();
  draft.stocks[0]!.line2 = "Buy it because this will rise over the next 10–15 sessions.";
  draft.claims[1]!.statement = draft.stocks[0]!.line2;
  const issues = validateWeeklyShortDraft(dossiers, draft, "weekly-review");
  assert.match(issues.join(" "), /short-window prediction|public-copy gate/);
});

test("week-ahead edition uses the locked forward-looking opener without new research", () => {
  const { dossiers, draft } = weeklyFixture();
  draft.intro =
    "Five big stocks carry the clearest evidence changes into next week. Here is what could matter next.";
  const issues = validateWeeklyShortDraft(dossiers, draft, "week-ahead");
  assert.deepEqual(issues, []);
});

test("weekly cached package rejects a changed dossier state", () => {
  const { dossiers, draft } = weeklyFixture();
  const episode = buildWeeklyShortEpisodePackage({
    dossiers,
    draft,
    targetDate: "2026-07-23",
    publicationDate: "2026-07-25",
    edition: "weekly-review",
    now: 1,
  });
  dossiers[0]!.emailHook.votes.support = 3;
  assert.match(
    weeklyShortPackageValidationError(dossiers, episode) ?? "",
    /no longer matches/,
  );
});
