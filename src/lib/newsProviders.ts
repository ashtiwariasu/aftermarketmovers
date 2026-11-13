import { getFilingsResult } from "./sec";
import { sha256 } from "./newsNormalize";
import type { NewsProvider, NewsSourceTier, ProviderResult, RawNewsCandidate } from "./newsTypes";
import { XMLParser } from "fast-xml-parser";

const USER_AGENT = process.env.CONTACT_USER_AGENT || "AMM-self-hosted (set CONTACT_USER_AGENT)";

export interface CompanyTarget {
  ticker: string;
  name?: string;
  newsSources?: Array<{
    id: string;
    name: string;
    url: string;
    type: "rss" | "atom" | "sitemap";
    authority: "primary" | "publisher";
    pathPrefix?: string;
    enabled?: boolean;
    verifiedAt: number;
    verifiedBy: string;
    verifiedHost: string;
  }>;
}

interface FetchOptions {
  timeoutMs?: number;
  attempts?: number;
  rateKey?: string;
  minIntervalMs?: number;
  headers?: HeadersInit;
  redirect?: RequestRedirect;
}

const rateChains = new Map<string, Promise<void>>();
const lastRequestAt = new Map<string, number>();

async function waitForRateSlot(key?: string, minIntervalMs = 0): Promise<void> {
  if (!key || minIntervalMs <= 0) return;
  const previous = rateChains.get(key) ?? Promise.resolve();
  const slot = previous.catch(() => {}).then(async () => {
    const waitMs = Math.max(0, (lastRequestAt.get(key) ?? 0) + minIntervalMs - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt.set(key, Date.now());
  });
  rateChains.set(key, slot);
  await slot;
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(1_000, seconds * 1_000));
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(30_000, Math.max(1_000, at - Date.now()));
  }
  return Math.min(12_000, 750 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
}

async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response | null = null;
    try {
      await waitForRateSlot(options.rateKey, options.minIntervalMs);
      const headers = new Headers(options.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
      if (!headers.has("Accept")) headers.set("Accept", "application/json");
      response = await fetch(url, {
        headers,
        cache: "no-store",
        redirect: options.redirect,
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
      });
      if (response.ok) {
        const body = await response.text();
        try {
          return JSON.parse(body) as T;
        } catch {
          lastError = /limit requests|rate limit/i.test(body)
            ? new Error("upstream rate limited the request")
            : new Error(`upstream returned invalid JSON: ${body.slice(0, 120).replace(/\s+/g, " ")}`);
          throw lastError;
        }
      }
      if (response.status < 500 && response.status !== 429) {
        lastError = new Error(`HTTP ${response.status}`);
        break;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response | null = null;
    try {
      await waitForRateSlot(options.rateKey, options.minIntervalMs);
      const headers = new Headers(options.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml");
      }
      response = await fetch(url, {
        headers,
        cache: "no-store",
        redirect: options.redirect,
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
      });
      if (response.ok) return await response.text();
      if (response.status < 500 && response.status !== 429) {
        lastError = new Error(`HTTP ${response.status}`);
        break;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}

function originalSourceFamily(url: string, fallback: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "benzinga.com" || host.endsWith(".benzinga.com")) return "benzinga";
    if (host === "sec.gov" || host.endsWith(".sec.gov")) return "sec";
    return `publisher:${host}`;
  } catch {
    return `publisher:${fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }
}

async function timed(
  provider: NewsProvider,
  tier: NewsSourceTier,
  work: () => Promise<RawNewsCandidate[]>,
): Promise<ProviderResult> {
  const started = Date.now();
  try {
    return { provider, tier, active: true, candidates: await work(), durationMs: Date.now() - started };
  } catch (error) {
    return { provider, tier, active: true, candidates: [], durationMs: Date.now() - started, error: cleanError(error) };
  }
}

interface YahooNewsRow {
  uuid?: string;
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: number;
  summary?: string;
  relatedTickers?: string[];
}

export async function collectYahoo(target: CompanyTarget): Promise<ProviderResult> {
  return timed("yahoo", "discovery", async () => {
    const fetchedAt = Date.now();
    const query = target.ticker.toUpperCase();
    const url =
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}` +
      `&quotesCount=0&newsCount=40&enableFuzzyQuery=false`;
    const json = await fetchJson<{ news?: YahooNewsRow[] }>(url, {
      rateKey: "yahoo-news",
      minIntervalMs: 1_000,
    });
    return (json.news ?? []).flatMap((row): RawNewsCandidate[] => {
      if (!row.title || !row.link || !row.providerPublishTime) return [];
      return [{
        provider: "yahoo",
        sourceFamily: originalSourceFamily(row.link, row.publisher ?? "yahoo"),
        tier: "discovery",
        ...(row.uuid ? { providerId: row.uuid } : {}),
        title: row.title,
        url: row.link,
        publishedAt: row.providerPublishTime * 1000,
        publisher: row.publisher ?? "Yahoo Finance feed",
        ...(row.summary ? { summary: row.summary } : {}),
        symbols: row.relatedTickers ?? [],
        sourceType: "aggregator",
        query,
        fetchedAt,
        raw: row,
      }];
    });
  });
}

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
}

function gdeltDate(value?: string): number {
  if (!value) return 0;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return Date.parse(value) || 0;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
}

export async function collectGdelt(target: CompanyTarget, hours = 2): Promise<ProviderResult> {
  return timed("gdelt", "discovery", async () => {
    const fetchedAt = Date.now();
    const companyTerm = target.name?.replace(/\b(inc|corp|corporation|plc|ltd)\.?\b/gi, "").trim();
    const query = companyTerm
      ? `("${companyTerm}" OR "${target.ticker}") sourcelang:english`
      : `"${target.ticker}" sourcelang:english`;
    const url =
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
      `&mode=ArtList&maxrecords=100&format=json&sort=DateDesc&timespan=${Math.max(1, hours)}h`;
    const json = await fetchJson<{ articles?: GdeltArticle[] }>(url, {
      timeoutMs: 20_000,
      rateKey: "gdelt-doc",
      // GDELT's public endpoint explicitly asks high-traffic users to remain
      // below one request per five seconds.
      minIntervalMs: 5_500,
    });
    return (json.articles ?? []).flatMap((row): RawNewsCandidate[] => {
      const publishedAt = gdeltDate(row.seendate);
      if (!row.title || !row.url || !publishedAt) return [];
      return [{
        provider: "gdelt",
        sourceFamily: originalSourceFamily(row.url, row.domain ?? "gdelt"),
        tier: "discovery",
        title: row.title,
        url: row.url,
        publishedAt,
        publisher: row.domain ?? "GDELT source",
        symbols: [],
        sourceType: "publisher",
        query,
        fetchedAt,
        raw: row,
      }];
    });
  });
}

interface PolygonNewsRow {
  id?: string;
  title?: string;
  article_url?: string;
  published_utc?: string;
  author?: string;
  description?: string;
  tickers?: string[];
  publisher?: { name?: string; homepage_url?: string };
}

export async function collectPolygon(target: CompanyTarget, sinceMs: number): Promise<ProviderResult> {
  return timed("polygon", "licensed", async () => {
    const apiKey = process.env.MASSIVE_API_KEY ?? process.env.POLYGON_API_KEY;
    if (!apiKey) throw new Error("MASSIVE_API_KEY/POLYGON_API_KEY not configured");
    const configuredInterval = Number(process.env.MASSIVE_REQUEST_INTERVAL_MS ?? "12500");
    const requestIntervalMs = Number.isFinite(configuredInterval)
      ? Math.max(250, configuredInterval)
      : 12_500;
    const fetchedAt = Date.now();
    const query = target.ticker.toUpperCase();
    const since = new Date(sinceMs).toISOString();
    const url =
      `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(query)}` +
      `&published_utc.gte=${encodeURIComponent(since)}&order=desc&sort=published_utc&limit=100` +
      `&apiKey=${encodeURIComponent(apiKey)}`;
    const rows: PolygonNewsRow[] = [];
    let nextUrl: string | undefined = url;
    for (let page = 0; page < 3 && nextUrl; page++) {
      const json: { results?: PolygonNewsRow[]; next_url?: string } = await fetchJson(nextUrl, {
        attempts: 4,
        rateKey: "polygon-news",
        // Massive's starter plan permits five requests per minute. The shared
        // rate chain serializes all ticker and pagination calls across a run.
        minIntervalMs: requestIntervalMs,
      });
      rows.push(...(json.results ?? []));
      if (!json.next_url) break;
      const next = new URL(json.next_url);
      if (!next.searchParams.has("apiKey")) next.searchParams.set("apiKey", apiKey);
      nextUrl = next.toString();
    }
    return rows.flatMap((row): RawNewsCandidate[] => {
      const publishedAt = Date.parse(row.published_utc ?? "");
      if (!row.title || !row.article_url || !publishedAt) return [];
      return [{
        provider: "polygon",
        sourceFamily: originalSourceFamily(
          row.article_url,
          row.publisher?.name ?? row.author ?? "massive",
        ),
        tier: "licensed",
        ...(row.id ? { providerId: row.id } : {}),
        title: row.title,
        url: row.article_url,
        publishedAt,
        publisher: row.publisher?.name ?? row.author ?? "Polygon news source",
        ...(row.description ? { summary: row.description } : {}),
        symbols: row.tickers ?? [],
        sourceType: "newswire",
        query,
        fetchedAt,
        raw: row,
      }];
    });
  });
}

interface AlpacaNewsRow {
  id?: number | string;
  headline?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  author?: string;
  summary?: string;
  symbols?: string[];
  source?: string;
}

export async function collectAlpaca(target: CompanyTarget, sinceMs: number): Promise<ProviderResult> {
  return timed("alpaca", "licensed", async () => {
    const key = process.env.APCA_API_KEY_ID;
    const secret = process.env.APCA_API_SECRET_KEY;
    if (!key || !secret) throw new Error("Alpaca news credentials not configured");
    const fetchedAt = Date.now();
    const query = target.ticker.toUpperCase();
    const url =
      `https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(query)}` +
      `&start=${encodeURIComponent(new Date(sinceMs).toISOString())}&sort=desc&limit=50`;
    const rows: AlpacaNewsRow[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page++) {
      const pageUrl = new URL(url);
      if (pageToken) pageUrl.searchParams.set("page_token", pageToken);
      const json: { news?: AlpacaNewsRow[]; next_page_token?: string } = await fetchJson(
        pageUrl.toString(),
        {
          headers: {
            "APCA-API-KEY-ID": key,
            "APCA-API-SECRET-KEY": secret,
          },
          rateKey: "alpaca-news",
          minIntervalMs: 250,
        },
      );
      rows.push(...(json.news ?? []));
      pageToken = json.next_page_token;
      if (!pageToken) break;
    }
    return rows.flatMap((row): RawNewsCandidate[] => {
      const publishedAt = Date.parse(row.created_at ?? "");
      if (!row.headline || !row.url || !publishedAt) return [];
      return [{
        provider: "alpaca",
        sourceFamily: "benzinga",
        tier: "licensed",
        ...(row.id != null ? { providerId: String(row.id) } : {}),
        title: row.headline,
        url: row.url,
        publishedAt,
        ...(row.updated_at && Date.parse(row.updated_at) ? { updatedAt: Date.parse(row.updated_at) } : {}),
        publisher: row.source ?? row.author ?? "Alpaca/Benzinga news",
        ...(row.summary ? { summary: row.summary } : {}),
        symbols: row.symbols ?? [],
        sourceType: "newswire",
        query,
        fetchedAt,
        raw: row,
      }];
    });
  });
}

interface BenzingaNewsRow {
  id?: number | string;
  author?: string;
  created?: string;
  updated?: string;
  title?: string;
  teaser?: string;
  url?: string;
  stocks?: Array<{ name?: string }>;
  channels?: Array<{ name?: string }>;
}

export async function collectBenzinga(target: CompanyTarget, sinceMs: number): Promise<ProviderResult> {
  return timed("benzinga", "licensed", async () => {
    const token = process.env.BENZINGA_API_KEY;
    if (!token) throw new Error("BENZINGA_API_KEY not configured");
    const fetchedAt = Date.now();
    const query = target.ticker.toUpperCase();
    const rows: BenzingaNewsRow[] = [];
    for (let page = 0; page < 3; page++) {
      const url = new URL("https://api.benzinga.com/api/v2/news");
      url.searchParams.set("token", token);
      url.searchParams.set("tickers", query);
      url.searchParams.set("updatedSince", String(Math.floor(sinceMs / 1_000)));
      url.searchParams.set("sort", "updated:desc");
      url.searchParams.set("displayOutput", "abstract");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("page", String(page));
      const pageRows = await fetchJson<BenzingaNewsRow[]>(url.toString(), {
        headers: { Accept: "application/json" },
        rateKey: "benzinga-news",
        minIntervalMs: 250,
      });
      rows.push(...pageRows);
      if (pageRows.length < 100) break;
    }
    return rows.flatMap((row): RawNewsCandidate[] => {
      const publishedAt = Date.parse(row.created ?? "");
      const updatedAt = Date.parse(row.updated ?? "");
      if (!row.title || !row.url || !publishedAt) return [];
      return [{
        provider: "benzinga",
        sourceFamily: "benzinga",
        tier: "licensed",
        ...(row.id != null ? { providerId: String(row.id) } : {}),
        title: row.title,
        url: row.url,
        publishedAt,
        ...(updatedAt ? { updatedAt } : {}),
        publisher: row.author ?? "Benzinga Newsdesk",
        ...(plainText(row.teaser) ? { summary: plainText(row.teaser) } : {}),
        symbols: (row.stocks ?? []).flatMap((stock) => stock.name ? [stock.name] : []),
        sourceType: row.channels?.some((channel) => channel.name === "Press Releases")
          ? "newswire"
          : "publisher",
        query,
        fetchedAt,
        raw: row,
      }];
    });
  });
}

interface TiingoNewsRow {
  id?: number | string;
  title?: string;
  url?: string;
  description?: string;
  publishedDate?: string;
  crawlDate?: string;
  source?: string;
  tickers?: string[];
  tags?: string[];
}

export async function collectTiingo(target: CompanyTarget, sinceMs: number): Promise<ProviderResult> {
  return timed("tiingo", "licensed", async () => {
    const token = process.env.TIINGO_API_TOKEN;
    if (!token) throw new Error("TIINGO_API_TOKEN not configured");
    const fetchedAt = Date.now();
    const query = target.ticker.toUpperCase();
    const startDate = new Date(sinceMs).toISOString().slice(0, 10);
    const url = new URL("https://api.tiingo.com/tiingo/news");
    url.searchParams.set("tickers", query.replaceAll(".", "-"));
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("sortBy", "crawlDate");
    url.searchParams.set("limit", "100");
    const rows = await fetchJson<TiingoNewsRow[]>(url.toString(), {
      headers: { Authorization: `Token ${token}` },
      rateKey: "tiingo-news",
      minIntervalMs: 250,
    });
    return rows.flatMap((row): RawNewsCandidate[] => {
      const publishedAt = Date.parse(row.publishedDate ?? "");
      const updatedAt = Date.parse(row.crawlDate ?? "");
      if (!row.title || !row.url || !publishedAt || Math.max(publishedAt, updatedAt || 0) < sinceMs) {
        return [];
      }
      return [{
        provider: "tiingo",
        sourceFamily: originalSourceFamily(row.url, row.source ?? "tiingo"),
        tier: "licensed",
        ...(row.id != null ? { providerId: String(row.id) } : {}),
        title: row.title,
        url: row.url,
        publishedAt,
        ...(updatedAt ? { updatedAt } : {}),
        publisher: row.source ?? "Tiingo source",
        ...(row.description ? { summary: row.description } : {}),
        symbols: row.tickers ?? [],
        sourceType: "aggregator",
        query,
        fetchedAt,
        raw: row,
      }];
    });
  });
}

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function plainText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return clean || undefined;
}

function atomLink(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  for (const link of arrayOf(value as Record<string, unknown> | Array<Record<string, unknown>>)) {
    if (typeof link?.["@_href"] === "string" && (!link["@_rel"] || link["@_rel"] === "alternate")) {
      return String(link["@_href"]);
    }
  }
  return undefined;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
    const decodeCodePoint = (code: number) => Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
    if (token.startsWith("#x") || token.startsWith("#X")) {
      return decodeCodePoint(Number.parseInt(token.slice(2), 16));
    }
    if (token.startsWith("#")) {
      return decodeCodePoint(Number.parseInt(token.slice(1), 10));
    }
    return named[token.toLowerCase()] ?? entity;
  });
}

function htmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[3]).replace(/\s+/g, " ").trim();
  }
  return attributes;
}

function metaContent(html: string, key: string): string | undefined {
  const wanted = key.toLowerCase();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = htmlAttributes(match[0]);
    if ((attributes.property ?? attributes.name)?.toLowerCase() === wanted && attributes.content) {
      return attributes.content;
    }
  }
  return undefined;
}

function firstValidDate(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const parsed = typeof value === "number" ? value : Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

interface OfficialPageMetadata {
  title: string;
  summary?: string;
  publishedAt?: number;
  modifiedAt?: number;
}

function officialPageMetadata(html: string, url: string): OfficialPageMetadata {
  let nextFields: Record<string, unknown> | undefined;
  const nextData = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData) as {
        props?: { pageProps?: { page?: { fields?: Record<string, unknown>; sys?: Record<string, unknown> } } };
      };
      nextFields = parsed.props?.pageProps?.page?.fields;
    } catch {
      // Generic metadata below remains sufficient when a framework payload changes.
    }
  }
  const seoFields = (nextFields?.seo as { fields?: Record<string, unknown> } | undefined)?.fields;
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "Official update";
  const title = plainText(
    metaContent(html, "og:title") ?? nextFields?.title ?? seoFields?.title ?? titleTag,
  ) ?? slug.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const summary = plainText(
    metaContent(html, "og:description") ?? metaContent(html, "description") ??
      nextFields?.description ?? seoFields?.seoDescription,
  );
  const publishedAt = firstValidDate(
    metaContent(html, "article:published_time"),
    metaContent(html, "datePublished"),
    nextFields?.publishDate,
    nextFields?.publishedAt,
  );
  const modifiedAt = firstValidDate(
    metaContent(html, "article:modified_time"),
    metaContent(html, "dateModified"),
    nextFields?.updatedAt,
  );
  return { title: decodeHtml(title), ...(summary ? { summary: decodeHtml(summary) } : {}), publishedAt, modifiedAt };
}

interface RegisteredSourceCollection {
  candidates: RawNewsCandidate[];
  failures: string[];
}

async function collectRegisteredSitemap(
  target: CompanyTarget,
  source: NonNullable<CompanyTarget["newsSources"]>[number],
  parsed: Record<string, unknown>,
  sinceMs: number,
  fetchedAt: number,
): Promise<RegisteredSourceCollection> {
  if (!source.pathPrefix?.startsWith("/")) {
    return { candidates: [], failures: [`${source.id}: sitemap registration has no valid path prefix`] };
  }
  const rows = arrayOf((parsed.urlset as { url?: unknown } | undefined)?.url)
    .flatMap((unknownRow) => {
      const row = unknownRow as Record<string, unknown>;
      const lastModifiedAt = Date.parse(String(row.lastmod ?? ""));
      if (!Number.isFinite(lastModifiedAt) || lastModifiedAt < sinceMs) return [];
      try {
        const url = new URL(String(row.loc ?? ""));
        const directory = source.pathPrefix!.replace(/\/+$/, "");
        if (url.protocol !== "https:" || url.hostname !== source.verifiedHost ||
            !url.pathname.startsWith(source.pathPrefix!) || url.pathname.replace(/\/+$/, "") === directory) {
          return [];
        }
        return [{ url: url.toString(), lastModifiedAt }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.lastModifiedAt - a.lastModifiedAt)
    .slice(0, 200);

  const settled = await Promise.allSettled(rows.map(async ({ url, lastModifiedAt }) => {
    const html = await fetchText(url, {
      timeoutMs: 15_000,
      attempts: 2,
      rateKey: `registered-page:${source.verifiedHost}`,
      minIntervalMs: 200,
      headers: { Accept: "text/html, application/xhtml+xml" },
      redirect: "error",
    });
    const metadata = officialPageMetadata(html, url);
    const contentSha256 = sha256(html);
    return {
      provider: "rss",
      tier: "authoritative",
      providerId: url,
      title: metadata.title,
      url,
      publishedAt: metadata.publishedAt ?? lastModifiedAt,
      publisher: source.name,
      ...(metadata.summary ? { summary: metadata.summary } : {}),
      symbols: [target.ticker.toUpperCase()],
      sourceType: source.authority === "primary" ? "primary" : "publisher",
      sourceVerification: {
        sourceId: source.id,
        verifiedAt: source.verifiedAt,
        verifiedBy: source.verifiedBy,
        verifiedHost: source.verifiedHost,
      },
      query: source.url,
      fetchedAt,
      updatedAt: Math.max(lastModifiedAt, metadata.modifiedAt ?? 0),
      raw: {
        title: metadata.title,
        ...(metadata.summary ? { summary: metadata.summary } : {}),
        ...(metadata.publishedAt ? { publishedAt: metadata.publishedAt } : {}),
        lastModifiedAt,
        contentSha256,
      },
      rawSha256: contentSha256,
    } satisfies RawNewsCandidate;
  }));
  const candidates: RawNewsCandidate[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") candidates.push(result.value);
    else failures.push(`${source.id}/${rows[index].url}: ${cleanError(result.reason)}`);
  });
  return { candidates, failures };
}

export async function collectRegisteredFeeds(target: CompanyTarget, sinceMs = 0): Promise<ProviderResult> {
  const started = Date.now();
  try {
    const configured = (target.newsSources ?? []).filter((source) => source.enabled !== false);
    const sources = configured.filter(
      (source) => source.verifiedAt > 0 && Boolean(source.verifiedBy) &&
        new URL(source.url).hostname === source.verifiedHost,
    );
    const unverified = configured.filter((source) => !sources.includes(source));
    if (configured.length === 0) {
      return {
        provider: "rss",
        tier: "authoritative",
        active: false,
        candidates: [],
        durationMs: Date.now() - started,
      };
    }
    if (sources.length === 0) {
      return {
        provider: "rss",
        tier: "authoritative",
        active: true,
        candidates: [],
        durationMs: Date.now() - started,
        error: `no verified registered feeds (${unverified.map((source) => source.id).join(", ")})`,
      };
    }
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const fetchedAt = Date.now();
    const settled = await Promise.allSettled(sources.map(async (source): Promise<RegisteredSourceCollection> => {
      const xml = await fetchText(source.url, {
        timeoutMs: 15_000,
        rateKey: `registered-feed:${new URL(source.url).hostname}`,
        minIntervalMs: 500,
      });
      const parsed = parser.parse(xml) as Record<string, unknown>;
      if (source.type === "sitemap") {
        return collectRegisteredSitemap(target, source, parsed, sinceMs, fetchedAt);
      }
      const rssChannel = (parsed.rss as { channel?: { item?: unknown } } | undefined)?.channel;
      const atomFeed = parsed.feed as { entry?: unknown } | undefined;
      const rows = rssChannel ? arrayOf(rssChannel.item) : arrayOf(atomFeed?.entry);
      const candidates = rows.flatMap((unknownRow): RawNewsCandidate[] => {
        const row = unknownRow as Record<string, unknown>;
        const title = plainText(row.title);
        const link = atomLink(row.link) ?? plainText(row.guid);
        const publishedRaw = row.pubDate ?? row.published ?? row.updated ?? row.date;
        const publishedAt = Date.parse(String(publishedRaw ?? ""));
        if (!title || !link || !publishedAt) return [];
        let url: string;
        try {
          const parsedUrl = new URL(link, source.url);
          if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return [];
          url = parsedUrl.toString();
        } catch {
          return [];
        }
        return [{
          provider: "rss",
          tier: "authoritative",
          providerId: plainText(row.guid) ?? url,
          title,
          url,
          publishedAt,
          publisher: source.name,
          ...(plainText(row.description ?? row.summary ?? row.content) ? {
            summary: plainText(row.description ?? row.summary ?? row.content),
          } : {}),
          symbols: [target.ticker.toUpperCase()],
          sourceType: source.authority === "primary" ? "primary" : "publisher",
          sourceVerification: {
            sourceId: source.id,
            verifiedAt: source.verifiedAt,
            verifiedBy: source.verifiedBy,
            verifiedHost: source.verifiedHost,
          },
          query: source.url,
          fetchedAt,
          raw: row,
        }];
      });
      return { candidates, failures: [] };
    }));
    const articles: RawNewsCandidate[] = [];
    const failures: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        articles.push(...result.value.candidates);
        failures.push(...result.value.failures);
      }
      else failures.push(`${sources[index].id}: ${cleanError(result.reason)}`);
    });
    return {
      provider: "rss",
      tier: "authoritative",
      active: true,
      candidates: articles,
      durationMs: Date.now() - started,
      ...((failures.length > 0 || unverified.length > 0) ? {
        error: [
          ...failures,
          ...unverified.map((source) => `${source.id}: registration is not verified`),
        ].join("; ").slice(0, 500),
      } : {}),
    };
  } catch (error) {
    return {
      provider: "rss",
      tier: "authoritative",
      active: true,
      candidates: [],
      durationMs: Date.now() - started,
      error: cleanError(error),
    };
  }
}

export async function collectSec(target: CompanyTarget): Promise<ProviderResult> {
  return timed("sec", "authoritative", async () => {
    const fetchedAt = Date.now();
    const result = await getFilingsResult(target.ticker, 25);
    if (!result.ok) throw new Error(result.error ?? "SEC filing collection failed");
    const filings = result.filings;
    return filings.map((filing): RawNewsCandidate => ({
      provider: "sec",
      tier: "authoritative",
      providerId: filing.url,
      title: `${target.ticker} filed ${filing.formLabel}: ${filing.title}`,
      url: filing.url,
      publishedAt: filing.filedAt ?? Date.parse(`${filing.date}T12:00:00Z`),
      publisher: "U.S. Securities and Exchange Commission",
      summary: `${filing.formLabel} filed ${filing.date}; ${filing.title}`,
      symbols: [target.ticker.toUpperCase()],
      sourceType: "primary",
      query: target.ticker.toUpperCase(),
      fetchedAt,
      raw: filing,
    }));
  });
}

export async function collectAllProviders(
  target: CompanyTarget,
  sinceMs: number,
): Promise<ProviderResult[]> {
  const providers = [
    collectSec(target),
    collectRegisteredFeeds(target, sinceMs),
    ...(process.env.BENZINGA_API_KEY ? [collectBenzinga(target, sinceMs)] : []),
    ...(process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY
      ? [collectAlpaca(target, sinceMs)]
      : []),
    ...(process.env.TIINGO_API_TOKEN ? [collectTiingo(target, sinceMs)] : []),
    collectYahoo(target),
    ...(process.env.ENABLE_GDELT_DISCOVERY === "true"
      ? [collectGdelt(target, Math.max(1, Math.ceil((Date.now() - sinceMs) / 3_600_000)))]
      : []),
    ...(process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY
      ? [collectPolygon(target, sinceMs)]
      : []),
  ];
  return Promise.all(providers);
}
