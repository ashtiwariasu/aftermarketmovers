import {
  getFundamentals,
  getSecCompanyIdentityResult,
  type Fundamentals,
  type SecCompanyIdentityResult,
} from "@/lib/sec";
import {
  getTickerSnapshot,
  getTiingoDailyMetadata,
  type TickerSnapshot,
  type TiingoDailyMetadata,
} from "@/lib/ticker";
import { Firestore } from "@google-cloud/firestore";

export const RESEARCH_SUPPORT_POLICY_VERSION = "us-research-v1";
export const RESEARCH_SUPPORT_CACHE_SCHEMA = "research-support-cache-v1" as const;
export const SUPPORTED_RESEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
export const UNSUPPORTED_RESEARCH_CACHE_TTL_MS = 24 * 60 * 60_000;

export type ResearchSupportCode =
  | "supported"
  | "invalid_symbol"
  | "verification_unavailable"
  | "not_sec_listed"
  | "not_major_us_exchange"
  | "foreign_issuer"
  | "unsupported_security_type"
  | "insufficient_primary_filings"
  | "insufficient_market_data";

export interface ResearchSupportDecision {
  symbol: string;
  supported: boolean;
  code: ResearchSupportCode;
  message: string;
  checkedAt: number;
  policyVersion: typeof RESEARCH_SUPPORT_POLICY_VERSION;
  companyName?: string;
  cik?: string;
  exchange?: string;
}

interface ResearchSupportCacheRecord {
  schema: typeof RESEARCH_SUPPORT_CACHE_SCHEMA;
  decision: ResearchSupportDecision;
  expiresAt: number;
}

export interface ResearchSupportCache {
  get(symbol: string): Promise<unknown>;
  set(symbol: string, value: ResearchSupportCacheRecord): Promise<void>;
}

const useMemory = process.env.DESK_STORE === "memory";
const memoryCache = ((globalThis as Record<string, unknown>).__researchSupportCache ??=
  new Map<string, ResearchSupportCacheRecord>()) as Map<string, ResearchSupportCacheRecord>;
let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

const defaultCache: ResearchSupportCache = {
  async get(symbol) {
    if (useMemory) return memoryCache.get(symbol);
    return (await firestore().collection("research_support_cache").doc(symbol).get()).data();
  },
  async set(symbol, value) {
    if (useMemory) {
      memoryCache.set(symbol, structuredClone(value));
      return;
    }
    await firestore().collection("research_support_cache").doc(symbol).set(value);
  },
};

export function researchSupportCacheTtlMs(decision: ResearchSupportDecision): number {
  // Missing market data can be a provider outage rather than a durable
  // coverage decision. Never let that transient state suppress a supported
  // company for a full scheduled cycle.
  if (decision.code === "verification_unavailable" || decision.code === "insufficient_market_data") {
    return 0;
  }
  return decision.supported
    ? SUPPORTED_RESEARCH_CACHE_TTL_MS
    : UNSUPPORTED_RESEARCH_CACHE_TTL_MS;
}

export function cachedResearchSupportDecision(
  value: unknown,
  symbol: string,
  now = Date.now(),
): ResearchSupportDecision | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ResearchSupportCacheRecord>;
  const item = record.decision;
  const validCodes = new Set<ResearchSupportCode>([
    "supported", "invalid_symbol", "verification_unavailable", "not_sec_listed",
    "not_major_us_exchange", "foreign_issuer", "unsupported_security_type",
    "insufficient_primary_filings", "insufficient_market_data",
  ]);
  if (
    record.schema !== RESEARCH_SUPPORT_CACHE_SCHEMA ||
    !item ||
    item.symbol !== symbol.trim().toUpperCase() ||
    item.policyVersion !== RESEARCH_SUPPORT_POLICY_VERSION ||
    typeof item.supported !== "boolean" ||
    !validCodes.has(item.code) ||
    typeof item.message !== "string" ||
    !Number.isFinite(item.checkedAt) ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt! <= now ||
    researchSupportCacheTtlMs(item) === 0
  ) return null;
  return item;
}

export interface ResearchSupportInputs {
  symbol: string;
  identity: SecCompanyIdentityResult;
  snapshot: TickerSnapshot | null;
  tiingo: TiingoDailyMetadata | null;
  fundamentals: Fundamentals | null;
  checkedAt?: number;
}

const US_JURISDICTIONS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU",
]);
const MAJOR_US_EXCHANGES = new Set(["Nasdaq", "NYSE", "NYSE American"]);
const ONGOING_FINANCIAL_FORMS = new Set(["10-K", "10-Q"]);
const US_IPO_FINANCIAL_FORMS = new Set(["S-1", "S-1/A", "424B4"]);
const FUND_SICS = new Set(["6722", "6726", "6732", "6770"]);

function decision(
  input: ResearchSupportInputs,
  code: ResearchSupportCode,
  message: string,
): ResearchSupportDecision {
  const identity = input.identity.identity;
  return {
    symbol: input.symbol.toUpperCase().trim(),
    supported: code === "supported",
    code,
    message,
    checkedAt: input.checkedAt ?? Date.now(),
    policyVersion: RESEARCH_SUPPORT_POLICY_VERSION,
    ...(identity?.name ? { companyName: identity.name } : {}),
    ...(identity?.cik ? { cik: identity.cik } : {}),
    ...(identity?.exchange ? { exchange: identity.exchange } : {}),
  };
}

export function classifyResearchSupport(input: ResearchSupportInputs): ResearchSupportDecision {
  const symbol = input.symbol.toUpperCase().trim();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(symbol)) {
    return decision(input, "invalid_symbol", "Choose a valid US stock ticker.");
  }
  if (!input.identity.ok) {
    return decision(
      input,
      "verification_unavailable",
      "We could not verify this stock just now. Nothing was added — please try again shortly.",
    );
  }
  const identity = input.identity.identity;
  if (!identity) {
    return decision(
      input,
      "not_sec_listed",
      "AMM currently follows verified US public companies. This ticker is outside that coverage, so we will not add it and give you thinner research.",
    );
  }
  if (!MAJOR_US_EXCHANGES.has(identity.exchange)) {
    return decision(
      input,
      "not_major_us_exchange",
      `${identity.name} is outside AMM's Nasdaq, NYSE and NYSE American coverage. We keep the universe focused so every thesis uses the same dependable evidence stack.`,
    );
  }
  if (FUND_SICS.has(identity.sic) || /\bETF\b|EXCHANGE[ -]TRADED|\bFUND\b/i.test(identity.name)) {
    return decision(
      input,
      "unsupported_security_type",
      `${identity.name} is a fund rather than an operating-company stock. AMM is deliberately focused on company research today.`,
    );
  }
  // SEC jurisdiction metadata is occasionally blank even for established US
  // issuers (PLTR is a current example). Treat an extractable XBRL record or a
  // domestic 10-K/10-Q as the capability test. Registration statements admit
  // brand-new IPOs only when the SEC identity is explicitly US-incorporated;
  // otherwise a foreign ADR's 424B4 would look deceptively equivalent.
  const isExplicitlyDomestic = US_JURISDICTIONS.has(identity.stateOfIncorporation);
  const hasOngoingRecord = Boolean(input.fundamentals) ||
    identity.recentForms.some((form) => ONGOING_FINANCIAL_FORMS.has(form));
  const hasDomesticIpoRecord = isExplicitlyDomestic &&
    identity.recentForms.some((form) => US_IPO_FINANCIAL_FORMS.has(form));
  const hasSupportedFinancialRecord = hasOngoingRecord || hasDomesticIpoRecord;
  if (!isExplicitlyDomestic && !hasOngoingRecord) {
    return decision(
      input,
      "foreign_issuer",
      `${identity.name} trades in the US, but it reports as a foreign issuer. AMM currently focuses on US companies so every thesis can use complete, comparable SEC filings and market data.`,
    );
  }
  if (!hasSupportedFinancialRecord) {
    return decision(
      input,
      "insufficient_primary_filings",
      `AMM does not yet have the complete primary filing record needed to research ${identity.name} to our standard. We will add it only when that coverage is dependable.`,
    );
  }
  if (!input.snapshot || !input.tiingo || input.tiingo.ticker !== symbol) {
    return decision(
      input,
      "insufficient_market_data",
      `AMM does not yet have dependable two-source US market data for ${identity.name}. We will add it only when we can track the thesis properly.`,
    );
  }
  return decision(
    input,
    "supported",
    `${identity.name} is fully supported by AMM's US filing and market-data stack.`,
  );
}

export interface ResearchSupportDependencies {
  getIdentity: typeof getSecCompanyIdentityResult;
  getSnapshot: typeof getTickerSnapshot;
  getTiingoMetadata: typeof getTiingoDailyMetadata;
  getFundamentals: typeof getFundamentals;
}

const defaultDependencies: ResearchSupportDependencies = {
  getIdentity: getSecCompanyIdentityResult,
  getSnapshot: getTickerSnapshot,
  getTiingoMetadata: getTiingoDailyMetadata,
  getFundamentals,
};

export async function assessResearchSupport(
  symbol: string,
  dependencies: ResearchSupportDependencies = defaultDependencies,
): Promise<ResearchSupportDecision> {
  const normalized = symbol.toUpperCase().trim();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(normalized)) {
    return classifyResearchSupport({
      symbol: normalized,
      identity: { identity: null, ok: true },
      snapshot: null,
      tiingo: null,
      fundamentals: null,
    });
  }
  const [identity, snapshot, tiingo, fundamentals] = await Promise.all([
    dependencies.getIdentity(normalized),
    dependencies.getSnapshot(normalized),
    dependencies.getTiingoMetadata(normalized),
    dependencies.getFundamentals(normalized),
  ]);
  return classifyResearchSupport({ symbol: normalized, identity, snapshot, tiingo, fundamentals });
}

export async function assessResearchSupportCached(
  symbol: string,
  dependencies: ResearchSupportDependencies = defaultDependencies,
  cache: ResearchSupportCache = defaultCache,
  now = Date.now(),
): Promise<ResearchSupportDecision> {
  const normalized = symbol.toUpperCase().trim();
  try {
    const cached = cachedResearchSupportDecision(await cache.get(normalized), normalized, now);
    if (cached) return cached;
  } catch (error) {
    console.warn(`[research-support] ${normalized}: cache read failed; verifying live`, error);
  }

  const result = await assessResearchSupport(normalized, dependencies);
  const ttlMs = researchSupportCacheTtlMs(result);
  if (ttlMs > 0) {
    try {
      await cache.set(normalized, {
        schema: RESEARCH_SUPPORT_CACHE_SCHEMA,
        decision: result,
        expiresAt: now + ttlMs,
      });
    } catch (error) {
      console.warn(`[research-support] ${normalized}: cache write failed`, error);
    }
  }
  return result;
}

export async function partitionResearchSupportedTickers(tickers: string[]): Promise<{
  supported: string[];
  excluded: ResearchSupportDecision[];
}> {
  const normalized = [...new Set(tickers.map((ticker) => ticker.toUpperCase().trim()).filter(Boolean))];
  const decisions = await Promise.all(normalized.map((ticker) => assessResearchSupportCached(ticker)));
  return {
    supported: decisions.filter((item) => item.supported).map((item) => item.symbol),
    excluded: decisions.filter((item) => !item.supported),
  };
}
