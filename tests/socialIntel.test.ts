import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clusterSocialNarratives,
  dedupeSocialPosts,
  highValueSocialPosts,
  socialNarrativeKey,
  selectRecentSocialPosts,
  type XPost,
} from "../src/lib/socialIntel";
import { tickerQuery } from "../src/lib/socialWatchlist";

function post(overrides: Partial<XPost> = {}): XPost {
  const createdAtMs = Date.UTC(2026, 6, 21, 12);
  return {
    id: "100",
    url: "https://x.com/i/status/100",
    text: "Microsoft demand commentary is drawing attention.",
    author: "analyst",
    authorFollowers: 10_000,
    authorVerified: false,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    publishedDate: "2026-07-21",
    likes: 3,
    reposts: 1,
    replies: 0,
    quotes: 0,
    impressions: 100,
    engagement: 5,
    authority: 0.1,
    cashtags: ["MSFT"],
    urls: [],
    tickers: ["MSFT"],
    isReply: false,
    isQuote: false,
    bucket: "ticker:MSFT",
    pulledAt: createdAtMs + 60_000,
    collectedDate: "2026-07-21",
    ...overrides,
  };
}

test("social intake query binds both cashtag and ticker with noise exclusions", () => {
  assert.equal(
    tickerQuery("msft"),
    "($MSFT OR MSFT) (stock OR earnings OR shares) -is:retweet -is:reply lang:en",
  );
  assert.equal(tickerQuery("not valid"), '"__invalid_amm_ticker__"');
});

test("duplicate query matches keep one source while preserving ticker and link provenance", () => {
  const merged = dedupeSocialPosts([
    post({ tickers: ["MSFT"], urls: ["https://example.com/a"] }),
    post({ bucket: "brand", tickers: ["MSFT", "NVDA"], urls: ["https://example.com/b"] }),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].tickers, ["MSFT", "NVDA"]);
  assert.deepEqual(merged[0].urls, ["https://example.com/a", "https://example.com/b"]);
});

test("raw chatter is retained separately while only useful records enter synthesis", () => {
  const lowValue = post({ id: "low", url: "https://x.com/i/status/101", authorFollowers: 12, engagement: 0 });
  const linked = post({ id: "linked", url: "https://x.com/i/status/102", authorFollowers: 12, engagement: 0, urls: ["https://sec.gov/filing"] });
  const admitted = highValueSocialPosts([lowValue, linked]);
  assert.deepEqual(admitted.map((item) => item.id), ["linked"]);
});

test("dossier selection uses publication time, company binding and quality instead of a fixed count", () => {
  const now = Date.UTC(2026, 6, 22, 0);
  const recent = Array.from({ length: 12 }, (_, index) => post({
    id: String(200 + index),
    url: `https://x.com/i/status/${200 + index}`,
    createdAtMs: now - index * 60_000,
    createdAt: new Date(now - index * 60_000).toISOString(),
  }));
  const stale = post({ id: "stale", createdAtMs: now - 40 * 3_600_000, createdAt: new Date(now - 40 * 3_600_000).toISOString() });
  const other = post({ id: "other", tickers: ["AAPL"] });
  const selected = selectRecentSocialPosts([...recent, stale, other], "MSFT", now);
  assert.equal(selected.length, 12);
  assert.equal(selected.some((item) => item.id === "stale"), false);
  assert.equal(selected.some((item) => item.id === "other"), false);
});

test("social intake cannot create a parallel digest or email channel", () => {
  const source = readFileSync("src/lib/socialIntel.ts", "utf8");
  assert.doesNotMatch(source, /resend\.com\/emails/);
  assert.doesNotMatch(source, /SOCIAL_NOTE_(?:MODEL|TO)/);
  assert.doesNotMatch(source, /social_intel_digests/);
  assert.doesNotMatch(source, /subject:\s*`Social Note/);
  assert.match(source, /getRecentSocialPosts/);
});

test("social narratives collapse repeated wording without imposing a fixed intake cap", () => {
  const repeated = Array.from({ length: 12 }, (_, index) => post({
    id: String(300 + index),
    url: `https://x.com/i/status/${300 + index}`,
    author: `analyst${index}`,
    text: index % 2 === 0
      ? "$MSFT demand commentary is drawing attention https://example.com/story"
      : "MSFT demand commentary is drawing attention @someone",
    engagement: index,
  }));
  const distinct = post({
    id: "400",
    url: "https://x.com/i/status/400",
    text: "Microsoft disclosed a separate security product launch.",
  });
  const clusters = clusterSocialNarratives([...repeated, distinct]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters.find((cluster) => cluster.posts.length === 12)?.representative.id, "311");
  assert.equal(socialNarrativeKey(repeated[0].text), socialNarrativeKey(repeated[1].text));
});
