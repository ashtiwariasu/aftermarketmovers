import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.DESK_STORE = "memory";

test("one global 09:00 ET slot admits only the pre-open retry window on trading days", async () => {
  const { globalMorningNoteSlot } = await import("../src/lib/morningNoteCron");
  assert.deepEqual(globalMorningNoteSlot(new Date("2026-07-16T13:00:00Z")), {
    date: "2026-07-16",
    hhmm: "09:00",
    due: true,
    minutesLate: 0,
  });
  assert.deepEqual(globalMorningNoteSlot(new Date("2026-07-16T13:29:00Z")), {
    date: "2026-07-16",
    hhmm: "09:29",
    due: true,
    minutesLate: 29,
  });
  assert.equal(globalMorningNoteSlot(new Date("2026-07-16T12:59:00Z")).due, false);
  assert.equal(globalMorningNoteSlot(new Date("2026-07-16T13:30:00Z")).due, false);
  assert.equal(
    globalMorningNoteSlot(new Date("2026-07-18T13:00:00Z")).due,
    false,
    "weekends do not produce a Morning Note",
  );
  assert.equal(
    globalMorningNoteSlot(new Date("2026-07-03T13:00:00Z")).due,
    false,
    "US market holidays do not produce a Morning Note",
  );
});

test("scheduler and delivery route use one fixed market-wide snapshot", () => {
  const scheduler = readFileSync(
    new URL("../scripts/configure-morning-note-scheduler.sh", import.meta.url),
    "utf8",
  );
  const route = readFileSync(
    new URL("../src/app/api/cron/morning-note/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(scheduler, /--schedule="0 9 \* \* 1-5"/);
  assert.match(scheduler, /--time-zone="America\/New_York"/);
  assert.doesNotMatch(scheduler, /\*\/30/);
  assert.match(route, /const capturedAt = new Date\(\)/);
  assert.match(route, /const capturedSnapshotList = \[\.\.\.capturedSnapshots\.values\(\)\]/);
  assert.doesNotMatch(route, /desk\.noteTime|dueDeliverySlot|localParts/);
  assert.ok(
    route.indexOf("await forEachConcurrent(desks, 4") <
      route.indexOf("await forEachConcurrent(deliveredForFiling, 2"),
    "every send attempt finishes before evidence filing begins",
  );
});

test("force-send verification can never false-pass a missing target or failed send", async () => {
  const { morningNoteRunStatus } = await import("../src/lib/morningNoteCron");
  assert.equal(morningNoteRunStatus({ force: "missing", forceMatched: false, sent: 0, errors: [] }), 404);
  assert.equal(morningNoteRunStatus({ force: "desk", forceMatched: true, sent: 0, errors: ["send failed"] }), 502);
  assert.equal(morningNoteRunStatus({ force: "desk", forceMatched: true, sent: 1, errors: [] }), 200);
  assert.equal(morningNoteRunStatus({ force: "", forceMatched: false, sent: 0, errors: ["retry"] }), 503);
});

test("Morning Note cron auth tolerates Secret Manager's trailing newline only", async () => {
  const { cronTokenAuthorized } = await import("../src/lib/cronAuth");
  assert.equal(cronTokenAuthorized("secret\n", "secret"), true);
  assert.equal(cronTokenAuthorized(" secret \n", "secret"), true);
  assert.equal(cronTokenAuthorized("secret", " secret "), true);
  assert.equal(cronTokenAuthorized("", ""), false);
  assert.equal(cronTokenAuthorized(" \n", ""), false);
  assert.equal(cronTokenAuthorized(undefined, "secret"), false);
  assert.equal(cronTokenAuthorized("secret", "wrong"), false);
});
