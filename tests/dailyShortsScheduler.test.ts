import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scheduler = readFileSync(
  new URL("../scripts/configure-daily-shorts-pipeline.sh", import.meta.url),
  "utf8",
);

test("daily Shorts start after the dossier run on trading and non-trading days", () => {
  assert.match(
    scheduler,
    /configure_scheduler "\$SCHEDULER_JOB" "\$JOB" "0 5 \* \* \*"/,
  );
  assert.match(
    scheduler,
    /configure_scheduler "\$RECOVERY_SCHEDULER_JOB" "\$RECOVERY_JOB" "0,15,30 7 \* \* \*"/,
  );
  assert.match(
    scheduler,
    /tsx,tools\/shorts\/run-daily-pipeline\.ts,--publish,--recovery/,
  );
  assert.match(scheduler, /--time-zone="America\/New_York"/);
  assert.match(scheduler, /2 weekday Shorts; 1 non-trading-day recap/);
  assert.match(
    scheduler,
    /07:00, 07:15 and 07:30 America\/New_York, daily \(idempotent, no quality-gate relaxation\)/,
  );
  assert.doesNotMatch(scheduler, /--schedule="0 5 \* \* 1-5"/);
  assert.doesNotMatch(scheduler, /--schedule="0 4 \* \* \*"/);
});
