import { createHash } from "node:crypto";
import type {
  NewsCategory,
  NewsProvenance,
  RawNewsCandidate,
  RelevanceAssessment,
} from "./newsTypes";
import { NEWS_PIPELINE_VERSION } from "./newsTypes";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
]);

const STOP_WORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "is", "of", "on",
  "or", "the", "to", "with", "says", "stock", "shares", "company", "inc",
  "corp", "corporation", "limited", "ltd", "plc",
]);

const CATEGORY_RULES: Array<[NewsCategory, RegExp]> = [
  ["earnings", /\b(earnings|quarterly results|revenue|eps|profit|loss)\b/i],
  ["guidance", /\b(guidance|forecast|outlook|raises? expectations|cuts? expectations)\b/i],
  ["filing", /\b(10-[qk]|8-k|sec filing|annual report|quarterly report)\b/i],
  ["regulatory", /\b(regulator|regulatory|ftc|doj|sec |fda|approval|antitrust|probe)\b/i],
  ["m-and-a", /\b(acquire|acquisition|merger|takeover|buyout|strategic review)\b/i],
  ["capital", /\b(offering|buyback|repurchase|dividend|debt|financing|capital raise)\b/i],
  ["leadership", /\b(ceo|cfo|chairman|director|appoints?|resigns?|steps down)\b/i],
  ["product", /\b(launch|product|recall|contract|partnership|customer|order)\b/i],
  ["legal", /\b(lawsuit|court|settlement|patent|investigation|charges?)\b/i],
  ["analyst", /\b(upgrade|downgrade|price target|analyst|rating)\b/i],
  ["market", /\b(after.hours|premarket|trading|volume|market)\b/i],
];

const MATERIAL_CATEGORIES = new Set<NewsCategory>([
  "earnings", "guidance", "filing", "regulatory", "m-and-a", "capital", "leadership", "legal",
]);

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return input.trim();
  }
}

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .join(" ")
    .trim();
}

export function titleClusterId(title: string): string {
  const tokens = [...new Set(normalizeTitle(title).split(" ").filter(Boolean))].sort();
  return sha256(tokens.join(" ")).slice(0, 32);
}

export function sourceFamilyFor(candidate: RawNewsCandidate): string {
  if (candidate.sourceFamily?.trim()) return candidate.sourceFamily.trim().toLowerCase();
  if (candidate.provider === "alpaca" || candidate.provider === "benzinga") return "benzinga";
  if (candidate.provider === "polygon") return "massive";
  if (candidate.provider === "rss") {
    return candidate.sourceVerification?.sourceId
      ? `registered:${candidate.sourceVerification.sourceId.toLowerCase()}`
      : "registered-feed";
  }
  return candidate.provider;
}

export function sourceDocumentIdForUrl(url: string): string {
  return sha256(canonicalizeUrl(url)).slice(0, 40);
}

export function articleId(candidate: RawNewsCandidate): string {
  const canonical = canonicalizeUrl(candidate.url);
  if (canonical.startsWith("http")) return sourceDocumentIdForUrl(canonical);
  return sha256(`${candidate.provider}:${candidate.providerId ?? ""}:${normalizeTitle(candidate.title)}`).slice(0, 40);
}

export function newsEventId(candidate: RawNewsCandidate, ticker: string, category: NewsCategory): string {
  const day = new Date(candidate.publishedAt).toISOString().slice(0, 10);
  return sha256(`${ticker.toUpperCase()}:${day}:${category}:${titleClusterId(candidate.title)}`).slice(0, 40);
}

export function sourceObservationId(
  runId: string,
  ticker: string,
  candidate: RawNewsCandidate,
): string {
  const rawSha256 = candidate.rawSha256 ?? rawPayloadHash(candidate.raw);
  return sha256([
    runId,
    ticker.toUpperCase(),
    candidate.provider,
    candidate.providerId ?? canonicalizeUrl(candidate.url),
    candidate.operation ?? "upsert",
    rawSha256,
  ].join(":" )).slice(0, 48);
}

export function rawPayloadHash(raw: unknown): string {
  return sha256(stableJson(raw));
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function provenanceFor(candidate: RawNewsCandidate, observationId?: string): NewsProvenance {
  return {
    provider: candidate.provider,
    sourceFamily: sourceFamilyFor(candidate),
    tier: candidate.tier,
    ...(candidate.providerId ? { providerId: candidate.providerId } : {}),
    publisher: candidate.publisher,
    sourceType: candidate.sourceType,
    ...(candidate.sourceVerification ? { sourceVerification: candidate.sourceVerification } : {}),
    sourceUrl: candidate.url,
    query: candidate.query,
    fetchedAt: candidate.fetchedAt,
    ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
    operation: candidate.operation ?? "upsert",
    rawSha256: candidate.rawSha256 ?? rawPayloadHash(candidate.raw),
    ...(observationId ? { observationId } : {}),
    adapterVersion: NEWS_PIPELINE_VERSION,
  };
}

export function classify(text: string): NewsCategory {
  return CATEGORY_RULES.find(([, rule]) => rule.test(text))?.[0] ?? "other";
}

export function assessRelevance(
  candidate: RawNewsCandidate,
  ticker: string,
  companyName?: string,
  now = Date.now(),
): RelevanceAssessment {
  const sym = ticker.toUpperCase();
  const haystack = `${candidate.title} ${candidate.summary ?? ""}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  let safeSourceUrl = false;
  try {
    const url = new URL(candidate.url);
    safeSourceUrl = url.protocol === "https:" || url.protocol === "http:";
  } catch {
    safeSourceUrl = false;
  }
  if (!safeSourceUrl) reasons.push("invalid-source-url");

  if ((candidate.symbols ?? []).map((s) => s.toUpperCase()).includes(sym)) {
    score += 45;
    reasons.push("provider-symbol-match");
  }
  const tickerRule = new RegExp(`(^|[^a-z0-9])\\$?${sym.toLowerCase().replace(/[.-]/g, "\\$&")}([^a-z0-9]|$)`);
  if (tickerRule.test(haystack)) {
    score += 35;
    reasons.push("explicit-ticker-mention");
  }
  const companyTokens = (companyName ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
  const matched = companyTokens.filter((token) => haystack.includes(token));
  if (matched.length > 0) {
    score += Math.min(30, 12 + matched.length * 6);
    reasons.push(`company-name-match:${matched.slice(0, 3).join(",")}`);
  }
  if (candidate.sourceType === "primary") {
    score += 20;
    reasons.push("primary-source");
  }
  const category = classify(haystack);
  if (MATERIAL_CATEGORIES.has(category)) {
    score += 10;
    reasons.push(`material-category:${category}`);
  }
  const ageHours = Math.max(0, now - candidate.publishedAt) / 3_600_000;
  if (ageHours <= 24) score += 5;
  if (ageHours > 168) {
    score -= 25;
    reasons.push("older-than-seven-days");
  }
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    accepted: score >= 45 && safeSourceUrl,
    reasons,
    category,
    material: MATERIAL_CATEGORIES.has(category),
  };
}
