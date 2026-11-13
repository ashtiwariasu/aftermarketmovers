import assert from "node:assert/strict";
import test from "node:test";
import type { Desk } from "../src/lib/desk";

process.env.DESK_STORE = "memory";

test("daily coverage remains incomplete until every followed stock has a receipt", async () => {
  const { dailyThesisCheckId, getDailyThesisCoverage } =
    await import("../src/lib/dailyThesisCheck");
  const coverage = await getDailyThesisCoverage(
    ["msft", "AAPL", "MSFT"],
    "2099-01-05",
  );

  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.checks, []);
  assert.deepEqual(coverage.missingTickers, ["AAPL", "MSFT"]);
  assert.equal(dailyThesisCheckId(" msft ", "2099-01-05"), "MSFT_2099-01-05");
});

test("invalid or tampered values cannot masquerade as completion receipts", async () => {
  const { isDailyThesisCheck } = await import("../src/lib/dailyThesisCheck");
  assert.equal(isDailyThesisCheck(null), false);
  assert.equal(isDailyThesisCheck({
    schema: "daily-thesis-check-v1",
    id: "MSFT_2099-01-05",
    ticker: "MSFT",
    date: "2099-01-05",
    checkedAt: Date.now(),
    outcome: "published",
    source: "dossier",
    sourceGeneratedAt: Date.now(),
    sourceFingerprint: "0".repeat(64),
    auditId: "audit",
    lifecycleId: null,
    thesisStatus: "open",
    score: 1,
    scoreLabel: "gentle upside",
    votes: { support: 3, oppose: 0, uncertain: 2, unavailable: 0 },
    evidenceCount: 2,
    receiptSha256: "0".repeat(64),
  }), false);
});

test("Morning Note carries prior research forward when a followed stock lacks its daily receipt", async () => {
  const { composeDoorbell } = await import("../src/lib/doorbell");
  const desk: Desk = {
    id: "daily_tracking_gate",
    email: "reader@example.com",
    tickers: ["INCMPLT"],
    createdAt: Date.now(),
    activity: [],
    noteTime: "07:00",
    tz: "Australia/Brisbane",
  };

  const previousAddress = process.env.COMPANY_POSTAL_ADDRESS;
  const previousUnsubscribe = process.env.UNSUBSCRIBE_SECRET;
  process.env.COMPANY_POSTAL_ADDRESS = "123 Test Street, Brisbane QLD 4000, Australia";
  process.env.UNSUBSCRIBE_SECRET = "daily-tracking-test-secret";
  try {
    const note = await composeDoorbell(desk, {
      trackingDate: "2099-01-05",
      now: new Date("2099-01-06T14:00:00Z"),
    });
    assert.ok(note);
    assert.match(note.subject, /research incomplete for INCMPLT/i);
    assert.match(note.html, /RESEARCH INCOMPLETE · INCMPLT/);
    assert.match(note.text, /no current-day ruling was produced/i);
    assert.doesNotMatch(`${note.subject}\n${note.html}\n${note.text}`, /unchanged/i);
  } finally {
    if (previousAddress == null) delete process.env.COMPANY_POSTAL_ADDRESS;
    else process.env.COMPANY_POSTAL_ADDRESS = previousAddress;
    if (previousUnsubscribe == null) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = previousUnsubscribe;
  }
});

test("Morning Note tracks the current New York research date across timezones", async () => {
  const { expectedDailyTrackingDate } = await import("../src/lib/doorbell");

  assert.equal(
    expectedDailyTrackingDate(new Date("2026-07-24T21:00:00.000Z")),
    "2026-07-24",
  );
  assert.equal(
    expectedDailyTrackingDate(new Date("2026-07-24T13:00:00.000Z")),
    "2026-07-24",
  );
  assert.equal(
    expectedDailyTrackingDate(new Date("2026-07-27T13:00:00.000Z")),
    "2026-07-27",
  );
  assert.equal(
    expectedDailyTrackingDate(new Date("2026-07-03T13:00:00.000Z")),
    "2026-07-02",
    "manual holiday renders use the latest valid research date",
  );
});
