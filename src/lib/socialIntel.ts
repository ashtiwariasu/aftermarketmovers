/**
 * Social evidence — exhaustive windowed X ingestion and delta memory for the
 * normal dossier synthesis. This module deliberately has no member-facing or
 * founder-facing delivery path: social is one traceable evidence dimension,
 * never a parallel research product.
 *
 * Quality doctrine: collect every matching record since the last successful
 * cursor, store it whole, then use deterministic identity/engagement/link
 * gates to keep low-value chatter out of council context.
 */
import { randomUUID } from "node:crypto";
import { FieldValue, Firestore } from "@google-cloud/firestore";
import { WATCHLIST, BRAND_QUERIES, TICKER_QUERIES, tickerQuery } from "@/lib/socialWatchlist";

export interface XPost {
  id: string;
  url: string; // evidence-source aligned: x.com/i/status/{id}
  text: string;
  author: string;
  authorFollowers: number;
  authorVerified: boolean;
  createdAt: string;
  createdAtMs: number;
  publishedDate: string; // YYYY-MM-DD, evidence-source aligned
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  impressions: number;
  engagement: number; // likes + 2*reposts + replies + quotes
  authority: number; // 0..1 reliability grade from reach+engagement — evidence-room compatible
  cashtags: string[];
  urls: string[]; // expanded outbound links — source discovery for the news pipeline
  tickers: string[]; // cashtags ∪ query bucket
  isReply: boolean;
  isQuote: boolean;
  bucket: string; // brand | ticker:SYM | watchlist-N
  pulledAt: number;
  collectedDate: string; // US-market date used by the daily aggregate
}

const useMemory = process.env.DESK_STORE === "memory";
const mem = ((globalThis as Record<string, unknown>).__socialIntel ??= {
  posts: new Map<string, XPost>(),
  budget: new Map<string, number>(),
  lease: null as { id: string; until: number } | null,
}) as { posts: Map<string, XPost>; budget: Map<string, number>; lease: { id: string; until: number } | null };

let db: Firestore | null = null;
const fs = () => (db ??= new Firestore());

async function readsUsedToday(date: string): Promise<number> {
  if (useMemory) return mem.budget.get(date) ?? 0;
  const d = await fs().collection("social_intel_budget").doc(date).get();
  return d.exists ? ((d.data() as { reads: number }).reads ?? 0) : 0;
}

async function addReads(date: string, n: number): Promise<void> {
  if (useMemory) {
    mem.budget.set(date, (mem.budget.get(date) ?? 0) + n);
    return;
  }
  await fs().collection("social_intel_budget").doc(date)
    .set({ reads: (await readsUsedToday(date)) + n, updatedAt: Date.now() });
}

interface XSearchResult {
  posts: XPost[];
  succeeded: boolean;
}

async function xSearch(
  query: string,
  bucket: string,
  date: string,
  log: string[],
  sinceIso?: string,
): Promise<XSearchResult> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    log.push("X_BEARER_TOKEN missing — skipped all pulls");
    return { posts: [], succeeded: false };
  }
  const collected: XPost[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  try {
    do {
      const url = new URL("https://api.x.com/2/tweets/search/recent");
      url.searchParams.set("query", query);
      url.searchParams.set("max_results", "100");
      url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id,entities,referenced_tweets,lang");
      url.searchParams.set("expansions", "author_id");
      url.searchParams.set("user.fields", "username,verified,public_metrics");
      if (sinceIso) url.searchParams.set("start_time", sinceIso);
      if (nextToken) url.searchParams.set("next_token", nextToken);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        log.push(`x-api ${res.status} on "${bucket}" page ${pages + 1}: ${(await res.text()).slice(0, 140)}`);
        return { posts: collected, succeeded: false };
      }
      const j = await res.json();
      const users = new Map(
        ((j.includes?.users ?? []) as {
          id: string; username: string; verified?: boolean;
          public_metrics?: { followers_count?: number };
        }[]).map((u) => [u.id, u]),
      );
      const bucketTicker = bucket.startsWith("ticker:") ? [bucket.slice(7)] : [];
      const posts: XPost[] = ((j.data ?? []) as {
        id: string; text: string; author_id: string; created_at: string; lang?: string;
        public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number; impression_count?: number };
        entities?: { cashtags?: { tag: string }[]; urls?: { expanded_url?: string }[] };
        referenced_tweets?: { type: string }[];
      }[]).map((t) => {
        const u = users.get(t.author_id);
        const m = t.public_metrics ?? {};
        const engagement = (m.like_count ?? 0) + 2 * (m.retweet_count ?? 0) + (m.reply_count ?? 0) + (m.quote_count ?? 0);
        const followers = u?.public_metrics?.followers_count ?? 0;
        // A ranking aid only. Social remains a low-grade source regardless of
        // account reach or engagement.
        const authority = Math.min(0.4, Math.round((Math.min(followers / 500_000, 1) * 0.25 + Math.min(engagement / 500, 1) * 0.15) * 100) / 100);
        const cashtags = (t.entities?.cashtags ?? []).map((c) => c.tag.toUpperCase());
        const createdAtMs = Date.parse(t.created_at);
        return {
          id: t.id,
          url: `https://x.com/i/status/${t.id}`,
          text: t.text,
          author: u?.username ?? t.author_id,
          authorFollowers: followers,
          authorVerified: Boolean(u?.verified),
          createdAt: t.created_at,
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
          publishedDate: (t.created_at ?? "").slice(0, 10),
          likes: m.like_count ?? 0,
          reposts: m.retweet_count ?? 0,
          replies: m.reply_count ?? 0,
          quotes: m.quote_count ?? 0,
          impressions: m.impression_count ?? 0,
          engagement,
          authority,
          cashtags,
          urls: (t.entities?.urls ?? []).map((x) => x.expanded_url ?? "").filter((x) => x && !x.includes("x.com/")),
          tickers: [...new Set([...bucketTicker, ...cashtags])],
          isReply: (t.referenced_tweets ?? []).some((r) => r.type === "replied_to"),
          isQuote: (t.referenced_tweets ?? []).some((r) => r.type === "quoted"),
          bucket,
          pulledAt: Date.now(),
          collectedDate: date,
        };
      });
      collected.push(...posts);
      await addReads(date, posts.length);
      pages += 1;
      nextToken = typeof j.meta?.next_token === "string" ? j.meta.next_token : undefined;
    } while (nextToken);
    log.push(`pulled ${collected.length} from "${bucket}" across ${pages} page(s)`);
    return { posts: collected, succeeded: true };
  } catch (e) {
    log.push(`x-api error on "${bucket}": ${String(e).slice(0, 120)}`);
    return { posts: collected, succeeded: false };
  }
}

async function savePosts(posts: XPost[]): Promise<void> {
  if (useMemory) {
    posts.forEach((post) => {
      const prior = mem.posts.get(post.id);
      mem.posts.set(post.id, prior ? {
        ...prior,
        ...post,
        tickers: [...new Set([...prior.tickers, ...post.tickers])],
        urls: [...new Set([...prior.urls, ...post.urls])],
      } : post);
    });
    return;
  }
  const writes = posts.flatMap((post) => [
    { ref: fs().collection("social_intel_posts").doc(post.id), data: post, mergeArrays: true },
    ...post.tickers.map((ticker) => ({
      ref: fs().collection("social_intel_tickers").doc(ticker).collection("posts").doc(post.id),
      data: post,
      mergeArrays: false,
    })),
  ]);
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = fs().batch();
    for (const write of writes.slice(offset, offset + 400)) {
      const data: Record<string, unknown> = { ...write.data };
      if (write.mergeArrays && write.data.tickers.length > 0) {
        data.tickers = FieldValue.arrayUnion(...write.data.tickers);
      }
      if (write.mergeArrays && write.data.urls.length > 0) {
        data.urls = FieldValue.arrayUnion(...write.data.urls);
      }
      batch.set(write.ref, data, { merge: true });
    }
    await batch.commit();
  }
}

/** Batched from: queries — ~8 handles per query keeps under the 512-char limit. */
function watchlistQueries(): { query: string; bucket: string }[] {
  const out: { query: string; bucket: string }[] = [];
  for (let i = 0; i < WATCHLIST.length; i += 8) {
    const group = WATCHLIST.slice(i, i + 8).map((w) => `from:${w.handle}`).join(" OR ");
    out.push({ query: `(${group}) -is:retweet -is:reply`, bucket: `watchlist-${i / 8 + 1}` });
  }
  return out;
}

/** Collapse a post returned by more than one query without losing ticker or
 * outbound-link provenance. Chatter volume must count unique posts, not API
 * query matches. */
export function dedupeSocialPosts(posts: XPost[]): XPost[] {
  const unique = new Map<string, XPost>();
  for (const post of posts) {
    const prior = unique.get(post.id);
    unique.set(post.id, prior ? {
      ...prior,
      tickers: [...new Set([...prior.tickers, ...post.tickers])],
      urls: [...new Set([...prior.urls, ...post.urls])],
      engagement: Math.max(prior.engagement, post.engagement),
      authorFollowers: Math.max(prior.authorFollowers, post.authorFollowers),
    } : post);
  }
  return [...unique.values()];
}

/** Raw posts are stored without filtering. Only posts that carry a useful
 * identity, attention, or source-discovery signal enter council context. */
export function highValueSocialPosts(posts: XPost[]): XPost[] {
  return posts.filter((post) =>
    post.authorVerified ||
    post.authorFollowers >= 5_000 ||
    post.engagement >= 3 ||
    post.urls.length > 0
  );
}

export interface SocialNarrativeCluster {
  key: string;
  representative: XPost;
  posts: XPost[];
  aggregateEngagement: number;
  aggregateReach: number;
}

/**
 * Collapse repeated social narratives before they reach frontier context.
 * The archive still retains every post. This is a relevance filter, not a
 * collection cap: repeated wording increases the cluster's attention signal
 * without consuming the prompt once per reposted talking point.
 */
export function socialNarrativeKey(text: string): string {
  const stop = new Set([
    "the", "and", "for", "that", "this", "with", "from", "into", "after", "before",
    "about", "your", "their", "they", "will", "would", "could", "should", "have", "has",
  ]);
  const tokens = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[a-z0-9_]+/g, " ")
    .replace(/\$([a-z]{1,6})\b/g, " $1 ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stop.has(token));
  return [...new Set(tokens)].sort().slice(0, 12).join("-") || "uncategorized";
}

export function clusterSocialNarratives(posts: XPost[]): SocialNarrativeCluster[] {
  const clusters = new Map<string, XPost[]>();
  for (const post of highValueSocialPosts(posts)) {
    const key = socialNarrativeKey(post.text);
    const members = clusters.get(key);
    if (members) members.push(post);
    else clusters.set(key, [post]);
  }
  return [...clusters.entries()].map(([key, members]) => {
    const ranked = [...members].sort((left, right) =>
      right.engagement - left.engagement ||
      Number(right.authorVerified) - Number(left.authorVerified) ||
      right.authorFollowers - left.authorFollowers ||
      right.createdAtMs - left.createdAtMs
    );
    return {
      key,
      representative: ranked[0],
      posts: ranked,
      aggregateEngagement: ranked.reduce((total, post) => total + post.engagement, 0),
      aggregateReach: ranked.reduce((total, post) => total + post.authorFollowers, 0),
    };
  }).sort((left, right) =>
    right.aggregateEngagement - left.aggregateEngagement ||
    right.aggregateReach - left.aggregateReach ||
    right.representative.createdAtMs - left.representative.createdAtMs
  );
}

/** Per-day, per-ticker aggregates — the trend series. One tiny doc per day
 *  makes 30-day chatter-velocity questions pure arithmetic, no reads. */
async function saveDaily(dateEt: string, posts: XPost[]): Promise<void> {
  const byTicker: Record<string, { n: number; eng: number; reach: number; top: string[] }> = {};
  for (const p of posts) {
    for (const t of p.tickers) {
      byTicker[t] ??= { n: 0, eng: 0, reach: 0, top: [] };
      byTicker[t].n += 1; byTicker[t].eng += p.engagement; byTicker[t].reach += p.authorFollowers;
    }
  }
  for (const t of Object.keys(byTicker)) {
    byTicker[t].top = highValueSocialPosts(posts.filter((p) => p.tickers.includes(t)))
      .sort((a, b) => b.engagement - a.engagement).map((p) => p.id);
  }
  const doc = {
    date: dateEt, posts: posts.length,
    brandMentions: posts.filter((p) => p.bucket === "brand").length,
    byTicker, at: Date.now(),
  };
  if (!useMemory) await fs().collection("social_daily").doc(dateEt).set(doc);
}

/** Recent high-signal posts for one ticker — the dossier evidence hookup. */
export async function getRecentSocialPosts(sym: string): Promise<XPost[]> {
  const select = (posts: XPost[]) => selectRecentSocialPosts(posts, sym);
  if (useMemory) return select([...mem.posts.values()]);
  const cutoff = Date.now() - 36 * 3_600_000;
  const snap = await fs().collection("social_intel_tickers").doc(sym.toUpperCase())
    .collection("posts").where("createdAtMs", ">=", cutoff).orderBy("createdAtMs", "desc").get();
  return select(snap.docs.map((d) => d.data() as XPost));
}

export function selectRecentSocialPosts(
  posts: XPost[],
  sym: string,
  now = Date.now(),
): XPost[] {
  const cutoff = now - 36 * 3_600_000;
  return highValueSocialPosts(posts
    .filter((post) => post.tickers.includes(sym.toUpperCase()))
    .filter((post) => (post.createdAtMs || Date.parse(post.createdAt)) >= cutoff))
    .sort((a, b) => b.engagement - a.engagement);
}

const SOCIAL_RUN_LEASE_MS = 35 * 60_000;

async function acquireRunLease(): Promise<string | null> {
  const id = randomUUID();
  const now = Date.now();
  if (useMemory) {
    const store = mem as typeof mem & { lease?: { id: string; until: number } | null };
    if (store.lease && store.lease.until > now) return null;
    store.lease = { id, until: now + SOCIAL_RUN_LEASE_MS };
    return id;
  }
  const ref = fs().collection("social_intel_budget").doc("run-lease");
  return fs().runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as { id?: string; until?: number } | undefined;
    if ((current?.until ?? 0) > now) return null;
    tx.set(ref, { id, until: now + SOCIAL_RUN_LEASE_MS, startedAt: now });
    return id;
  });
}

async function releaseRunLease(id: string): Promise<void> {
  if (useMemory) {
    const store = mem as typeof mem & { lease?: { id: string; until: number } | null };
    if (store.lease?.id === id) store.lease = null;
    return;
  }
  const ref = fs().collection("social_intel_budget").doc("run-lease");
  await fs().runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as { id?: string } | undefined;
    if (current?.id === id) tx.set(ref, { id, until: 0, finishedAt: Date.now() }, { merge: true });
  });
}

export async function runSocialIntel(dateEt: string, fleetTickers: string[] = []): Promise<{
  posts: number; qualified: number; narratives: number; readsUsed: number; skipped: boolean; complete: boolean; log: string[];
}> {
  const log: string[] = [];
  const leaseId = await acquireRunLease();
  if (!leaseId) {
    return {
      posts: 0,
      qualified: 0,
      narratives: 0,
      readsUsed: await readsUsedToday(dateEt),
      skipped: true,
      complete: false,
      log: ["active run"],
    };
  }

  try {
    const all: XPost[] = [];
    let successfulPulls = 0;
    let failedPulls = 0;

    // Cursor: only pay for posts newer than the last successful run (minus
    // one hour overlap). Failed/misconfigured runs never advance it.
    let sinceIso = new Date(Date.now() - 36 * 3_600_000).toISOString();
    if (!useMemory) {
      const cur = (await fs().collection("social_intel_budget").doc("cursor").get()).data() as { lastRunAt?: number } | undefined;
      if (cur?.lastRunAt) sinceIso = new Date(cur.lastRunAt - 3_600_000).toISOString();
    }

    const pull = async (query: string, bucket: string) => {
      const result = await xSearch(query, bucket, dateEt, log, sinceIso);
      if (result.succeeded) successfulPulls += 1;
      else failedPulls += 1;
      all.push(...result.posts);
    };
    for (const query of BRAND_QUERIES) await pull(query, "brand");
    const tickers = [...new Set((fleetTickers.length > 0 ? fleetTickers : TICKER_QUERIES.map((item) => item.ticker))
      .map((ticker) => ticker.toUpperCase().trim()).filter((ticker) => /^[A-Z][A-Z.\-]{0,9}$/.test(ticker)))];
    for (const sym of tickers) await pull(tickerQuery(sym), `ticker:${sym}`);
    for (const query of watchlistQueries()) await pull(query.query, query.bucket);

    const posts = dedupeSocialPosts(all);
    if (posts.length > 0) await savePosts(posts);
    if (failedPulls > 0) {
      log.push(`cursor held: ${failedPulls} source quer${failedPulls === 1 ? "y" : "ies"} incomplete`);
      return {
        posts: posts.length,
        qualified: highValueSocialPosts(posts).length,
        narratives: clusterSocialNarratives(posts).length,
        readsUsed: await readsUsedToday(dateEt),
        skipped: false,
        complete: false,
        log,
      };
    }
    await saveDaily(dateEt, posts);
    if (!useMemory && successfulPulls > 0) {
      await fs().collection("social_intel_budget").doc("cursor").set({ lastRunAt: Date.now() });
    }
    const qualified = highValueSocialPosts(posts).length;
    const narratives = clusterSocialNarratives(posts).length;
    log.push(`evidence ready: ${qualified} qualified posts collapsed into ${narratives} narrative clusters`);
    return {
      posts: posts.length,
      qualified,
      narratives,
      readsUsed: await readsUsedToday(dateEt),
      skipped: false,
      complete: true,
      log,
    };
  } finally {
    await releaseRunLease(leaseId);
  }
}
