import assert from "node:assert/strict";
import test from "node:test";
import {
  assessResearchSupport,
  assessResearchSupportCached,
  cachedResearchSupportDecision,
  classifyResearchSupport,
  RESEARCH_SUPPORT_CACHE_SCHEMA,
  RESEARCH_SUPPORT_POLICY_VERSION,
  researchSupportCacheTtlMs,
  type ResearchSupportInputs,
} from "../src/lib/researchSupport";
import type { SecCompanyIdentity } from "../src/lib/sec";

const fundamentals = {
  schemaVersion: 2,
  asOf: "2026-03-31",
  fiscal: "Q1 FY2026",
  revenue: 1,
  revenueYoY: 1,
  netIncome: 1,
  netIncomeYoY: 1,
  eps: 1,
  epsYoY: 1,
  quarters: [],
};

const appleIdentity: SecCompanyIdentity = {
  symbol: "AAPL",
  cik: "0000320193",
  name: "Apple Inc.",
  exchange: "Nasdaq",
  entityType: "operating",
  category: "Large accelerated filer",
  stateOfIncorporation: "CA",
  stateOfIncorporationDescription: "CA",
  sic: "3571",
  recentForms: ["10-Q", "8-K", "4"],
};

function fixture(overrides: Partial<ResearchSupportInputs> = {}): ResearchSupportInputs {
  return {
    symbol: "AAPL",
    identity: { ok: true, identity: appleIdentity },
    snapshot: {
      symbol: "AAPL",
      name: "Apple Inc.",
      exchange: "NasdaqGS",
      price: 200,
      previousClose: 199,
      dayChangePercent: 0.5,
      afterHoursPrice: null,
      afterHoursChangePercent: null,
      fiftyTwoWeekHigh: 220,
      fiftyTwoWeekLow: 150,
      volume: 1_000_000,
      marketState: "CLOSED",
      nextEvent: null,
    },
    tiingo: { ticker: "AAPL", startDate: "1980-12-12", endDate: "2026-07-20" },
    fundamentals: null,
    checkedAt: 123,
    ...overrides,
  };
}

test("admits a US company with a supported primary filing and two-source prices", () => {
  const result = classifyResearchSupport(fixture());
  assert.equal(result.supported, true);
  assert.equal(result.code, "supported");
  assert.equal(result.policyVersion, RESEARCH_SUPPORT_POLICY_VERSION);
});

test("admits a new US IPO from its registration filing before XBRL fundamentals exist", () => {
  const result = classifyResearchSupport(fixture({
    symbol: "SPCX",
    identity: {
      ok: true,
      identity: {
        ...appleIdentity,
        symbol: "SPCX",
        cik: "0001181412",
        name: "SPACE EXPLORATION TECHNOLOGIES CORP",
        stateOfIncorporation: "TX",
        stateOfIncorporationDescription: "TX",
        recentForms: ["S-1", "8-K"],
      },
    },
    snapshot: { ...fixture().snapshot!, symbol: "SPCX", name: "Space Exploration Technologies Corp." },
    tiingo: { ticker: "SPCX", startDate: "2026-06-12", endDate: "2026-07-20" },
  }));
  assert.equal(result.supported, true);
});

test("admits an established US issuer when SEC jurisdiction metadata is blank", () => {
  const result = classifyResearchSupport(fixture({
    symbol: "PLTR",
    identity: {
      ok: true,
      identity: {
        ...appleIdentity,
        symbol: "PLTR",
        cik: "0001321655",
        name: "Palantir Technologies Inc.",
        stateOfIncorporation: "",
        stateOfIncorporationDescription: "",
        recentForms: ["10-Q", "10-K", "8-K"],
      },
    },
    snapshot: { ...fixture().snapshot!, symbol: "PLTR", name: "Palantir Technologies Inc." },
    tiingo: { ticker: "PLTR", startDate: "2020-09-30", endDate: "2026-07-20" },
    fundamentals,
  }));
  assert.equal(result.supported, true);
});

test("positions a US-listed foreign ADR as outside the deliberate research boundary", () => {
  const result = classifyResearchSupport(fixture({
    symbol: "SKHY",
    identity: {
      ok: true,
      identity: {
        ...appleIdentity,
        symbol: "SKHY",
        cik: "0002120882",
        name: "SK hynix Inc.",
        stateOfIncorporation: "M5",
        stateOfIncorporationDescription: "Korea, Republic of",
        recentForms: ["F-1", "6-K", "424B4"],
      },
    },
    snapshot: { ...fixture().snapshot!, symbol: "SKHY", name: "SK hynix Inc." },
    tiingo: { ticker: "SKHY", startDate: "2026-07-10", endDate: "2026-07-20" },
  }));
  assert.equal(result.supported, false);
  assert.equal(result.code, "foreign_issuer");
  assert.match(result.message, /trades in the US/);
  assert.match(result.message, /every thesis/);
});

test("rejects funds even when they trade on a supported exchange", () => {
  const result = classifyResearchSupport(fixture({
    identity: {
      ok: true,
      identity: { ...appleIdentity, name: "Example Growth ETF", sic: "6722" },
    },
  }));
  assert.equal(result.code, "unsupported_security_type");
});

test("requires a financial filing or extractable fundamentals", () => {
  const result = classifyResearchSupport(fixture({
    identity: {
      ok: true,
      identity: { ...appleIdentity, recentForms: ["4", "SC 13G"] },
    },
  }));
  assert.equal(result.code, "insufficient_primary_filings");
});

test("requires both live and adjusted market-data coverage", () => {
  assert.equal(classifyResearchSupport(fixture({ snapshot: null })).code, "insufficient_market_data");
  assert.equal(classifyResearchSupport(fixture({ tiingo: null })).code, "insufficient_market_data");
  assert.equal(classifyResearchSupport(fixture({
    tiingo: { ticker: "AAPLX", startDate: "1980-12-12", endDate: "2026-07-20" },
  })).code, "insufficient_market_data");
});

test("distinguishes a temporary verification outage from unsupported coverage", () => {
  const result = classifyResearchSupport(fixture({
    identity: { ok: false, identity: null, error: "SEC HTTP 503" },
  }));
  assert.equal(result.code, "verification_unavailable");
  assert.match(result.message, /try again shortly/);
});

test("async assessment evaluates all required providers before admission", async () => {
  const result = await assessResearchSupport("aapl", {
    getIdentity: async () => ({ ok: true, identity: appleIdentity }),
    getSnapshot: async () => fixture().snapshot,
    getTiingoMetadata: async () => fixture().tiingo,
    getFundamentals: async () => fixture().fundamentals,
  });
  assert.equal(result.supported, true);
  assert.equal(result.symbol, "AAPL");
});

test("fleet support cache reuses a fresh derived decision without provider calls", async () => {
  const stored = new Map<string, unknown>();
  let providerCalls = 0;
  const dependencies = {
    getIdentity: async () => { providerCalls++; return { ok: true as const, identity: appleIdentity }; },
    getSnapshot: async () => { providerCalls++; return fixture().snapshot; },
    getTiingoMetadata: async () => { providerCalls++; return fixture().tiingo; },
    getFundamentals: async () => { providerCalls++; return fixture().fundamentals; },
  };
  const cache = {
    get: async (symbol: string) => stored.get(symbol),
    set: async (symbol: string, value: unknown) => { stored.set(symbol, value); },
  };
  const first = await assessResearchSupportCached("aapl", dependencies, cache, 1_000);
  const second = await assessResearchSupportCached("AAPL", dependencies, cache, 2_000);
  assert.equal(first.supported, true);
  assert.deepEqual(second, first);
  assert.equal(providerCalls, 4);
});

test("support cache rejects expired, mismatched-policy, and transient decisions", () => {
  const supported = classifyResearchSupport(fixture({ checkedAt: 100 }));
  const fresh = {
    schema: RESEARCH_SUPPORT_CACHE_SCHEMA,
    decision: supported,
    expiresAt: 1_000,
  };
  assert.deepEqual(cachedResearchSupportDecision(fresh, "AAPL", 999), supported);
  assert.equal(cachedResearchSupportDecision(fresh, "AAPL", 1_000), null);
  assert.equal(cachedResearchSupportDecision({
    ...fresh,
    decision: { ...supported, policyVersion: "old-policy" },
  }, "AAPL", 999), null);

  const transient = classifyResearchSupport(fixture({
    identity: { ok: false, identity: null, error: "SEC HTTP 503" },
  }));
  assert.equal(researchSupportCacheTtlMs(transient), 0);
  assert.equal(researchSupportCacheTtlMs(classifyResearchSupport(fixture({ snapshot: null }))), 0);
});
