/**
 * The canonical per-company store — the system of record between upstream
 * APIs (EDGAR, Yahoo) and everything else. Firestore:
 *
 *   companies/{SYM}                       profile + lastRefreshed markers
 *   companies/{SYM}/dossiers/{date}       full dossier history
 *   companies/{SYM}/filings/{accession}   filing metadata (+ extract when filed)
 *   companies/{SYM}/fundamentals/{end}    XBRL snapshot per quarter
 *   companies/{SYM}/bars/{date}           daily close/volume/change
 *   companies/{SYM}/wires/{id}            dated headlines
 *
 * Crons write through; pages read store-first with fetch-on-miss. One copy
 * per company, shared by every watcher.
 */

import { createHash, randomUUID } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import {
  getDailyHistory,
  getTiingoDailyHistory,
  getTiingoDailyMetadata,
  marketHistoryStart,
  validIsoCalendarDate,
  type DailyBar,
  type TiingoDailyMetadata,
} from "@/lib/ticker";
import { getTickerNews, type NewsItem } from "@/lib/news";
import {
  getFilings,
  getFundamentals,
  FUNDAMENTALS_SCHEMA_VERSION,
  type SecFiling,
  type Fundamentals,
} from "@/lib/sec";

const useMemory = process.env.DESK_STORE === "memory";
const mem = ((globalThis as Record<string, unknown>).__companyStore ??= {
  profiles: new Map<string, CompanyProfile>(),
  subs: new Map<string, Map<string, Record<string, unknown>>>(),
}) as {
  profiles: Map<string, CompanyProfile>;
  subs: Map<string, Map<string, Record<string, unknown>>>;
};

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

export interface CompanyProfile {
  symbol: string;
  name?: string;
  exchange?: string;
  nextEvent?: string | null;
  lastRefreshed?: Record<string, number>; // source → ms epoch
  /** Canonical adjusted-price generation used by private signal research. */
  researchBarsSeries?: {
    generationId: string;
    source: NonNullable<DailyBar["source"]>;
    startDate: string;
    endDate: string;
    count: number;
    chunkCount: number;
    yearCoverage: Record<string, number>;
    contentSha256: string;
    /** Captured before the vendor fetch; used for last-started-wins CAS. */
    requestedAt: number;
    refreshedAt: number;
  };
  newsSources?: Array<{
    id: string;
    name: string;
    url: string;
    type: "rss" | "atom" | "sitemap";
    authority: "primary" | "publisher";
    /** Required for sitemap sources; limits collection to the verified section. */
    pathPrefix?: string;
    enabled?: boolean;
    verifiedAt: number;
    verifiedBy: string;
    verifiedHost: string;
  }>;
}

function subKey(sym: string, sub: string): string {
  return `${sym}:${sub}`;
}

async function memSub(sym: string, sub: string): Promise<Map<string, Record<string, unknown>>> {
  const k = subKey(sym, sub);
  if (!mem.subs.has(k)) mem.subs.set(k, new Map());
  return mem.subs.get(k)!;
}

export async function getProfile(sym: string): Promise<CompanyProfile | null> {
  const s = sym.toUpperCase();
  if (useMemory) return mem.profiles.get(s) ?? null;
  const doc = await firestore().collection("companies").doc(s).get();
  return doc.exists ? (doc.data() as CompanyProfile) : null;
}

async function mergeProfile(sym: string, patch: Partial<CompanyProfile>): Promise<void> {
  const s = sym.toUpperCase();
  if (useMemory) {
    mem.profiles.set(s, { symbol: s, ...(mem.profiles.get(s) ?? {}), ...patch,
      lastRefreshed: { ...(mem.profiles.get(s)?.lastRefreshed ?? {}), ...(patch.lastRefreshed ?? {}) } });
    return;
  }
  await firestore().collection("companies").doc(s).set({ symbol: s, ...patch }, { merge: true });
}

async function setSub(
  sym: string,
  sub: string,
  rows: Array<{ id: string; data: Record<string, unknown> }>
): Promise<void> {
  if (rows.length === 0) return;
  const s = sym.toUpperCase();
  if (useMemory) {
    const m = await memSub(s, sub);
    for (const r of rows) m.set(r.id, r.data);
    return;
  }
  const col = firestore().collection("companies").doc(s).collection(sub);
  // Firestore batches have a 500-write ceiling. Chunk instead of silently
  // dropping long adjusted-price histories after the first 400 sessions.
  for (let offset = 0; offset < rows.length; offset += 400) {
    const batch = firestore().batch();
    for (const r of rows.slice(offset, offset + 400)) {
      batch.set(col.doc(r.id), r.data, { merge: true });
    }
    await batch.commit();
  }
}

/**
 * Execute every immutable-generation write before publishing its active
 * pointer. Kept injectable so failure ordering is directly testable.
 */
export async function publishAfterCompleteBatches<T>(input: {
  rows: T[];
  batchSize: number;
  writeBatch: (rows: T[], batchIndex: number) => Promise<void>;
  publish: () => Promise<void>;
}): Promise<void> {
  const batchSize = Math.max(1, Math.floor(input.batchSize));
  for (let offset = 0; offset < input.rows.length; offset += batchSize) {
    await input.writeBatch(input.rows.slice(offset, offset + batchSize), offset / batchSize);
  }
  await input.publish();
}

function researchBarsDigest(bars: DailyBar[]): string {
  return createHash("sha256").update(JSON.stringify(bars.map((bar) => ({
    date: bar.date,
    close: bar.close,
    adjustedClose: bar.adjustedClose,
    changePct: bar.changePct,
    volume: bar.volume,
    source: bar.source,
  })))).digest("hex");
}

function validAdjustedGeneration(bars: DailyBar[]): bars is Array<DailyBar & {
  adjustedClose: number;
  source: NonNullable<DailyBar["source"]>;
}> {
  if (bars.length === 0) return false;
  return bars.every((bar, index) =>
    validIsoCalendarDate(bar.date) &&
    typeof bar.adjustedClose === "number" && Number.isFinite(bar.adjustedClose) && bar.adjustedClose > 0 &&
    Boolean(bar.source) &&
    (index === 0 || bars[index - 1].date < bar.date) &&
    bar.source === bars[0].source,
  );
}

function researchGenerationSub(generationId: string): string {
  return `researchBarGenerations:${generationId}:chunks`;
}

const RESEARCH_CHUNK_SIZE = 400;
const RESEARCH_MIN_SESSIONS = 60;
const RESEARCH_CACHE_MAX_ENTRIES = 32;
const researchBarsCache = ((globalThis as Record<string, unknown>).__researchBarsCache ??=
  new Map<string, { generationId: string; bars: DailyBar[] }>()) as
  Map<string, { generationId: string; bars: DailyBar[] }>;

function seriesOrder(series: Pick<NonNullable<CompanyProfile["researchBarsSeries"]>, "requestedAt" | "generationId">): string {
  return `${String(series.requestedAt).padStart(16, "0")}:${series.generationId}`;
}

export function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  const maximum = Math.max(1, Math.floor(maxEntries));
  while (map.size > maximum) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function cachedResearchBars(sym: string, generationId: string): DailyBar[] | null {
  const key = sym.toUpperCase();
  const cached = researchBarsCache.get(key);
  if (cached?.generationId !== generationId) return null;
  setBoundedMapEntry(researchBarsCache, key, cached, RESEARCH_CACHE_MAX_ENTRIES);
  return structuredClone(cached.bars);
}

function cacheResearchBars(sym: string, generationId: string, bars: DailyBar[]): void {
  setBoundedMapEntry(
    researchBarsCache,
    sym.toUpperCase(),
    { generationId, bars: structuredClone(bars) },
    RESEARCH_CACHE_MAX_ENTRIES,
  );
}

function yearCoverage(bars: DailyBar[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bar of bars) counts[bar.date.slice(0, 4)] = (counts[bar.date.slice(0, 4)] ?? 0) + 1;
  return counts;
}

export function researchSeriesCanReplace(
  current: NonNullable<CompanyProfile["researchBarsSeries"]> | null | undefined,
  candidate: NonNullable<CompanyProfile["researchBarsSeries"]>,
): boolean {
  if (!current) return true;
  if (current.source === "tiingo-eod" && candidate.source !== "tiingo-eod") return false;
  if (candidate.count + 10 < current.count || candidate.endDate < current.endDate) return false;
  const currentCoverage = current.yearCoverage ?? {};
  const candidateCoverage = candidate.yearCoverage ?? {};
  for (const [year, count] of Object.entries(currentCoverage)) {
    // The moving ten-year boundary may legitimately remove sessions only
    // from the oldest calendar year.
    if (year === current.startDate.slice(0, 4)) continue;
    if ((candidateCoverage[year] ?? 0) < count) return false;
  }
  const providerImproved = current.source !== "tiingo-eod" && candidate.source === "tiingo-eod";
  const coverageImproved = candidate.endDate > current.endDate || candidate.count > current.count + 10;
  return providerImproved || coverageImproved || seriesOrder(current) <= seriesOrder(candidate);
}

function etDateToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysBetween(left: string, right: string): number {
  return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000);
}

export function researchCoverageIsComplete(input: {
  bars: DailyBar[];
  requestedStartDate: string;
  tiingoMetadata?: TiingoDailyMetadata | null;
  nowEtDate: string;
}): boolean {
  const bars = input.bars;
  if (!validAdjustedGeneration(bars) || bars.length < RESEARCH_MIN_SESSIONS) return false;
  const first = bars[0].date;
  const last = bars.at(-1)!.date;
  if (!validIsoCalendarDate(input.nowEtDate) || last > input.nowEtDate) return false;
  if (daysBetween(last, input.nowEtDate) > 14) return false;
  if (input.tiingoMetadata) {
    if (input.tiingoMetadata.endDate > input.nowEtDate) return false;
    const expectedStart = input.tiingoMetadata.startDate > input.requestedStartDate
      ? input.tiingoMetadata.startDate
      : input.requestedStartDate;
    if (!(daysBetween(expectedStart, first) >= 0 && daysBetween(expectedStart, first) <= 7 &&
        Math.abs(daysBetween(last, input.tiingoMetadata.endDate)) <= 3)) return false;
    return hasConservativeSessionDensity(bars, expectedStart, last);
  }
  // Without authoritative listing metadata, accept only a response that
  // visibly covers the requested decade. New listings remain pending until a
  // licensed metadata source can distinguish them from partial transport.
  return daysBetween(input.requestedStartDate, first) >= 0 &&
    daysBetween(input.requestedStartDate, first) <= 7 &&
    hasConservativeSessionDensity(bars, input.requestedStartDate, last);
}

function hasConservativeSessionDensity(
  bars: DailyBar[],
  expectedStart: string,
  endDate: string,
): boolean {
  // US exchanges normally produce ~250 sessions/year. A 180/year floor is
  // deliberately tolerant of holidays and lengthy halts while refusing a
  // sparse/partial transport response that merely includes both endpoints.
  const coveredDays = Math.max(1, daysBetween(expectedStart, endDate));
  const overallFloor = Math.max(RESEARCH_MIN_SESSIONS, Math.floor(coveredDays / 365.25 * 180));
  if (bars.length < overallFloor) return false;
  const coverage = yearCoverage(bars);
  const firstFullYear = Number(expectedStart.slice(0, 4)) + 1;
  const lastFullYear = Number(endDate.slice(0, 4)) - 1;
  for (let year = firstFullYear; year <= lastFullYear; year += 1) {
    if ((coverage[String(year)] ?? 0) < 180) return false;
  }
  return true;
}

async function readResearchGeneration(
  sym: string,
  series: NonNullable<CompanyProfile["researchBarsSeries"]>,
): Promise<DailyBar[]> {
  const cached = cachedResearchBars(sym, series.generationId);
  if (cached) return cached;
  let rows: DailyBar[];
  if (useMemory) {
    const stored = await memSub(sym.toUpperCase(), researchGenerationSub(series.generationId));
    rows = [...stored.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, value]) => Array.isArray(value.bars) ? value.bars as DailyBar[] : []);
  } else {
    const snapshot = await firestore()
      .collection("companies").doc(sym.toUpperCase())
      .collection("researchBarGenerations").doc(series.generationId)
      .collection("chunks").orderBy("index", "asc").get();
    rows = snapshot.docs.flatMap((document) => {
      const data = document.data() as { bars?: DailyBar[] };
      return Array.isArray(data.bars) ? data.bars : [];
    });
  }
  if (
    !Number.isInteger(series.chunkCount) || series.chunkCount <= 0 ||
    Math.ceil(rows.length / RESEARCH_CHUNK_SIZE) !== series.chunkCount ||
    rows.length !== series.count ||
    rows[0]?.date !== series.startDate ||
    rows.at(-1)?.date !== series.endDate ||
    !validAdjustedGeneration(rows) ||
    researchBarsDigest(rows) !== series.contentSha256
  ) return [];
  cacheResearchBars(sym, series.generationId, rows);
  return structuredClone(rows);
}

async function writeResearchGeneration(
  sym: string,
  bars: Array<DailyBar & { adjustedClose: number; source: NonNullable<DailyBar["source"]> }>,
  requestedAt: number,
): Promise<{ series: NonNullable<CompanyProfile["researchBarsSeries"]>; published: boolean }> {
  const refreshedAt = Date.now();
  const contentSha256 = researchBarsDigest(bars);
  // Request-unique IDs make rejected-generation cleanup ownership-safe. The
  // content hash remains in both the manifest and ID for reproducibility, but
  // no other in-flight publisher can later activate this caller's document.
  const generationId = `${bars[0].source}-${requestedAt}-${contentSha256.slice(0, 16)}-${randomUUID()}`;
  const series = {
    generationId,
    source: bars[0].source,
    startDate: bars[0].date,
    endDate: bars.at(-1)!.date,
    count: bars.length,
    chunkCount: Math.ceil(bars.length / RESEARCH_CHUNK_SIZE),
    yearCoverage: yearCoverage(bars),
    contentSha256,
    requestedAt,
    refreshedAt,
  };
  const chunks = Array.from({ length: series.chunkCount }, (_, index) => ({
    id: String(index).padStart(4, "0"),
    index,
    bars: bars.slice(index * RESEARCH_CHUNK_SIZE, (index + 1) * RESEARCH_CHUNK_SIZE),
  }));
  const generationRef = useMemory ? null : firestore()
    .collection("companies").doc(sym.toUpperCase())
    .collection("researchBarGenerations").doc(generationId);
  if (useMemory) {
    const manifests = await memSub(sym.toUpperCase(), "researchBarGenerationManifests");
    if (!manifests.has(generationId)) {
      manifests.set(generationId, { ...series, complete: false, createdAt: Date.now() });
    }
  } else {
    await firestore().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(generationRef!);
      const existing = snapshot.data() as { contentSha256?: string } | undefined;
      if (snapshot.exists && existing?.contentSha256 !== contentSha256) {
        throw new Error("research generation id/hash collision");
      }
      if (!snapshot.exists) transaction.create(generationRef!, { ...series, complete: false, createdAt: Date.now() });
    });
  }
  let published = false;
  await publishAfterCompleteBatches({
    rows: chunks,
    batchSize: 400,
    writeBatch: async (batch) => {
      if (useMemory) {
        const stored = await memSub(sym.toUpperCase(), researchGenerationSub(generationId));
        for (const chunk of batch) stored.set(chunk.id, { index: chunk.index, bars: chunk.bars });
        return;
      }
      const write = firestore().batch();
      for (const chunk of batch) {
        write.set(generationRef!.collection("chunks").doc(chunk.id), {
          index: chunk.index,
          bars: chunk.bars,
        });
      }
      await write.commit();
    },
    publish: async () => {
      if (useMemory) {
        const manifests = await memSub(sym.toUpperCase(), "researchBarGenerationManifests");
        manifests.set(generationId, { ...series, complete: true, createdAt: Date.now() });
        const current = mem.profiles.get(sym.toUpperCase())?.researchBarsSeries;
        if (researchSeriesCanReplace(current, series)) {
          await mergeProfile(sym, {
            lastRefreshed: { researchBars: refreshedAt },
            researchBarsSeries: series,
          });
          published = true;
        }
        return;
      }
      await generationRef!.set({ ...series, complete: true }, { merge: true });
      const profileRef = firestore().collection("companies").doc(sym.toUpperCase());
      published = await firestore().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(profileRef);
        const current = (snapshot.data() as CompanyProfile | undefined)?.researchBarsSeries;
        if (!researchSeriesCanReplace(current, series)) return false;
        transaction.set(profileRef, {
          symbol: sym.toUpperCase(),
          lastRefreshed: { researchBars: refreshedAt },
          researchBarsSeries: series,
        }, { merge: true });
        return true;
      });
    },
  });
  if (published) {
    cacheResearchBars(sym, generationId, bars);
  }
  return { series, published };
}

async function pruneResearchGenerations(sym: string): Promise<void> {
  const active = (await getProfile(sym))?.researchBarsSeries;
  if (!active) return;
  const staleIncompleteBefore = Date.now() - 24 * 3600_000;
  if (useMemory) {
    const manifests = await memSub(sym.toUpperCase(), "researchBarGenerationManifests");
    for (const [generationId, raw] of [...manifests.entries()]) {
      const candidate = raw as unknown as NonNullable<CompanyProfile["researchBarsSeries"]> & {
        complete?: boolean; createdAt?: number;
      };
      const olderComplete = candidate.complete === true && seriesOrder(candidate) < seriesOrder(active);
      const abandoned = candidate.complete !== true && Number(candidate.createdAt) < staleIncompleteBefore;
      if (generationId !== active.generationId && (olderComplete || abandoned)) {
        manifests.delete(generationId);
        mem.subs.delete(subKey(sym, researchGenerationSub(generationId)));
      }
    }
    return;
  }
  const generations = await firestore()
    .collection("companies").doc(sym.toUpperCase())
    .collection("researchBarGenerations").get();
  for (const generation of generations.docs) {
    const candidate = generation.data() as NonNullable<CompanyProfile["researchBarsSeries"]> & {
      complete?: boolean; createdAt?: number;
    };
    const olderComplete = candidate.complete === true && seriesOrder(candidate) < seriesOrder(active);
    const abandoned = candidate.complete !== true && Number(candidate.createdAt) < staleIncompleteBefore;
    if (generation.id !== active.generationId && (olderComplete || abandoned)) {
      await firestore().recursiveDelete(generation.ref);
    }
  }
}

async function deleteRejectedResearchGeneration(sym: string, generationId: string): Promise<void> {
  const active = (await getProfile(sym))?.researchBarsSeries;
  if (active?.generationId === generationId) return;
  if (useMemory) {
    const manifests = await memSub(sym.toUpperCase(), "researchBarGenerationManifests");
    manifests.delete(generationId);
    mem.subs.delete(subKey(sym, researchGenerationSub(generationId)));
    return;
  }
  const reference = firestore()
    .collection("companies").doc(sym.toUpperCase())
    .collection("researchBarGenerations").doc(generationId);
  await firestore().recursiveDelete(reference);
}

async function listSub<T>(
  sym: string,
  sub: string,
  orderByField: string,
  limit: number,
  desc = true
): Promise<T[]> {
  const s = sym.toUpperCase();
  if (useMemory) {
    const m = await memSub(s, sub);
    return [...m.values()]
      .sort((a, b) =>
        String(desc ? b[orderByField] : a[orderByField]).localeCompare(
          String(desc ? a[orderByField] : b[orderByField])
        )
      )
      .slice(0, limit) as T[];
  }
  const snap = await firestore()
    .collection("companies")
    .doc(s)
    .collection(sub)
    .orderBy(orderByField, desc ? "desc" : "asc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as T);
}

// ---- write-through refresh (crons + provisioning + fetch-on-miss) ----

function wireId(link: string): string {
  return Buffer.from(link).toString("base64url").slice(0, 80) || "wire";
}

function accessionFromUrl(url: string): string | null {
  return url.match(/\/Archives\/edgar\/data\/\d+\/(\d{10,})\//)?.[1] ?? null;
}

/** Fetch every source upstream and write through to the store. ~5–10s. */
export async function refreshCompanySources(sym: string): Promise<void> {
  const s = sym.toUpperCase();
  const now = Date.now();
  const [bars, filings, fundamentals, wires] = await Promise.all([
    getDailyHistory(s, "3mo"),
    getFilings(s, 10),
    getFundamentals(s),
    getTickerNews(s, 6),
  ]);

  const jobs: Promise<void>[] = [];
  if (bars.length > 0) {
    jobs.push(
      setSub(s, "bars", bars.slice(-45).map((b) => ({
        id: b.date,
        data: { ...b },
      })))
    );
  }
  if (filings.length > 0) {
    jobs.push(
      setSub(s, "filings", filings.flatMap((f) => {
        const id = accessionFromUrl(f.url);
        return id ? [{ id, data: { ...f, storedAt: now } }] : [];
      }))
    );
  }
  if (fundamentals) {
    jobs.push(
      setSub(s, "fundamentals", [{ id: fundamentals.asOf, data: { ...fundamentals, storedAt: now } }])
    );
  }
  if (wires.length > 0) {
    jobs.push(
      setSub(s, "wires", wires.map((w) => ({ id: wireId(w.link || w.title), data: { ...w, storedAt: now } })))
    );
  }
  jobs.push(
    mergeProfile(s, {
      lastRefreshed: {
        ...(bars.length ? { bars: now } : {}),
        ...(filings.length ? { filings: now } : {}),
        ...(fundamentals ? { fundamentals: now } : {}),
        ...(wires.length ? { wires: now } : {}),
      },
    })
  );
  await Promise.all(jobs);
}

/** True when a source was refreshed within maxAgeMs. */
function fresh(profile: CompanyProfile | null, source: string, maxAgeMs: number): boolean {
  const at = profile?.lastRefreshed?.[source];
  return typeof at === "number" && Date.now() - at < maxAgeMs;
}

// ---- store-first getters (fetch-on-miss, write-through) ----

/** Read-only daily bars for presentation surfaces; never fetches or writes. */
export async function getBarsSnapshot(sym: string): Promise<DailyBar[]> {
  const latest = await listSub<DailyBar>(sym, "bars", "date", 60, true);
  return latest.reverse();
}

/** Read-only filing metadata for presentation surfaces; never fetches or writes. */
export async function getFilingsSnapshot(sym: string, count = 12): Promise<SecFiling[]> {
  return listSub<SecFiling>(sym, "filings", "date", Math.max(1, count), true);
}

/**
 * Read the sparse reporting-cycle anchors directly. Form 4 volume must never
 * hide the quarter that an active thesis is measured against.
 */
export async function getPeriodicFilingsSnapshot(sym: string, count = 4): Promise<SecFiling[]> {
  const s = sym.toUpperCase();
  const limit = Math.max(1, count);
  if (useMemory) {
    const rows = [...(await memSub(s, "filings")).values()] as unknown as SecFiling[];
    return rows
      .filter((item) => item.form === "10-Q" || item.form === "10-K")
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, limit);
  }
  const collection = firestore().collection("companies").doc(s).collection("filings");
  const [quarterlies, annuals] = await Promise.all([
    collection.where("form", "==", "10-Q").get(),
    collection.where("form", "==", "10-K").get(),
  ]);
  return [...quarterlies.docs, ...annuals.docs]
    .map((doc) => doc.data() as SecFiling)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, limit);
}

export async function getBarsStored(sym: string): Promise<DailyBar[]> {
  const profile = await getProfile(sym);
  if (fresh(profile, "bars", 20 * 3600_000)) {
    const rows = await listSub<DailyBar>(sym, "bars", "date", 60, false);
    if (rows.length > 0) return rows;
  }
  const bars = await getDailyHistory(sym, "3mo");
  if (bars.length > 0) {
    await Promise.all([
      setSub(sym, "bars", bars.slice(-45).map((b) => ({ id: b.date, data: { ...b } }))),
      mergeProfile(sym, { lastRefreshed: { bars: Date.now() } }),
    ]).catch(() => {});
  }
  return bars;
}

/**
 * Long adjusted history for private research only. Each stale refresh writes
 * one complete ten-year provider generation so retroactive corporate-action
 * adjustments can never be mixed with an older basis.
 */
export async function getResearchBarsStored(sym: string): Promise<DailyBar[]> {
  const requestedAt = Date.now();
  const profile = await getProfile(sym);
  const series = profile?.researchBarsSeries;
  const canonicalStored = series ? await readResearchGeneration(sym, series) : [];
  if (fresh(profile, "researchBars", 20 * 3600_000) && canonicalStored.length > 0) {
    return canonicalStored;
  }

  // Adjusted vendors rewrite the full historical series after splits and
  // dividends. Always refresh one complete generation; merging a 45-session
  // tail into stale adjusted history can manufacture a discontinuity.
  const hasTiingo = Boolean(process.env.TIINGO_API_TOKEN);
  // A licensed basis is sticky. Losing a secret binding is an operational
  // fault, not permission to replace ten years of Tiingo adjustments.
  if (series?.source === "tiingo-eod" && !hasTiingo) return canonicalStored;
  const requestedStartDate = marketHistoryStart(10);
  const [fetched, tiingoMetadata] = hasTiingo
    ? await Promise.all([
        getTiingoDailyHistory(sym, { startDate: requestedStartDate }),
        getTiingoDailyMetadata(sym),
      ])
    : [await getDailyHistory(sym, "10y", { requireCompleteAdjusted: true }), null] as const;
  if (fetched.length > 0) {
    const ordered = [...fetched].sort((left, right) => left.date.localeCompare(right.date));
    if (!validAdjustedGeneration(ordered) || !researchCoverageIsComplete({
      bars: ordered,
      requestedStartDate,
      tiingoMetadata,
      nowEtDate: etDateToday(),
    })) return canonicalStored;
    // A provider timeout must not replace a complete decade with a short or
    // regressed response. Every previously admitted overlapping session must
    // remain represented even when the vendor revises adjusted values.
    const fetchedDates = new Set(ordered.map((bar) => bar.date));
    const overlapMissing = canonicalStored.some((bar) =>
      bar.date >= ordered[0].date && bar.date <= ordered.at(-1)!.date && !fetchedDates.has(bar.date));
    if (
      canonicalStored.length > 0 &&
      (ordered.at(-1)!.date < canonicalStored.at(-1)!.date ||
        ordered.length + 10 < canonicalStored.length ||
        overlapMissing)
    ) {
      return canonicalStored;
    }
    try {
      const result = await writeResearchGeneration(sym, ordered, requestedAt);
      await pruneResearchGenerations(sym).catch(() => {});
      if (result.published) return ordered;
      await deleteRejectedResearchGeneration(sym, result.series.generationId).catch(() => {});
      const active = (await getProfile(sym))?.researchBarsSeries;
      return active ? await readResearchGeneration(sym, active) : canonicalStored;
    } catch {
      // Calibration uses only the generation visible through the durable
      // pointer. The next request retries the unpublished vendor response.
      return canonicalStored;
    }
  }
  // When the licensed provider is configured, a transient failure must not
  // silently switch the calibration basis to Yahoo. Keep the last complete
  // same-provider generation and retry Tiingo on the next refresh.
  return canonicalStored;
}

export async function getFilingsStored(sym: string, count = 8): Promise<SecFiling[]> {
  const profile = await getProfile(sym);
  if (fresh(profile, "filings", 6 * 3600_000)) {
    const rows = await listSub<SecFiling>(sym, "filings", "date", count);
    if (rows.length > 0) return rows;
  }
  const filings = await getFilings(sym, Math.max(count, 10));
  if (filings.length > 0) {
    const now = Date.now();
    await Promise.all([
      setSub(sym, "filings", filings.flatMap((f) => {
        const id = accessionFromUrl(f.url);
        return id ? [{ id, data: { ...f, storedAt: now } }] : [];
      })),
      mergeProfile(sym, { lastRefreshed: { filings: now } }),
    ]).catch(() => {});
  }
  return filings.slice(0, count);
}

export async function getFundamentalsStored(sym: string): Promise<Fundamentals | null> {
  const profile = await getProfile(sym);
  if (fresh(profile, "fundamentals", 24 * 3600_000)) {
    const rows = await listSub<Fundamentals>(sym, "fundamentals", "asOf", 1);
    if (rows.length > 0 && rows[0].schemaVersion === FUNDAMENTALS_SCHEMA_VERSION) return rows[0];
  }
  const f = await getFundamentals(sym);
  if (f) {
    await Promise.all([
      setSub(sym, "fundamentals", [{ id: f.asOf, data: { ...f, storedAt: Date.now() } }]),
      mergeProfile(sym, { lastRefreshed: { fundamentals: Date.now() } }),
    ]).catch(() => {});
  }
  return f;
}

export async function getWiresStored(sym: string, count = 6): Promise<NewsItem[]> {
  const rows = await listSub<NewsItem>(sym, "wires", "at", count);
  return rows;
}

// ---- dossier history ----

export async function saveDossierHistory(
  sym: string,
  date: string,
  dossier: Record<string, unknown>
): Promise<void> {
  await setSub(sym, "dossiers", [{ id: date, data: dossier }]);
  await mergeProfile(sym, { lastRefreshed: { dossier: Date.now() } });
}

export async function getDossierHistory<T>(sym: string, limit = 14): Promise<T[]> {
  return listSub<T>(sym, "dossiers", "date", limit);
}
