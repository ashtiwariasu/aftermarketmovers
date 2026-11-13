import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scheduledFleetConsumers = [
  "src/app/api/cron/dossiers/route.ts",
  "src/app/api/cron/resolve/route.ts",
  "src/app/api/cron/social-intel/route.ts",
  "src/app/api/cron/private-signals/route.ts",
  "src/lib/newsPipeline.ts",
  "tools/shorts/run-daily-pipeline.ts",
  "tools/shorts/run-weekly-pipeline.ts",
] as const;

test("every scheduled company-wide research collector uses the canonical active fleet", async () => {
  for (const path of scheduledFleetConsumers) {
    const source = await readFile(path, "utf8");
    assert.match(source, /listActiveCompanyTickers/);
    assert.doesNotMatch(source, /listDesks\s*\(/);
  }
});

test("dossier scheduling has no age-based company expiry", async () => {
  for (const path of [
    "src/app/api/cron/dossiers/route.ts",
    "tools/shorts/run-daily-pipeline.ts",
    "tools/shorts/run-weekly-pipeline.ts",
  ]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /DECAY_DAYS|lastActiveAt|aliveSince|decayed/i);
  }
});

test("daily Shorts prepares both selected stocks before enforcing the pair gate", async () => {
  const source = await readFile("tools/shorts/run-daily-pipeline.ts", "utf8");
  assert.match(
    source,
    /for \(const item of claimed\)[\s\S]*?prepareEpisode\(item\.dossier, today, format\)[\s\S]*?catch \(error\)[\s\S]*?continue;/,
  );
  assert.doesNotMatch(
    source,
    /prepareEpisode\(item\.dossier, today, format\)[\s\S]{0,500}?catch \(error\)[\s\S]{0,300}?break;/,
  );
  assert.match(source, /preparedPair\.length !== claimed\.length/);
});
