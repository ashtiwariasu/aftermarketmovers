import assert from "node:assert/strict";
import test from "node:test";
import { dossier } from "./dailyShorts.test";
import {
  assessWeeklyShortStock,
  selectWeeklyShortStocks,
  weeklyShortEditionForPublicationDate,
} from "../src/lib/weeklyShorts";

test("weekly review selects five or six qualified popular stocks by thesis movement", () => {
  const tickers = ["NVDA", "META", "AMZN", "MSFT", "TSLA", "AAPL"];
  const dossiers = tickers.map((ticker, index) => {
    const value = dossier(ticker, { support: index === 5 ? 3 : 4 });
    if (value.thesisLifecycle) {
      value.thesisLifecycle.observationStatus =
        index < 2 ? "strengthened" : index < 4 ? "weakened" : "open";
    }
    return value;
  });
  const selection = selectWeeklyShortStocks({
    dossiers,
    targetDate: "2026-07-23",
    publicationDate: "2026-07-25",
    edition: "weekly-review",
  });
  assert.equal(selection.eligible, true);
  assert.equal(selection.selected.length, 6);
  assert.deepEqual(
    selection.selected.slice(0, 4).map((item) => item.lifecycleStatus),
    ["strengthened", "strengthened", "weakened", "weakened"],
  );
});

test("weekly review fails closed rather than padding a four-stock edition", () => {
  const selection = selectWeeklyShortStocks({
    dossiers: ["NVDA", "META", "AMZN", "MSFT"].map((ticker) => dossier(ticker)),
    targetDate: "2026-07-23",
    publicationDate: "2026-07-25",
    edition: "weekly-review",
  });
  assert.equal(selection.eligible, false);
  assert.deepEqual(selection.selected, []);
  assert.match(selection.reason ?? "", /only 4 released stocks/);
});

test("Saturday is the review while Sunday and exchange holidays are week-ahead editions", () => {
  assert.equal(weeklyShortEditionForPublicationDate("2026-07-25"), "weekly-review");
  assert.equal(weeklyShortEditionForPublicationDate("2026-07-26"), "week-ahead");
  assert.equal(weeklyShortEditionForPublicationDate("2026-09-07"), "week-ahead");
  assert.throws(
    () => weeklyShortEditionForPublicationDate("2026-02-30"),
    /invalid weekly Short publication date/,
  );
});

test("ranking retains a meaningful thesis move from earlier in the completed week", () => {
  const tickers = ["NVDA", "META", "AMZN", "MSFT", "TSLA", "AAPL"];
  const dossiers = tickers.map((ticker) => {
    const value = dossier(ticker);
    if (value.thesisLifecycle) value.thesisLifecycle.observationStatus = "open";
    return value;
  });
  const earlierMsft = dossier("MSFT");
  earlierMsft.date = "2026-07-21";
  earlierMsft.generatedAt -= 2 * 86_400_000;
  if (earlierMsft.thesisLifecycle) {
    earlierMsft.thesisLifecycle.observationDate = earlierMsft.date;
    earlierMsft.thesisLifecycle.observationStatus = "strengthened";
  }
  const selection = selectWeeklyShortStocks({
    dossiers,
    targetDate: "2026-07-23",
    publicationDate: "2026-07-25",
    edition: "weekly-review",
    historyByTicker: { MSFT: [earlierMsft] },
  });
  assert.equal(selection.selected[0]?.ticker, "MSFT");
  assert.deepEqual(selection.selected[0]?.weeklyMovement.statuses, ["strengthened", "open"]);
  assert.equal(selection.selected[0]?.weeklyMovement.meaningfulChangeCount, 1);
});

test("weekly review can use the latest released dossier from the completed five-session week", () => {
  const dossiers = ["NVDA", "META", "AMZN", "MSFT", "TSLA"].map(
    (ticker) => dossier(ticker),
  );
  const selection = selectWeeklyShortStocks({
    dossiers,
    targetDate: "2026-07-24",
    minimumDossierDate: "2026-07-17",
    publicationDate: "2026-07-25",
    edition: "weekly-review",
  });
  assert.equal(selection.eligible, true);
  assert.equal(selection.selected.length, 5);
  assert.deepEqual(
    selection.selected.map((item) => item.ticker).sort(),
    ["AMZN", "META", "MSFT", "NVDA", "TSLA"],
  );
});

test("weekly candidate rejects stale, low-confidence and social-only evidence", () => {
  const stale = assessWeeklyShortStock(dossier("NVDA"), "2026-07-24");
  assert.equal(stale.eligible, false);
  assert.match(stale.reasons.join(" "), /completed research window/);

  const weak = assessWeeklyShortStock(dossier("META", { support: 2 }), "2026-07-23");
  assert.equal(weak.eligible, false);
  assert.match(weak.reasons.join(" "), /only 2\/5/);

  const socialOnly = dossier("AMZN");
  socialOnly.citations = socialOnly.citations?.map((citation) => ({
    ...citation,
    authority: "social",
  }));
  const noisy = assessWeeklyShortStock(socialOnly, "2026-07-23");
  assert.equal(noisy.eligible, false);
  assert.match(noisy.reasons.join(" "), /non-social sources|primary or company/);
});
