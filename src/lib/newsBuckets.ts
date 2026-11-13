import type { TraceableNewsArticle } from "./newsTypes";

export type NewsBucket =
  | "filings"
  | "company"
  | "news"
  | "regulatory"
  | "market"
  | "discovery"
  | "social";

type BucketInput = Pick<
  TraceableNewsArticle,
  "category" | "evidenceTier" | "provenance"
>;

/**
 * Assign a canonical Room bucket from retained provenance, not publisher text.
 * Discovery stays isolated even when its headline looks official; it can move
 * into an evidence bucket only after an authoritative/licensed observation
 * upgrades the canonical article.
 */
export function newsBucketFor(article: BucketInput): NewsBucket {
  if (article.evidenceTier === "discovery") return "discovery";
  if (article.provenance.some((source) => source.provider === "sec") || article.category === "filing") {
    return "filings";
  }
  if (article.category === "regulatory") return "regulatory";
  if (article.category === "market") return "market";
  if (
    article.evidenceTier === "authoritative" &&
    article.provenance.some((source) => source.provider === "rss" && source.sourceType === "primary")
  ) {
    return "company";
  }
  return "news";
}

export const NEWS_BUCKET_FILE_PREFIX: Record<NewsBucket, string> = {
  filings: "Filing",
  company: "Company",
  news: "News",
  regulatory: "Regulatory",
  market: "Market",
  discovery: "Discovery",
  social: "Social",
};
