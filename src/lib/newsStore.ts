import { Firestore } from "@google-cloud/firestore";
import {
  NEWS_PIPELINE_VERSION,
  type GeneratedBriefAudit,
  type DossierCouncilRunAudit,
  type NewsRunRecord,
  type RawNewsCandidate,
  type RelevanceAssessment,
  type SourceDocument,
  type SourceObservation,
  type TraceableNewsEvent,
  type TraceableNewsArticle,
} from "./newsTypes";
import {
  articleId,
  canonicalizeUrl,
  newsEventId,
  normalizeTitle,
  provenanceFor,
  rawPayloadHash,
  sha256,
  sourceFamilyFor,
  sourceObservationId,
  titleClusterId,
} from "./newsNormalize";

const useMemory = process.env.DESK_STORE === "memory";
const memory = ((globalThis as Record<string, unknown>).__traceableNewsStore ??= {
  runs: new Map<string, NewsRunRecord>(),
  articles: new Map<string, TraceableNewsArticle>(),
  observations: new Map<string, SourceObservation>(),
  documents: new Map<string, SourceDocument>(),
  events: new Map<string, TraceableNewsEvent>(),
  generatedBriefs: new Map<string, GeneratedBriefAudit>(),
  dossierCouncilRuns: new Map<string, DossierCouncilRunAudit>(),
  companyNews: new Map<string, Map<string, CompanyNewsLink>>(),
  decisions: new Map<string, Record<string, unknown>>(),
  deadLetters: new Map<string, Record<string, unknown>>(),
  leases: new Map<string, { owner: string; expiresAt: number }>(),
  checkpoints: new Map<string, Record<string, unknown>>(),
  sourceHealth: new Map<string, Record<string, unknown>>(),
}) as {
  runs: Map<string, NewsRunRecord>;
  articles: Map<string, TraceableNewsArticle>;
  observations: Map<string, SourceObservation>;
  documents: Map<string, SourceDocument>;
  events: Map<string, TraceableNewsEvent>;
  generatedBriefs: Map<string, GeneratedBriefAudit>;
  dossierCouncilRuns: Map<string, DossierCouncilRunAudit>;
  companyNews: Map<string, Map<string, CompanyNewsLink>>;
  decisions: Map<string, Record<string, unknown>>;
  deadLetters: Map<string, Record<string, unknown>>;
  leases: Map<string, { owner: string; expiresAt: number }>;
  checkpoints: Map<string, Record<string, unknown>>;
  sourceHealth: Map<string, Record<string, unknown>>;
};
// Dev hot reload can preserve a store created by an older module version.
memory.sourceHealth ??= new Map<string, Record<string, unknown>>();
memory.observations ??= new Map<string, SourceObservation>();
memory.documents ??= new Map<string, SourceDocument>();
memory.events ??= new Map<string, TraceableNewsEvent>();
memory.generatedBriefs ??= new Map<string, GeneratedBriefAudit>();
memory.dossierCouncilRuns ??= new Map<string, DossierCouncilRunAudit>();

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

function isExpiredFirestoreTransaction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /referenced transaction has expired|transaction has expired|transaction.*no longer valid/i
    .test(message);
}

async function retryExpiredFirestoreTransaction<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !isExpiredFirestoreTransaction(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** (attempt - 1)));
    }
  }
  throw new Error("unreachable Firestore transaction retry state");
}

export interface CompanyNewsLink {
  articleId: string;
  sourceDocumentId: string;
  eventId: string;
  clusterId: string;
  title: string;
  canonicalUrl: string;
  publisher: string;
  publishedAt: number;
  category: TraceableNewsArticle["category"];
  material: boolean;
  evidenceTier: TraceableNewsArticle["evidenceTier"];
  assessment: RelevanceAssessment;
  firstSeenAt: number;
  lastSeenAt: number;
  runIds: string[];
}

export interface CandidateDecision {
  runId: string;
  ticker: string;
  companyName?: string;
  candidate: RawNewsCandidate;
  assessment: RelevanceAssessment;
}

export interface NewsDeadLetter {
  id: string;
  runId: string;
  ticker?: string;
  stage: string;
  error: string;
  payloadHash?: string;
  decision?: CandidateDecision;
  attempts: number;
  status: "pending" | "resolved" | "abandoned";
  createdAt: number;
  nextAttemptAt: number;
  lockedBy?: string | null;
  lockUntil?: number;
  resolvedAt?: number;
  resolvedRunId?: string;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueProvenance(
  values: TraceableNewsArticle["provenance"],
): TraceableNewsArticle["provenance"] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.provider}:${item.providerId ?? ""}:${item.rawSha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-100);
}

function strongestTier(
  values: Array<TraceableNewsArticle["evidenceTier"] | undefined>,
): TraceableNewsArticle["evidenceTier"] {
  if (values.includes("authoritative")) return "authoritative";
  if (values.includes("licensed")) return "licensed";
  return "discovery";
}

function payloadPolicy(candidate: RawNewsCandidate): SourceObservation["payloadPolicy"] {
  if (candidate.tier === "authoritative") return "public-payload";
  if (candidate.tier === "licensed" && process.env.STORE_LICENSED_NEWS_PAYLOADS === "true") {
    return "licensed-payload";
  }
  return "hash-only";
}

function buildObservation(decision: CandidateDecision): SourceObservation {
  const candidate = decision.candidate;
  const policy = payloadPolicy(candidate);
  return {
    id: sourceObservationId(decision.runId, decision.ticker, candidate),
    runId: decision.runId,
    ticker: decision.ticker.toUpperCase(),
    provider: candidate.provider,
    sourceFamily: sourceFamilyFor(candidate),
    tier: candidate.tier,
    ...(candidate.providerId ? { providerId: candidate.providerId } : {}),
    operation: candidate.operation ?? "upsert",
    title: candidate.title.trim(),
    publisher: candidate.publisher,
    sourceType: candidate.sourceType,
    sourceUrl: candidate.url,
    canonicalUrl: canonicalizeUrl(candidate.url),
    publishedAt: candidate.publishedAt,
    ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
    fetchedAt: candidate.fetchedAt,
    query: candidate.query,
    rawSha256: candidate.rawSha256 ?? rawPayloadHash(candidate.raw),
    payloadPolicy: policy,
    ...(policy !== "hash-only" && candidate.raw !== undefined ? { rawPayload: candidate.raw } : {}),
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
}

async function saveSourceObservation(decision: CandidateDecision): Promise<SourceObservation> {
  const observation = buildObservation(decision);
  if (useMemory) {
    if (!memory.observations.has(observation.id)) {
      memory.observations.set(observation.id, structuredClone(observation));
    }
    return observation;
  }
  const ref = firestore().collection("source_observations").doc(observation.id);
  try {
    await ref.create(observation);
  } catch (error) {
    // Deterministic IDs make retrying a partially failed run safe. Firestore
    // uses gRPC code 6 / ALREADY_EXISTS for an immutable duplicate.
    const code = (error as { code?: number | string } | null)?.code;
    if (code !== 6 && code !== "6" && code !== "already-exists") throw error;
  }
  return observation;
}

function buildArticle(
  candidate: RawNewsCandidate,
  ticker: string,
  assessment: RelevanceAssessment,
  now: number,
  observationId: string,
): TraceableNewsArticle {
  const id = articleId(candidate);
  const retainSummary = candidate.tier === "authoritative" ||
    (candidate.tier === "licensed" && process.env.STORE_LICENSED_NEWS_SUMMARIES === "true");
  return {
    id,
    sourceDocumentId: id,
    eventId: newsEventId(candidate, ticker, assessment.category),
    clusterId: titleClusterId(candidate.title),
    canonicalUrl: canonicalizeUrl(candidate.url),
    title: candidate.title.trim(),
    normalizedTitle: normalizeTitle(candidate.title),
    publisher: candidate.publisher,
    publishedAt: candidate.publishedAt,
    firstSeenAt: now,
    lastSeenAt: now,
    ...(retainSummary && candidate.summary ? { summary: candidate.summary.trim() } : {}),
    symbols: uniqueStrings([ticker.toUpperCase(), ...(candidate.symbols ?? []).map((s) => s.toUpperCase())]),
    category: assessment.category,
    material: assessment.material,
    evidenceTier: candidate.tier,
    relevance: { [ticker.toUpperCase()]: assessment },
    provenance: [provenanceFor(candidate, observationId)],
    observationIds: [observationId],
    observationCount: 1,
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
}

function mergeArticle(
  existing: TraceableNewsArticle,
  incoming: TraceableNewsArticle,
): TraceableNewsArticle {
  const existingVersionAt = Math.max(...existing.provenance.map((item) => item.updatedAt ?? item.fetchedAt), 0);
  const incomingVersionAt = Math.max(...incoming.provenance.map((item) => item.updatedAt ?? item.fetchedAt), 0);
  const incomingIsNewer = incomingVersionAt >= existingVersionAt;
  const summary = incomingIsNewer
    ? incoming.summary ?? existing.summary
    : existing.summary ?? incoming.summary;
  return {
    ...existing,
    sourceDocumentId: existing.sourceDocumentId ?? incoming.sourceDocumentId,
    eventId: existing.eventId ?? incoming.eventId,
    title: incomingIsNewer ? incoming.title : existing.title,
    normalizedTitle: incomingIsNewer ? incoming.normalizedTitle : existing.normalizedTitle,
    publisher: incomingIsNewer ? incoming.publisher : existing.publisher,
    lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
    publishedAt: Math.min(existing.publishedAt, incoming.publishedAt),
    ...(summary ? { summary } : {}),
    symbols: uniqueStrings([...existing.symbols, ...incoming.symbols]),
    material: existing.material || incoming.material,
    evidenceTier: strongestTier([existing.evidenceTier, incoming.evidenceTier]),
    relevance: { ...existing.relevance, ...incoming.relevance },
    provenance: uniqueProvenance([...existing.provenance, ...incoming.provenance]),
    observationIds: uniqueStrings([
      ...(existing.observationIds ?? existing.provenance.flatMap((item) => item.observationId ? [item.observationId] : [])),
      ...incoming.observationIds,
    ]).slice(-100),
    observationCount: (existing.observationCount ?? existing.provenance.length) + 1,
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
}

function buildSourceDocument(
  article: TraceableNewsArticle,
  observation: SourceObservation,
): SourceDocument {
  return {
    id: article.sourceDocumentId,
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    normalizedTitle: article.normalizedTitle,
    publisher: article.publisher,
    sourceType: observation.sourceType,
    publishedAt: article.publishedAt,
    ...(observation.updatedAt ? { updatedAt: observation.updatedAt } : {}),
    firstSeenAt: article.firstSeenAt,
    lastSeenAt: article.lastSeenAt,
    status: observation.operation === "withdraw" ? "withdrawn" : "active",
    symbols: article.symbols,
    evidenceTier: article.evidenceTier,
    sourceFamilies: [observation.sourceFamily],
    authoritativeSourceFamilies: observation.tier === "authoritative" ? [observation.sourceFamily] : [],
    licensedSourceFamilies: observation.tier === "licensed" ? [observation.sourceFamily] : [],
    discoverySourceFamilies: observation.tier === "discovery" ? [observation.sourceFamily] : [],
    observationIds: [observation.id],
    currentRawSha256: observation.rawSha256,
    revisions: [{
      observationId: observation.id,
      rawSha256: observation.rawSha256,
      operation: observation.operation,
      observedAt: observation.fetchedAt,
      ...(observation.updatedAt ? { updatedAt: observation.updatedAt } : {}),
    }],
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
}

function mergeSourceDocument(
  existing: SourceDocument,
  incoming: SourceDocument,
): SourceDocument {
  const revisionKeys = new Set<string>();
  const revisions = [...(existing.revisions ?? []), ...incoming.revisions]
    .filter((revision) => {
      const key = `${revision.operation}:${revision.rawSha256}:${revision.updatedAt ?? 0}`;
      if (revisionKeys.has(key)) return false;
      revisionKeys.add(key);
      return true;
    })
    .sort((a, b) => a.observedAt - b.observedAt)
    .slice(-100);
  const latest = revisions.at(-1) ?? incoming.revisions[0];
  const updatedAt = Math.max(existing.updatedAt ?? 0, incoming.updatedAt ?? 0);
  return {
    ...existing,
    title: incoming.title,
    normalizedTitle: incoming.normalizedTitle,
    publisher: incoming.publisher,
    sourceType: incoming.sourceType,
    publishedAt: Math.min(existing.publishedAt, incoming.publishedAt),
    ...(updatedAt ? { updatedAt } : {}),
    firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
    status: latest.operation === "withdraw" ? "withdrawn" : "active",
    symbols: uniqueStrings([...existing.symbols, ...incoming.symbols]),
    evidenceTier: strongestTier([existing.evidenceTier, incoming.evidenceTier]),
    sourceFamilies: uniqueStrings([...(existing.sourceFamilies ?? []), ...incoming.sourceFamilies]),
    authoritativeSourceFamilies: uniqueStrings([
      ...(existing.authoritativeSourceFamilies ?? (existing.evidenceTier === "authoritative" ? existing.sourceFamilies : [])),
      ...incoming.authoritativeSourceFamilies,
    ]),
    licensedSourceFamilies: uniqueStrings([
      ...(existing.licensedSourceFamilies ?? (existing.evidenceTier === "licensed" ? existing.sourceFamilies : [])),
      ...incoming.licensedSourceFamilies,
    ]),
    discoverySourceFamilies: uniqueStrings([
      ...(existing.discoverySourceFamilies ?? (existing.evidenceTier === "discovery" ? existing.sourceFamilies : [])),
      ...incoming.discoverySourceFamilies,
    ]),
    observationIds: uniqueStrings([...(existing.observationIds ?? []), ...incoming.observationIds]).slice(-100),
    currentRawSha256: latest.rawSha256,
    revisions,
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
}

function evidenceStateFor(input: {
  documents: SourceDocument[];
  material: boolean;
}): Pick<TraceableNewsEvent,
  "evidenceState" | "eligibleForBrief" | "authoritativeSources" | "independentLicensedSources"
> {
  const active = input.documents.filter((document) => document.status === "active");
  if (active.length === 0) {
    return {
      evidenceState: "withdrawn",
      eligibleForBrief: false,
      authoritativeSources: 0,
      independentLicensedSources: 0,
    };
  }
  const authoritativeFamilies = new Set(active.flatMap((document) =>
    document.authoritativeSourceFamilies ??
      (document.evidenceTier === "authoritative" ? document.sourceFamilies : [])
  ));
  const authoritativeSources = authoritativeFamilies.size;
  const licensedFamilies = new Set(active.flatMap((document) =>
    document.licensedSourceFamilies ??
      (document.evidenceTier === "licensed" ? document.sourceFamilies : [])
  ));
  const independentLicensedSources = licensedFamilies.size;
  if (authoritativeSources > 0) {
    return { evidenceState: "verified", eligibleForBrief: true, authoritativeSources, independentLicensedSources };
  }
  if (independentLicensedSources >= 2) {
    return { evidenceState: "corroborated", eligibleForBrief: true, authoritativeSources, independentLicensedSources };
  }
  if (independentLicensedSources === 1) {
    return {
      evidenceState: "reported",
      // Material claims need an official record or two independent licensed
      // families. Lower-stakes reported items remain usable with attribution.
      eligibleForBrief: !input.material,
      authoritativeSources,
      independentLicensedSources,
    };
  }
  return {
    evidenceState: "discovery",
    eligibleForBrief: false,
    authoritativeSources,
    independentLicensedSources,
  };
}

function buildEvent(
  article: TraceableNewsArticle,
  documents: SourceDocument[],
): TraceableNewsEvent {
  const evidence = evidenceStateFor({ documents, material: article.material });
  return {
    id: article.eventId,
    ticker: article.symbols[0],
    clusterId: article.clusterId,
    category: article.category,
    title: article.title,
    normalizedTitle: article.normalizedTitle,
    material: article.material,
    eventAt: article.publishedAt,
    firstSeenAt: article.firstSeenAt,
    lastSeenAt: article.lastSeenAt,
    ...evidence,
    sourceDocumentIds: uniqueStrings(documents.map((document) => document.id)),
    observationIds: uniqueStrings(documents.flatMap((document) => document.observationIds)).slice(-200),
    sourceFamilies: uniqueStrings(documents.flatMap((document) => document.sourceFamilies)),
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
}

function mergeEvent(
  existing: TraceableNewsEvent,
  incoming: TraceableNewsEvent,
  documents: SourceDocument[],
): TraceableNewsEvent {
  const material = existing.material || incoming.material;
  const evidence = evidenceStateFor({ documents, material });
  return {
    ...existing,
    title: incoming.title,
    normalizedTitle: incoming.normalizedTitle,
    material,
    eventAt: Math.min(existing.eventAt, incoming.eventAt),
    firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
    ...evidence,
    sourceDocumentIds: uniqueStrings([...existing.sourceDocumentIds, ...incoming.sourceDocumentIds]),
    observationIds: uniqueStrings([...existing.observationIds, ...incoming.observationIds]).slice(-200),
    sourceFamilies: uniqueStrings([...existing.sourceFamilies, ...incoming.sourceFamilies]),
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
}

export async function createNewsRun(run: NewsRunRecord): Promise<void> {
  if (useMemory) {
    memory.runs.set(run.id, structuredClone(run));
    return;
  }
  await firestore().collection("news_runs").doc(run.id).create(run);
}

export async function updateNewsRun(run: NewsRunRecord): Promise<void> {
  if (useMemory) {
    memory.runs.set(run.id, structuredClone(run));
    return;
  }
  await firestore().collection("news_runs").doc(run.id).set(run, { merge: true });
}

export async function saveCandidateDecision(decision: CandidateDecision): Promise<SourceObservation> {
  // Observations are written before relevance decisions so rejected candidates
  // remain fully auditable and later classifier changes can be replayed.
  const observation = await saveSourceObservation(decision);
  const provenance = provenanceFor(decision.candidate, observation.id);
  const decisionId = sha256(
    `${decision.ticker}:${decision.candidate.provider}:${provenance.rawSha256}`,
  ).slice(0, 40);
  const record = {
    runId: decision.runId,
    ticker: decision.ticker.toUpperCase(),
    ...(decision.companyName ? { companyName: decision.companyName } : {}),
    accepted: decision.assessment.accepted,
    assessment: decision.assessment,
    candidate: {
      provider: decision.candidate.provider,
      tier: decision.candidate.tier,
      providerId: decision.candidate.providerId ?? null,
      title: decision.candidate.title,
      sourceUrl: decision.candidate.url,
      canonicalUrl: canonicalizeUrl(decision.candidate.url),
      publisher: decision.candidate.publisher,
      sourceType: decision.candidate.sourceType,
      ...(decision.candidate.sourceVerification
        ? { sourceVerification: decision.candidate.sourceVerification }
        : {}),
      publishedAt: decision.candidate.publishedAt,
      fetchedAt: decision.candidate.fetchedAt,
      query: decision.candidate.query,
      rawSha256: decision.candidate.rawSha256 ?? rawPayloadHash(decision.candidate.raw),
    },
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
  if (useMemory) {
    memory.decisions.set(`${decision.runId}:${decisionId}`, record);
    return observation;
  }
  await firestore()
    .collection("news_runs")
    .doc(decision.runId)
    .collection("decisions")
    .doc(decisionId)
    .set(record);
  return observation;
}

export async function upsertAcceptedArticle(decision: CandidateDecision): Promise<{
  article: TraceableNewsArticle;
  created: boolean;
}> {
  const now = Date.now();
  const observation = await saveSourceObservation(decision);
  const incoming = buildArticle(
    decision.candidate,
    decision.ticker,
    decision.assessment,
    now,
    observation.id,
  );
  const symbol = decision.ticker.toUpperCase();

  if (useMemory) {
    const existing = memory.articles.get(incoming.id);
    const article = existing ? mergeArticle(existing, incoming) : incoming;
    memory.articles.set(article.id, structuredClone(article));
    const incomingDocument = buildSourceDocument(article, observation);
    const existingDocument = memory.documents.get(incomingDocument.id);
    const document = existingDocument
      ? mergeSourceDocument(existingDocument, incomingDocument)
      : incomingDocument;
    memory.documents.set(document.id, structuredClone(document));
    const existingEvent = memory.events.get(article.eventId);
    const eventDocumentIds = uniqueStrings([
      ...(existingEvent?.sourceDocumentIds ?? []),
      document.id,
    ]);
    const eventDocuments = eventDocumentIds.flatMap((id) => {
      const item = memory.documents.get(id);
      return item ? [item] : [];
    });
    const incomingEvent = buildEvent(article, eventDocuments);
    const event = existingEvent
      ? mergeEvent(existingEvent, incomingEvent, eventDocuments)
      : incomingEvent;
    memory.events.set(event.id, structuredClone(event));
    const company = memory.companyNews.get(symbol) ?? new Map<string, CompanyNewsLink>();
    const previous = company.get(article.id);
    company.set(article.id, {
      articleId: article.id,
      sourceDocumentId: document.id,
      eventId: event.id,
      clusterId: article.clusterId,
      title: article.title,
      canonicalUrl: article.canonicalUrl,
      publisher: article.publisher,
      publishedAt: article.publishedAt,
      category: article.category,
      material: article.material,
      evidenceTier: article.evidenceTier,
      assessment: decision.assessment,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      runIds: uniqueStrings([...(previous?.runIds ?? []), decision.runId]),
    });
    memory.companyNews.set(symbol, company);
    return { article, created: !existing };
  }

  const database = firestore();
  const articleRef = database.collection("news_articles").doc(incoming.id);
  const documentRef = database.collection("source_documents").doc(incoming.sourceDocumentId);
  const eventRef = database.collection("news_events").doc(incoming.eventId);
  const companyRef = database
    .collection("companies")
    .doc(symbol)
    .collection("news")
    .doc(incoming.id);
  return retryExpiredFirestoreTransaction(() => database.runTransaction(async (transaction) => {
    // Fetch transaction documents in batches. Calling transaction.get() for every
    // source document can turn a large event merge into dozens of RPCs and let the
    // Firestore transaction expire under licensed-provider volume.
    const [articleSnapshot, companySnapshot, documentSnapshot, eventSnapshot] =
      await transaction.getAll(articleRef, companyRef, documentRef, eventRef);
    const created = !articleSnapshot.exists;
    const article = articleSnapshot.exists
      ? mergeArticle(articleSnapshot.data() as TraceableNewsArticle, incoming)
      : incoming;
    const incomingDocument = buildSourceDocument(article, observation);
    const document = documentSnapshot.exists
      ? mergeSourceDocument(documentSnapshot.data() as SourceDocument, incomingDocument)
      : incomingDocument;
    const existingEvent = eventSnapshot.exists
      ? eventSnapshot.data() as TraceableNewsEvent
      : null;
    const otherDocumentIds = (existingEvent?.sourceDocumentIds ?? [])
      .filter((id) => id !== document.id)
      .slice(-50);
    const otherDocumentRefs = otherDocumentIds.map((id) =>
      database.collection("source_documents").doc(id)
    );
    const otherDocumentSnapshots = otherDocumentRefs.length > 0
      ? await transaction.getAll(...otherDocumentRefs)
      : [];
    const eventDocuments = [
      ...otherDocumentSnapshots.flatMap((snapshot) =>
        snapshot.exists ? [snapshot.data() as SourceDocument] : []),
      document,
    ];
    const incomingEvent = buildEvent(article, eventDocuments);
    const event = existingEvent
      ? mergeEvent(existingEvent, incomingEvent, eventDocuments)
      : incomingEvent;
    const oldLink = companySnapshot.exists
      ? (companySnapshot.data() as CompanyNewsLink)
      : null;
    const link: CompanyNewsLink = {
      articleId: article.id,
      sourceDocumentId: document.id,
      eventId: event.id,
      clusterId: article.clusterId,
      title: article.title,
      canonicalUrl: article.canonicalUrl,
      publisher: article.publisher,
      publishedAt: article.publishedAt,
      category: article.category,
      material: article.material,
      evidenceTier: article.evidenceTier,
      assessment: decision.assessment,
      firstSeenAt: oldLink?.firstSeenAt ?? now,
      lastSeenAt: now,
      runIds: uniqueStrings([...(oldLink?.runIds ?? []), decision.runId]).slice(-20),
    };
    transaction.set(articleRef, article);
    transaction.set(documentRef, document);
    transaction.set(eventRef, event);
    transaction.set(companyRef, link);
    return { article, created };
  }));
}

export async function saveDeadLetter(input: {
  runId: string;
  ticker?: string;
  stage: string;
  error: string;
  payloadHash?: string;
  decision?: CandidateDecision;
  retryDelayMs?: number;
}): Promise<void> {
  const id = sha256(
    `${input.runId}:${input.ticker ?? ""}:${input.stage}:${input.payloadHash ?? input.error}`,
  ).slice(0, 40);
  const replayDecision = input.decision ? (() => {
    const { raw, ...candidate } = input.decision!.candidate;
    return {
      runId: input.decision!.runId,
      ticker: input.decision!.ticker,
      ...(input.decision!.companyName ? { companyName: input.decision!.companyName } : {}),
      assessment: input.decision!.assessment,
      candidate: {
        ...candidate,
        rawSha256: input.decision!.candidate.rawSha256 ?? rawPayloadHash(raw),
      },
    };
  })() : undefined;
  const record = {
    runId: input.runId,
    ...(input.ticker ? { ticker: input.ticker.toUpperCase() } : {}),
    stage: input.stage,
    error: input.error,
    ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
    ...(replayDecision ? { decision: replayDecision } : {}),
    attempts: 0,
    status: "pending",
    createdAt: Date.now(),
    nextAttemptAt: Date.now() + (input.retryDelayMs ?? 5 * 60_000),
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
  if (useMemory) {
    memory.deadLetters.set(id, record);
    return;
  }
  await firestore().collection("news_dead_letters").doc(id).set(record, { merge: true });
}

/** Claim replayable dead letters without hiding them from other workers after a crash. */
export async function claimPendingDeadLetters(
  owner: string,
  limit = 25,
): Promise<NewsDeadLetter[]> {
  const now = Date.now();
  const lockUntil = now + 10 * 60_000;
  if (useMemory) {
    const claimed: NewsDeadLetter[] = [];
    for (const [id, raw] of memory.deadLetters) {
      if (claimed.length >= limit) break;
      const record = raw as unknown as NewsDeadLetter;
      if (record.status !== "pending" || record.stage !== "persist-candidate" || !record.decision) continue;
      if (record.nextAttemptAt > now || (record.lockUntil ?? 0) > now) continue;
      const updated = { ...record, id, lockedBy: owner, lockUntil };
      memory.deadLetters.set(id, updated as unknown as Record<string, unknown>);
      claimed.push(structuredClone(updated));
    }
    return claimed;
  }
  const candidates = await firestore()
    .collection("news_dead_letters")
    .where("status", "==", "pending")
    .limit(500)
    .get();
  const claimed: NewsDeadLetter[] = [];
  for (const document of candidates.docs) {
    if (claimed.length >= limit) break;
    const ref = document.ref;
    const value = await firestore().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return null;
      const record = snapshot.data() as NewsDeadLetter;
      if (record.stage !== "persist-candidate" || !record.decision ||
          record.nextAttemptAt > now || (record.lockUntil ?? 0) > now) return null;
      transaction.set(ref, { lockedBy: owner, lockUntil }, { merge: true });
      return { ...record, id: snapshot.id, lockedBy: owner, lockUntil };
    });
    if (value) claimed.push(value);
  }
  return claimed;
}

export async function resolveDeadLetter(id: string, runId: string): Promise<void> {
  const patch = {
    status: "resolved",
    resolvedAt: Date.now(),
    resolvedRunId: runId,
    lockedBy: null,
    lockUntil: 0,
  };
  if (useMemory) {
    const existing = memory.deadLetters.get(id);
    if (existing) memory.deadLetters.set(id, { ...existing, ...patch });
    return;
  }
  await firestore().collection("news_dead_letters").doc(id).set(patch, { merge: true });
}

export async function rescheduleDeadLetter(id: string, owner: string, error: string): Promise<void> {
  const now = Date.now();
  if (useMemory) {
    const existing = memory.deadLetters.get(id) as (Record<string, unknown> & { attempts?: number; lockedBy?: string }) | undefined;
    if (!existing || existing.lockedBy !== owner) return;
    const attempts = (existing.attempts ?? 0) + 1;
    memory.deadLetters.set(id, {
      ...existing,
      attempts,
      status: attempts >= 5 ? "abandoned" : "pending",
      error: error.slice(0, 500),
      nextAttemptAt: now + Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** attempts),
      lockedBy: null,
      lockUntil: 0,
    });
    return;
  }
  const ref = firestore().collection("news_dead_letters").doc(id);
  await firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.lockedBy !== owner) return;
    const attempts = Number(snapshot.data()?.attempts ?? 0) + 1;
    transaction.set(ref, {
      attempts,
      status: attempts >= 5 ? "abandoned" : "pending",
      error: error.slice(0, 500),
      nextAttemptAt: now + Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** attempts),
      lockedBy: null,
      lockUntil: 0,
    }, { merge: true });
  });
}

/** A later successful recollection closes older ticker-level collection failures. */
export async function resolveCollectionDeadLetters(ticker: string, runId: string): Promise<void> {
  const symbol = ticker.toUpperCase();
  const now = Date.now();
  if (useMemory) {
    for (const [id, record] of memory.deadLetters) {
      if (record.ticker === symbol &&
          (record.stage === "collect-ticker" || record.stage === "save-checkpoint") &&
          record.status === "pending") {
        memory.deadLetters.set(id, {
          ...record,
          status: "resolved",
          resolvedAt: now,
          resolvedRunId: runId,
        });
      }
    }
    return;
  }
  const snapshot = await firestore()
    .collection("news_dead_letters")
    .where("ticker", "==", symbol)
    .limit(100)
    .get();
  const batch = firestore().batch();
  for (const document of snapshot.docs) {
    const record = document.data();
    if ((record.stage === "collect-ticker" || record.stage === "save-checkpoint") &&
        record.status === "pending") {
      batch.set(document.ref, { status: "resolved", resolvedAt: now, resolvedRunId: runId }, { merge: true });
    }
  }
  await batch.commit();
}

export async function getCompanyNews(
  ticker: string,
  limit = 50,
): Promise<CompanyNewsLink[]> {
  const symbol = ticker.toUpperCase();
  if (useMemory) {
    return [...(memory.companyNews.get(symbol)?.values() ?? [])]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, limit);
  }
  const snapshot = await firestore()
    .collection("companies")
    .doc(symbol)
    .collection("news")
    .orderBy("publishedAt", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map((document) => document.data() as CompanyNewsLink);
}

export async function getArticle(articleIdValue: string): Promise<TraceableNewsArticle | null> {
  if (useMemory) return memory.articles.get(articleIdValue) ?? null;
  const snapshot = await firestore().collection("news_articles").doc(articleIdValue).get();
  return snapshot.exists ? (snapshot.data() as TraceableNewsArticle) : null;
}

export async function getSourceObservation(id: string): Promise<SourceObservation | null> {
  if (useMemory) return memory.observations.get(id) ?? null;
  const snapshot = await firestore().collection("source_observations").doc(id).get();
  return snapshot.exists ? (snapshot.data() as SourceObservation) : null;
}

export async function getSourceDocument(id: string): Promise<SourceDocument | null> {
  if (useMemory) return memory.documents.get(id) ?? null;
  const snapshot = await firestore().collection("source_documents").doc(id).get();
  return snapshot.exists ? (snapshot.data() as SourceDocument) : null;
}

export async function getNewsEvent(id: string): Promise<TraceableNewsEvent | null> {
  if (useMemory) return memory.events.get(id) ?? null;
  const snapshot = await firestore().collection("news_events").doc(id).get();
  return snapshot.exists ? (snapshot.data() as TraceableNewsEvent) : null;
}

export async function saveGeneratedBriefAudit(
  audit: GeneratedBriefAudit,
): Promise<void> {
  if (useMemory) {
    if (!memory.generatedBriefs.has(audit.id)) {
      memory.generatedBriefs.set(audit.id, structuredClone(audit));
    }
    return;
  }
  // The content-addressed ID makes dossier retries idempotent while preserving
  // every materially different generated brief.
  try {
    await firestore().collection("generated_briefs").doc(audit.id).create(audit);
  } catch (error) {
    const code = (error as { code?: number | string } | null)?.code;
    if (code !== 6 && code !== "6" && code !== "already-exists") throw error;
  }
}

export async function getGeneratedBriefAudit(id: string): Promise<GeneratedBriefAudit | null> {
  if (useMemory) return memory.generatedBriefs.get(id) ?? null;
  const snapshot = await firestore().collection("generated_briefs").doc(id).get();
  return snapshot.exists ? (snapshot.data() as GeneratedBriefAudit) : null;
}

/** Preserve the exact evidence and complete deliberation behind a dossier. */
export async function saveDossierCouncilRun(
  run: DossierCouncilRunAudit,
): Promise<void> {
  if (useMemory) {
    if (!memory.dossierCouncilRuns.has(run.id)) {
      memory.dossierCouncilRuns.set(run.id, structuredClone(run));
    }
    return;
  }
  try {
    await firestore().collection("dossier_council_runs").doc(run.id).create(run);
  } catch (error) {
    const code = (error as { code?: number | string } | null)?.code;
    if (code !== 6 && code !== "6" && code !== "already-exists") throw error;
  }
}

export async function getDossierCouncilRun(id: string): Promise<DossierCouncilRunAudit | null> {
  if (useMemory) return memory.dossierCouncilRuns.get(id) ?? null;
  const snapshot = await firestore().collection("dossier_council_runs").doc(id).get();
  return snapshot.exists ? (snapshot.data() as DossierCouncilRunAudit) : null;
}

export async function acquirePipelineLease(
  leaseId: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const now = Date.now();
  if (useMemory) {
    const lease = memory.leases.get(leaseId);
    if (lease && lease.expiresAt > now && lease.owner !== owner) return false;
    memory.leases.set(leaseId, { owner, expiresAt: now + ttlMs });
    return true;
  }
  const ref = firestore().collection("pipeline_leases").doc(leaseId);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existing = snapshot.exists
      ? (snapshot.data() as { owner?: string; expiresAt?: number })
      : null;
    if (existing?.expiresAt && existing.expiresAt > now && existing.owner !== owner) return false;
    transaction.set(ref, {
      owner,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + ttlMs,
    });
    return true;
  });
}

export async function renewPipelineLease(
  leaseId: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const now = Date.now();
  if (useMemory) {
    const lease = memory.leases.get(leaseId);
    if (!lease || lease.owner !== owner) return false;
    memory.leases.set(leaseId, { owner, expiresAt: now + ttlMs });
    return true;
  }
  const ref = firestore().collection("pipeline_leases").doc(leaseId);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.owner !== owner) return false;
    transaction.set(ref, { heartbeatAt: now, expiresAt: now + ttlMs }, { merge: true });
    return true;
  });
}

export async function releasePipelineLease(leaseId: string, owner: string): Promise<void> {
  if (useMemory) {
    if (memory.leases.get(leaseId)?.owner === owner) memory.leases.delete(leaseId);
    return;
  }
  const ref = firestore().collection("pipeline_leases").doc(leaseId);
  await firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists && snapshot.data()?.owner === owner) transaction.delete(ref);
  });
}

export async function saveNewsCheckpoint(input: {
  ticker: string;
  runId: string;
  attemptedAt: number;
  successfulAt?: number;
  newestPublishedAt?: number;
  providers: Record<string, {
    tier?: "authoritative" | "licensed" | "discovery";
    active?: boolean;
    fetched: number;
    error?: string;
  }>;
}): Promise<void> {
  const ticker = input.ticker.toUpperCase();
  const record = { ...input, ticker, pipelineVersion: NEWS_PIPELINE_VERSION };
  if (useMemory) {
    memory.checkpoints.set(ticker, record);
    return;
  }
  await firestore().collection("news_checkpoints").doc(ticker).set(record, { merge: true });
}

export async function updateSourceHealth(input: {
  provider: string;
  tier: "authoritative" | "licensed" | "discovery";
  ticker: string;
  runId: string;
  attemptedAt: number;
  successful: boolean;
  nonEmpty: boolean;
  fetched: number;
  durationMs: number;
  error?: string;
}): Promise<void> {
  const patch = {
    provider: input.provider,
    tier: input.tier,
    ticker: input.ticker.toUpperCase(),
    runId: input.runId,
    lastAttemptAt: input.attemptedAt,
    lastFetched: input.fetched,
    lastDurationMs: input.durationMs,
    lastStatus: input.successful ? "success" : "error",
    ...(input.successful ? { lastSuccessAt: input.attemptedAt } : {}),
    ...(input.nonEmpty ? { lastNonEmptyAt: input.attemptedAt } : {}),
    ...(input.error ? { lastError: input.error } : {}),
    pipelineVersion: NEWS_PIPELINE_VERSION,
  };
  const id = `${input.provider}--${input.ticker.toUpperCase()}`;
  if (useMemory) {
    memory.sourceHealth.set(id, { ...(memory.sourceHealth.get(id) ?? {}), ...patch });
    return;
  }
  await firestore().collection("source_health").doc(id).set(patch, { merge: true });
}

export async function getNewsPipelineHealth(): Promise<{
  checkedAt: number;
  runs: NewsRunRecord[];
  checkpoints: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  pendingDeadLetters: Record<string, unknown>[];
}> {
  const checkedAt = Date.now();
  if (useMemory) {
    return {
      checkedAt,
      runs: [...memory.runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10),
      checkpoints: [...memory.checkpoints.values()],
      sources: [...memory.sourceHealth.values()],
      pendingDeadLetters: [...memory.deadLetters.entries()]
        .filter(([, item]) => item.status === "pending" || item.status === "abandoned")
        .map(([id, item]) => ({ id, ...item })),
    };
  }
  const [runs, checkpoints, sources, deadLetters] = await Promise.all([
    firestore().collection("news_runs").orderBy("startedAt", "desc").limit(10).get(),
    firestore().collection("news_checkpoints").limit(500).get(),
    firestore().collection("source_health").limit(500).get(),
    firestore().collection("news_dead_letters").where("status", "in", ["pending", "abandoned"]).limit(100).get(),
  ]);
  return {
    checkedAt,
    runs: runs.docs.map((document) => document.data() as NewsRunRecord),
    checkpoints: checkpoints.docs.map((document) => ({ id: document.id, ...document.data() })),
    sources: sources.docs.map((document) => ({ id: document.id, ...document.data() })),
    pendingDeadLetters: deadLetters.docs.map((document) => ({ id: document.id, ...document.data() })),
  };
}
