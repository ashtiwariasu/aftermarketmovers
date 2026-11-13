import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  dossierCronAuthorized,
  dossierCronStatus,
  dailyResearchLeaseId,
  dossierTickerShard,
  selectDossierCandidates,
  selectDossierShard,
} from "../src/lib/dossierCron";

test("dossier cron retries any unfinished daily research work", () => {
  assert.equal(dossierCronStatus([]), 200);
  assert.equal(dossierCronStatus(["NVDA"]), 503);
});

test("dossier cron accepts a Secret Manager token with a trailing newline", () => {
  assert.equal(dossierCronAuthorized("dev-secret\n", "dev-secret"), true);
  assert.equal(dossierCronAuthorized("dev-secret", "wrong-secret"), false);
  assert.equal(dossierCronAuthorized("\n", ""), false);
  assert.equal(dossierCronAuthorized(undefined, null), false);
});

test("dossier shards are stable, complete, and non-overlapping", () => {
  const tickers = [
    "AAPL", "ACHR", "AMD", "AMZN", "AVGO", "CCXI", "CRSP", "CRSR", "CRWV",
    "GOOGL", "IBM", "INTC", "IONQ", "IREN", "JOBY", "META", "MSFT", "NVDA",
    "PL", "PLTR", "QBTS", "QNT", "RGTI", "RKLB", "RVLV", "SNDK", "SPCX",
    "TSEM", "TSLA", "VRT",
  ];
  const shards = Array.from({ length: 9 }, (_, shard) =>
    selectDossierShard(tickers, shard, 9)
  );
  assert.deepEqual(
    shards.flat().sort((a, b) => a.localeCompare(b)),
    [...tickers].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(new Set(shards.flat()).size, tickers.length);
  assert.ok(Math.max(...shards.map((group) => group.length)) <= 5);
  assert.equal(dossierTickerShard("NVDA", 9), dossierTickerShard("nvda", 9));

  const before = dossierTickerShard("META", 9);
  selectDossierShard([...tickers, "XYZ"], before, 9);
  assert.equal(dossierTickerShard("META", 9), before);
});

test("fleet scheduler has one sharded same-day pre-market cycle", () => {
  const source = readFileSync(new URL("../scripts/configure-dossier-scheduler.sh", import.meta.url), "utf8");
  assert.match(source, /SHARD_COUNT="\$\{DOSSIER_SHARD_COUNT:-9\}"/);
  assert.match(source, /START_MINUTES="\$\{DOSSIER_START_MINUTES:-30\}"/);
  assert.match(source, /STAGGER_MINUTES="\$\{DOSSIER_STAGGER_MINUTES:-10\}"/);
  assert.match(source, /shard=\$shard&shards=\$SHARD_COUNT/);
  assert.match(source, /--time-zone="America\/New_York"/);
  assert.doesNotMatch(source, /--schedule="0 \*\/12 \* \* \*"/);
});

test("daily cron narrows the fleet before provider-backed support checks", () => {
  const active = ["NVDA", "AAPL", "META", "MSFT"];
  assert.deepEqual(selectDossierCandidates({
    activeTickers: active,
    requestedTicker: "meta",
  }), ["META"]);
  assert.deepEqual(selectDossierCandidates({
    activeTickers: active,
    requestedTicker: "TSLA",
  }), []);

  const selected = selectDossierCandidates({
    activeTickers: active,
    shard: 1,
    shardCount: 3,
  });
  assert.deepEqual(selected, selectDossierShard(active, 1, 3));
  assert.equal(dailyResearchLeaseId("nvda", "2026-08-05"), "daily-research:NVDA:2026-08-05");
});

test("every unfinished trading-day review reaches the council", () => {
  const source = readFileSync(
    new URL("../src/app/api/cron/dossiers/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /councilInvoked = true;\s+const modelStartedAt/);
  assert.match(source, /ensureDossier\(sym, today, \{ evidencePack: preparedPack \}\)/);
  assert.match(source, /if \(!isUsEquityTradingDay\(today\)\)/);
  assert.doesNotMatch(source, /assessEvidenceMateriality|recordUnchangedDailyThesisCheck|recordUnchangedThesisObservation/);
});
