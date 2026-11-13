import { Firestore } from "@google-cloud/firestore";
import { listAllDesks, type Desk } from "@/lib/desk";
import { companyFleetSnapshot } from "@/lib/companyFleet";
import {
  DOSSIER_ARTIFACT_VERSION,
  calculateDossierCitationCoverage,
  dossierReleaseValidationError,
  getCachedDossier,
  isDetailedDossier,
  type Dossier,
  type DossierCitation,
} from "@/lib/dossier";
import {
  claimLedgerKey,
  claimLedgerRevisionId,
  getClaimLedgerSnapshot,
  type ClaimLedgerSnapshot,
} from "@/lib/evidenceRoom";
import { sha256 } from "@/lib/newsNormalize";
import { getDossierCouncilRun, getGeneratedBriefAudit } from "@/lib/newsStore";
import type { DossierCouncilRunAudit, GeneratedBriefAudit } from "@/lib/newsTypes";

export const EVIDENCE_RECONCILIATION_SCHEMA = "evidence-reconciliation-v1" as const;
export const EVIDENCE_RECONCILIATION_COLLECTION = "evidence_reconciliation_audits";

type CheckStatus = "pass" | "fail" | "deferred";

export interface EvidenceReconciliationCheck {
  code: string;
  status: CheckStatus;
}

/**
 * Compact, content-addressed integrity receipt. It intentionally stores only
 * lineage IDs, hashes and counts: the dossier, ledger and generation audits
 * remain the one canonical evidence system.
 */
export interface EvidenceReconciliationAudit {
  id: string;
  schema: typeof EVIDENCE_RECONCILIATION_SCHEMA;
  ticker: string;
  dossierDate: string;
  dossierGeneratedAt: number;
  checkedAt: number;
  checkedDate: string;
  result: "consistent" | "inconsistent";
  briefAuditId: string;
  councilRunId: string;
  checks: EvidenceReconciliationCheck[];
  lineage: {
    claimLedgerDate: string;
    claimIds: string[];
    citationIds: string[];
    sourceDocumentIds: string[];
    eventIds: string[];
    observationIds: string[];
    contentSha256: string;
    evidenceSha256: string;
    websiteSha256: string;
    emailHookSha256: string;
    latestClaimLedgerSha256: string;
    publishedClaimLedgerSha256: string;
    generatedBriefAuditSha256: string;
    councilRunAuditSha256: string;
    generationAuditPayloadSha256: string;
    councilContextSha256: string;
  };
  fingerprintSha256: string;
}

export interface EvidenceReconciliationResult {
  requestedTicker: string | null;
  watchedTickers: number;
  processed: string[];
  consistent: string[];
  inconsistent: string[];
  audits: Array<{ ticker: string; id: string; result: EvidenceReconciliationAudit["result"] }>;
  errors: string[];
}

export class EvidenceReconciliationRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
    this.name = "EvidenceReconciliationRequestError";
  }
}

export interface EvidenceReconciliationDependencies {
  listAllDesks: () => Promise<Desk[]>;
  getCachedDossier: (ticker: string) => Promise<Dossier | null>;
  getClaimLedgerSnapshot: (ticker: string) => Promise<ClaimLedgerSnapshot | null>;
  getGeneratedBriefAudit: (id: string) => Promise<GeneratedBriefAudit | null>;
  getDossierCouncilRun: (id: string) => Promise<DossierCouncilRunAudit | null>;
  getDossierGenerationAudit: (id: string) => Promise<LoadedDossierGenerationAudit | null>;
  saveAudit: (audit: EvidenceReconciliationAudit) => Promise<void>;
  now: () => number;
}

export interface LoadedDossierGenerationAudit {
  record: unknown;
  payloadSha256: string;
  storage: "memory" | "inline" | "chunks";
}

const useMemory = process.env.DESK_STORE === "memory";
const memoryAudits = ((globalThis as Record<string, unknown>).__evidenceReconciliationAudits ??=
  new Map<string, EvidenceReconciliationAudit>()) as Map<string, EvidenceReconciliationAudit>;

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

async function saveEvidenceReconciliationAudit(audit: EvidenceReconciliationAudit): Promise<void> {
  if (useMemory) {
    if (!memoryAudits.has(audit.id)) memoryAudits.set(audit.id, structuredClone(audit));
    return;
  }
  try {
    await firestore().collection(EVIDENCE_RECONCILIATION_COLLECTION).doc(audit.id).create(audit);
  } catch (error) {
    const code = (error as { code?: number | string } | null)?.code;
    if (code !== 6 && code !== "6" && code !== "already-exists") throw error;
  }
}

export function decodeInlineDossierGenerationAudit(
  data: Record<string, unknown>,
): LoadedDossierGenerationAudit {
  const payloadSha256 = String(data.payloadSha256 ?? "");
  let serialized: string;
  let record: unknown;
  if (data.encoding === "json-string-inline-v2" && typeof data.payloadJson === "string") {
    serialized = data.payloadJson;
    try { record = JSON.parse(serialized); }
    catch { throw new Error("inline generation audit payload is not valid JSON"); }
  } else if (data.encoding === "json-inline-v1" && "payload" in data) {
    // Legacy best-effort reader. v2 stores exact bytes because Firestore map
    // ordering itself is not an integrity boundary.
    record = data.payload;
    serialized = JSON.stringify(record);
  } else {
    throw new Error("missing inline generation audit payload");
  }
  if (!/^[a-f0-9]{64}$/.test(payloadSha256) || sha256(serialized) !== payloadSha256 ||
      Buffer.byteLength(serialized, "utf8") !== data.payloadBytes) {
    throw new Error("inline generation audit payload failed reconstruction hash");
  }
  return { record, payloadSha256, storage: "inline" };
}

async function getDossierGenerationAudit(id: string): Promise<LoadedDossierGenerationAudit | null> {
  if (!/^[a-f0-9]{48}$/.test(id)) return null;
  if (useMemory) {
    const store = (globalThis as Record<string, unknown>).__dossierGenerationAudits as Map<string, unknown> | undefined;
    const record = store?.get(id);
    if (record === undefined) return null;
    return { record, payloadSha256: sha256(JSON.stringify(record)), storage: "memory" };
  }
  const root = firestore().collection("dossier_generation_audits").doc(id);
  const snapshot = await root.get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() as Record<string, unknown>;
  const payloadSha256 = String(data.payloadSha256 ?? "");
  if (!/^[a-f0-9]{64}$/.test(payloadSha256)) throw new Error("invalid generation audit payload hash");
  if (data.encoding === "json-inline-v1" || data.encoding === "json-string-inline-v2") {
    return decodeInlineDossierGenerationAudit(data);
  }
  if (data.encoding !== "utf8-json-base64-parts-v1" || !Number.isInteger(data.chunks) || Number(data.chunks) < 1) {
    throw new Error("unsupported generation audit encoding");
  }
  const expectedChunks = Number(data.chunks);
  const parts = await root.collection("parts").orderBy("index", "asc").get();
  if (parts.size !== expectedChunks) throw new Error("incomplete generation audit parts");
  const buffers = parts.docs.map((document, index) => {
    const part = document.data() as Record<string, unknown>;
    const base64 = String(part.base64 ?? "");
    if (part.index !== index || document.id !== String(index).padStart(4, "0") ||
        part.chunkSha256 !== sha256(base64)) {
      throw new Error("invalid generation audit part lineage");
    }
    const decoded = Buffer.from(base64, "base64");
    if (decoded.byteLength !== part.bytes) throw new Error("invalid generation audit part length");
    return decoded;
  });
  const serialized = Buffer.concat(buffers).toString("utf8");
  if (Buffer.byteLength(serialized, "utf8") !== data.payloadBytes || sha256(serialized) !== payloadSha256) {
    throw new Error("generation audit payload failed reconstruction hash");
  }
  return { record: JSON.parse(serialized), payloadSha256, storage: "chunks" };
}

const defaultDependencies: EvidenceReconciliationDependencies = {
  listAllDesks,
  getCachedDossier,
  getClaimLedgerSnapshot,
  getGeneratedBriefAudit,
  getDossierCouncilRun,
  getDossierGenerationAudit,
  saveAudit: saveEvidenceReconciliationAudit,
  now: Date.now,
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function manifestFor(citations: DossierCitation[]): GeneratedBriefAudit["citationManifest"] {
  return citations.map((source) => ({
    id: source.id,
    title: source.title,
    url: source.url,
    publisher: source.publisher,
    authority: source.authority,
    publishedAt: source.publishedAt,
    retrievedAt: source.retrievedAt,
    sourceDocumentId: source.sourceDocumentId,
    ...(source.contentSha256 ? { contentSha256: source.contentSha256 } : {}),
    ...(source.eventId ? { eventId: source.eventId } : {}),
    ...(source.observationIds ? { observationIds: source.observationIds } : {}),
  }));
}

function websiteCardsFor(dossier: Dossier): Record<string, unknown> {
  return {
    headline: dossier.headline,
    story: dossier.story,
    bulls: dossier.bulls,
    bears: dossier.bears,
    risk: dossier.risk,
    numbersRead: dossier.numbersRead,
    signalCase: {
      eventType: dossier.signalCase.eventType,
      direction: dossier.signalCase.direction,
      strength: dossier.signalCase.strength,
      horizonSessions: {
        min: dossier.signalCase.horizonSessions.min,
        max: dossier.signalCase.horizonSessions.max,
      },
      mechanism: dossier.signalCase.mechanism,
      invalidation: dossier.signalCase.invalidation,
    },
  };
}

/** Rebuild the exact property order used before the immutable hook hash is written. */
function emailHookForHash(dossier: Dossier): Record<string, unknown> {
  const hook = dossier.emailHook;
  return {
    subjectPunchline: hook.subjectPunchline,
    priorUpdate: hook.priorUpdate ? { status: hook.priorUpdate.status, text: hook.priorUpdate.text } : null,
    whatChanged: hook.whatChanged,
    thesis: hook.thesis,
    question: hook.question,
    primaryEvidence: hook.primaryEvidence,
    secondaryEvidence: hook.secondaryEvidence,
    signal: {
      eventType: hook.signal.eventType,
      direction: hook.signal.direction,
      strength: hook.signal.strength,
      horizonSessions: { min: hook.signal.horizonSessions.min, max: hook.signal.horizonSessions.max },
    },
    votesSupport: hook.votesSupport,
    votesOppose: hook.votesOppose,
    votesUncertain: hook.votesUncertain,
    votesTotal: hook.votesTotal,
    votes: {
      support: hook.votes.support,
      oppose: hook.votes.oppose,
      uncertain: hook.votes.uncertain,
    },
    confidence: {
      majorityReason: hook.confidence.majorityReason,
      dissentReason: hook.confidence.dissentReason,
      uncertaintyReason: hook.confidence.uncertaintyReason,
      flipCondition: hook.confidence.flipCondition,
    },
    oracle: {
      type: hook.oracle.type,
      trigger: hook.oracle.trigger,
      dueBy: hook.oracle.dueBy,
    },
    editorialStrength: {
      novelty: hook.editorialStrength.novelty,
      materiality: hook.editorialStrength.materiality,
      evidence: hook.editorialStrength.evidence,
      asymmetry: hook.editorialStrength.asymmetry,
      score: hook.editorialStrength.score,
    },
  };
}

function exactStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function exactCalendarDate(value: string): boolean {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isStoragePointer(value: string): boolean {
  return /^\[exact (?:context|response|attempts)/.test(value);
}

function addCheck(checks: EvidenceReconciliationCheck[], code: string, status: CheckStatus): void {
  checks.push({ code, status });
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

interface PublishedGenerationView {
  raw: Record<string, unknown>;
  shared: Record<string, unknown>;
  publishedClaims: ClaimLedgerSnapshot["claims"];
  publishedManifest: ClaimLedgerSnapshot["manifest"];
  context: string;
  evidence: DossierCitation[];
  seats: Array<Record<string, unknown>>;
  website: Record<string, unknown>;
  emailDraftCheckpoint: Record<string, unknown>;
  emailDraft: Record<string, unknown>;
  ballots: Array<Record<string, unknown>>;
  confidence: Record<string, unknown>;
  confidenceCheckpoint: Record<string, unknown>;
  final: Record<string, unknown>;
}

function publishedGenerationView(value: unknown): PublishedGenerationView | null {
  const raw = recordValue(value);
  const shared = recordValue(raw?.shared);
  const website = recordValue(raw?.website);
  const emailDraftCheckpoint = recordValue(raw?.emailDraft);
  const emailDraft = recordValue(emailDraftCheckpoint?.artifact);
  const confidenceCheckpoint = recordValue(raw?.confidence);
  const confidence = recordValue(confidenceCheckpoint?.artifact);
  const final = recordValue(raw?.final);
  if (!raw || raw.schema !== "dossier-generation-audit-v1" || raw.status !== "published" ||
      !shared || !website || !emailDraftCheckpoint || !emailDraft ||
      !confidenceCheckpoint || !confidence || !final ||
      typeof shared.context !== "string" || !Array.isArray(shared.evidence) ||
      !Array.isArray(shared.claims) || !Array.isArray(shared.seats) || !Array.isArray(raw.ballots)) return null;
  return {
    raw,
    shared,
    publishedClaims: shared.claims as ClaimLedgerSnapshot["claims"],
    publishedManifest: recordValue(shared.evidenceManifest) as unknown as ClaimLedgerSnapshot["manifest"],
    context: shared.context,
    evidence: shared.evidence as DossierCitation[],
    seats: shared.seats as Array<Record<string, unknown>>,
    website,
    emailDraftCheckpoint,
    emailDraft,
    ballots: raw.ballots as Array<Record<string, unknown>>,
    confidence,
    confidenceCheckpoint,
    final,
  };
}

function attemptsFrom(artifact: Record<string, unknown>): Array<Record<string, unknown>> | null {
  return Array.isArray(artifact.attempts) ? artifact.attempts as Array<Record<string, unknown>> : null;
}

function reconstructCouncilPreimage(view: PublishedGenerationView, ticker: string, date: string): {
  councilRunId: string;
  websiteChairAuditRaw: string;
  emailChairAuditRaw: string;
  websiteInput: string;
  websiteInputSha256: string;
  emailInput: string;
  emailInputSha256: string;
} | null {
  const websiteAttempts = attemptsFrom(view.website);
  const draftAttempts = attemptsFrom(view.emailDraft);
  const confidenceAttempts = attemptsFrom(view.confidence);
  if (!websiteAttempts?.length || !draftAttempts?.length || !confidenceAttempts?.length ||
      view.seats.some((seat) => typeof seat.model !== "string" || typeof seat.response !== "string")) return null;
  const ballotRows = view.ballots.map((ballot) => ({
    family: ballot.family,
    model: ballot.model,
    position: ballot.position,
    propositionSha256: ballot.propositionSha256,
    evidencePacketSha256: ballot.evidencePacketSha256,
    attempts: ballot.attempts,
  }));
  if (ballotRows.some((ballot) => typeof ballot.family !== "string" || typeof ballot.model !== "string" ||
      !["SUPPORT", "OPPOSE", "UNCERTAIN"].includes(String(ballot.position)) || !Array.isArray(ballot.attempts))) return null;
  const websiteRawResponse = String(view.website.rawResponse ?? "");
  const emailRawResponse = JSON.stringify({
    draftAttemptResponseSha256: draftAttempts.map((attempt) => attempt.rawResponseSha256),
    ballotResponseSha256: ballotRows.map((ballot) =>
      (ballot.attempts as Array<Record<string, unknown>>).map((attempt) => attempt.rawResponseSha256)),
    confidenceAttemptResponseSha256: confidenceAttempts.map((attempt) => attempt.rawResponseSha256),
  });
  const evidencePacketSha256 = String(ballotRows[0]?.evidencePacketSha256 ?? "");
  const propositionSha256 = String(view.emailDraftCheckpoint.propositionSha256 ?? "");
  if (!/^[a-f0-9]{64}$/.test(evidencePacketSha256) || !/^[a-f0-9]{64}$/.test(propositionSha256) ||
      typeof view.emailDraftCheckpoint.key !== "string" || typeof view.confidenceCheckpoint.key !== "string" ||
      ballotRows.some((ballot) => ballot.evidencePacketSha256 !== evidencePacketSha256 ||
        ballot.propositionSha256 !== propositionSha256)) return null;
  const emailInput = JSON.stringify({
    draftKey: view.emailDraftCheckpoint.key,
    propositionSha256,
    evidencePacketSha256,
    confidenceKey: view.confidenceCheckpoint.key,
  });
  const councilRunId = sha256(JSON.stringify({
    ticker,
    date,
    contextSha256: sha256(view.context),
    seats: view.seats.map((seat) => ({ model: seat.model, responseSha256: sha256(String(seat.response)) })),
    websiteResponseSha256: sha256(websiteRawResponse),
    emailResponseSha256: sha256(emailRawResponse),
  })).slice(0, 48);
  return {
    councilRunId,
    websiteInput: String(view.website.input ?? ""),
    websiteInputSha256: String(websiteAttempts[0].inputSha256 ?? ""),
    emailInput,
    emailInputSha256: String(draftAttempts[0].inputSha256 ?? ""),
    websiteChairAuditRaw: JSON.stringify({ attempts: websiteAttempts }),
    emailChairAuditRaw: JSON.stringify({
      draftAndConfidenceAttempts: [...draftAttempts, ...confidenceAttempts],
      ballots: ballotRows,
    }),
  };
}

function validateLedger(
  ledger: ClaimLedgerSnapshot,
  dossier: Dossier,
  citationIds: string[],
  publishedClaims: ClaimLedgerSnapshot["claims"],
  publishedManifest: ClaimLedgerSnapshot["manifest"],
  publishedContextSha256: string,
  checkedAt: number,
  checkedDate: string,
  checks: EvidenceReconciliationCheck[],
): void {
  const claimShape = (claim: ClaimLedgerSnapshot["claims"][number], index: number): boolean =>
    Boolean(claim && claim.id === `C${index + 1}` && typeof claim.statement === "string" && claim.statement.trim().length >= 15 &&
      ["earnings", "guidance", "product", "legal", "macro", "analyst", "ownership", "other"].includes(claim.eventType) &&
      ["primary", "company", "independent", "market-data", "social"].includes(claim.authority) &&
      ["today", "recent", "background"].includes(claim.freshness) && Number.isFinite(claim.relevance) &&
      claim.relevance >= 0 && claim.relevance <= 1 && Number.isInteger(claim.duplicatesCollapsed) &&
      claim.duplicatesCollapsed >= 0 && (claim.contradicts === undefined ||
        (typeof claim.contradicts === "string" && claim.contradicts.trim().length > 0 && claim.contradicts.length <= 1_000)) &&
      exactStrings(claim.sourceIds) && claim.sourceIds.length > 0 &&
      new Set(claim.sourceIds).size === claim.sourceIds.length && claim.sourceIds.every((id) => /^S\d+$/.test(id)));
  const pointerAdvanced = Number.isFinite(ledger.savedAt) && Number(ledger.savedAt) > dossier.generatedAt &&
    Number(ledger.savedAt) <= checkedAt;
  addCheck(checks, "ledger.identity", ledger.ticker === dossier.ticker && exactCalendarDate(ledger.date) &&
    ledger.date <= checkedDate && (!pointerAdvanced ? ledger.date === dossier.date : ledger.date >= dossier.date) ? "pass" : "fail");
  const currentClaimsValid = Array.isArray(ledger.claims) && ledger.claims.every(claimShape);
  addCheck(checks, "ledger.current-shape", currentClaimsValid ? "pass" : "fail");
  const expectedKeys = Array.isArray(ledger.claims)
    ? ledger.claims.map((claim) => claimLedgerKey(claim.statement))
    : [];
  addCheck(checks, "ledger.claim-keys", exactStrings(ledger.keys) && sameValue(ledger.keys, expectedKeys) ? "pass" : "fail");
  addCheck(checks, "ledger.saved-at", Number.isFinite(ledger.savedAt) && Number(ledger.savedAt) > 0 &&
    Number(ledger.savedAt) <= checkedAt ? "pass" : "fail");
  const currentManifestValid = Boolean(ledger.manifest &&
    [ledger.manifest.itemsSeen, ledger.manifest.clustersFormed, ledger.manifest.duplicatesCollapsed, ledger.manifest.included]
      .every((value) => Number.isInteger(value) && value >= 0) && Array.isArray(ledger.manifest.excluded) &&
    ledger.manifest.excluded.every((item) => typeof item?.title === "string" && typeof item.reason === "string"));
  addCheck(checks, "ledger.current-manifest-shape", currentManifestValid ? "pass" : "fail");
  const revisionValid = typeof ledger.contextSha256 === "string" && /^[a-f0-9]{64}$/.test(ledger.contextSha256) &&
    typeof ledger.revisionId === "string" && ledger.revisionId === claimLedgerRevisionId(ledger);
  addCheck(checks, "ledger.content-addressed-revision", revisionValid ? "pass" : "fail");

  const publishedClaimsValid = Array.isArray(publishedClaims) && publishedClaims.every((claim, index) =>
    claimShape(claim, index) && claim.sourceIds.every((id) => citationIds.includes(id)));
  addCheck(checks, "ledger.published-claim-source-ids", publishedClaimsValid ? "pass" : "fail");
  addCheck(checks, "ledger.published-coverage-manifest", publishedManifest &&
    Number.isInteger(publishedManifest.included) && publishedManifest.included === citationIds.length ? "pass" : "fail");
  // A newer failed/rejected attempt may legitimately advance the mutable
  // latest pointer. The exact published snapshot is bound by the immutable
  // generation audit; only a non-advanced pointer is required to match it.
  addCheck(checks, "ledger.latest-pointer-binding", pointerAdvanced || (
    sameValue(ledger.claims, publishedClaims) && sameValue(ledger.manifest, publishedManifest) &&
    ledger.contextSha256 === publishedContextSha256
  ) ? "pass" : "fail");
}

function validateCouncil(
  council: DossierCouncilRunAudit,
  dossier: Dossier,
  citationIds: string[],
  generation: PublishedGenerationView,
  preimage: NonNullable<ReturnType<typeof reconstructCouncilPreimage>>,
  brief: GeneratedBriefAudit,
  checks: EvidenceReconciliationCheck[],
): void {
  addCheck(checks, "council.identity", (
    council.id === dossier.councilRunId && council.ticker === dossier.ticker &&
    council.date === dossier.date && council.generatedAt === dossier.generatedAt &&
    council.artifactVersion === DOSSIER_ARTIFACT_VERSION
  ) ? "pass" : "fail");
  addCheck(checks, "council.content-addressed-id", preimage.councilRunId === council.id ? "pass" : "fail");
  addCheck(checks, "council.citation-ids", sameValue(council.selectedEvidence?.citationIds, citationIds) ? "pass" : "fail");

  const context = council.selectedEvidence?.context;
  if (typeof context !== "string" || !/^[a-f0-9]{64}$/.test(council.selectedEvidence?.contextSha256 ?? "")) {
    addCheck(checks, "council.context-hash", "fail");
  } else if (isStoragePointer(context)) {
    const expectedPointer = `[exact context stored in dossier_generation_audits/${council.id}]`;
    addCheck(checks, "council.context-hash", context === expectedPointer &&
      sha256(generation.context) === council.selectedEvidence.contextSha256 &&
      generation.context.length === council.selectedEvidence.contextChars ? "pass" : "fail");
  } else {
    addCheck(checks, "council.context-hash", sha256(context) === council.selectedEvidence.contextSha256 &&
      council.selectedEvidence.contextChars === context.length && context === generation.context ? "pass" : "fail");
  }

  const seatsValid = Array.isArray(council.seats) && council.seats.length === dossier.seats &&
    council.seats.length === generation.seats.length && council.seats.every((seat, index) => {
      const source = generation.seats[index];
      const expectedHash = sha256(String(source.response ?? ""));
      const expectedPointer = `[exact response stored in dossier_generation_audits/${council.id}; sha256 ${seat.responseSha256}]`;
      return typeof seat.response === "string" && /^[a-f0-9]{64}$/.test(seat.responseSha256) &&
        source.role === seat.role && source.model === seat.model && expectedHash === seat.responseSha256 &&
        (isStoragePointer(seat.response) ? seat.response === expectedPointer : seat.response === source.response);
    });
  addCheck(checks, "council.seat-hashes", seatsValid ? "pass" : "fail");

  for (const [code, chair, expectedRaw, expectedPointer, expectedInput, expectedInputSha256, expectedModel, expectedPrompt] of [
    ["council.website-chair-hash", council.websiteChairman, preimage.websiteChairAuditRaw,
      `[exact attempts stored in dossier_generation_audits/${council.id}]`, preimage.websiteInput,
      preimage.websiteInputSha256, brief.generator.chairman, brief.generator.promptVersion],
    ["council.email-chair-hash", council.emailChairman, preimage.emailChairAuditRaw,
      `[exact attempts and ballots stored in dossier_generation_audits/${council.id}]`, preimage.emailInput,
      preimage.emailInputSha256, brief.generator.emailChairman, brief.generator.emailPromptVersion],
  ] as const) {
    const validHashFields = /^[a-f0-9]{64}$/.test(chair.inputSha256) &&
      /^[a-f0-9]{64}$/.test(chair.responseSha256) && typeof chair.rawResponse === "string";
    if (!validHashFields) addCheck(checks, code, "fail");
    else addCheck(checks, code, chair.input === expectedInput && chair.inputSha256 === expectedInputSha256 &&
      chair.model === expectedModel && chair.promptVersion === expectedPrompt &&
      sha256(expectedRaw) === chair.responseSha256 &&
      (isStoragePointer(chair.rawResponse) ? chair.rawResponse === expectedPointer : chair.rawResponse === expectedRaw)
      ? "pass" : "fail");
  }
}

/** Deterministically reconcile one already-published dossier; never calls an LLM. */
export function reconcileEvidenceArtifacts(input: {
  dossier: Dossier;
  ledger: ClaimLedgerSnapshot;
  brief: GeneratedBriefAudit;
  council: DossierCouncilRunAudit;
  generationAudit: LoadedDossierGenerationAudit;
  checkedAt: number;
}): EvidenceReconciliationAudit {
  const { dossier, ledger, brief, council, generationAudit, checkedAt } = input;
  const checkedDate = new Date(checkedAt).toISOString().slice(0, 10);
  const checks: EvidenceReconciliationCheck[] = [];
  const releaseError = dossierReleaseValidationError(dossier);
  addCheck(checks, "dossier.strict-v5", releaseError === null ? "pass" : "fail");

  const citations = dossier.citations ?? [];
  const citationManifest = manifestFor(citations);
  const citationIds = citations.map((citation) => citation.id);
  const sourceDocumentIds = unique(citations.map((citation) => citation.sourceDocumentId));
  const eventIds = unique(citations.flatMap((citation) => citation.eventId ? [citation.eventId] : []));
  const observationIds = unique(citations.flatMap((citation) => citation.observationIds ?? []));
  const evidenceSha256 = sha256(JSON.stringify(citationManifest));
  const websiteSha256 = sha256(JSON.stringify(websiteCardsFor(dossier)));
  const emailHookSha256 = sha256(JSON.stringify(emailHookForHash(dossier)));
  const contentSha256 = sha256(JSON.stringify({
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    ticker: dossier.ticker,
    date: dossier.date,
    websiteSha256,
    emailHookSha256,
  }));
  const briefAuditId = sha256(`${dossier.ticker}:${dossier.date}:${contentSha256}:${evidenceSha256}`).slice(0, 48);

  addCheck(checks, "brief.identity", (
    brief.id === dossier.briefAuditId && brief.id === briefAuditId &&
    brief.ticker === dossier.ticker && brief.date === dossier.date &&
    brief.generatedAt === dossier.generatedAt && brief.kind === "dossier" &&
    brief.artifactVersion === DOSSIER_ARTIFACT_VERSION && brief.councilRunId === dossier.councilRunId
  ) ? "pass" : "fail");
  addCheck(checks, "brief.citation-manifest", sameValue(brief.citationManifest, citationManifest) ? "pass" : "fail");
  addCheck(checks, "brief.citation-ids", sameValue(brief.citationIds, citationIds) ? "pass" : "fail");
  addCheck(checks, "brief.source-document-ids", sameValue(brief.sourceDocumentIds, sourceDocumentIds) ? "pass" : "fail");
  addCheck(checks, "brief.event-ids", sameValue(brief.eventIds, eventIds) ? "pass" : "fail");
  addCheck(checks, "brief.observation-ids", sameValue(brief.observationIds, observationIds) ? "pass" : "fail");
  addCheck(checks, "brief.evidence-hash", brief.evidenceSha256 === evidenceSha256 ? "pass" : "fail");
  addCheck(checks, "brief.website-hash", brief.websiteSha256 === websiteSha256 ? "pass" : "fail");
  addCheck(checks, "brief.email-hook-hash", brief.emailHookSha256 === emailHookSha256 ? "pass" : "fail");
  addCheck(checks, "brief.content-hash", brief.contentSha256 === contentSha256 ? "pass" : "fail");
  const coverage = calculateDossierCitationCoverage(dossier);
  addCheck(checks, "brief.citation-coverage", sameValue(brief.citationCoverage, coverage) ? "pass" : "fail");

  const generation = publishedGenerationView(generationAudit.record);
  const preimage = generation ? reconstructCouncilPreimage(generation, dossier.ticker, dossier.date) : null;
  addCheck(checks, "generation-audit.schema", generation ? "pass" : "fail");
  addCheck(checks, "generation-audit.identity", generation && (
    generation.raw.ticker === dossier.ticker && generation.raw.date === dossier.date &&
    generation.raw.generatedAt === dossier.generatedAt
  ) ? "pass" : "fail");
  addCheck(checks, "generation-audit.final", generation && sameValue(generation.final.dossier, dossier) &&
    generation.final.contentSha256 === contentSha256 && generation.final.evidenceSha256 === evidenceSha256 &&
    generation.final.websiteSha256 === websiteSha256 && generation.final.emailHookSha256 === emailHookSha256
    ? "pass" : "fail");
  addCheck(checks, "generation-audit.evidence", generation && sameValue(generation.evidence, citations) ? "pass" : "fail");
  addCheck(checks, "generation-audit.preimage", preimage ? "pass" : "fail");

  validateLedger(
    ledger,
    dossier,
    citationIds,
    generation?.publishedClaims ?? [],
    generation?.publishedManifest,
    generation ? sha256(generation.context) : "",
    checkedAt,
    checkedDate,
    checks,
  );
  if (generation && preimage) validateCouncil(council, dossier, citationIds, generation, preimage, brief, checks);
  else {
    for (const code of [
      "council.identity", "council.content-addressed-id", "council.citation-ids", "council.context-hash",
      "council.seat-hashes", "council.website-chair-hash", "council.email-chair-hash",
    ]) addCheck(checks, code, "fail");
  }

  const publishedClaims = generation?.publishedClaims ?? [];
  const publishedManifest = generation?.publishedManifest ?? null;
  const lineage = {
    claimLedgerDate: ledger.date,
    claimIds: publishedClaims.map((claim) => claim.id),
    citationIds,
    sourceDocumentIds,
    eventIds,
    observationIds,
    contentSha256,
    evidenceSha256,
    websiteSha256,
    emailHookSha256,
    latestClaimLedgerSha256: sha256(canonicalJson({
      ticker: ledger.ticker,
      date: ledger.date,
      claims: ledger.claims,
      keys: ledger.keys,
      manifest: ledger.manifest ?? null,
      savedAt: ledger.savedAt ?? null,
      contextSha256: ledger.contextSha256 ?? null,
      revisionId: ledger.revisionId ?? null,
    })),
    publishedClaimLedgerSha256: sha256(canonicalJson({
      ticker: dossier.ticker,
      date: dossier.date,
      claims: publishedClaims,
      keys: publishedClaims.map((claim) => claimLedgerKey(claim.statement)),
      manifest: publishedManifest,
    })),
    generatedBriefAuditSha256: sha256(canonicalJson(brief)),
    councilRunAuditSha256: sha256(canonicalJson(council)),
    generationAuditPayloadSha256: generationAudit.payloadSha256,
    councilContextSha256: council.selectedEvidence?.contextSha256 ?? "",
  };
  const fingerprintSha256 = sha256(canonicalJson({
    schema: EVIDENCE_RECONCILIATION_SCHEMA,
    ticker: dossier.ticker,
    dossierDate: dossier.date,
    briefAuditId: dossier.briefAuditId,
    councilRunId: dossier.councilRunId,
    checks,
    lineage,
  }));
  return {
    id: sha256(`${EVIDENCE_RECONCILIATION_SCHEMA}:${checkedDate}:${dossier.ticker}:${dossier.date}:${fingerprintSha256}`).slice(0, 48),
    schema: EVIDENCE_RECONCILIATION_SCHEMA,
    ticker: dossier.ticker,
    dossierDate: dossier.date,
    dossierGeneratedAt: dossier.generatedAt,
    checkedAt,
    checkedDate,
    result: checks.some((check) => check.status !== "pass") ? "inconsistent" : "consistent",
    briefAuditId: dossier.briefAuditId ?? "",
    councilRunId: dossier.councilRunId ?? "",
    checks,
    lineage,
    fingerprintSha256,
  };
}

export function normalizeEvidenceReconciliationTicker(raw: string): string | null {
  const ticker = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : null;
}

/** Reconcile every watched ticker, isolating failures so one bad record cannot hide the rest. */
export async function runEvidenceReconciliation(
  options: { ticker?: string | null } = {},
  dependencies: EvidenceReconciliationDependencies = defaultDependencies,
): Promise<EvidenceReconciliationResult> {
  const desks = await dependencies.listAllDesks();
  const activeDesks = desks.filter((desk) => desk.researchActive !== false);
  const invalidWatched = unique(activeDesks.flatMap((desk) => desk.tickers).filter((ticker) =>
    normalizeEvidenceReconciliationTicker(ticker) === null
  )).sort();
  const watched = companyFleetSnapshot(desks).tickers;

  let requestedTicker: string | null = null;
  if (options.ticker !== undefined && options.ticker !== null) {
    requestedTicker = normalizeEvidenceReconciliationTicker(options.ticker);
    if (!requestedTicker) throw new EvidenceReconciliationRequestError("invalid ticker", 400);
    if (!watched.includes(requestedTicker)) {
      throw new EvidenceReconciliationRequestError("ticker is not watched", 404);
    }
  }
  const tickers = requestedTicker ? [requestedTicker] : watched;
  const result: EvidenceReconciliationResult = {
    requestedTicker,
    watchedTickers: watched.length,
    processed: [],
    consistent: [],
    inconsistent: [],
    audits: [],
    errors: requestedTicker ? [] : invalidWatched.map((ticker) => `INVALID_WATCHED_TICKER:${ticker}`),
  };

  for (const ticker of tickers) {
    result.processed.push(ticker);
    try {
      const dossier = await dependencies.getCachedDossier(ticker);
      if (!isDetailedDossier(dossier)) throw new Error("missing exact strict v5 dossier");
      if (!dossier.briefAuditId || !dossier.councilRunId) throw new Error("missing dossier audit ids");
      const [ledger, brief, council, generationAudit] = await Promise.all([
        dependencies.getClaimLedgerSnapshot(ticker),
        dependencies.getGeneratedBriefAudit(dossier.briefAuditId),
        dependencies.getDossierCouncilRun(dossier.councilRunId),
        dependencies.getDossierGenerationAudit(dossier.councilRunId),
      ]);
      if (!ledger) throw new Error("missing claim ledger");
      if (!brief) throw new Error("missing generated brief audit");
      if (!council) throw new Error("missing dossier council run");
      if (!generationAudit) throw new Error("missing immutable dossier generation audit");
      const audit = reconcileEvidenceArtifacts({
        dossier,
        ledger,
        brief,
        council,
        generationAudit,
        checkedAt: dependencies.now(),
      });
      await dependencies.saveAudit(audit);
      result.audits.push({ ticker, id: audit.id, result: audit.result });
      if (audit.result === "consistent") result.consistent.push(ticker);
      else {
        result.inconsistent.push(ticker);
        const failed = audit.checks.filter((check) => check.status === "fail").map((check) => check.code);
        result.errors.push(`${ticker}:INCONSISTENT:${failed.join(",")}`);
      }
    } catch (error) {
      result.errors.push(`${ticker}:${String(error instanceof Error ? error.message : error).slice(0, 240)}`);
    }
  }
  return result;
}
