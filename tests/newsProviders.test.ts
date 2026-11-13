import assert from "node:assert/strict";
import test from "node:test";
import { collectBenzinga, collectRegisteredFeeds, collectTiingo } from "../src/lib/newsProviders";

test("direct Benzinga maps updates to the benzinga upstream family", async () => {
  const originalFetch = globalThis.fetch;
  process.env.BENZINGA_API_KEY = "test-token";
  let requested = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify([{
      id: 42,
      author: "Benzinga Newsdesk",
      created: "Thu, 16 Jul 2026 12:00:00 -0400",
      updated: "Thu, 16 Jul 2026 12:05:00 -0400",
      title: "AAPL reports quarterly earnings",
      teaser: "A dated abstract.",
      url: "https://www.benzinga.com/news/26/07/42/aapl-results",
      stocks: [{ name: "AAPL" }],
      channels: [{ name: "News" }],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await collectBenzinga({ ticker: "AAPL" }, Date.parse("2026-07-16T15:00:00Z"));
    assert.equal(result.error, undefined);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sourceFamily, "benzinga");
    assert.equal(result.candidates[0].updatedAt, Date.parse("2026-07-16T16:05:00Z"));
    const url = new URL(requested);
    assert.equal(url.searchParams.get("updatedSince"), String(Date.parse("2026-07-16T15:00:00Z") / 1_000));
    assert.equal(url.searchParams.get("displayOutput"), "abstract");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.BENZINGA_API_KEY;
  }
});

test("Tiingo retains the original publisher family instead of claiming Tiingo as origin", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TIINGO_API_TOKEN = "test-token";
  let authorization = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify([{
      id: 7,
      title: "MSFT announces a new product",
      url: "https://reliable.example/msft-product",
      description: "Publisher description.",
      publishedDate: "2026-07-16T16:00:00Z",
      crawlDate: "2026-07-16T16:01:00Z",
      source: "reliable.example",
      tickers: ["MSFT"],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await collectTiingo({ ticker: "MSFT" }, Date.parse("2026-07-16T15:00:00Z"));
    assert.equal(result.error, undefined);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sourceFamily, "publisher:reliable.example");
    assert.equal(result.candidates[0].sourceType, "aggregator");
    assert.equal(authorization, "Token test-token");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TIINGO_API_TOKEN;
  }
});

test("registered sitemap sources fetch only changed official pages with hash-only page traceability", async () => {
  const originalFetch = globalThis.fetch;
  const sitemapUrl = "https://official.example/sitemap.xml";
  const pageUrl = "https://official.example/news/releases/new-contract/";
  const oldPageUrl = "https://official.example/news/releases/old-contract/";
  const fetched: string[] = [];
  const html = `<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Official &amp; Auditable Contract" />
    <meta property="og:description" content="The company signed a material contract." />
    <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"page":{"fields":{"publishDate":"2026-07-16"}}}}}</script>
  </head><body>Public page body that must not be retained.</body></html>`;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const requested = String(input);
    fetched.push(requested);
    if (requested === sitemapUrl) {
      return new Response(`<?xml version="1.0"?><urlset>
        <url><loc>${pageUrl}</loc><lastmod>2026-07-16T16:30:00Z</lastmod></url>
        <url><loc>${oldPageUrl}</loc><lastmod>2026-07-10T16:30:00Z</lastmod></url>
        <url><loc>https://untrusted.example/news/releases/wrong-host/</loc><lastmod>2026-07-16T16:30:00Z</lastmod></url>
      </urlset>`, { status: 200 });
    }
    assert.equal(new Headers(init?.headers).get("accept"), "text/html, application/xhtml+xml");
    return new Response(html, { status: 200 });
  }) as typeof fetch;
  try {
    const result = await collectRegisteredFeeds({
      ticker: "TEST",
      newsSources: [{
        id: "official-sitemap",
        name: "Official Newsroom",
        url: sitemapUrl,
        type: "sitemap",
        authority: "primary",
        pathPrefix: "/news/releases/",
        verifiedAt: Date.parse("2026-07-01T00:00:00Z"),
        verifiedBy: "auditor@example.com",
        verifiedHost: "official.example",
      }],
    }, Date.parse("2026-07-16T15:00:00Z"));
    assert.equal(result.error, undefined);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(fetched, [sitemapUrl, pageUrl]);
    const candidate = result.candidates[0];
    assert.equal(candidate.title, "Official & Auditable Contract");
    assert.equal(candidate.publishedAt, Date.parse("2026-07-16T00:00:00Z"));
    assert.equal(candidate.updatedAt, Date.parse("2026-07-16T16:30:00Z"));
    assert.equal(candidate.sourceType, "primary");
    assert.equal(candidate.sourceVerification?.sourceId, "official-sitemap");
    assert.match(candidate.rawSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(candidate.raw).includes("page body"), false);
    assert.equal((candidate.raw as { contentSha256: string }).contentSha256, candidate.rawSha256);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
