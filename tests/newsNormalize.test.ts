import assert from "node:assert/strict";
import test from "node:test";
import {
  articleId,
  assessRelevance,
  canonicalizeUrl,
  normalizeTitle,
  rawPayloadHash,
  titleClusterId,
} from "../src/lib/newsNormalize";
import type { RawNewsCandidate } from "../src/lib/newsTypes";

function candidate(patch: Partial<RawNewsCandidate> = {}): RawNewsCandidate {
  return {
    provider: "sec",
    tier: "authoritative",
    title: "Apple files 8-K with updated guidance",
    url: "https://www.sec.gov/Archives/example?utm_source=test&ref=home",
    publishedAt: Date.now() - 60_000,
    publisher: "SEC",
    summary: "Apple Inc. updated its quarterly guidance.",
    symbols: ["AAPL"],
    sourceType: "primary",
    query: "AAPL",
    fetchedAt: Date.now(),
    raw: { accession: "123" },
    ...patch,
  };
}

test("canonical URLs discard tracking parameters and fragments", () => {
  assert.equal(
    canonicalizeUrl("https://WWW.Example.com/story/?b=2&utm_source=x&a=1#part"),
    "https://example.com/story?a=1&b=2",
  );
});

test("article IDs remain stable across tracking variants", () => {
  const first = candidate({ url: "https://example.com/a?utm_campaign=x" });
  const second = candidate({ url: "https://example.com/a?fbclid=y" });
  assert.equal(articleId(first), articleId(second));
});

test("syndicated title punctuation produces one cluster", () => {
  assert.equal(
    titleClusterId("Apple: files an 8-K — updated guidance"),
    titleClusterId("Updated guidance: Apple files 8 K"),
  );
});

test("primary ticker-linked evidence is accepted with explicit reasons", () => {
  const result = assessRelevance(candidate(), "AAPL", "Apple Inc.");
  assert.equal(result.accepted, true);
  assert.equal(result.material, true);
  assert.ok(result.score >= 90);
  assert.ok(result.reasons.includes("provider-symbol-match"));
  assert.ok(result.reasons.includes("primary-source"));
});

test("irrelevant broad-web results are rejected", () => {
  const result = assessRelevance(candidate({
    provider: "gdelt",
    tier: "discovery",
    title: "Regional weather changes expected tomorrow",
    summary: "A general forecast with no company reference.",
    symbols: [],
    sourceType: "publisher",
  }), "AAPL", "Apple Inc.");
  assert.equal(result.accepted, false);
});

test("non-web source URLs can never be admitted", () => {
  const result = assessRelevance(candidate({ url: "javascript:alert(1)" }), "AAPL", "Apple Inc.");
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("invalid-source-url"));
});

test("raw payload hashes ignore object key order", () => {
  assert.equal(rawPayloadHash({ a: 1, b: 2 }), rawPayloadHash({ b: 2, a: 1 }));
  assert.equal(normalizeTitle("The Apple, Inc. shares"), "apple");
});
