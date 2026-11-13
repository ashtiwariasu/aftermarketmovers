import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { requestCronTokenAuthorized } from "../src/lib/cronAuth";

process.env.DESK_STORE = "memory";

test("private signal cron fails closed without the exact configured token", async () => {
  const previous = process.env.CRON_TOKEN;
  process.env.CRON_TOKEN = "private-signal-test-secret";
  try {
    const { POST } = await import(
      "../src/app/api/cron/private-signals/route"
    );
    const missing = new NextRequest("https://example.test/api/cron/private-signals", {
      method: "POST",
    });
    const wrong = new NextRequest("https://example.test/api/cron/private-signals", {
      method: "POST",
      headers: { "x-cron-token": "wrong" },
    });
    const valid = new NextRequest("https://example.test/api/cron/private-signals", {
      method: "POST",
      headers: { "x-cron-token": "private-signal-test-secret" },
    });
    assert.equal(requestCronTokenAuthorized(missing), false);
    assert.equal(requestCronTokenAuthorized(wrong), false);
    assert.equal(requestCronTokenAuthorized(valid), true);
    assert.equal((await POST(missing)).status, 403);
    assert.equal((await POST(wrong)).status, 403);
  } finally {
    if (previous == null) delete process.env.CRON_TOKEN;
    else process.env.CRON_TOKEN = previous;
  }
});

test("private signal cron returns retryable status and honest hasMore before page one", async () => {
  const previousToken = process.env.CRON_TOKEN;
  const originalNow = Date.now;
  process.env.CRON_TOKEN = "private-signal-deadline-secret";
  // Import before replacing the process clock: module initialization may
  // legitimately read Date.now(), which must not consume this fixture's two
  // deliberately controlled request-time readings.
  const { POST } = await import("../src/app/api/cron/private-signals/route");
  let clockCalls = 0;
  Date.now = () => {
    clockCalls += 1;
    return clockCalls === 1 ? 1_000 : 241_001;
  };
  try {
    const request = new NextRequest("https://example.test/api/cron/private-signals", {
      method: "POST",
      headers: { "x-cron-token": "private-signal-deadline-secret" },
    });
    const response = await POST(request);
    assert.equal(response.status, 503);
    const body = await response.json() as {
      ok: boolean;
      completeSweep: boolean;
      stoppedPhase: string;
      outbox: { pages: number; hasMore: boolean };
      settlement: { pages: number; hasMore: boolean };
    };
    assert.equal(body.ok, false);
    assert.equal(body.completeSweep, false);
    assert.equal(body.stoppedPhase, "outbox");
    assert.equal(body.outbox.pages, 0);
    assert.equal(body.outbox.hasMore, true);
    assert.equal(body.settlement.pages, 0);
    assert.equal(body.settlement.hasMore, true);
  } finally {
    Date.now = originalNow;
    if (previousToken == null) delete process.env.CRON_TOKEN;
    else process.env.CRON_TOKEN = previousToken;
  }
});
