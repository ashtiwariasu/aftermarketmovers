/**
 * The Evidence Room — everything collected gets utilised; only what earns it
 * reaches the council. Sits in front of the council as a triage stage:
 *
 *   all collected items → mechanical clustering (hashes/events, no LLM)
 *     → one cheap-model claim-extraction pass → claim ledger (persisted)
 *     → deterministic budgeted evidence pack + coverage manifest
 *
 * "Utilised" is a contract: every item is read, deduplicated, connected to a
 * claim, scored, and either selected or excluded WITH A REASON. Forty copies
 * of one announcement enter; the original + strongest confirmation + a
 * "×38 collapsed" note come out. Frontier tokens are for deliberation only.
 * Any failure here returns null and the caller falls back to the plain
 * bundle — the Evidence Room can only ever add quality, never block a note.
 */

import { Firestore } from "@google-cloud/firestore";
import { getTickerSnapshot } from "@/lib/ticker";
import { cikFor, fundamentalsMd, fetchFilingText } from "@/lib/sec";
import {
  getBarsStored,
  getFilingsStored,
  getFundamentalsStored,
} from "@/lib/companyStore";
import { getArticle, getCompanyNews, getNewsEvent } from "@/lib/newsStore";
import { rawPayloadHash, sha256, sourceDocumentIdForUrl } from "@/lib/newsNormalize";
import { AUXILIARY_MODELS } from "@/lib/modelPolicy";
import { clusterSocialNarratives, getRecentSocialPosts } from "@/lib/socialIntel";
import type { DossierCitation } from "@/lib/dossier";

const EXTRACTOR_MODEL = process.env.EVIDENCE_EXTRACTOR_MODEL || AUXILIARY_MODELS.evidenceExtractor;
const PACK_CHAR_BUDGET = 55_000;
const MAX_CLAIMS = 24;
const LEDGER_EVENT_TYPES = new Set([
  "earnings", "guidance", "product", "legal", "macro", "analyst", "ownership", "other",
]);

export interface EvidencePackSection {
  id: string;
  text: string;
  /** Lower numbers are more important. Ordering is stable inside a priority. */
  priority: 0 | 1 | 2 | 3;
  /** A pack that cannot admit this section is unsafe to send to the council. */
  required?: boolean;
}

/**
 * Fit complete evidence sections into a bounded prompt. A section is either
 * admitted whole or withheld with an audit reason; source text is never cut in
 * the middle merely to satisfy a prompt budget.
 */
export function packEvidenceSections(
  sections: EvidencePackSection[],
  budget = PACK_CHAR_BUDGET,
): { text: string; includedIds: string[]; excludedIds: string[]; requiredExcludedIds: string[] } {
  const ranked = sections
    .map((section, index) => ({ ...section, index }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const admitted: Array<EvidencePackSection & { index: number }> = [];
  const excludedIds: string[] = [];
  let used = 0;
  for (const section of ranked) {
    const separator = admitted.length === 0 ? 0 : 2;
    if (section.text.length > 0 && used + separator + section.text.length <= budget) {
      admitted.push(section);
      used += separator + section.text.length;
    } else {
      excludedIds.push(section.id);
    }
  }
  admitted.sort((left, right) => left.index - right.index);
  return {
    text: admitted.map((section) => section.text).join("\n\n"),
    includedIds: admitted.map((section) => section.id),
    excludedIds,
    requiredExcludedIds: ranked.filter((section) => section.required && excludedIds.includes(section.id)).map((section) => section.id),
  };
}

export interface LedgerClaim {
  id: string; // C1, C2…
  statement: string;
  eventType: string; // earnings | guidance | product | legal | macro | analyst | ownership | other
  sourceIds: string[]; // S# ids
  authority: "primary" | "company" | "independent" | "market-data" | "social";
  freshness: "today" | "recent" | "background";
  relevance: number; // 0-1
  duplicatesCollapsed: number;
  contradicts?: string; // claim id it tensions with
}

export interface EvidenceManifest {
  itemsSeen: number;
  clustersFormed: number;
  duplicatesCollapsed: number;
  included: number;
  excluded: Array<{ title: string; reason: string }>;
  social?: {
    qualifiedPosts: number;
    narrativeClusters: number;
    duplicatesCollapsed: number;
    admittedNarratives: number;
    admittedCitationIds: string[];
  };
  /** Full admitted-evidence state retained for deterministic change auditing. */
  materiality?: EvidencePackMateriality;
}

export interface EvidencePack {
  context: string;
  sources: string;
  evidence: DossierCitation[];
  claims: LedgerClaim[];
  manifest: EvidenceManifest;
  newClaimCount: number;
  deterministicEvidence: DeterministicEvidenceFact[];
  /**
   * Deterministic evidence delta retained for audit and explanations. Daily
   * research still runs the council on every trading day; similarity cannot
   * substitute for a strengthened/weakened/open review.
   */
  materiality: EvidencePackMateriality;
  /** Chairman-only sections: full ledger + contradictions, appended at chair time. */
  chairAddendum: string;
}

export interface EvidencePackMateriality {
  stableEvidenceFingerprint: string;
  stableEvidenceKeys: string[];
  /** Regular-session reference price at the last full council checkpoint. */
  referencePrice: number | null;
  dayChangePercent: number | null;
  afterHoursChangePercent: number | null;
}

export const MATERIAL_DAY_MOVE_PERCENT = 2;
export const MATERIAL_AFTER_HOURS_MOVE_PERCENT = 1;

export interface EvidenceMaterialityAssessment {
  checkedAt: number;
  auditId: string;
  needsCouncil: boolean;
  reasons: Array<
    | "no-prior-dossier"
    | "new-stable-evidence"
    | "stable-evidence-removed"
    | "material-day-move"
    | "material-after-hours-move"
    | "material-cumulative-move"
    | "evidence-unchanged"
  >;
  newStableEvidenceKeys: string[];
  removedStableEvidenceKeys: string[];
  priorStableEvidenceFingerprint: string;
  currentStableEvidenceFingerprint: string;
  cumulativeChangePercent: number | null;
  dayChangePercent: number | null;
  afterHoursChangePercent: number | null;
}

export function stableResearchEvidenceKey(
  citation: Pick<
    DossierCitation,
    "authority" | "sourceDocumentId" | "url" | "publishedDate" | "contentSha256"
  >,
): string | null {
  if (citation.authority === "market-data") return null;
  return [
    citation.authority,
    citation.sourceDocumentId || citation.url,
    citation.publishedDate,
    citation.contentSha256 ?? "",
  ].join(":");
}

export function stableResearchEvidenceFingerprint(
  citations: readonly Pick<
    DossierCitation,
    "authority" | "sourceDocumentId" | "url" | "publishedDate" | "contentSha256"
  >[],
): { fingerprint: string; keys: string[] } {
  const keys = [...new Set(
    citations
      .map(stableResearchEvidenceKey)
      .filter((key): key is string => Boolean(key)),
  )].sort();
  return { fingerprint: sha256(JSON.stringify(keys)), keys };
}

/**
 * Decide whether today's verified state merits another frontier council.
 * This is intentionally conservative: disappearance of an old citation does
 * not suppress work, while any new or content-changed stable source does.
 * Social remains explicitly low-grade evidence, but a newly admitted social
 * narrative is still new information and therefore merits the normal council.
 */
export function assessEvidenceMateriality(
  pack: Pick<EvidencePack, "materiality">,
  priorState: EvidencePackMateriality | readonly Pick<
    DossierCitation,
    "authority" | "sourceDocumentId" | "url" | "publishedDate" | "contentSha256"
  >[] | null | undefined,
  checkedAt = Date.now(),
): EvidenceMaterialityAssessment {
  const prior = Array.isArray(priorState)
    ? { ...stableResearchEvidenceFingerprint(priorState), referencePrice: null }
    : priorState && typeof priorState === "object" && "stableEvidenceKeys" in priorState
      ? {
          fingerprint: priorState.stableEvidenceFingerprint,
          keys: [...new Set(priorState.stableEvidenceKeys)].sort(),
          referencePrice: Number.isFinite(priorState.referencePrice)
            ? priorState.referencePrice
            : null,
        }
      : { ...stableResearchEvidenceFingerprint([]), referencePrice: null };
  const currentKeys = [...new Set(pack.materiality.stableEvidenceKeys)].sort();
  const priorKeySet = new Set(prior.keys);
  const currentKeySet = new Set(currentKeys);
  const newStableEvidenceKeys = currentKeys.filter((key) => !priorKeySet.has(key));
  const removedStableEvidenceKeys = prior.keys.filter((key) => !currentKeySet.has(key));
  const dayMove = pack.materiality.dayChangePercent;
  const afterHoursMove = pack.materiality.afterHoursChangePercent;
  const currentPrice = Number.isFinite(pack.materiality.referencePrice)
    ? pack.materiality.referencePrice
    : null;
  const cumulativeChangePercent = prior.referencePrice !== null && prior.referencePrice !== 0 && currentPrice !== null
    ? ((currentPrice - prior.referencePrice) / prior.referencePrice) * 100
    : null;
  const reasons: EvidenceMaterialityAssessment["reasons"] = [];
  const hasPriorState = Array.isArray(priorState)
    ? priorState.length > 0
    : Boolean(priorState && typeof priorState === "object" && "stableEvidenceKeys" in priorState);
  if (!hasPriorState) reasons.push("no-prior-dossier");
  if (newStableEvidenceKeys.length > 0) reasons.push("new-stable-evidence");
  if (removedStableEvidenceKeys.length > 0) reasons.push("stable-evidence-removed");
  if (dayMove !== null && Math.abs(dayMove) >= MATERIAL_DAY_MOVE_PERCENT) {
    reasons.push("material-day-move");
  }
  if (afterHoursMove !== null && Math.abs(afterHoursMove) >= MATERIAL_AFTER_HOURS_MOVE_PERCENT) {
    reasons.push("material-after-hours-move");
  }
  if (cumulativeChangePercent !== null && Math.abs(cumulativeChangePercent) >= MATERIAL_DAY_MOVE_PERCENT) {
    reasons.push("material-cumulative-move");
  }
  const needsCouncil = reasons.length > 0;
  if (!needsCouncil) reasons.push("evidence-unchanged");
  const currentStableEvidenceFingerprint = sha256(JSON.stringify(currentKeys));
  const auditId = sha256(JSON.stringify({
    schema: "evidence-materiality-v2",
    priorStableEvidenceFingerprint: prior.fingerprint,
    currentStableEvidenceFingerprint,
    newStableEvidenceKeys,
    removedStableEvidenceKeys,
    priorReferencePrice: prior.referencePrice,
    currentReferencePrice: currentPrice,
    cumulativeChangePercent,
    dayMove,
    afterHoursMove,
    needsCouncil,
    reasons,
  }));
  return {
    checkedAt,
    auditId,
    needsCouncil,
    reasons,
    newStableEvidenceKeys,
    removedStableEvidenceKeys,
    priorStableEvidenceFingerprint: prior.fingerprint,
    currentStableEvidenceFingerprint,
    cumulativeChangePercent,
    dayChangePercent: dayMove,
    afterHoursChangePercent: afterHoursMove,
  };
}

export interface DeterministicEvidenceFact {
  id: string;
  kind: "market" | "filed-metric" | "filing" | "coverage";
  /** Exact complete row admitted to the council packet. */
  value: string;
  period: string | null;
  sourceIds: string[];
  recordSha256: string;
}

/** Canonical persisted Evidence Room state read by the weekly integrity job. */
export interface ClaimLedgerSnapshot {
  ticker: string;
  date: string;
  claims: LedgerClaim[];
  keys: string[];
  manifest?: EvidenceManifest;
  savedAt?: number;
  contextSha256?: string;
  revisionId?: string;
}

const useMemory = process.env.DESK_STORE === "memory";
const memLedger = ((globalThis as Record<string, unknown>).__claimLedger ??=
  new Map<string, ClaimLedgerSnapshot>()) as Map<string, ClaimLedgerSnapshot>;

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

export function claimLedgerKey(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 64);
}

export function claimLedgerRevisionId(value: Pick<ClaimLedgerSnapshot,
  "ticker" | "date" | "claims" | "keys" | "manifest" | "contextSha256">): string {
  return rawPayloadHash({
    ticker: value.ticker,
    date: value.date,
    claims: value.claims,
    keys: value.keys,
    manifest: value.manifest ?? null,
    contextSha256: value.contextSha256 ?? null,
  });
}

/** Read the existing ledger without mutating or regenerating Evidence Room state. */
export async function getClaimLedgerSnapshot(sym: string): Promise<ClaimLedgerSnapshot | null> {
  const ticker = sym.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return null;
  if (useMemory) return memLedger.get(ticker) ?? null;
  const doc = await firestore().collection("claimLedger").doc(ticker).get();
  return doc.exists ? (doc.data() as ClaimLedgerSnapshot) : null;
}

async function loadPriorLedger(sym: string): Promise<{ keys: Set<string> }> {
  try {
    if (useMemory) {
      const m = memLedger.get(sym);
      return { keys: new Set(m?.keys ?? []) };
    }
    const doc = await firestore().collection("claimLedger").doc(sym).get();
    const data = doc.exists ? (doc.data() as { keys?: string[] }) : null;
    return { keys: new Set(data?.keys ?? []) };
  } catch {
    return { keys: new Set() };
  }
}

async function saveLedger(
  sym: string,
  date: string,
  claims: LedgerClaim[],
  manifest: EvidenceManifest,
  contextSha256: string,
): Promise<void> {
  const keys = claims.map((c) => claimLedgerKey(c.statement));
  const savedAt = Date.now();
  const revisionId = claimLedgerRevisionId({ ticker: sym, date, claims, keys, manifest, contextSha256 });
  try {
    if (useMemory) {
      memLedger.set(sym, { ticker: sym, date, claims, keys, manifest, savedAt, contextSha256, revisionId });
      return;
    }
    await firestore().collection("claimLedger").doc(sym).set({
      ticker: sym,
      date,
      claims,
      keys,
      manifest,
      savedAt,
      contextSha256,
      revisionId,
    });
  } catch (e) {
    console.error(`[evidence] ledger save failed for ${sym}: ${String(e).slice(0, 120)}`);
  }
}

/** Cheap title fingerprint for near-duplicate clustering when no event id exists. */
function titleKey(title: string): string {
  const stop = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "as", "at", "by", "with", "after", "amid"]);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .sort()
    .slice(0, 6)
    .join("-");
}

interface RawItem {
  title: string;
  url: string;
  publisher: string;
  tier: string;
  sourceType?: string;
  publishedAt: number;
  eventId?: string;
  evidenceState?: string;
  observationIds?: string[];
  rawSha256?: string;
  sourceVerifiedAt?: number;
  sourceVerifiedBy?: string;
  sourceDocumentId?: string;
}

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function selectFiledItemSections(text: string, title: string): string {
  const requestedItems = [...title.matchAll(/\b\d\.\d{2}\b/g)].map((match) => match[0]);
  if (requestedItems.length === 0) return "";
  const starts = [...text.matchAll(/\bItem\s+(\d\.\d{2})\b/gi)];
  if (starts.length === 0) return "";
  const sections = starts.flatMap((match, index) => {
    if (!requestedItems.includes(match[1])) return [];
    const start = match.index ?? 0;
    const nextItem = starts[index + 1]?.index ?? text.length;
    const signatureOffset = text.slice(start, nextItem).search(/\bSIGNATURES?\b/i);
    const end = signatureOffset >= 0 ? start + signatureOffset : nextItem;
    const section = text.slice(start, end).trim();
    return section ? [section] : [];
  });
  return [...new Set(sections)].join("\n\n");
}

/** One cheap-model pass: clustered digest → structured claims. */
export function normalizeExtractedClaim(
  value: unknown,
): Omit<LedgerClaim, "id" | "duplicatesCollapsed"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = value as Record<string, unknown>;
  const statement = String(claim.statement ?? "").trim();
  const sourceIds = [...new Set(
    Array.isArray(claim.sourceIds)
      ? claim.sourceIds.map(String).filter((id) => /^S\d+$/.test(id))
      : [],
  )];
  if (statement.length < 15 || sourceIds.length === 0) return null;
  const rawEventType = String(claim.eventType ?? "other").trim().toLowerCase();
  const eventType = LEDGER_EVENT_TYPES.has(rawEventType) ? rawEventType : "other";
  const parsedRelevance = Number(claim.relevance ?? 0.5);
  const contradiction = typeof claim.contradicts === "string" ? claim.contradicts.trim() : "";
  return {
    statement,
    eventType,
    sourceIds,
    authority: (["primary", "company", "independent", "market-data", "social"] as const).includes(
      claim.authority as "primary",
    ) ? claim.authority as LedgerClaim["authority"] : "independent",
    freshness: (["today", "recent", "background"] as const).includes(claim.freshness as "today")
      ? claim.freshness as LedgerClaim["freshness"]
      : "recent",
    relevance: Number.isFinite(parsedRelevance) ? Math.min(1, Math.max(0, parsedRelevance)) : 0.5,
    ...(contradiction.length > 0 && contradiction.length <= 1_000 && !/^c?-?none\b/i.test(contradiction)
      ? { contradicts: contradiction }
      : {}),
  };
}

async function extractClaims(
  sym: string,
  digest: string
): Promise<Omit<LedgerClaim, "id" | "duplicatesCollapsed">[] | null> {
  const key = process.env.OPENROUTER_API_KEY_AMM ?? process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const sys =
    `You file evidence for an equity research desk. From the clustered evidence digest, extract the distinct FACTUAL claims that matter for ${sym}. ` +
    `Return STRICT JSON only: {"claims":[{"statement":"one plain sentence","eventType":"earnings|guidance|product|legal|macro|analyst|ownership|other",` +
    `"sourceIds":["S1"],"authority":"primary|company|independent|market-data|social","freshness":"today|recent|background","relevance":0.0,` +
    `"contradicts":"C-none-or-earlier-claim-statement-prefix"}]}. ` +
    `Rules: one claim per distinct fact (merge duplicates), max ${MAX_CLAIMS}, sourceIds must come from the digest's [S#] markers, ` +
    `relevance = how much this moves the ${sym} investment story (0-1), mark contradictions between claims when present, no advice, no speculation beyond the sources. ` +
    `A SOCIAL source may establish what a cited account posted and its sampled sentiment. It may not establish market-wide sentiment, attention acceleration, or the posted statement as company fact unless deterministic volume data or a higher-grade cited source independently confirms it.`;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aftermarketmovers.com",
        "X-Title": "AMM Evidence Room",
      },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: digest },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.error(`[evidence] extractor HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    const raw = text.replace(/```json?|```/g, "").trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (!Array.isArray(parsed.claims)) return null;
    const out: Omit<LedgerClaim, "id" | "duplicatesCollapsed">[] = [];
    for (const c of parsed.claims.slice(0, MAX_CLAIMS)) {
      const normalized = normalizeExtractedClaim(c);
      if (normalized) out.push(normalized);
    }
    return out.length > 0 ? out : null;
  } catch (e) {
    console.error(`[evidence] extractor failed: ${String(e).slice(0, 150)}`);
    return null;
  }
}

/**
 * Build the budgeted evidence pack for a ticker. Null on any failure —
 * the caller falls back to the plain bundle.
 */
export async function buildEvidencePack(sym: string, todayEt: string): Promise<EvidencePack | null> {
  const [snap, daily, filings, fundamentals, companyNews, cik, prior, socialPosts] = await Promise.all([
    getTickerSnapshot(sym),
    getBarsStored(sym),
    getFilingsStored(sym, 8),
    getFundamentalsStored(sym),
    getCompanyNews(sym, 40), // wide intake — triage decides what survives
    cikFor(sym),
    loadPriorLedger(sym),
    getRecentSocialPosts(sym).catch(() => []),
  ]);
  if (!snap) return null;

  // ---- assemble raw items (news) ----
  const rawItems: RawItem[] = [];
  await Promise.all(
    companyNews.map(async (link) => {
      const article = await getArticle(link.articleId).catch(() => null);
      if (!article) return;
      const event = article.eventId ? await getNewsEvent(article.eventId).catch(() => null) : null;
      if (event && !event.eligibleForBrief) return; // uncorroborated material news stays out
      const provenance =
        article.provenance.find((s) => s.tier === "authoritative") ??
        article.provenance.find((s) => s.tier === "licensed") ??
        article.provenance[0];
      rawItems.push({
        title: article.title,
        url: article.canonicalUrl,
        publisher: provenance?.publisher ?? article.publisher,
        tier: article.evidenceTier ?? provenance?.tier ?? "aggregated",
        sourceType: provenance?.sourceType,
        publishedAt: article.publishedAt,
        ...(article.eventId ? { eventId: article.eventId } : {}),
        ...(event ? { evidenceState: event.evidenceState, observationIds: event.observationIds } : {}),
        ...(provenance?.rawSha256 ? { rawSha256: provenance.rawSha256 } : {}),
        ...(provenance?.sourceVerification
          ? {
              sourceVerifiedAt: provenance.sourceVerification.verifiedAt,
              sourceVerifiedBy: provenance.sourceVerification.verifiedBy,
            }
          : {}),
        sourceDocumentId: article.sourceDocumentId ?? article.id,
      });
    })
  );

  // ---- mechanical clustering: event id first, title fingerprint second ----
  const clusters = new Map<string, RawItem[]>();
  for (const item of rawItems) {
    const k = item.eventId ?? `t:${titleKey(item.title)}`;
    const existing = clusters.get(k);
    if (existing) existing.push(item);
    else clusters.set(k, [item]);
  }
  const tierRank = (t: string) => (t === "authoritative" ? 0 : t === "licensed" ? 1 : 2);
  const picked: Array<{ rep: RawItem; collapsed: number; corroborator?: RawItem }> = [];
  const excluded: Array<{ title: string; reason: string }> = [];
  for (const members of clusters.values()) {
    const sorted = [...members].sort(
      (a, b) => tierRank(a.tier) - tierRank(b.tier) || a.publishedAt - b.publishedAt
    );
    const rep = sorted[0];
    const corroborator = sorted.find(
      (m) => m !== rep && m.publisher !== rep.publisher && tierRank(m.tier) <= 1
    );
    picked.push({ rep, collapsed: members.length - 1, ...(corroborator ? { corroborator } : {}) });
  }
  // stale, low-tier singletons don't earn pack space — but their exclusion is recorded
  const cutoff = Date.now() - 14 * 86_400_000;
  const kept = picked.filter(({ rep, collapsed }) => {
    if (collapsed === 0 && tierRank(rep.tier) >= 2 && rep.publishedAt < cutoff) {
      excluded.push({ title: rep.title.slice(0, 90), reason: "stale aggregated singleton (>14d, no corroboration)" });
      return false;
    }
    return true;
  });
  kept.sort((a, b) => b.rep.publishedAt - a.rep.publishedAt);

  // ---- citation index (same [S#] contract the chairman already enforces) ----
  const retrievedAt = Date.now();
  const evidence: DossierCitation[] = [];
  const addEvidence = (
    source: Omit<DossierCitation, "id" | "retrievedAt" | "sourceDocumentId"> & { sourceDocumentId?: string }
  ): string => {
    const existing = evidence.find((item) => item.url === source.url);
    if (existing) return existing.id;
    const id = `S${evidence.length + 1}`;
    evidence.push({
      id,
      retrievedAt,
      ...source,
      sourceDocumentId: source.sourceDocumentId ?? sourceDocumentIdForUrl(source.url),
    });
    return id;
  };

  const pct = (v: number | null) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
  const tapeId = addEvidence({
    title: `${snap.name} market tape`,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`,
    publisher: "Yahoo Finance market data",
    authority: "market-data",
    publishedAt: retrievedAt,
    publishedDate: isoDate(retrievedAt),
  });

  const sections: EvidencePackSection[] = [
    { id: "company", priority: 0, required: true, text: `COMPANY: ${snap.name} (${sym}), ${snap.exchange}. [${tapeId}]` },
    { id: "tape", priority: 0, required: true, text: `TAPE: last $${snap.price?.toFixed(2)}, ${pct(snap.dayChangePercent)} day, ` +
      `${snap.afterHoursChangePercent != null ? `${pct(snap.afterHoursChangePercent)} after hours` : "after hours quiet"}, ` +
      `52-week ${snap.fiftyTwoWeekLow?.toFixed(0)}–${snap.fiftyTwoWeekHigh?.toFixed(0)}. [${tapeId}]` },
  ];
  const month = daily.slice(-21);
  if (month.length > 1 && month[0].close && month[month.length - 1].close) {
    sections.push({
      id: "month-tape",
      priority: 1,
      text: `ONE-MONTH TAPE: ${pct(((month[month.length - 1].close! - month[0].close!) / month[0].close!) * 100)} over ${month.length} sessions. [${tapeId}]`,
    });
  }
  if (fundamentals) {
    const xbrlId = addEvidence({
      title: `${sym} SEC XBRL company facts — ${fundamentals.asOf}`,
      url: cik
        ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`
        : `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(sym)}`,
      publisher: "U.S. Securities and Exchange Commission",
      authority: "primary",
      publishedAt: Date.parse(`${fundamentals.asOf}T23:59:59Z`),
      publishedDate: fundamentals.asOf,
    });
    sections.push({
      id: "fundamentals",
      priority: 0,
      required: true,
      text: `FILED FUNDAMENTALS (SEC XBRL) [${xbrlId}]:\n${fundamentalsMd(sym, fundamentals)}\nSOURCE: [${xbrlId}]`,
    });
  }
  if (filings.length > 0) {
    sections.push({
      id: "filing-index",
      priority: 0,
      required: true,
      text: `OFFICIAL RECORD (SEC EDGAR, newest first):\n` +
        filings
          .map((filing) => {
            const id = addEvidence({
              title: `${sym} ${filing.formLabel} — ${filing.title}`,
              url: filing.url,
              publisher: "U.S. Securities and Exchange Commission",
              authority: "primary",
              publishedAt: filing.filedAt ?? Date.parse(`${filing.date}T12:00:00Z`),
              publishedDate: filing.date,
            });
            return `- [${id}] ${filing.formLabel} filed ${filing.date} — ${filing.title}`;
          })
          .join("\n"),
    });
    const latest8k = filings.find((f) => f.form === "8-K");
    if (latest8k) {
      const text = await fetchFilingText(latest8k.url);
      const source = evidence.find((item) => item.url === latest8k.url);
      const selected = text ? selectFiledItemSections(text, latest8k.title) : "";
      if (selected && source) {
        source.contentSha256 = sha256(selected);
        sections.push({
          id: "latest-8k-items",
          priority: 1,
          text: `LATEST 8-K FILED ITEMS (${latest8k.date}) [${source.id}]:\n${selected}\nSOURCE: [${source.id}]`,
        });
      } else {
        excluded.push({
          title: `${latest8k.formLabel} ${latest8k.date}`,
          reason: text
            ? "filed item numbers were not identifiable; no partial filing extract admitted"
            : "SEC filing body unavailable; no partial filing extract admitted",
        });
      }
    }
  }

  // news clusters → digest lines with S ids + collapse notes
  const digestLines: string[] = [];
  for (const { rep, collapsed, corroborator } of kept) {
    const repId = addEvidence({
      title: rep.title,
      url: rep.url,
      publisher: rep.publisher,
      authority: rep.sourceType === "primary" ? "primary" : "independent",
      publishedAt: rep.publishedAt,
      publishedDate: isoDate(rep.publishedAt),
      ...(rep.rawSha256 ? { contentSha256: rep.rawSha256 } : {}),
      ...(rep.sourceVerifiedAt ? { sourceVerifiedAt: rep.sourceVerifiedAt, sourceVerifiedBy: rep.sourceVerifiedBy } : {}),
      ...(rep.eventId ? { eventId: rep.eventId } : {}),
      ...(rep.observationIds ? { observationIds: rep.observationIds } : {}),
      ...(rep.evidenceState ? { evidenceState: rep.evidenceState as DossierCitation["evidenceState"] } : {}),
      ...(rep.sourceDocumentId ? { sourceDocumentId: rep.sourceDocumentId } : {}),
    });
    let line = `- [${repId}] ${rep.title} (${rep.publisher}, ${isoDate(rep.publishedAt)}${rep.evidenceState ? `, ${rep.evidenceState}` : ""})`;
    if (corroborator) {
      const corrId = addEvidence({
        title: corroborator.title,
        url: corroborator.url,
        publisher: corroborator.publisher,
        authority: "independent",
        publishedAt: corroborator.publishedAt,
        publishedDate: isoDate(corroborator.publishedAt),
        ...(corroborator.sourceDocumentId ? { sourceDocumentId: corroborator.sourceDocumentId } : {}),
      });
      line += ` — independently confirmed [${corrId}]`;
    }
    if (collapsed > 0) line += ` — ×${collapsed} duplicate report${collapsed === 1 ? "" : "s"} collapsed`;
    digestLines.push(line);
  }
  digestLines.forEach((line, index) => sections.push({
    id: `news-${index + 1}`,
    priority: 2,
    text: `${index === 0 ? "NEWS EVIDENCE (deduplicated, dated, traceable):\n" : ""}${line}`,
  }));

  // Social is a discovery/attention family, never a factual authority. Every
  // qualifying post remains in the archive; mechanically repeated narratives
  // collapse into one representative before the council sees them.
  const socialClusters = clusterSocialNarratives(socialPosts);
  const newsDuplicatesCollapsed = picked.reduce((total, item) => total + item.collapsed, 0);
  const socialDuplicatesCollapsed = socialClusters.reduce(
    (total, cluster) => total + Math.max(0, cluster.posts.length - 1),
    0,
  );
  socialClusters.forEach((cluster, index) => {
    const post = cluster.representative;
    const sourceId = addEvidence({
      title: `@${post.author} on X — social attention signal`,
      url: post.url,
      publisher: `@${post.author} · X`,
      authority: "social",
      publishedAt: Date.parse(post.createdAt) || post.pulledAt,
      publishedDate: post.publishedDate,
      sourceDocumentId: `social-x-${post.id}`,
    });
    const repeated = cluster.posts.length > 1
      ? ` · ${cluster.posts.length} similar posts collapsed · aggregate engagement ${cluster.aggregateEngagement}`
      : "";
    sections.push({
      id: `social-${index + 1}`,
      priority: 3,
      text: `${index === 0
        ? "SOCIAL ATTENTION (X · SOCIAL grade only — shows what sampled accounts are discussing; never broad sentiment, acceleration, or the posted claim as company fact):\n"
        : ""}` +
        `- [${sourceId}] @${post.author} (${post.authorFollowers.toLocaleString()} followers, engagement ${post.engagement}${repeated}): ` +
        `"${post.text.replace(/\s+/g, " ")}"`,
    });
  });

  // ---- claim extraction over the digest (one cheap call) ----
  const digestPack = packEvidenceSections(sections);
  if (digestPack.requiredExcludedIds.length > 0) {
    console.error(`[evidence] ${sym}: required sections exceed safe packet budget: ${digestPack.requiredExcludedIds.join(", ")}`);
    return null;
  }
  for (const id of digestPack.excludedIds) {
    excluded.push({ title: id, reason: "withheld by ranked prompt budget; source retained in archive" });
  }
  const digest = digestPack.text;
  const extracted = await extractClaims(sym, digest);
  const validSourceIds = new Set(evidence.map((source) => source.id));
  const claims: LedgerClaim[] = (extracted ?? []).flatMap((claim) => {
    const sourceIds = [...new Set(claim.sourceIds.filter((id) => validSourceIds.has(id)))];
    if (sourceIds.length === 0) return [];
    return [{ ...claim, id: "", sourceIds, duplicatesCollapsed: 0 }];
  }).map((claim, index) => ({ ...claim, id: `C${index + 1}` }));
  const newClaimCount = claims.filter((c) => !prior.keys.has(claimLedgerKey(c.statement))).length;

  const manifest: EvidenceManifest = {
    itemsSeen: rawItems.length + filings.length + (fundamentals ? 1 : 0) + 1 + socialPosts.length,
    clustersFormed: clusters.size + socialClusters.length,
    duplicatesCollapsed: newsDuplicatesCollapsed + socialDuplicatesCollapsed,
    included: evidence.length,
    excluded,
    social: {
      qualifiedPosts: socialPosts.length,
      narrativeClusters: socialClusters.length,
      duplicatesCollapsed: socialDuplicatesCollapsed,
      admittedNarratives: 0,
      admittedCitationIds: [],
    },
  };

  const claimLines = claims.map(
    (c) =>
      `- [${c.id}] (${c.eventType} · ${c.authority} · ${c.freshness} · rel ${c.relevance.toFixed(1)}${
        prior.keys.has(claimLedgerKey(c.statement)) ? "" : " · NEW"
      }) ${c.statement} ${c.sourceIds.map((s) => `[${s}]`).join("")}${c.contradicts ? ` — TENSION with: ${c.contradicts}` : ""}`
  );
  const contradictions = claims.filter((c) => c.contradicts);
  if (claims.length > 0) {
    sections.push({
      id: "claim-ledger",
      priority: 0,
      required: true,
      text: `CLAIM LEDGER (every distinct fact on file tonight):\n${claimLines.join("\n")}`,
    });
  }
  if (contradictions.length > 0) {
    sections.push({
      id: "contradictions",
      priority: 0,
      required: true,
      text: `CONTRADICTIONS TO RECONCILE:\n${contradictions.map((c) => `- [${c.id}] vs ${c.contradicts}`).join("\n")}`,
    });
  }
  sections.push({
    id: "coverage-manifest",
    priority: 0,
    required: true,
    text: `COVERAGE MANIFEST: ${manifest.itemsSeen} items seen · ${manifest.clustersFormed} clusters · ` +
      `${manifest.duplicatesCollapsed} duplicates collapsed · ${manifest.included} sources in pack · ` +
      `${excluded.length} excluded${excluded.length ? ` (${excluded.map((e) => e.reason).slice(0, 2).join("; ")})` : ""}.`,
  });

  const sources = [
    "Yahoo Finance market-data snapshot",
    fundamentals ? `SEC XBRL (${fundamentals.fiscal})` : null,
    filings.length ? `${filings.length} EDGAR filings` : null,
    digestLines.length ? `${digestLines.length} deduplicated news clusters (${newsDuplicatesCollapsed} duplicates collapsed)` : null,
    socialClusters.length ? `${socialClusters.length} social-attention narratives (${socialDuplicatesCollapsed} duplicates collapsed)` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const chairAddendum =
    claims.length > 0
      ? `\n\nFULL CLAIM LEDGER (reconcile every tension; note coverage gaps):\n${claimLines.join("\n")}` +
        (contradictions.length > 0
          ? `\nCONTRADICTIONS: ${contradictions.map((c) => `[${c.id}]↔${c.contradicts}`).join(" · ")}`
          : "")
      : "";

  const finalPack = packEvidenceSections(sections);
  if (finalPack.requiredExcludedIds.length > 0) {
    console.error(`[evidence] ${sym}: required final sections exceed safe packet budget: ${finalPack.requiredExcludedIds.join(", ")}`);
    return null;
  }
  for (const id of finalPack.excludedIds) {
    if (!excluded.some((item) => item.title === id)) {
      excluded.push({ title: id, reason: "withheld by ranked prompt budget; source retained in archive" });
    }
  }
  const admittedCitationIds = new Set(
    [...finalPack.text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]),
  );
  const admittedEvidence = evidence.filter((citation) => admittedCitationIds.has(citation.id));
  const stableEvidence = stableResearchEvidenceFingerprint(admittedEvidence);
  manifest.included = admittedEvidence.length;
  const socialCitationIds = new Set(
    evidence.filter((citation) => citation.authority === "social").map((citation) => citation.id),
  );
  const admittedSocialCitationIds = [...new Set(
    [...admittedCitationIds].filter((id) => socialCitationIds.has(id)),
  )];
  manifest.social = {
    ...manifest.social!,
    admittedNarratives: admittedSocialCitationIds.length,
    admittedCitationIds: admittedSocialCitationIds,
  };
  const materiality: EvidencePackMateriality = {
    stableEvidenceFingerprint: stableEvidence.fingerprint,
    stableEvidenceKeys: stableEvidence.keys,
    referencePrice: snap.price,
    dayChangePercent: snap.dayChangePercent,
    afterHoursChangePercent: snap.afterHoursChangePercent,
  };
  manifest.materiality = materiality;
  await saveLedger(sym, todayEt, claims, manifest, sha256(finalPack.text));

  const deterministicEvidence: DeterministicEvidenceFact[] = finalPack.includedIds.flatMap((sectionId) => {
    const section = sections.find((candidate) => candidate.id === sectionId);
    if (!section || !/^(?:tape|month-tape|fundamentals|filing-index|coverage-manifest)$/.test(sectionId)) return [];
    const kind: DeterministicEvidenceFact["kind"] = sectionId.includes("tape")
      ? "market"
      : sectionId === "filing-index" || sectionId === "latest-8k-items"
        ? "filing"
        : sectionId === "coverage-manifest"
          ? "coverage"
          : "filed-metric";
    return section.text.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
      const sourceIds = [...new Set([...line.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))];
      const period = line.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ??
        (sectionId === "fundamentals" ? fundamentals?.asOf ?? null : null);
      return {
        id: `D-${sectionId}-${index + 1}`,
        kind,
        value: line,
        period,
        sourceIds,
        recordSha256: sha256(JSON.stringify({ sectionId, line, period, sourceIds })),
      };
    });
  });

  return {
    context: finalPack.text,
    sources,
    evidence: admittedEvidence,
    claims,
    manifest,
    newClaimCount,
    deterministicEvidence,
    materiality,
    chairAddendum,
  };
}
