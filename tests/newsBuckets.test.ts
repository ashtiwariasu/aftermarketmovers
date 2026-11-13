import assert from "node:assert/strict";
import test from "node:test";
import { newsBucketFor } from "../src/lib/newsBuckets";
import type { NewsProvenance, TraceableNewsArticle } from "../src/lib/newsTypes";

function provenance(
  provider: NewsProvenance["provider"],
  sourceType: NewsProvenance["sourceType"],
): NewsProvenance {
  return {
    provider,
    sourceFamily: provider === "alpaca" || provider === "benzinga" ? "benzinga" : provider,
    tier: provider === "yahoo" ? "discovery" : provider === "polygon" ? "licensed" : "authoritative",
    publisher: "Source",
    sourceType,
    sourceUrl: "https://example.com/story",
    query: "TEST",
    fetchedAt: 1,
    operation: "upsert",
    rawSha256: "abc",
    adapterVersion: "test",
  };
}

function article(
  input: Partial<Pick<TraceableNewsArticle, "category" | "evidenceTier" | "provenance">>,
): Pick<TraceableNewsArticle, "category" | "evidenceTier" | "provenance"> {
  return {
    category: input.category ?? "other",
    evidenceTier: input.evidenceTier ?? "licensed",
    provenance: input.provenance ?? [provenance("polygon", "newswire")],
  };
}

test("Room buckets are derived from trust tier and provenance", () => {
  assert.equal(newsBucketFor(article({
    category: "regulatory",
    evidenceTier: "discovery",
    provenance: [provenance("yahoo", "aggregator")],
  })), "discovery");
  assert.equal(newsBucketFor(article({
    category: "other",
    evidenceTier: "authoritative",
    provenance: [provenance("sec", "primary")],
  })), "filings");
  assert.equal(newsBucketFor(article({
    category: "earnings",
    evidenceTier: "authoritative",
    provenance: [provenance("rss", "primary")],
  })), "company");
  assert.equal(newsBucketFor(article({ category: "regulatory" })), "regulatory");
  assert.equal(newsBucketFor(article({ category: "market" })), "market");
  assert.equal(newsBucketFor(article({})), "news");
});
