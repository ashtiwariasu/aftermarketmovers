export const NEWS_PIPELINE_VERSION = "2026-07-16.4";

export type NewsProvider =
  | "sec"
  | "rss"
  | "benzinga"
  | "alpaca"
  | "tiingo"
  | "polygon"
  | "yahoo"
  | "gdelt";
export type NewsSourceTier = "authoritative" | "licensed" | "discovery";
export type NewsObservationOperation = "upsert" | "withdraw";
export type NewsPayloadPolicy = "public-payload" | "licensed-payload" | "hash-only";
export type NewsEvidenceState = "verified" | "corroborated" | "reported" | "discovery" | "withdrawn";

export type NewsCategory =
  | "earnings"
  | "guidance"
  | "filing"
  | "regulatory"
  | "m-and-a"
  | "capital"
  | "leadership"
  | "product"
  | "legal"
  | "analyst"
  | "market"
  | "other";

export interface RawNewsCandidate {
  provider: NewsProvider;
  /** Independent upstream family. Alpaca and direct Benzinga are both benzinga. */
  sourceFamily?: string;
  tier: NewsSourceTier;
  providerId?: string;
  title: string;
  url: string;
  publishedAt: number;
  publisher: string;
  summary?: string;
  symbols?: string[];
  sourceType: "primary" | "newswire" | "publisher" | "aggregator";
  sourceVerification?: {
    sourceId: string;
    verifiedAt: number;
    verifiedBy: string;
    verifiedHost: string;
  };
  query: string;
  fetchedAt: number;
  updatedAt?: number;
  operation?: NewsObservationOperation;
  raw?: unknown;
  /** Preserves the original observation hash when replaying a dead letter. */
  rawSha256?: string;
}

export interface NewsProvenance {
  provider: NewsProvider;
  sourceFamily: string;
  tier: NewsSourceTier;
  providerId?: string;
  publisher: string;
  sourceType: RawNewsCandidate["sourceType"];
  sourceVerification?: RawNewsCandidate["sourceVerification"];
  sourceUrl: string;
  query: string;
  fetchedAt: number;
  updatedAt?: number;
  operation: NewsObservationOperation;
  rawSha256: string;
  observationId?: string;
  adapterVersion: string;
}

/** One immutable retrieval event, retained even when relevance rejects it. */
export interface SourceObservation {
  id: string;
  runId: string;
  ticker: string;
  provider: NewsProvider;
  sourceFamily: string;
  tier: NewsSourceTier;
  providerId?: string;
  operation: NewsObservationOperation;
  title: string;
  publisher: string;
  sourceType: RawNewsCandidate["sourceType"];
  sourceUrl: string;
  canonicalUrl: string;
  publishedAt: number;
  updatedAt?: number;
  fetchedAt: number;
  query: string;
  rawSha256: string;
  payloadPolicy: NewsPayloadPolicy;
  rawPayload?: unknown;
  pipelineVersion: string;
}

export interface SourceDocumentRevision {
  observationId: string;
  rawSha256: string;
  operation: NewsObservationOperation;
  observedAt: number;
  updatedAt?: number;
}

/** Canonical original document. Observations are its immutable revision log. */
export interface SourceDocument {
  id: string;
  canonicalUrl: string;
  title: string;
  normalizedTitle: string;
  publisher: string;
  sourceType: RawNewsCandidate["sourceType"];
  publishedAt: number;
  updatedAt?: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: "active" | "withdrawn";
  symbols: string[];
  evidenceTier: NewsSourceTier;
  sourceFamilies: string[];
  authoritativeSourceFamilies: string[];
  licensedSourceFamilies: string[];
  discoverySourceFamilies: string[];
  observationIds: string[];
  currentRawSha256: string;
  revisions: SourceDocumentRevision[];
  pipelineVersion: string;
}

/** A normalized company event supported by one or more original documents. */
export interface TraceableNewsEvent {
  id: string;
  ticker: string;
  clusterId: string;
  category: NewsCategory;
  title: string;
  normalizedTitle: string;
  material: boolean;
  eventAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  evidenceState: NewsEvidenceState;
  eligibleForBrief: boolean;
  sourceDocumentIds: string[];
  observationIds: string[];
  sourceFamilies: string[];
  authoritativeSources: number;
  independentLicensedSources: number;
  pipelineVersion: string;
}

export interface GeneratedBriefAudit {
  id: string;
  ticker: string;
  date: string;
  generatedAt: number;
  kind: "dossier";
  contentSha256: string;
  evidenceSha256: string;
  sourceDocumentIds: string[];
  eventIds: string[];
  observationIds: string[];
  citationIds: string[];
  citationManifest: Array<{
    id: string;
    title: string;
    url: string;
    publisher: string;
    authority: "primary" | "company" | "independent" | "market-data" | "social";
    publishedAt: number;
    retrievedAt: number;
    sourceDocumentId: string;
    contentSha256?: string;
    eventId?: string;
    observationIds?: string[];
  }>;
  citationCoverage: { claims: number; cited: number; primarySources: number };
  generator: {
    council: string;
    chairman: string;
    emailChairman?: string;
    promptVersion: string;
    emailPromptVersion?: string;
    pipelineVersion: string;
  };
  artifactVersion?: number;
  websiteSha256?: string;
  emailHookSha256?: string;
  councilRunId?: string;
}

export interface DossierCouncilRunAudit {
  id: string;
  ticker: string;
  date: string;
  generatedAt: number;
  artifactVersion: number;
  question: string;
  selectedEvidence: {
    context: string;
    contextSha256: string;
    contextChars: number;
    citationIds: string[];
  };
  seats: Array<{
    role: string;
    model: string;
    response: string;
    responseSha256: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  }>;
  websiteChairman: {
    model: string;
    promptVersion: string;
    input: string;
    inputSha256: string;
    rawResponse: string;
    responseSha256: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  };
  emailChairman: {
    model: string;
    promptVersion: string;
    input: string;
    inputSha256: string;
    rawResponse: string;
    responseSha256: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  };
}

export interface RelevanceAssessment {
  score: number;
  accepted: boolean;
  reasons: string[];
  category: NewsCategory;
  material: boolean;
}

export interface TraceableNewsArticle {
  id: string;
  sourceDocumentId: string;
  eventId: string;
  clusterId: string;
  canonicalUrl: string;
  title: string;
  normalizedTitle: string;
  publisher: string;
  publishedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  summary?: string;
  symbols: string[];
  category: NewsCategory;
  material: boolean;
  evidenceTier: NewsSourceTier;
  relevance: Record<string, RelevanceAssessment>;
  provenance: NewsProvenance[];
  observationIds: string[];
  observationCount: number;
  pipelineVersion: string;
}

export interface ProviderResult {
  provider: NewsProvider;
  tier: NewsSourceTier;
  active: boolean;
  candidates: RawNewsCandidate[];
  durationMs: number;
  error?: string;
}

export interface NewsRunRecord {
  id: string;
  pipelineVersion: string;
  /** "hourly" is retained for historical run records written before v2026-07-16.4. */
  mode: "scheduled" | "hourly" | "backfill";
  status: "running" | "completed" | "partial" | "failed";
  startedAt: number;
  finishedAt?: number;
  requestedTickers: string[];
  providerResults: Array<{
    provider: NewsProvider;
    tier: NewsSourceTier;
    active: boolean;
    fetched: number;
    durationMs: number;
    attempts: number;
    successes: number;
    failures: number;
    error?: string;
  }>;
  candidates: number;
  observations: number;
  accepted: number;
  rejected: number;
  deduplicated: number;
  persisted: number;
  eventsUpdated: number;
  recoveredDeadLetters: number;
  failedDeadLetterReplays: number;
  errors: string[];
  warnings: string[];
}
