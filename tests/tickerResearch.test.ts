import assert from "node:assert/strict";
import test from "node:test";
import {
  getDailyHistory,
  getTiingoDailyHistory,
  getTiingoDailyMetadata,
} from "../src/lib/ticker";

test("Tiingo research history uses adjusted prices and keeps the token out of the URL", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TIINGO_API_TOKEN;
  process.env.TIINGO_API_TOKEN = "commercial-secret";
  let requestedUrl = "";
  let authorization = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(JSON.stringify([
      { date: "2026-01-02T00:00:00.000Z", close: 100, adjClose: 50, volume: 20, adjVolume: 40 },
      { date: "2026-01-05T00:00:00.000Z", close: 104, adjClose: 52, volume: 22, adjVolume: 44 },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const bars = await getTiingoDailyHistory("BRK.B", { startDate: "2025-01-01" });
    assert.equal(requestedUrl.includes("commercial-secret"), false);
    assert.match(requestedUrl, /BRK-B\/prices\?startDate=2025-01-01/);
    assert.equal(authorization, "Token commercial-secret");
    assert.deepEqual(bars, [
      {
        date: "2026-01-02",
        close: 100,
        adjustedClose: 50,
        changePct: null,
        volume: 40,
        source: "tiingo-eod",
      },
      {
        date: "2026-01-05",
        close: 104,
        adjustedClose: 52,
        changePct: 4,
        volume: 44,
        source: "tiingo-eod",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken == null) delete process.env.TIINGO_API_TOKEN;
    else process.env.TIINGO_API_TOKEN = originalToken;
  }
});

test("Tiingo research history fails closed when an adjusted close is missing", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TIINGO_API_TOKEN;
  process.env.TIINGO_API_TOKEN = "commercial-secret";
  globalThis.fetch = (async () => new Response(JSON.stringify([
    { date: "2026-01-02T00:00:00.000Z", close: 100, adjClose: 50 },
    { date: "2026-01-05T00:00:00.000Z", close: 104 },
  ]), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  try {
    assert.deepEqual(
      await getTiingoDailyHistory("ACME", { startDate: "2025-01-01" }),
      [],
      "a partial raw/adjusted series must never enter calibration",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken == null) delete process.env.TIINGO_API_TOKEN;
    else process.env.TIINGO_API_TOKEN = originalToken;
  }
});

test("Tiingo research history rejects a malformed row instead of publishing a partial response", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TIINGO_API_TOKEN;
  process.env.TIINGO_API_TOKEN = "commercial-secret";
  globalThis.fetch = (async () => new Response(JSON.stringify([
    { date: "2026-02-30T00:00:00.000Z", close: 98, adjClose: 49 },
    { date: "2026-01-05T00:00:00.000Z", close: 104, adjClose: 52 },
  ]), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    assert.deepEqual(await getTiingoDailyHistory("ACME"), []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken == null) delete process.env.TIINGO_API_TOKEN;
    else process.env.TIINGO_API_TOKEN = originalToken;
  }
});

test("Tiingo research history rejects an impossible requested start date before fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TIINGO_API_TOKEN;
  process.env.TIINGO_API_TOKEN = "commercial-secret";
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await getTiingoDailyHistory("ACME", { startDate: "2026-02-30" }), []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken == null) delete process.env.TIINGO_API_TOKEN;
    else process.env.TIINGO_API_TOKEN = originalToken;
  }
});

test("Tiingo metadata supplies authoritative coverage bounds", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TIINGO_API_TOKEN;
  process.env.TIINGO_API_TOKEN = "commercial-secret";
  let requested = "";
  globalThis.fetch = (async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({
      ticker: "ACME",
      startDate: "2025-03-04",
      endDate: "2026-07-17",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await getTiingoDailyMetadata("ACME"), {
      ticker: "ACME",
      startDate: "2025-03-04",
      endDate: "2026-07-17",
    });
    assert.equal(requested.includes("commercial-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken == null) delete process.env.TIINGO_API_TOKEN;
    else process.env.TIINGO_API_TOKEN = originalToken;
  }
});

test("private Yahoo history rejects mixed raw and adjusted closes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    chart: {
      result: [{
        timestamp: [1_767_398_400, 1_767_657_600],
        indicators: {
          quote: [{ close: [100, 104], volume: [10, 11] }],
          adjclose: [{ adjclose: [50, null] }],
        },
      }],
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    assert.deepEqual(
      await getDailyHistory("ACME", "10y", { requireCompleteAdjusted: true }),
      [],
    );
    const publicBars = await getDailyHistory("ACME", "3mo");
    assert.equal(publicBars[1]?.adjustedClose, 104, "public tape may retain its raw-close fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
