/**
 * The daily dossier — a Morningstar-grade company read, council-authored,
 * grounded ONLY in verified sources (SEC XBRL, EDGAR filings, the tape,
 * dated wires). Generated once per company per day, shared across desks,
 * filed into each watcher's company file as dated cards.
 *
 * Deliberately absent: fair-value estimates, price targets, buy/sell/hold.
 */

import { randomUUID } from "node:crypto";
import { getRecentSocialPosts } from "@/lib/socialIntel";
import { FieldPath, Firestore, type DocumentReference } from "@google-cloud/firestore";
import { getTickerSnapshot } from "@/lib/ticker";
import { cikFor, fundamentalsMd, fetchFilingText } from "@/lib/sec";
import { callLlmc3Council } from "@/lib/councilEngine";
import {
  buildFrontierChairUser,
  FRONTIER_CONTRACT_POLICY,
  runFrontierCouncil,
  type CouncilModelUsage,
} from "@/lib/frontierCouncil";
import {
  getBarsStored,
  getDossierHistory,
  getFilingsStored,
  getFundamentalsStored,
  saveDossierHistory,
} from "@/lib/companyStore";
import {
  getArticle,
  getCompanyNews,
  getNewsEvent,
  acquirePipelineLease,
  releasePipelineLease,
  renewPipelineLease,
  saveDossierCouncilRun,
  saveGeneratedBriefAudit,
} from "@/lib/newsStore";
import { sha256, sourceDocumentIdForUrl } from "@/lib/newsNormalize";
import { NEWS_PIPELINE_VERSION } from "@/lib/newsTypes";
import {
  buildEvidencePack,
  packEvidenceSections,
  selectFiledItemSections,
  type DeterministicEvidenceFact,
  type EvidencePack,
  type EvidenceManifest,
  type LedgerClaim,
} from "@/lib/evidenceRoom";
import {
  PRIVATE_SIGNAL_OUTBOX_COLLECTION,
  buildPrivateSignalOutboxItem,
  enqueuePrivateSignalOutboxInMemory,
  enqueuePrivateSignalOutboxInTransaction,
} from "@/lib/privateSignalOutbox";
import {
  SOCIAL_EVIDENCE_SCORECARD_COLLECTION,
  buildSocialEvidenceScorecard,
  saveSocialEvidenceScorecardInMemory,
  type SocialEvidenceScorecard,
} from "@/lib/socialQuality";
import { publicResearchContentIssues } from "@/lib/notifications";
import { COUNCIL_MODELS, MODEL_POLICY_VERSION, RESEARCH_MODELS } from "@/lib/modelPolicy";

export interface DossierCitation {
  id: string;
  title: string;
  url: string;
  publisher: string;
  authority: "primary" | "company" | "independent" | "market-data" | "social";
  publishedAt: number;
  publishedDate: string;
  retrievedAt: number;
  contentSha256?: string;
  sourceVerifiedAt?: number;
  sourceVerifiedBy?: string;
  sourceDocumentId: string;
  eventId?: string;
  observationIds?: string[];
  evidenceState?: "verified" | "corroborated" | "reported" | "discovery" | "withdrawn";
}

export const DOSSIER_ARTIFACT_VERSION = 5;

export type DossierSignalDirection = "UP" | "DOWN";
export type DossierSignalStrength = "GENTLE" | "MODERATE" | "STRONG";
export type DossierSignalEventType =
  | "earnings" | "guidance" | "regulatory" | "product" | "legal"
  | "capital" | "leadership" | "macro" | "other";

export interface DossierQualitativeSignal {
  /** Stable research key for later signed/event-conditioned calibration. */
  eventType: DossierSignalEventType;
  direction: DossierSignalDirection;
  strength: DossierSignalStrength;
  /** The product horizon is fixed: roughly two to three trading weeks. */
  horizonSessions: { min: 10; max: 15 };
}

export interface DossierSignalCase extends DossierQualitativeSignal {
  /** Why the admitted change could matter over the fixed horizon. */
  mechanism: string;
  /** The observable evidence that would negate or materially weaken the read. */
  invalidation: string;
}

export type DossierPriorStatus =
  | "strengthened"
  | "weakened"
  | "resolved"
  | "invalidated"
  | "replaced"
  | "open";

export type DossierThesisObservationStatus =
  | "opened"
  | "strengthened"
  | "weakened"
  | "open";

export interface DossierPriorUpdate {
  status: DossierPriorStatus;
  text: string;
}

export interface DossierPriorThesisContext {
  lifecycleId: string;
  openedDate: string;
  openedAt: number;
  observationIndex: number;
  date: string;
  subjectPunchline: string;
  thesis: string;
  canonicalSignal: DossierQualitativeSignal;
  /** The latest admitted state, used only to classify strengthen/weaken. */
  signal: DossierQualitativeSignal;
  question: string;
  flipCondition: string;
  oracle: DossierQuestionOracle;
  votes: {
    support: number;
    oppose: number;
    uncertain: number;
    total: 5;
  };
  state: "open";
  outcomeContext: {
    status: "unresolved";
    asOfDate: string;
    note: string;
  };
}

export interface DossierThesisLifecycle {
  schemaVersion: 1;
  /** Stable across daily observations of the same public proposition. */
  id: string;
  openedDate: string;
  openedAt: number;
  observationDate: string;
  observationIndex: number;
  observationStatus: DossierThesisObservationStatus;
  /** Immutable initial proposition and forecast used by the private scorecard. */
  canonicalSubjectPunchline: string;
  canonicalThesis: string;
  canonicalQuestion: string;
  canonicalSignal: DossierQualitativeSignal;
  canonicalOracle: DossierQuestionOracle;
  canonicalVotes: {
    support: number;
    oppose: number;
    uncertain: number;
    total: 5;
  };
  /** Latest admitted strength/direction state; canonicalSignal remains scored. */
  latestSignal: DossierQualitativeSignal;
  /** Present only when this observation explicitly closes the prior lifecycle. */
  previousLifecycle?: {
    id: string;
    openedDate: string;
    status: "resolved" | "invalidated" | "replaced";
    text: string;
  };
}

export interface DossierCouncilConfidence {
  majorityReason: string;
  dissentReason: string | null;
  uncertaintyReason: string | null;
  flipCondition: string;
}

export interface DossierQuestionOracle {
  type: "filing" | "tape";
  /** The already-audited confidence flip condition; never a second model-authored test. */
  trigger: string;
  /** Latest review date. Claim-delta evidence may resolve a filing oracle earlier. */
  dueBy: string;
}

export interface DossierEmailHook {
  /** Code adds the stable AMM/ticker subject wrapper. */
  subjectPunchline: string;
  /** Honest payoff loop; null only when there is no previous thesis. */
  priorUpdate: DossierPriorUpdate | null;
  /** Beat 1 — the newly observed external trigger. */
  whatChanged: string;
  /** Beat 2 — AMM's non-obvious, falsifiable synthesis. */
  thesis: string;
  /** Stable scoreboard framing derived from the subject punchline. */
  question: string;
  /** Beat 3 — the strongest direct support plus deliberately few corroborators. */
  primaryEvidence: string;
  secondaryEvidence: string[];
  /** Qualitative only. No public percentage forecast belongs in this contract. */
  signal: DossierQualitativeSignal;
  /** Beat 4 — independently re-balloted on this exact proposition. */
  votesSupport: number;
  votesOppose: number;
  votesUncertain: number;
  votesTotal: 5;
  /** Scoreboard-compatible view of the same recorded ballots. */
  votes: {
    support: number;
    oppose: number;
    uncertain: number;
  };
  confidence: DossierCouncilConfidence;
  /** Scoreboard oracle. trigger is identical to confidence.flipCondition. */
  oracle: DossierQuestionOracle;
  /** Robust median ratings used to choose the morning hero. */
  editorialStrength: {
    novelty: number;
    materiality: number;
    evidence: number;
    asymmetry: number;
    score: number;
  };
}

export interface Dossier {
  ticker: string;
  date: string; // YYYY-MM-DD ET
  generatedAt: number;
  artifactVersion: number;
  headline: string;
  story: string;
  bulls: string[];
  bears: string[];
  risk: string;
  numbersRead: string;
  signalCase: DossierSignalCase;
  sources: string;
  citations?: DossierCitation[];
  /** Complete admitted-evidence fingerprint for deterministic change auditing. */
  evidenceManifest?: EvidenceManifest;
  citationCoverage?: { claims: number; cited: number; primarySources: number };
  briefAuditId?: string;
  councilRunId?: string;
  emailHook: DossierEmailHook;
  thesisLifecycle?: DossierThesisLifecycle;
  seats: number;
  winner?: string;
  consensus?: number;
}

export const REJECTED_DOSSIER_UPDATE_SCHEMA = "rejected-dossier-factual-update-v1" as const;

/** Fact-only public fallback from a proposition that did not clear 3/5. */
export interface RejectedDossierFactualUpdate {
  schema: typeof REJECTED_DOSSIER_UPDATE_SCHEMA;
  ticker: string;
  date: string;
  generatedAt: number;
  rejectionAuditId: string;
  compactWhatChanged: string;
  whatChanged: string;
  citations: DossierCitation[];
  votesSupport: number;
  votesOppose: number;
  votesUncertain: number;
  /** A malformed or unavailable family is disclosed, never imputed as a vote. */
  votesUnavailable?: number;
  reason: "minority-support" | "incomplete-ballot" | "fatal-contradiction";
  /**
   * Audited continuity proposal for the already-published thesis. This binds
   * the completed review to its lifecycle and advances the review cursor, but
   * a sub-3/5 result does not admit its status or signal as canonical state.
   */
  thesisObservation?: {
    lifecycleId: string;
    openedDate: string;
    observationIndex: number;
    status: DossierPriorStatus;
    subjectPunchline: string;
    signal: DossierQualitativeSignal;
    compactUpdateText: string;
    updateText: string;
  };
  contentSha256: string;
}

interface DossierFailureAttemptReceipt {
  model?: string;
  inputSha256: string;
  rawResponseSha256: string;
  validationError?: string;
  repairedFields?: string[];
}

export interface DossierTerminalFailure {
  stage: "website" | "email-draft" | "ballot-packet" | "email-confidence" | "email-final";
  error: string;
  failedAt: number;
  attempts: DossierFailureAttemptReceipt[];
  usage?: CouncilModelUsage;
}

interface PendingDossierRun {
  ticker: string;
  date: string;
  artifactVersion: number;
  contractVersion: string;
  generationOwner: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  question: string;
  context: string;
  sources: string;
  evidence: DossierCitation[];
  claims: LedgerClaim[];
  deterministicEvidence: DeterministicEvidenceFact[];
  evidenceManifest?: EvidenceManifest;
  stage1: DossierSeatMaterial[];
  winner?: string;
  consensus?: number;
  websiteArtifact?: ChairmanArtifact<WebsiteDossierCards>;
  emailDraft?: EmailDraftCheckpoint;
  emailBallots?: EmailBallotCheckpoint[];
  emailConfidence?: EmailConfidenceCheckpoint;
  emailRejected?: EmailRejectedCheckpoint;
  terminalFailure?: DossierTerminalFailure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactObjectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  if (!isRecord(value)) return false; // fail soft on model-shaped surprises (e.g. a bare number)
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function exactQualitativeSignal(value: unknown): value is DossierQualitativeSignal {
  if (!isRecord(value) || !exactObjectKeys(value, ["eventType", "direction", "strength", "horizonSessions"])) return false;
  if (!isRecord(value.horizonSessions) || !exactObjectKeys(value.horizonSessions, ["min", "max"])) return false;
  return ["earnings", "guidance", "regulatory", "product", "legal", "capital", "leadership", "macro", "other"].includes(String(value.eventType)) &&
    ["UP", "DOWN"].includes(String(value.direction)) &&
    ["GENTLE", "MODERATE", "STRONG"].includes(String(value.strength)) &&
    value.horizonSessions.min === 10 && value.horizonSessions.max === 15;
}

const CONTINUING_THESIS_STATUSES = new Set<DossierPriorStatus>([
  "open",
  "strengthened",
  "weakened",
]);
const TERMINAL_THESIS_STATUSES = new Set<DossierPriorStatus>([
  "resolved",
  "invalidated",
  "replaced",
]);

export type WebsiteChairAuthority = "canonical" | "continuity";

/**
 * Canonical thesis creation is deliberately rarer and independently routed.
 * An existing lifecycle defaults to the cost-controlled daily continuity
 * route; a terminal transition is separately re-authorized by the canonical
 * route before publication.
 */
export function websiteChairAuthority(
  previousThesis: DossierPriorThesisContext | null,
): WebsiteChairAuthority {
  return previousThesis ? "continuity" : "canonical";
}

export function requiresCanonicalBoundaryAuthorization(
  priorUpdate: DossierPriorUpdate | null | undefined,
): boolean {
  return Boolean(priorUpdate && TERMINAL_THESIS_STATUSES.has(priorUpdate.status));
}
const SIGNAL_STRENGTH_RANK: Record<DossierSignalStrength, number> = {
  GENTLE: 1,
  MODERATE: 2,
  STRONG: 3,
};

function exactQuestionOracle(value: unknown): value is DossierQuestionOracle {
  return isRecord(value) &&
    exactObjectKeys(value, ["type", "trigger", "dueBy"]) &&
    ["filing", "tape"].includes(String(value.type)) &&
    typeof value.trigger === "string" &&
    value.trigger.trim().length > 0 &&
    parseIsoDate(String(value.dueBy)) !== null;
}

function exactThesisLifecycle(value: unknown): value is DossierThesisLifecycle {
  if (!isRecord(value) || !exactObjectKeys(value, [
    "schemaVersion", "id", "openedDate", "openedAt", "observationDate", "observationIndex",
    "observationStatus", "canonicalSubjectPunchline", "canonicalThesis", "canonicalQuestion",
    "canonicalSignal", "canonicalOracle", "canonicalVotes", "latestSignal",
  ], ["previousLifecycle"])) return false;
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{48}$/.test(String(value.id)) ||
      parseIsoDate(String(value.openedDate)) === null || parseIsoDate(String(value.observationDate)) === null ||
      !Number.isInteger(value.openedAt) || Number(value.openedAt) <= 0 ||
      !Number.isInteger(value.observationIndex) || Number(value.observationIndex) < 1 ||
      !["opened", "strengthened", "weakened", "open"].includes(String(value.observationStatus)) ||
      typeof value.canonicalSubjectPunchline !== "string" || !value.canonicalSubjectPunchline.trim() ||
      typeof value.canonicalThesis !== "string" || !value.canonicalThesis.trim() ||
      typeof value.canonicalQuestion !== "string" || !value.canonicalQuestion.trim() ||
      !exactQualitativeSignal(value.canonicalSignal) || !exactQuestionOracle(value.canonicalOracle) ||
      !isRecord(value.canonicalVotes) ||
      !exactObjectKeys(value.canonicalVotes, ["support", "oppose", "uncertain", "total"]) ||
      value.canonicalVotes.total !== 5 ||
      [value.canonicalVotes.support, value.canonicalVotes.oppose, value.canonicalVotes.uncertain]
        .some((vote) => !Number.isInteger(vote) || Number(vote) < 0) ||
      Number(value.canonicalVotes.support) + Number(value.canonicalVotes.oppose) +
        Number(value.canonicalVotes.uncertain) !== 5 ||
      !exactQualitativeSignal(value.latestSignal)) return false;
  if (value.previousLifecycle !== undefined && (
    !isRecord(value.previousLifecycle) ||
    !exactObjectKeys(value.previousLifecycle, ["id", "openedDate", "status", "text"]) ||
    !/^[a-f0-9]{48}$/.test(String(value.previousLifecycle.id)) ||
    parseIsoDate(String(value.previousLifecycle.openedDate)) === null ||
    !["resolved", "invalidated", "replaced"].includes(String(value.previousLifecycle.status)) ||
    typeof value.previousLifecycle.text !== "string" ||
    !value.previousLifecycle.text.trim()
  )) return false;
  return true;
}

function thesisLifecycleId(
  ticker: string,
  openedDate: string,
  subjectPunchline: string,
): string {
  return sha256(JSON.stringify({
    schema: "amm-thesis-lifecycle-v1",
    ticker: ticker.toUpperCase(),
    openedDate,
    subjectPunchline: subjectPunchline.trim(),
  })).slice(0, 48);
}

function priorThesisContextFromDossier(dossier: Dossier): DossierPriorThesisContext {
  const lifecycle = dossier.thesisLifecycle;
  const openedDate = lifecycle?.openedDate ?? dossier.date;
  const openedAt = lifecycle?.openedAt ?? dossier.generatedAt;
  const subjectPunchline = lifecycle?.canonicalSubjectPunchline ?? dossier.emailHook.subjectPunchline;
  const thesis = lifecycle?.canonicalThesis ?? dossier.emailHook.thesis;
  const signal = lifecycle?.latestSignal ?? dossier.emailHook.signal;
  const question = lifecycle?.canonicalQuestion ?? dossier.emailHook.question;
  const oracle = lifecycle?.canonicalOracle ?? dossier.emailHook.oracle;
  return {
    lifecycleId: lifecycle?.id ?? thesisLifecycleId(dossier.ticker, openedDate, subjectPunchline),
    openedDate,
    openedAt,
    observationIndex: lifecycle?.observationIndex ?? 1,
    date: dossier.date,
    subjectPunchline,
    thesis,
    canonicalSignal: lifecycle?.canonicalSignal ?? dossier.emailHook.signal,
    signal,
    question,
    flipCondition: oracle.trigger,
    oracle,
    votes: lifecycle?.canonicalVotes ?? {
      support: dossier.emailHook.votesSupport,
      oppose: dossier.emailHook.votesOppose,
      uncertain: dossier.emailHook.votesUncertain,
      total: 5,
    },
    state: "open",
    outcomeContext: {
      status: "unresolved",
      asOfDate: dossier.date,
      note: "No later admitted evidence has resolved this thesis; update the same proposition unless the current packet explicitly resolves, invalidates, or replaces it.",
    },
  };
}

/**
 * Attach one stable lifecycle to daily observations. Continuing observations
 * inherit the original public proposition and private forecast; only an
 * explicit terminal transition may open a new scored lifecycle.
 */
export function buildDossierThesisLifecycle(input: {
  ticker: string;
  date: string;
  generatedAt: number;
  hook: DossierEmailHook;
  previousThesis: DossierPriorThesisContext | null;
}): DossierThesisLifecycle {
  const { ticker, date, generatedAt, hook, previousThesis } = input;
  const transition = hook.priorUpdate?.status;
  if (previousThesis && transition && CONTINUING_THESIS_STATUSES.has(transition)) {
    return {
      schemaVersion: 1,
      id: previousThesis.lifecycleId,
      openedDate: previousThesis.openedDate,
      openedAt: previousThesis.openedAt,
      observationDate: date,
      observationIndex: previousThesis.observationIndex + 1,
      observationStatus: transition as Exclude<DossierThesisObservationStatus, "opened">,
      canonicalSubjectPunchline: previousThesis.subjectPunchline,
      canonicalThesis: previousThesis.thesis,
      canonicalQuestion: previousThesis.question,
      canonicalSignal: previousThesis.canonicalSignal,
      canonicalOracle: previousThesis.oracle,
      canonicalVotes: previousThesis.votes,
      latestSignal: hook.signal,
    };
  }

  const lifecycle: DossierThesisLifecycle = {
    schemaVersion: 1,
    id: thesisLifecycleId(ticker, date, hook.subjectPunchline),
    openedDate: date,
    openedAt: generatedAt,
    observationDate: date,
    observationIndex: 1,
    observationStatus: "opened",
    canonicalSubjectPunchline: hook.subjectPunchline,
    canonicalThesis: hook.thesis,
    canonicalQuestion: hook.question,
    canonicalSignal: hook.signal,
    canonicalOracle: hook.oracle,
    canonicalVotes: {
      support: hook.votesSupport,
      oppose: hook.votesOppose,
      uncertain: hook.votesUncertain,
      total: 5,
    },
    latestSignal: hook.signal,
  };
  if (previousThesis && transition && TERMINAL_THESIS_STATUSES.has(transition)) {
    lifecycle.previousLifecycle = {
      id: previousThesis.lifecycleId,
      openedDate: previousThesis.openedDate,
      status: transition as "resolved" | "invalidated" | "replaced",
      text: hook.priorUpdate!.text,
    };
  }
  return lifecycle;
}

/** One immutable private forecast per lifecycle, never one per daily observation. */
export function shouldIssuePrivateSignalForDossier(dossier: Dossier): boolean {
  return !dossier.thesisLifecycle || dossier.thesisLifecycle.observationIndex === 1;
}

export function thesisContinuityValidationError(
  hook: Pick<DossierEmailHook, "subjectPunchline" | "priorUpdate" | "signal">,
  previousThesis: DossierPriorThesisContext | null,
): string | null {
  if (!previousThesis) {
    return hook.priorUpdate === null ? null : "priorUpdate must be null without an active thesis";
  }
  const transition = hook.priorUpdate?.status;
  if (!transition) return "priorUpdate is required for the active thesis";
  if (TERMINAL_THESIS_STATUSES.has(transition)) return null;
  if (!CONTINUING_THESIS_STATUSES.has(transition)) return "priorUpdate has an unknown lifecycle state";
  if (hook.subjectPunchline.trim() !== previousThesis.subjectPunchline.trim()) {
    return "an open, strengthened, or weakened thesis must preserve the canonical subjectPunchline verbatim; use replaced for a new proposition";
  }
  if (hook.signal.direction !== previousThesis.signal.direction) {
    return "a continuing thesis cannot reverse direction; use resolved, invalidated, or replaced";
  }
  const currentStrength = SIGNAL_STRENGTH_RANK[hook.signal.strength];
  const previousStrength = SIGNAL_STRENGTH_RANK[previousThesis.signal.strength];
  if (transition === "open" && currentStrength !== previousStrength) {
    return "an open thesis must keep its canonical strength; use strengthened or weakened for a supported change";
  }
  if (transition === "strengthened" && currentStrength < previousStrength) {
    return "a strengthened thesis cannot lower its qualitative strength";
  }
  if (transition === "weakened" && currentStrength > previousStrength) {
    return "a weakened thesis cannot raise its qualitative strength";
  }
  return null;
}

function exactCitation(value: unknown): value is DossierCitation {
  if (!isRecord(value) || !exactObjectKeys(value, [
    "id", "title", "url", "publisher", "authority", "publishedAt", "publishedDate", "retrievedAt", "sourceDocumentId",
  ], ["contentSha256", "sourceVerifiedAt", "sourceVerifiedBy", "eventId", "observationIds", "evidenceState"])) return false;
  if (!/^S\d+$/.test(String(value.id)) || typeof value.title !== "string" || !/^https?:\/\//.test(String(value.url)) ||
      typeof value.publisher !== "string" || !["primary", "company", "independent", "market-data", "social"].includes(String(value.authority)) ||
      !Number.isFinite(value.publishedAt) || !Number.isFinite(value.retrievedAt) || !/^20\d{2}-\d{2}-\d{2}$/.test(String(value.publishedDate)) ||
      typeof value.sourceDocumentId !== "string") return false;
  if (value.contentSha256 !== undefined && typeof value.contentSha256 !== "string") return false;
  if (value.sourceVerifiedAt !== undefined && !Number.isFinite(value.sourceVerifiedAt)) return false;
  if (value.sourceVerifiedBy !== undefined && typeof value.sourceVerifiedBy !== "string") return false;
  if (value.eventId !== undefined && typeof value.eventId !== "string") return false;
  if (value.observationIds !== undefined && (!Array.isArray(value.observationIds) ||
      !value.observationIds.every((id) => typeof id === "string"))) return false;
  if (value.evidenceState !== undefined && !["verified", "corroborated", "reported", "discovery", "withdrawn"].includes(String(value.evidenceState))) return false;
  return true;
}

function exactEvidenceManifest(value: unknown): value is EvidenceManifest {
  if (!isRecord(value) || !exactObjectKeys(value, [
    "itemsSeen", "clustersFormed", "duplicatesCollapsed", "included", "excluded",
  ], ["social", "materiality"])) return false;
  if ([value.itemsSeen, value.clustersFormed, value.duplicatesCollapsed, value.included]
      .some((item) => !Number.isInteger(item) || Number(item) < 0) ||
      !Array.isArray(value.excluded) || !value.excluded.every((item) =>
        isRecord(item) &&
        exactObjectKeys(item, ["title", "reason"]) &&
        typeof item.title === "string" && item.title.trim().length > 0 &&
        typeof item.reason === "string" && item.reason.trim().length > 0
      )) return false;
  if (value.social !== undefined && (
    !isRecord(value.social) ||
    !exactObjectKeys(value.social, [
      "qualifiedPosts", "narrativeClusters", "duplicatesCollapsed", "admittedNarratives", "admittedCitationIds",
    ]) ||
    [
      value.social.qualifiedPosts,
      value.social.narrativeClusters,
      value.social.duplicatesCollapsed,
      value.social.admittedNarratives,
    ].some((item) => !Number.isInteger(item) || Number(item) < 0) ||
    !Array.isArray(value.social.admittedCitationIds) ||
    !value.social.admittedCitationIds.every((id) => typeof id === "string" && /^S\d+$/.test(id))
  )) return false;
  if (value.materiality !== undefined && (
    !isRecord(value.materiality) ||
    !exactObjectKeys(value.materiality, [
      "stableEvidenceFingerprint", "stableEvidenceKeys", "referencePrice", "dayChangePercent", "afterHoursChangePercent",
    ]) ||
    !/^[a-f0-9]{64}$/.test(String(value.materiality.stableEvidenceFingerprint)) ||
    !Array.isArray(value.materiality.stableEvidenceKeys) ||
    !value.materiality.stableEvidenceKeys.every((key) => typeof key === "string" && key.trim().length > 0) ||
    ![value.materiality.referencePrice, value.materiality.dayChangePercent, value.materiality.afterHoursChangePercent]
      .every((item) => item === null || (typeof item === "number" && Number.isFinite(item)))
  )) return false;
  return true;
}

/** A public thesis cannot survive when its own recorded dissent defeats a core fact. */
export function fatalCouncilContradictionIssue(
  confidence: Pick<DossierCouncilConfidence, "dissentReason" | "uncertaintyReason">,
): string | null {
  const text = [confidence.dissentReason, confidence.uncertaintyReason].filter(Boolean).join(" ");
  const fatalPatterns = [
    /\b(?:arithmetically|mathematically|numerically)\s+(?:wrong|incorrect|false)\b/i,
    /\b(?:arithmetic|calculation|ratio|scale)\s+(?:is\s+)?(?:wrong|incorrect|false|does not reconcile)\b/i,
    /\b(?:core|central|scale|profit|premise|claim)[^.!?]{0,45}\bconflicts? with (?:the )?(?:filed|filing|primary-source)\b/i,
    /\bcontradict(?:s|ed)? by (?:the )?(?:filed|filing|primary-source)\b/i,
    /\bperiod mismatch[^.!?]{0,45}\b(?:invalidates?|defeats?|contradicts?)\b/i,
  ];
  const match = fatalPatterns.find((pattern) => pattern.test(text));
  return match ? `recorded council dissent contains a fatal factual contradiction: ${text.slice(0, 260)}` : null;
}

/** Old or structurally ambiguous dossiers remain readable, but are never current. */
export function isDetailedDossier(value: Partial<Dossier> | null | undefined): value is Dossier {
  if (!isRecord(value) || !exactObjectKeys(value, [
    "ticker", "date", "generatedAt", "artifactVersion", "headline", "story", "bulls", "bears", "risk",
    "numbersRead", "signalCase", "sources", "emailHook", "seats",
  ], ["citations", "evidenceManifest", "citationCoverage", "briefAuditId", "councilRunId", "winner", "consensus", "thesisLifecycle"])) return false;
  if (value.artifactVersion !== DOSSIER_ARTIFACT_VERSION || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(String(value.ticker)) ||
      !/^20\d{2}-\d{2}-\d{2}$/.test(String(value.date)) || !Number.isFinite(value.generatedAt) || Number(value.generatedAt) <= 0 ||
      !Number.isInteger(value.seats) || Number(value.seats) < 1 || typeof value.sources !== "string") return false;
  if (value.briefAuditId !== undefined && typeof value.briefAuditId !== "string") return false;
  if (value.councilRunId !== undefined && typeof value.councilRunId !== "string") return false;
  if (value.winner !== undefined && typeof value.winner !== "string") return false;
  if (value.consensus !== undefined && (typeof value.consensus !== "number" || value.consensus < 0 || value.consensus > 1)) return false;
  if (value.citationCoverage !== undefined && (!isRecord(value.citationCoverage) ||
      !exactObjectKeys(value.citationCoverage, ["claims", "cited", "primarySources"]) ||
      [value.citationCoverage.claims, value.citationCoverage.cited, value.citationCoverage.primarySources]
        .some((item) => !Number.isInteger(item) || Number(item) < 0))) return false;
  if (value.citations !== undefined && (!Array.isArray(value.citations) || !value.citations.every(exactCitation))) return false;
  if (value.evidenceManifest !== undefined && !exactEvidenceManifest(value.evidenceManifest)) return false;
  if (value.thesisLifecycle !== undefined && (
    !exactThesisLifecycle(value.thesisLifecycle) ||
    value.thesisLifecycle.observationDate !== value.date ||
    (value.thesisLifecycle.observationStatus === "opened") !== (value.thesisLifecycle.observationIndex === 1) ||
    value.thesisLifecycle.canonicalQuestion !== dossierQuestionFromPunchline(value.thesisLifecycle.canonicalSubjectPunchline)
  )) return false;
  if (typeof value.headline !== "string" || typeof value.story !== "string" || value.story.length < 1_200 ||
      typeof value.risk !== "string" || value.risk.length < 700 || typeof value.numbersRead !== "string" || value.numbersRead.length < 700 ||
      !Array.isArray(value.bulls) || value.bulls.length < 3 || value.bulls.length > 5 || !value.bulls.every((item) => typeof item === "string") ||
      !Array.isArray(value.bears) || value.bears.length < 3 || value.bears.length > 5 || !value.bears.every((item) => typeof item === "string")) return false;

  if (!isRecord(value.signalCase) || !exactObjectKeys(value.signalCase, [
    "eventType", "direction", "strength", "horizonSessions", "mechanism", "invalidation",
  ]) || !exactQualitativeSignal({
    eventType: value.signalCase.eventType,
    direction: value.signalCase.direction,
    strength: value.signalCase.strength,
    horizonSessions: value.signalCase.horizonSessions,
  }) ||
      typeof value.signalCase.mechanism !== "string" || typeof value.signalCase.invalidation !== "string") return false;

  if (websiteSynthesisIssues({
    story: value.story,
    bulls: value.bulls,
    bears: value.bears,
    risk: value.risk,
    numbersRead: value.numbersRead,
  }).length > 0) return false;

  const hook = value.emailHook;
  if (!isRecord(hook) || !exactObjectKeys(hook, [
    "subjectPunchline", "priorUpdate", "whatChanged", "thesis", "question", "primaryEvidence", "secondaryEvidence", "signal",
    "votesSupport", "votesOppose", "votesUncertain", "votesTotal", "votes", "confidence", "oracle", "editorialStrength",
  ])) return false;
  for (const field of ["subjectPunchline", "whatChanged", "thesis", "primaryEvidence"] as const) {
    if (typeof hook[field] !== "string" || !hook[field]) return false;
  }
  if (!Array.isArray(hook.secondaryEvidence) || hook.secondaryEvidence.length < 2 || hook.secondaryEvidence.length > 3 ||
      !hook.secondaryEvidence.every((item) => typeof item === "string")) return false;
  if (hook.priorUpdate !== null && (!isRecord(hook.priorUpdate) || !exactObjectKeys(hook.priorUpdate, ["status", "text"]) ||
      !["strengthened", "weakened", "resolved", "invalidated", "replaced", "open"].includes(String(hook.priorUpdate.status)) ||
      typeof hook.priorUpdate.text !== "string")) return false;
  if (!exactQualitativeSignal(hook.signal) || hook.signal.eventType !== value.signalCase.eventType ||
      hook.signal.direction !== value.signalCase.direction || hook.signal.strength !== value.signalCase.strength) return false;
  if (hook.question !== dossierQuestionFromPunchline(String(hook.subjectPunchline))) return false;
  if (value.thesisLifecycle && (
    stableJson(hook.signal) !== stableJson(value.thesisLifecycle.latestSignal) ||
    (value.thesisLifecycle.observationIndex === 1 &&
      stableJson(hook.signal) !== stableJson(value.thesisLifecycle.canonicalSignal)) ||
    (value.thesisLifecycle.observationIndex > 1 && (
      hook.subjectPunchline !== value.thesisLifecycle.canonicalSubjectPunchline ||
      hook.signal.direction !== value.thesisLifecycle.canonicalSignal.direction
    ))
  )) return false;
  if (hook.votesTotal !== 5 || !Number.isInteger(hook.votesSupport) || !Number.isInteger(hook.votesOppose) ||
      !Number.isInteger(hook.votesUncertain) || Number(hook.votesSupport) < 3 ||
      Number(hook.votesSupport) + Number(hook.votesOppose) + Number(hook.votesUncertain) !== 5) return false;
  if (!isRecord(hook.votes) || !exactObjectKeys(hook.votes, ["support", "oppose", "uncertain"]) ||
      hook.votes.support !== hook.votesSupport || hook.votes.oppose !== hook.votesOppose ||
      hook.votes.uncertain !== hook.votesUncertain) return false;
  if (!isRecord(hook.confidence) || !exactObjectKeys(hook.confidence, ["majorityReason", "dissentReason", "uncertaintyReason", "flipCondition"]) ||
      typeof hook.confidence.majorityReason !== "string" || typeof hook.confidence.flipCondition !== "string" ||
      !(hook.confidence.dissentReason === null || typeof hook.confidence.dissentReason === "string") ||
      !(hook.confidence.uncertaintyReason === null || typeof hook.confidence.uncertaintyReason === "string")) return false;
  if ((Number(hook.votesOppose) > 0) !== (typeof hook.confidence.dissentReason === "string" && hook.confidence.dissentReason.length > 0) ||
      (Number(hook.votesUncertain) > 0) !== (typeof hook.confidence.uncertaintyReason === "string" && hook.confidence.uncertaintyReason.length > 0)) return false;
  if (fatalCouncilContradictionIssue(hook.confidence as DossierCouncilConfidence)) return false;
  if (!isRecord(hook.oracle) || !exactObjectKeys(hook.oracle, ["type", "trigger", "dueBy"]) ||
      typeof hook.oracle.trigger !== "string" || hook.oracle.trigger !== hook.confidence.flipCondition ||
      parseIsoDate(String(hook.oracle.dueBy)) === null ||
      stableJson(hook.oracle) !== stableJson(dossierQuestionOracle(
        hook.signal as DossierQualitativeSignal,
        hook.confidence.flipCondition,
        String(value.date),
      ))) return false;
  if (!isRecord(hook.editorialStrength) || !exactObjectKeys(hook.editorialStrength, ["novelty", "materiality", "evidence", "asymmetry", "score"])) return false;
  const dimensions = [hook.editorialStrength.novelty, hook.editorialStrength.materiality, hook.editorialStrength.evidence, hook.editorialStrength.asymmetry].map(Number);
  if (dimensions.some((item) => !Number.isInteger(item) || item < 1 || item > 5)) return false;
  const expectedScore = Math.round(((dimensions[0] * .30) + (dimensions[1] * .25) + (dimensions[2] * .25) + (dimensions[3] * .20)) / 5 * 100);
  if (hook.editorialStrength.score !== expectedScore) return false;
  return [value.headline, value.story, ...value.bulls, ...value.bears, value.risk, value.numbersRead,
    hook.subjectPunchline, hook.whatChanged, hook.thesis, hook.question, hook.primaryEvidence, ...hook.secondaryEvidence,
    value.signalCase.mechanism, value.signalCase.invalidation,
    hook.confidence.majorityReason, hook.confidence.dissentReason ?? "", hook.confidence.uncertaintyReason ?? "", hook.confidence.flipCondition,
    hook.priorUpdate?.text ?? "",
  ].every((text) => publicProseValidationError(String(text)) === null);
}

// ---- shared per-ticker cache (Firestore; memory fallback in dev) ----

const useMemory = process.env.DESK_STORE === "memory";
const memStore = ((globalThis as Record<string, unknown>).__dossierStore ??=
  new Map<string, Dossier>()) as Map<string, Dossier>;
const memPendingStore = ((globalThis as Record<string, unknown>).__dossierPendingStore ??=
  new Map<string, PendingDossierRun>()) as Map<string, PendingDossierRun>;
const memGenerationAudits = ((globalThis as Record<string, unknown>).__dossierGenerationAudits ??=
  new Map<string, unknown>()) as Map<string, unknown>;
const memRejectedUpdates = ((globalThis as Record<string, unknown>).__rejectedDossierUpdates ??=
  new Map<string, RejectedDossierFactualUpdate>()) as Map<string, RejectedDossierFactualUpdate>;

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

const GENERATION_LEASE_TTL_MS = 15 * 60_000;
const FIRESTORE_SAFE_DOCUMENT_BYTES = 900_000;

interface DossierGenerationLease {
  id: string;
  owner: string;
  lost: boolean;
}

async function assertGenerationLease(lease: DossierGenerationLease): Promise<void> {
  if (lease.lost || !(await renewPipelineLease(lease.id, lease.owner, GENERATION_LEASE_TTL_MS))) {
    lease.lost = true;
    throw new Error(`dossier generation lease ${lease.id} is no longer owned by this request`);
  }
}

export async function getCachedDossier(ticker: string): Promise<Dossier | null> {
  const sym = ticker.toUpperCase();
  if (useMemory) return memStore.get(sym) ?? null;
  const doc = await firestore().collection("dossiers").doc(sym).get();
  return doc.exists ? (doc.data() as Dossier) : null;
}

function rejectedUpdateKey(ticker: string, date: string): string {
  return `${ticker.toUpperCase()}_${date}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rejectedUpdateHash(value: Omit<RejectedDossierFactualUpdate, "contentSha256">): string {
  return sha256(stableJson(value));
}

export function isRejectedDossierFactualUpdate(value: unknown): value is RejectedDossierFactualUpdate {
  if (!isRecord(value) || !exactObjectKeys(value, [
    "schema", "ticker", "date", "generatedAt", "rejectionAuditId", "compactWhatChanged", "whatChanged",
    "citations", "votesSupport", "votesOppose", "votesUncertain", "reason", "contentSha256",
  ], ["votesUnavailable", "thesisObservation"]) || value.schema !== REJECTED_DOSSIER_UPDATE_SCHEMA ||
      !/^[A-Z][A-Z0-9.-]{0,9}$/.test(String(value.ticker)) ||
      !/^20\d{2}-\d{2}-\d{2}$/.test(String(value.date)) || !Number.isFinite(value.generatedAt) ||
      !/^[a-f0-9]{48}$/.test(String(value.rejectionAuditId)) || typeof value.compactWhatChanged !== "string" ||
      typeof value.whatChanged !== "string" || !Array.isArray(value.citations) || !value.citations.every(exactCitation) ||
      !Number.isInteger(value.votesSupport) || !Number.isInteger(value.votesOppose) || !Number.isInteger(value.votesUncertain) ||
      Number(value.votesSupport) < 0 || Number(value.votesOppose) < 0 ||
      Number(value.votesUncertain) < 0 || Number(value.votesSupport) + Number(value.votesOppose) + Number(value.votesUncertain) > 5 ||
      (value.votesUnavailable !== undefined && (!Number.isInteger(value.votesUnavailable) ||
        Number(value.votesUnavailable) < 0 || Number(value.votesUnavailable) > 5)) ||
      !["minority-support", "incomplete-ballot", "fatal-contradiction"].includes(String(value.reason)) ||
      !/^[a-f0-9]{64}$/.test(String(value.contentSha256))) return false;
  const voteTotal = Number(value.votesSupport) + Number(value.votesOppose) + Number(value.votesUncertain);
  const votesUnavailable = value.votesUnavailable === undefined ? 5 - voteTotal : Number(value.votesUnavailable);
  if (voteTotal + votesUnavailable !== 5) return false;
  if ((value.reason === "minority-support" && (Number(value.votesSupport) >= 3 || voteTotal !== 5)) ||
      (value.reason === "incomplete-ballot" && voteTotal >= 5) ||
      (value.reason === "fatal-contradiction" && voteTotal !== 5)) return false;
  if (value.thesisObservation !== undefined) {
    const observation = value.thesisObservation;
    if (!isRecord(observation) || !exactObjectKeys(observation, [
      "lifecycleId", "openedDate", "observationIndex", "status", "subjectPunchline", "signal",
      "compactUpdateText", "updateText",
    ]) || !/^[a-f0-9]{48}$/.test(String(observation.lifecycleId)) ||
        parseIsoDate(String(observation.openedDate)) === null ||
        !Number.isInteger(observation.observationIndex) || Number(observation.observationIndex) < 2 ||
        !["strengthened", "weakened", "resolved", "invalidated", "replaced", "open"].includes(String(observation.status)) ||
        typeof observation.subjectPunchline !== "string" || !observation.subjectPunchline.trim() ||
        !exactQualitativeSignal(observation.signal) ||
        typeof observation.compactUpdateText !== "string" || !observation.compactUpdateText.trim() ||
        typeof observation.updateText !== "string" || !observation.updateText.trim() ||
        renderCitations(observation.compactUpdateText, value.citations as DossierCitation[]) !== observation.updateText ||
        publicProseValidationError(observation.updateText)) return false;
  }
  const rendered = renderCitations(value.compactWhatChanged, value.citations as DossierCitation[]);
  if (!rendered || rendered !== value.whatChanged || publicProseValidationError(rendered)) return false;
  const { contentSha256, ...payload } = value as unknown as RejectedDossierFactualUpdate;
  return contentSha256 === rejectedUpdateHash(payload);
}

export function buildRejectedDossierFactualUpdate(input: {
  ticker: string;
  date: string;
  generatedAt: number;
  rejectionAuditId: string;
  compactWhatChanged: string;
  evidence: DossierCitation[];
  rejected: EmailRejectedCheckpoint;
  previousThesis?: DossierPriorThesisContext | null;
  compactPriorUpdate?: DossierPriorUpdate | null;
}): RejectedDossierFactualUpdate {
  const observationInput = input.previousThesis && input.compactPriorUpdate
    ? input.compactPriorUpdate.text
    : null;
  const citations = referencedEvidence(
    [input.compactWhatChanged, ...(observationInput ? [observationInput] : [])],
    input.evidence,
  );
  const whatChanged = renderCitations(input.compactWhatChanged, citations);
  if (!whatChanged || citations.length === 0 || publicProseValidationError(whatChanged)) {
    throw new Error("rejected proposition has no safe, fully cited factual change");
  }
  const updateText = observationInput ? renderCitations(observationInput, citations) : null;
  if (observationInput && (!updateText || publicProseValidationError(updateText))) {
    throw new Error("rejected proposition has no safe, fully cited thesis observation");
  }
  const voteTotal = input.rejected.votesSupport + input.rejected.votesOppose + input.rejected.votesUncertain;
  const payload: Omit<RejectedDossierFactualUpdate, "contentSha256"> = {
    schema: REJECTED_DOSSIER_UPDATE_SCHEMA,
    ticker: input.ticker,
    date: input.date,
    generatedAt: input.generatedAt,
    rejectionAuditId: input.rejectionAuditId,
    compactWhatChanged: input.compactWhatChanged,
    whatChanged,
    citations,
    votesSupport: input.rejected.votesSupport,
    votesOppose: input.rejected.votesOppose,
    votesUncertain: input.rejected.votesUncertain,
    votesUnavailable: 5 - voteTotal,
    reason: input.rejected.reason,
    ...(input.previousThesis && input.compactPriorUpdate && updateText
      ? {
          thesisObservation: {
            lifecycleId: input.previousThesis.lifecycleId,
            openedDate: input.previousThesis.openedDate,
            observationIndex: input.previousThesis.observationIndex + 1,
            status: input.compactPriorUpdate.status,
            subjectPunchline: input.previousThesis.subjectPunchline,
            signal: input.previousThesis.signal,
            compactUpdateText: input.compactPriorUpdate.text,
            updateText,
          },
        }
      : {}),
  };
  return { ...payload, contentSha256: rejectedUpdateHash(payload) };
}

export async function getRejectedDossierFactualUpdate(
  ticker: string,
  date: string,
): Promise<RejectedDossierFactualUpdate | null> {
  const key = rejectedUpdateKey(ticker, date);
  const value = useMemory
    ? memRejectedUpdates.get(key) ?? null
    : await firestore().collection("dossier_rejected_updates").doc(key).get()
      .then((snapshot) => snapshot.exists ? snapshot.data() : null);
  if (!isRejectedDossierFactualUpdate(value)) return null;
  if (value.thesisObservation) return value;

  // The first rejected-update receipts predated explicit lifecycle
  // observations. Their immutable generation audit already contains the exact
  // prior thesis, compact daily update, evidence packet, and vote result. Read
  // that audit to present the same outcome on newer clients without rewriting
  // shared data or purchasing another council run.
  try {
    const audit = await getImmutableGenerationAuditRecord(value.rejectionAuditId);
    if (!isRecord(audit) || audit.status !== "rejected" ||
        audit.ticker !== value.ticker || audit.date !== value.date ||
        !isRecord(audit.shared) || !Array.isArray(audit.shared.evidence) ||
        !isRecord(audit.shared.priorThesis) || !isRecord(audit.emailDraft) ||
        !isRecord(audit.emailDraft.artifact) || !isRecord(audit.emailDraft.artifact.compactOutput)) {
      return value;
    }
    const compactPriorUpdate = parsedPriorUpdate(audit.emailDraft.artifact.compactOutput.priorUpdate);
    if (!compactPriorUpdate) return value;
    const enriched = buildRejectedDossierFactualUpdate({
      ticker: value.ticker,
      date: value.date,
      generatedAt: value.generatedAt,
      rejectionAuditId: value.rejectionAuditId,
      compactWhatChanged: value.compactWhatChanged,
      evidence: audit.shared.evidence as DossierCitation[],
      rejected: {
        key: `legacy:${value.rejectionAuditId}`,
        propositionSha256: "",
        rejectedAt: value.generatedAt,
        votesSupport: value.votesSupport,
        votesOppose: value.votesOppose,
        votesUncertain: value.votesUncertain,
        reason: value.reason,
        ballotResponseSha256: [],
      },
      previousThesis: audit.shared.priorThesis as unknown as DossierPriorThesisContext,
      compactPriorUpdate,
    });
    return isRejectedDossierFactualUpdate(enriched) ? enriched : value;
  } catch (error) {
    console.warn(`[dossier] ${value.ticker}: legacy rejected update could not be hydrated: ${String(error).slice(0, 160)}`);
    return value;
  }
}

/**
 * Completed no-directional reviews since the last published artifact.
 * Document-id bounds keep this query on Firestore's built-in key index and
 * avoid a fleet-specific composite index.
 */
export async function getRejectedDossierFactualUpdatesBetween(
  ticker: string,
  afterDate: string,
  beforeDate: string,
): Promise<RejectedDossierFactualUpdate[]> {
  const sym = ticker.toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym) ||
      !/^20\d{2}-\d{2}-\d{2}$/.test(afterDate) ||
      !/^20\d{2}-\d{2}-\d{2}$/.test(beforeDate) || afterDate >= beforeDate) {
    return [];
  }
  const candidates = useMemory
    ? [...memRejectedUpdates.values()]
        .filter((value) => value.ticker === sym && value.date > afterDate && value.date < beforeDate)
        .sort((left, right) => left.date.localeCompare(right.date))
    : (await firestore()
        .collection("dossier_rejected_updates")
        .where(FieldPath.documentId(), ">", `${sym}_${afterDate}`)
        .where(FieldPath.documentId(), "<", `${sym}_${beforeDate}`)
        .orderBy(FieldPath.documentId(), "asc")
        .limit(130)
        .get()).docs.map((document) => document.data() as RejectedDossierFactualUpdate);

  const result: RejectedDossierFactualUpdate[] = [];
  for (const candidate of candidates) {
    if (!isRejectedDossierFactualUpdate(candidate)) continue;
    // Hydrate immutable legacy receipts through the existing audit path when
    // possible; non-hydratable receipts remain daily completion evidence but
    // cannot advance a lifecycle-bound cursor.
    const hydrated = candidate.thesisObservation
      ? candidate
      : await getRejectedDossierFactualUpdate(sym, candidate.date) ?? candidate;
    if (hydrated.thesisObservation) result.push(hydrated);
  }
  return result;
}

/**
 * Advance the daily review cursor without treating a rejected proposition as
 * a newly admitted directional state. Canonical thesis fields and signal stay
 * anchored to the last release-valid dossier.
 */
export function priorThesisContextWithRejectedReviews(
  prior: DossierPriorThesisContext,
  rejected: readonly RejectedDossierFactualUpdate[],
): DossierPriorThesisContext {
  const matching = rejected
    .filter((receipt) => {
      const observation = receipt.thesisObservation;
      return receipt.date > prior.date && Boolean(observation) &&
        observation!.lifecycleId === prior.lifecycleId &&
        observation!.openedDate === prior.openedDate &&
        observation!.subjectPunchline === prior.subjectPunchline;
    })
    .sort((left, right) => left.date.localeCompare(right.date));
  if (matching.length === 0) return prior;
  let observationIndex = prior.observationIndex;
  for (const receipt of matching) {
    observationIndex = Math.max(
      observationIndex + 1,
      receipt.thesisObservation!.observationIndex,
    );
  }
  const latest = matching.at(-1)!;
  return {
    ...prior,
    observationIndex,
    outcomeContext: {
      status: "unresolved",
      asOfDate: latest.date,
      note: `The ${latest.date} council review completed without enough support to admit a new directional state. Keep the canonical thesis and latest admitted signal unchanged while testing today's evidence.`,
    },
  };
}

async function saveRejectedDossierFactualUpdate(
  update: RejectedDossierFactualUpdate,
  lease: DossierGenerationLease,
): Promise<RejectedDossierFactualUpdate> {
  if (!isRejectedDossierFactualUpdate(update)) throw new Error("invalid rejected factual update");
  await assertGenerationLease(lease);
  const key = rejectedUpdateKey(update.ticker, update.date);
  if (useMemory) {
    const existing = memRejectedUpdates.get(key);
    if (existing) {
      if (!isRejectedDossierFactualUpdate(existing)) {
        throw new Error(`stored rejected factual update ${key} is invalid`);
      }
      return structuredClone(existing);
    }
    memRejectedUpdates.set(key, structuredClone(update));
    return structuredClone(update);
  }

  const ref = firestore().collection("dossier_rejected_updates").doc(key);
  return firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) {
      const existing = snapshot.data();
      if (!isRejectedDossierFactualUpdate(existing)) {
        throw new Error(`stored rejected factual update ${key} is invalid`);
      }
      return existing;
    }
    transaction.create(ref, update);
    return update;
  });
}

async function saveDossier(
  d: Dossier,
  lease: DossierGenerationLease,
  socialScorecard: SocialEvidenceScorecard,
): Promise<string | null> {
  const privateSignalOutbox = shouldIssuePrivateSignalForDossier(d)
    ? buildPrivateSignalOutboxItem(d)
    : null;
  await assertGenerationLease(lease);
  if (useMemory) {
    const current = memStore.get(d.ticker);
    if (current && current.date > d.date) throw new Error("refusing to clobber a newer dossier");
    // Validate and stage the compact outbox before the dossier map changes.
    // Both writes are synchronous and no awaited work can observe one alone.
    if (privateSignalOutbox) enqueuePrivateSignalOutboxInMemory(privateSignalOutbox);
    memStore.set(d.ticker, d);
    saveSocialEvidenceScorecardInMemory(socialScorecard);
  } else {
    const dossierRef = firestore().collection("dossiers").doc(d.ticker);
    const leaseRef = firestore().collection("pipeline_leases").doc(lease.id);
    const outboxRef = privateSignalOutbox
      ? firestore().collection(PRIVATE_SIGNAL_OUTBOX_COLLECTION).doc(privateSignalOutbox.id)
      : null;
    const socialScorecardRef = firestore()
      .collection(SOCIAL_EVIDENCE_SCORECARD_COLLECTION)
      .doc(socialScorecard.id);
    await firestore().runTransaction(async (transaction) => {
      const [leaseSnapshot, currentSnapshot, outboxSnapshot] = await Promise.all([
        transaction.get(leaseRef),
        transaction.get(dossierRef),
        outboxRef ? transaction.get(outboxRef) : Promise.resolve(null),
      ]);
      const leaseData = leaseSnapshot.data() as { owner?: string; expiresAt?: number } | undefined;
      if (!leaseSnapshot.exists || leaseData?.owner !== lease.owner || Number(leaseData.expiresAt) <= Date.now()) {
        throw new Error("generation lease lost before final dossier compare-and-set");
      }
      const current = currentSnapshot.exists ? currentSnapshot.data() as Partial<Dossier> : null;
      if (current?.date && current.date > d.date) throw new Error("refusing to clobber a newer dossier");
      if (privateSignalOutbox && outboxRef && outboxSnapshot) {
        enqueuePrivateSignalOutboxInTransaction(
          transaction,
          outboxRef,
          outboxSnapshot,
          privateSignalOutbox,
        );
      }
      transaction.set(dossierRef, d);
      transaction.set(socialScorecardRef, socialScorecard);
    });
  }
  // History: every dossier ever written stays on the company record.
  await saveDossierHistory(d.ticker, d.date, { ...d }).catch(() => {});
  return privateSignalOutbox?.id ?? null;
}

function pendingRunId(ticker: string, date: string): string {
  return `${ticker.toUpperCase()}_${date}`;
}

async function getPendingDossierRun(ticker: string, date: string): Promise<PendingDossierRun | null> {
  const id = pendingRunId(ticker, date);
  if (useMemory) return memPendingStore.get(id) ?? null;
  const doc = await firestore().collection("dossier_pending_runs").doc(id).get();
  return doc.exists ? (doc.data() as PendingDossierRun) : null;
}

/** Operational receipt for a same-contract terminal validation failure. */
export async function getDossierTerminalFailure(
  ticker: string,
  date: string,
): Promise<DossierTerminalFailure | null> {
  return (await getPendingDossierRun(ticker, date))?.terminalFailure ?? null;
}

function pendingForStorage(run: PendingDossierRun): PendingDossierRun {
  const stored = structuredClone(run);
  if (stored.websiteArtifact) delete stored.websiteArtifact.output;
  if (stored.emailDraft?.artifact) delete stored.emailDraft.artifact.output;
  if (stored.emailConfidence?.artifact) delete stored.emailConfidence.artifact.output;
  const bytes = Buffer.byteLength(JSON.stringify(stored), "utf8");
  if (bytes > FIRESTORE_SAFE_DOCUMENT_BYTES) {
    throw new Error(`dossier checkpoint is ${bytes} bytes; refusing to truncate or exceed Firestore's document limit`);
  }
  return stored;
}

async function savePendingDossierRun(run: PendingDossierRun, lease: DossierGenerationLease): Promise<void> {
  await assertGenerationLease(lease);
  const id = pendingRunId(run.ticker, run.date);
  const stored = pendingForStorage(run);
  if (useMemory) {
    const current = memPendingStore.get(id);
    if (current?.generationOwner === lease.owner && current.revision !== run.revision) {
      throw new Error(`pending dossier CAS failed: expected revision ${run.revision}, found ${current.revision}`);
    }
    stored.revision = (current?.revision ?? -1) + 1;
    stored.generationOwner = lease.owner;
    run.revision = stored.revision;
    run.generationOwner = lease.owner;
    memPendingStore.set(id, stored);
    return;
  }
  const pendingRef = firestore().collection("dossier_pending_runs").doc(id);
  const leaseRef = firestore().collection("pipeline_leases").doc(lease.id);
  const nextRevision = await firestore().runTransaction(async (transaction) => {
    const [leaseSnapshot, currentSnapshot] = await Promise.all([
      transaction.get(leaseRef), transaction.get(pendingRef),
    ]);
    const leaseData = leaseSnapshot.data() as { owner?: string; expiresAt?: number } | undefined;
    if (!leaseSnapshot.exists || leaseData?.owner !== lease.owner || Number(leaseData.expiresAt) <= Date.now()) {
      throw new Error("generation lease lost before pending-run compare-and-set");
    }
    const current = currentSnapshot.exists ? currentSnapshot.data() as PendingDossierRun : null;
    if (current?.generationOwner === lease.owner && current.revision !== run.revision) {
      throw new Error(`pending dossier CAS failed: expected revision ${run.revision}, found ${current.revision}`);
    }
    const revision = (current?.revision ?? -1) + 1;
    transaction.set(pendingRef, { ...stored, generationOwner: lease.owner, revision });
    return revision;
  });
  run.revision = nextRevision;
  run.generationOwner = lease.owner;
}

async function deletePendingDossierRun(ticker: string, date: string, lease: DossierGenerationLease): Promise<void> {
  await assertGenerationLease(lease);
  const id = pendingRunId(ticker, date);
  if (useMemory) {
    if (memPendingStore.get(id)?.generationOwner === lease.owner) memPendingStore.delete(id);
    return;
  }
  const pendingRef = firestore().collection("dossier_pending_runs").doc(id);
  const leaseRef = firestore().collection("pipeline_leases").doc(lease.id);
  await firestore().runTransaction(async (transaction) => {
    const [leaseSnapshot, pendingSnapshot] = await Promise.all([
      transaction.get(leaseRef), transaction.get(pendingRef),
    ]);
    if (leaseSnapshot.data()?.owner !== lease.owner) throw new Error("generation lease lost before pending deletion");
    if (pendingSnapshot.exists && pendingSnapshot.data()?.generationOwner === lease.owner) transaction.delete(pendingRef);
  });
}

async function createIgnoringExisting(ref: DocumentReference, value: unknown): Promise<void> {
  try { await ref.create(value as Record<string, unknown>); }
  catch (error) {
    const code = (error as { code?: number | string } | null)?.code;
    if (code !== 6 && code !== "6" && code !== "already-exists") throw error;
  }
}

async function getImmutableGenerationAuditRecord(id: string): Promise<unknown | null> {
  if (!/^[a-f0-9]{48}$/.test(id)) return null;
  if (useMemory) return structuredClone(memGenerationAudits.get(id) ?? null);
  const root = firestore().collection("dossier_generation_audits").doc(id);
  const snapshot = await root.get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() as Record<string, unknown>;
  const payloadSha256 = String(data.payloadSha256 ?? "");
  if (!/^[a-f0-9]{64}$/.test(payloadSha256)) throw new Error("invalid immutable audit payload hash");
  let serialized: string;
  if (data.encoding === "json-string-inline-v2" && typeof data.payloadJson === "string") {
    serialized = data.payloadJson;
  } else if (data.encoding === "json-inline-v1" && "payload" in data) {
    serialized = JSON.stringify(data.payload);
  } else if (data.encoding === "utf8-json-base64-parts-v1" &&
      Number.isInteger(data.chunks) && Number(data.chunks) > 0) {
    const expectedChunks = Number(data.chunks);
    const parts = await root.collection("parts").orderBy("index", "asc").get();
    if (parts.size !== expectedChunks) throw new Error("incomplete immutable audit payload");
    const buffers = parts.docs.map((document, index) => {
      const part = document.data() as Record<string, unknown>;
      const base64 = String(part.base64 ?? "");
      if (part.index !== index || document.id !== String(index).padStart(4, "0") ||
          part.chunkSha256 !== sha256(base64)) {
        throw new Error("invalid immutable audit part lineage");
      }
      const decoded = Buffer.from(base64, "base64");
      if (decoded.byteLength !== part.bytes) throw new Error("invalid immutable audit part length");
      return decoded;
    });
    serialized = Buffer.concat(buffers).toString("utf8");
  } else {
    throw new Error("unsupported immutable audit encoding");
  }
  if (sha256(serialized) !== payloadSha256 ||
      Buffer.byteLength(serialized, "utf8") !== data.payloadBytes) {
    throw new Error("immutable audit failed reconstruction hash");
  }
  return JSON.parse(serialized);
}

/** Immutable and reconstructable even when the payload needs Firestore child documents. */
async function saveImmutableGenerationAudit(id: string, record: unknown): Promise<void> {
  if (useMemory) {
    if (!memGenerationAudits.has(id)) memGenerationAudits.set(id, structuredClone(record));
    return;
  }
  const serialized = JSON.stringify(record);
  const bytes = Buffer.from(serialized, "utf8");
  const root = firestore().collection("dossier_generation_audits").doc(id);
  if (bytes.byteLength <= FIRESTORE_SAFE_DOCUMENT_BYTES) {
    await createIgnoringExisting(root, {
      // Preserve the exact hashed bytes. Firestore map key order is not a
      // serialization contract, so storing `payload: record` cannot later
      // prove the original JSON.stringify preimage deterministically.
      encoding: "json-string-inline-v2", payloadJson: serialized,
      payloadSha256: sha256(serialized), payloadBytes: bytes.byteLength,
    });
    return;
  }
  const chunkBytes = 500_000;
  const chunks = Math.ceil(bytes.byteLength / chunkBytes);
  for (let index = 0; index < chunks; index += 1) {
    const chunk = bytes.subarray(index * chunkBytes, Math.min(bytes.byteLength, (index + 1) * chunkBytes));
    await createIgnoringExisting(root.collection("parts").doc(String(index).padStart(4, "0")), {
      index, base64: chunk.toString("base64"), bytes: chunk.byteLength, chunkSha256: sha256(chunk.toString("base64")),
    });
  }
  await createIgnoringExisting(root, {
    encoding: "utf8-json-base64-parts-v1", chunks, payloadSha256: sha256(serialized), payloadBytes: bytes.byteLength,
  });
}

// ---- verified-source context bundle ----

interface DossierContextBundle {
  context: string;
  sources: string;
  evidence: DossierCitation[];
  claims: LedgerClaim[];
  deterministicEvidence: DeterministicEvidenceFact[];
  evidenceManifest?: EvidenceManifest;
}

function pct(v: number | null): string {
  if (v == null) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function deterministicFactsFromContext(context: string): DeterministicEvidenceFact[] {
  return context.split("\n").flatMap((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || !/^(?:TAPE|ONE-MONTH TAPE|Latest reported quarter:|- Revenue:|- Net income:|- Diluted EPS:|- \[S\d+\].*filed|COVERAGE MANIFEST)/i.test(line)) return [];
    const sourceIds = [...new Set([...line.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))];
    const period = line.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
    const kind: DeterministicEvidenceFact["kind"] = /^TAPE|^ONE-MONTH/i.test(line)
      ? "market"
      : /filed/i.test(line)
        ? "filing"
        : /^COVERAGE/i.test(line)
          ? "coverage"
          : "filed-metric";
    return [{
      id: `D-context-${index + 1}`,
      kind,
      value: line,
      period,
      sourceIds,
      recordSha256: sha256(JSON.stringify({ line, period, sourceIds })),
    }];
  });
}

async function buildContext(sym: string): Promise<DossierContextBundle | null> {
  const [snap, daily, filings, fundamentals, companyNews, cik] = await Promise.all([
    getTickerSnapshot(sym),
    getBarsStored(sym),
    getFilingsStored(sym, 6),
    getFundamentalsStored(sym),
    getCompanyNews(sym, 8),
    cikFor(sym),
  ]);
  if (!snap) return null;

  const retrievedAt = Date.now();
  const fallbackExclusions: Array<{ title: string; reason: string }> = [];
  const evidence: DossierCitation[] = [];
  const addEvidence = (
    source: Omit<DossierCitation, "id" | "retrievedAt" | "sourceDocumentId"> & {
      sourceDocumentId?: string;
    },
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
  const tapeId = addEvidence({
    title: `${snap.name} market tape`,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`,
    publisher: "Yahoo Finance market data",
    authority: "market-data",
    publishedAt: retrievedAt,
    publishedDate: isoDate(retrievedAt),
  });

  const parts: string[] = [
    `COMPANY: ${snap.name} (${sym}), ${snap.exchange}. [${tapeId}]`,
    `TAPE (Yahoo Finance market-data snapshot): last $${snap.price?.toFixed(2)}, ${pct(snap.dayChangePercent)} on the day, ` +
      `${snap.afterHoursChangePercent != null ? `${pct(snap.afterHoursChangePercent)} after hours` : "after hours quiet"}, ` +
      `52-week ${snap.fiftyTwoWeekLow?.toFixed(0)}–${snap.fiftyTwoWeekHigh?.toFixed(0)}. [${tapeId}]`,
  ];
  const month = daily.slice(-21);
  if (month.length > 1) {
    const first = month[0].close;
    const last = month[month.length - 1].close;
    if (first && last) {
      parts.push(`ONE-MONTH TAPE: ${pct(((last - first) / first) * 100)} over ${month.length} sessions. [${tapeId}]`);
    }
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
    parts.push(`FILED FUNDAMENTALS (SEC XBRL) [${xbrlId}]:\n${fundamentalsMd(sym, fundamentals)}\nSOURCE: [${xbrlId}]`);
  }
  if (filings.length > 0) {
    const filingRows = filings.map((filing) => {
      const id = addEvidence({
        title: `${sym} ${filing.formLabel} — ${filing.title}`,
        url: filing.url,
        publisher: "U.S. Securities and Exchange Commission",
        authority: "primary",
        publishedAt: filing.filedAt ?? Date.parse(`${filing.date}T12:00:00Z`),
        publishedDate: filing.date,
      });
      return `- [${id}] ${filing.formLabel} filed ${filing.date} — ${filing.title}`;
    });
    parts.push(
      `OFFICIAL RECORD (SEC EDGAR, newest first):\n` +
        filingRows.join("\n")
    );
    const latest8k = filings.find((f) => f.form === "8-K");
    if (latest8k) {
      const text = await fetchFilingText(latest8k.url);
      const source = evidence.find((item) => item.url === latest8k.url);
      const selected = text ? selectFiledItemSections(text, latest8k.title) : "";
      if (selected && source) {
        source.contentSha256 = sha256(selected);
        parts.push(`LATEST 8-K FILED ITEMS (${latest8k.date}) [${source.id}]:\n${selected}\nSOURCE: [${source.id}]`);
      } else {
        fallbackExclusions.push({
          title: `${latest8k.formLabel} ${latest8k.date}`,
          reason: text
            ? "filed item numbers were not identifiable; no partial filing extract admitted"
            : "SEC filing body unavailable; no partial filing extract admitted",
        });
      }
    }
  }
  const newsEvidence = (await Promise.all(companyNews.map(async (link) => {
    const article = await getArticle(link.articleId);
    if (!article) return null;
    const event = article.eventId ? await getNewsEvent(article.eventId) : null;
    return { article, event };
  })))
    .filter((item) => item != null)
    .filter(({ article, event }) =>
      (article.evidenceTier === "authoritative" || article.evidenceTier === "licensed") &&
      // Existing pre-migration articles have no event yet. Newly ingested
      // material news must be primary or independently corroborated.
      (!event || event.eligibleForBrief));
  if (newsEvidence.length > 0) {
    parts.push(
      `VERIFIED NEWS (dated, traceable):\n` +
        newsEvidence.map(({ article, event }) => {
          const provenance = article.provenance.find((source) => source.tier === "authoritative") ??
            article.provenance.find((source) => source.tier === "licensed") ??
            article.provenance[0];
          const id = addEvidence({
            title: article.title,
            url: article.canonicalUrl,
            publisher: provenance?.publisher ?? article.publisher,
            authority: provenance?.sourceType === "primary" ? "primary" : "independent",
            publishedAt: article.publishedAt,
            publishedDate: isoDate(article.publishedAt),
            ...(provenance?.rawSha256 ? { contentSha256: provenance.rawSha256 } : {}),
            ...(provenance?.sourceVerification ? {
              sourceVerifiedAt: provenance.sourceVerification.verifiedAt,
              sourceVerifiedBy: provenance.sourceVerification.verifiedBy,
            } : {}),
            sourceDocumentId: article.sourceDocumentId ?? article.id,
            ...(event ? {
              eventId: event.id,
              observationIds: event.observationIds,
              evidenceState: event.evidenceState,
            } : {
              observationIds: article.observationIds ?? [],
            }),
          });
          return `- [${id}] ${article.title} (${provenance?.publisher ?? article.publisher}, ${isoDate(article.publishedAt)}${
            event ? `, ${event.evidenceState}` : ""
          })`;
        }).join("\n")
    );
  }
  const socialPosts = await getRecentSocialPosts(sym).catch(() => []);
  if (socialPosts.length > 0) {
    parts.push(
      `SOCIAL CHATTER (X posts · SOCIAL grade — shows what sampled accounts are discussing; never broad sentiment, acceleration, or a factual source; a posted claim is unverified unless a higher-grade source in this bundle confirms it):\n` +
        socialPosts.map((post) => {
          const id = addEvidence({
            title: `@${post.author} on X — retail chatter`,
            url: post.url,
            publisher: `@${post.author} · X`,
            authority: "social",
            publishedAt: Date.parse(post.createdAt) || post.pulledAt,
            publishedDate: post.publishedDate,
          });
          return `- [${id}] @${post.author} (${post.authorFollowers.toLocaleString()} followers, engagement ${post.engagement}): "${post.text.replace(/\s+/g, " ")}"`;
        }).join("\n")
    );
  }

  const sources = [
    `Yahoo Finance market-data snapshot`,
    fundamentals ? `SEC XBRL (${fundamentals.fiscal})` : null,
    filings.length ? `${filings.length} EDGAR filings` : null,
    newsEvidence.length ? `${newsEvidence.length} traceable news sources` : null,
    socialPosts.length ? `${socialPosts.length} social-chatter posts (low grade)` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const sourceIndex = evidence
    .map((item) => `[${item.id}] ${item.authority.toUpperCase()} · ${item.publishedDate} · ${item.title} · ${item.url}`)
    .join("\n");
  const packed = packEvidenceSections([
    ...parts.map((text, index) => ({
      id: `fallback-${index + 1}`,
      text,
      priority: (index < 2 || /^FILED FUNDAMENTALS|^OFFICIAL RECORD/.test(text) ? 0 : 1) as 0 | 1,
      required: index < 2 || /^FILED FUNDAMENTALS|^OFFICIAL RECORD/.test(text),
    })),
    { id: "fallback-source-index", text: `SOURCE INDEX:\n${sourceIndex}`, priority: 0, required: true },
  ]);
  if (packed.requiredExcludedIds.length > 0) {
    console.error(`[dossier] ${sym}: fallback evidence cannot fit required complete sections: ${packed.requiredExcludedIds.join(", ")}`);
    return null;
  }
  for (const id of packed.excludedIds) {
    fallbackExclusions.push({ title: id, reason: "withheld as a complete section by ranked prompt budget" });
  }
  return {
    context: packed.text,
    sources,
    evidence,
    claims: [],
    deterministicEvidence: deterministicFactsFromContext(packed.text),
    evidenceManifest: {
      itemsSeen: parts.length,
      clustersFormed: newsEvidence.length,
      duplicatesCollapsed: 0,
      included: evidence.length,
      excluded: fallbackExclusions,
    },
  };
}

// ---- chairman: council answers → strict card JSON ----

export const CANONICAL_THESIS_MODEL = RESEARCH_MODELS.canonicalChair;
export const DAILY_CONTINUITY_MODEL = RESEARCH_MODELS.dailyChair;
export const THESIS_SHADOW_DEFAULT_MODEL = RESEARCH_MODELS.thesisShadow;
const EMAIL_CHAIRMAN_MODEL = DAILY_CONTINUITY_MODEL;

export type ThesisShadowAuditStatus =
  | "aligned"
  | "more_cautious"
  | "more_aggressive"
  | "boundary_candidate";

export interface ThesisShadowAuditOutput {
  status: ThesisShadowAuditStatus;
  reason: string;
  sourceIds: string[];
  contradiction: string | null;
}

export function modelForWebsiteAuthority(authority: WebsiteChairAuthority): string {
  return authority === "canonical" ? CANONICAL_THESIS_MODEL : DAILY_CONTINUITY_MODEL;
}

const THESIS_SHADOW_PROMPT = `You are an internal, non-publishing audit model for AMM thesis continuity.

Audit the already-produced daily continuity observation against the compact claim ledger, deterministic facts and dated source index supplied below. You have no authority to rewrite, approve, reject, strengthen, weaken, resolve, invalidate or replace the public thesis. Your only job is to leave a traceable diagnostic for later evaluation.

Use only the supplied evidence. Do not browse. Do not infer missing facts. "boundary_candidate" means only that the supplied evidence may warrant a separate canonical lifecycle review; it is not a lifecycle decision. Every conclusion must cite source IDs through the sourceIds array.

Return STRICT JSON only with exactly these keys:
{
  "status": "aligned | more_cautious | more_aggressive | boundary_candidate",
  "reason": "one concise evidence-grounded explanation",
  "sourceIds": ["S1"],
  "contradiction": "the single strongest material contradiction, or null"
}`;

const CHAIR_PROMPT = `You are the chairman of a research desk's council. Write the canonical, full-depth website dossier from the complete council record and verified source bundle.

This is the product, not an email summary. The reader is paying for synthesis: identify the one non-obvious implication that best reconciles the new event, the filed economics, the market response and the strongest counterevidence. Start with that answer. Do not start with a chronology or a list of facts.

Preserve every UNIQUE material insight, correction, dissent and unresolved question, but state each fact once. Give every fact one home: the story owns only the facts required for the causal chain; bulls and bears add distinct evidence; risk owns failure modes and missing evidence; numbersRead owns detailed arithmetic and metric relationships. Cross-reference an implication in plain words instead of repeating the same figures in multiple sections. Depth follows the evidence. Never pad to a word target and never shorten by cutting a material point.

The public dossier is not a transcript. State the corrected conclusion directly. Do not mention the bundle, packets, models, seats, Kimi, the Evidence Marshal, a lead draft or what the council "did." A reader should see the better conclusion, not generation-process narration.

When the research question includes an ACTIVE THESIS CONTINUITY block, treat that proposition as the standing hypothesis. Test it against the new evidence instead of inventing an unrelated daily thesis. Preserve it when still open, strengthen or weaken it only when the evidence warrants, and depart from it only when the evidence resolves, invalidates, or materially replaces it.

Return STRICT JSON only, no markdown fences, with exactly these keys:
{
  "headline": "one sharp line, <=110 chars, ending with one or more source markers such as [S1]",
  "story": "the chairman's synthesis in 4-7 substantive paragraphs: the answer first, what changed, the causal mechanism, why the market may be misreading it, the strongest counterevidence and the single unresolved question; EVERY factual sentence ends with supporting [S#] markers",
  "bulls": ["3-5 distinct evidence-backed points that strengthen the synthesis without repeating the story or numbersRead; every factual sentence carries supporting [S#] markers"],
  "bears": ["3-5 distinct evidence-backed counterpoints that weaken the synthesis without repeating the story or risk; every factual sentence carries supporting [S#] markers"],
  "risk": "the failure mechanism, contradictory evidence, real data limitations, strongest dissent and observable invalidation; do not recap bulls, bears or numbersRead; every factual sentence carries supporting [S#] markers",
  "numbersRead": "interpret the filed numbers once: reconcile headline earnings with operating income, non-operating items, cash generation, capital spending and balance-sheet capacity when present; distinguish quarterly, YTD and point-in-time periods; do not repeat the story; every factual sentence carries supporting [S#] markers",
  "signalCase": {
    "eventType": "earnings | guidance | regulatory | product | legal | capital | leadership | macro | other",
    "direction": "UP | DOWN",
    "strength": "GENTLE | MODERATE | STRONG",
    "horizonSessions": {"min": 10, "max": 15},
    "mechanism": "35-80 plain-English words explaining why the admitted change could support this direction over the next 10-15 sessions; every factual sentence carries [S#] markers",
    "invalidation": "20-55 words naming observable evidence that would negate or materially weaken the read; with [S#] markers"
  }
}

HARD RULES: no buy/sell/hold language, no personalised allocation, no price target, no fair-value estimate, no percentage forecast, and no 'investors should'. The signal is a time-bounded research read, not an instruction. Choose direction and qualitative strength from the supported mechanism. Never invent a numeric move band: public signal magnitude is qualitative only. Only use facts present in the verified source bundle. Never invent a source marker. EVERY factual sentence and every array item MUST contain at least one valid [S#] marker from the SOURCE INDEX. Clearly label inference, uncertainty and genuinely missing evidence. Inspect every filed metric in the source bundle before declaring a cash-flow, balance-sheet, operating-income, tax, capital-spending or securities-gain bridge unavailable. If a claim lacks a source, omit it. Write for an intelligent reader with another full-time job: short sentences, concrete nouns, no desk jargon. Do not mention models or the generation process.`;

export const EMAIL_HOOK_PROMPT = `You are the chairman writing AMM's fixed-format morning email AFTER the full website dossier is finished.

The reader already has news feeds. AMM's product is the non-obvious synthesis: connect the new external signal to a specific business or financial mechanism, explain why that implication matters now, and show the strongest traceable evidence. Do not write a generic recap or withhold the insight as a tease.

Return STRICT JSON only, no markdown fences, with exactly these keys:
{
  "subjectPunchline": "6-12 plain-English words stating the non-obvious proposition; it must stand alone AND read grammatically after 'Is it true that'; no question, wordplay, source marker, ticker, forecast or sensationalism",
  "priorUpdate": null,
  "whatChanged": "20-40 words stating the newly observed EXTERNAL signal and its timing; report what happened, not AMM's implication; with source markers",
  "thesis": "25-45 words giving ONE clear, falsifiable central proposition. It must say the verified change is more likely to SUPPORT or PRESSURE the shares over the next 10-15 sessions, matching the supplied canonical direction; explain the mechanism and main risk; with source markers",
  "primaryEvidence": "20-45 words explaining the strongest fact that directly supports the thesis; with source markers",
  "secondaryEvidence": ["exactly 2 distinct corroborating facts or signals, 15-30 words each, strongest first, each with source markers"]
}

When code supplies an ACTIVE THESIS, priorUpdate MUST be {"status":"strengthened | weakened | resolved | invalidated | replaced | open","text":"8-20 words honestly describing its state with source markers"}. For open, strengthened or weakened, reproduce the supplied canonical subjectPunchline VERBATIM and keep its direction; open also keeps its qualitative strength. Use strengthened only when new evidence materially increases support, weakened only when new contrary evidence reduces support, resolved only when the named oracle is answered, invalidated when evidence defeats the proposition, and replaced only when materially new evidence justifies a genuinely different proposition. Any direction reversal requires resolved, invalidated or replaced. Never silently substitute today's most interesting headline. Never say confirmed. With no active thesis, priorUpdate MUST be null.

The immutable reading order is WHAT CHANGED → AMM▲THESIS → EVIDENCE. The thesis must make the direction and fixed horizon unmistakable in prose: "more likely to support the shares over the next 10-15 sessions" for UP, or "more likely to pressure the shares over the next 10-15 sessions" for DOWN. A separate five-family ballot pass creates COUNCIL CONFIDENCE after every analyst votes on that exact proposition. Do not predict votes or output signal fields, confidence, a move percentage, price level, separate question or recommendation.

Every factual sentence in whatChanged, thesis, primaryEvidence, secondaryEvidence and priorUpdate.text must end with valid [S#] markers from the SOURCE INDEX. Use only conclusions already present in the compact dossier packet and active-thesis block. Extract the dossier's canonical synthesis; do not invent a second angle, turn a caveat into a hook, or repeat the same figure in every beat. The thesis must explain the canonical signal mechanism without inventing causality. No buy/sell/hold language, ratings, price targets, fair value, personalised allocation or percentage forecast. Write for an intelligent reader with another full-time job: concrete words, short sentences, no 'decision-relevant', 'proxy for operating momentum', 'admitted source', 'the tape', 'cash residual', bundle, packet, seat or draft. Precise and compelling; no sensationalism.`;

const EMAIL_BALLOT_PROMPT = `You are one of five independent AMM analysts casting a recorded ballot on the exact final public proposition.

Return STRICT JSON only with exactly:
{
  "position": "SUPPORT | OPPOSE | UNCERTAIN",
  "rationale": "20-90 words explaining why this complete proposition is or is not supported; every factual sentence carries [S#] markers",
  "flipEvidence": "15-55 words naming the observable evidence that would change your position; with [S#] markers",
  "fatalContradiction": false,
  "contradictionReason": null,
  "strength": {"novelty": 1, "materiality": 1, "evidence": 1, "asymmetry": 1}
}

Vote on the EXACT thesis plus direction, qualitative strength and 10-15-session horizon. SUPPORT means the complete directional proposition is more likely than not over that horizon because the evidence supplies both a verified trigger and a credible mechanism. A merely defensible sentence is not enough. OPPOSE means the proposition is materially wrong or overstated. UNCERTAIN means a missing primary fact, unverified trigger, weak market response or unresolved causal link prevents a directional choice. Do not rewrite the thesis or substitute another horizon. Use only the compact shared evidence packet and its source index. Rate each dimension 1-5 under the same stable rubric: 3 solid, 4 exceptional, 5 rare. No advice, price target, fair value or percentage forecast.

Set fatalContradiction true only when arithmetic, a period mismatch, or a primary-source fact demonstrably defeats a core premise of the exact thesis. A fatal contradiction requires position OPPOSE and a 15-55-word cited contradictionReason. Ordinary uncertainty, missing evidence, causal doubt or disagreement is not fatal; set false and contradictionReason null. A single recorded fatal contradiction blocks publication regardless of the raw SUPPORT count.`;

const EMAIL_CONFIDENCE_PROMPT = `You are AMM's chairman explaining five recorded ballots on one exact public proposition.

Return STRICT JSON only with exactly:
{
  "majorityReason": "18-35 words faithfully synthesising the SUPPORT reason; external factual sentences carry [S#] markers",
  "dissentReason": "15-30 words preserving OPPOSE reasoning, or null when no ballot opposed",
  "uncertaintyReason": "15-30 words preserving UNCERTAIN reasoning, or null when nobody was uncertain",
  "flipCondition": "15-30 words stating the observable evidence that would flip or resolve the read; with [S#] markers"
}

Do not restate vote counts: code renders them. Preserve OPPOSE and UNCERTAIN as different positions and never manufacture unanimity. The flip condition is required. No advice, rating, price target, fair value or percentage forecast.`;

export function renderCitations(text: string, evidence: DossierCitation[]): string | null {
  const valid = new Map(evidence.map((source, index) => [source.id, { source, number: index + 1 }]));
  if (citationValidationError(text, evidence)) return null;
  return text.replace(/\[(S\d+)\]/g, (_, marker: string) => {
    const citation = valid.get(marker)!;
    const date = citation.source.publishedDate;
    const title = `${citation.source.title} — ${date}`.replace(/"/g, "'");
    return `[${citation.number} · ${date}](${citation.source.url} "${title}")`;
  });
}

/**
 * Split public prose without treating an initialism such as "U.S." as two
 * sentence endings. The citation gate operates per factual sentence, so a
 * false split here can reject a correctly cited claim after the final marker.
 */
function splitPublicSentences(text: string): string[] {
  const stop = "\u0000";
  const protectedText = text.replace(
    /\b(?:[A-Za-z]\.){2,}/g,
    (initialism) => initialism.replace(/\./g, stop),
  );
  return protectedText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replaceAll(stop, "."));
}

function citationValidationError(text: string, evidence: DossierCitation[]): string | null {
  const valid = new Map(evidence.map((source) => [source.id, source]));
  const markers = [...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]);
  if (markers.length === 0) return "no source markers are present";
  const invalidMarkers = [...new Set(markers.filter((marker) => !valid.has(marker)))];
  if (invalidMarkers.length > 0) return `invalid source markers: ${invalidMarkers.join(", ")}`;
  for (const marker of markers) {
    try {
      const sourceUrl = new URL(valid.get(marker)!.url);
      if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") {
        return `source ${marker} does not have a web URL`;
      }
    } catch {
      return `source ${marker} has an invalid URL`;
    }
  }
  // Models naturally emit `Sentence. [S1]`; move the marker before terminal
  // punctuation only for validation so it remains associated with that
  // sentence rather than being mistaken for the next one.
  const validationText = text.replace(
    /([.!?])\s*((?:\[S\d+\]\s*)+)/g,
    (_, punctuation: string, citations: string) => ` ${citations.trim()}${punctuation} `,
  );
  const sentences = splitPublicSentences(validationText)
    .filter((sentence) => sentence.replace(/\[S\d+\]/g, "").trim().length > 20);
  const uncited = sentences
    .map((sentence, index) => ({ sentence: sentence.replace(/\s+/g, " ").trim(), index: index + 1 }))
    // Per-claim, not per-sentence: connective prose needs no receipt — sentences
    // carrying numbers, money or percentages do.
    .filter(({ sentence }) => /[0-9%$€£]/.test(
      sentence.replace(/\[S\d+\]/g, "").replace(/\b10\s*[–—-]\s*15\s+(?:trading\s+)?sessions?\b/gi, ""),
    ))
    // The council's own verdict line ("UP — GENTLE over 10–15 sessions") is a
    // conclusion, not an external fact — it has no source to cite.
    .filter(({ sentence }) => !/\b(?:UP|DOWN)\s*[—–-]+\s*(?:GENTLE|MODERATE|STRONG)\b/.test(sentence))
    .filter(({ sentence }) => !/\[S\d+\]/.test(sentence));
  if (uncited.length === 0) return null;
  return `uncited factual sentences: ${uncited
    .slice(0, 8)
    .map(({ sentence, index }) => `#${index} "${sentence.slice(0, 180)}"`)
    .join("; ")}${uncited.length > 8 ? `; plus ${uncited.length - 8} more` : ""}`;
}

function citationScopeError(text: string, allowedSourceIds?: ReadonlySet<string>): string | null {
  if (!allowedSourceIds) return null;
  const outside = [...new Set(
    [...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]).filter((id) => !allowedSourceIds.has(id)),
  )];
  return outside.length > 0 ? `source markers outside the supplied compact packet: ${outside.join(", ")}` : null;
}

interface WebsiteDossierCards {
  headline: string;
  story: string;
  bulls: string[];
  bears: string[];
  risk: string;
  numbersRead: string;
  signalCase: DossierSignalCase;
}

interface DossierSeatMaterial {
  model: string;
  role: string;
  response: string;
  usage?: CouncilModelUsage;
}

interface DossierEmailDraft {
  subjectPunchline: string;
  priorUpdate: DossierPriorUpdate | null;
  whatChanged: string;
  thesis: string;
  primaryEvidence: string;
  secondaryEvidence: string[];
}

interface DossierEmailBallot {
  family: string;
  model: string;
  position: "SUPPORT" | "OPPOSE" | "UNCERTAIN";
  propositionSha256: string;
  evidencePacketSha256: string;
  rationale: string;
  flipEvidence: string;
  fatalContradiction: boolean;
  contradictionReason: string | null;
  strength: {
    novelty: number;
    materiality: number;
    evidence: number;
    asymmetry: number;
  };
  input: string;
  inputSha256: string;
  rawResponse: string;
  attempts: Array<{
    inputSha256: string;
    instruction: string | null;
    rawResponse: string;
    rawResponseSha256: string;
    validationError?: string;
  }>;
  usage?: CouncilModelUsage;
}

interface ChairmanArtifact<T> {
  /** Actual model that produced the final accepted fields (fallbacks included). */
  model?: string;
  /** Rehydrated by validators; omitted from the Firestore checkpoint to avoid duplicating compactOutput. */
  output?: T;
  /** Source-marker form used for hashing and downstream model calls. */
  compactOutput: T;
  /** Small deterministic reconstruction recipe; the exact actual input hash is recorded per attempt. */
  input: string;
  /** Hash-only summary; complete raw responses live once in attempts. */
  rawResponse: string;
  attempts: Array<{
    /** Actual provider model for this attempt; absent only on legacy checkpoints. */
    model?: string;
    inputSha256: string;
    /** Exact prefix/delta joined to the shared reconstructable input; null for the initial call. */
    instruction: string | null;
    rawResponse: string;
    rawResponseSha256: string;
    validationError?: string;
    repairedFields?: string[];
  }>;
  usage?: CouncilModelUsage;
  ballots?: DossierEmailBallot[];
}

function terminalFailureReceipt(
  stage: DossierTerminalFailure["stage"],
  error: string,
  attempts: ChairmanArtifact<unknown>["attempts"] = [],
  usage?: CouncilModelUsage,
): DossierTerminalFailure {
  return {
    stage,
    error: error.slice(0, 2_000),
    failedAt: Date.now(),
    attempts: attempts.map((attempt) => ({
      ...(attempt.model ? { model: attempt.model } : {}),
      inputSha256: attempt.inputSha256,
      rawResponseSha256: attempt.rawResponseSha256,
      ...(attempt.validationError ? { validationError: attempt.validationError.slice(0, 1_000) } : {}),
      ...(attempt.repairedFields ? { repairedFields: attempt.repairedFields } : {}),
    })),
    ...(usage ? { usage } : {}),
  };
}

interface EmailDraftCheckpoint {
  key: string;
  propositionSha256: string;
  artifact: ChairmanArtifact<DossierEmailDraft>;
}

interface EmailBallotCheckpoint {
  key: string;
  family: string;
  ballot: DossierEmailBallot;
}

interface EmailConfidenceCheckpoint {
  key: string;
  artifact: ChairmanArtifact<DossierCouncilConfidence>;
}

interface EmailRejectedCheckpoint {
  key: string;
  propositionSha256: string;
  rejectedAt: number;
  votesSupport: number;
  votesOppose: number;
  votesUncertain: number;
  reason: "minority-support" | "incomplete-ballot" | "fatal-contradiction";
  ballotResponseSha256: string[];
}

type ArtifactValidation<T> =
  | { output: T; compactOutput: T }
  | { error: string; fields: string[]; parsed?: Record<string, unknown> };

function claimSentences(value: string): string[] {
  // Collapse the rendered link first so periods inside source titles (for
  // example, "U.S. Securities...") cannot be mistaken for research claims.
  // Then associate the readable `Sentence. [source]` form with its sentence.
  const collapsed = value.replace(
    /\[\d+ · \d{4}-\d{2}-\d{2}\]\([^\n]*?"[^"]*"\)/g,
    "[CITED]",
  );
  const normalized = collapsed.replace(
    /([.!?])\s*((?:\[CITED\]\s*)+)/g,
    (_, punctuation: string, citations: string) => ` ${citations.trim()}${punctuation} `,
  );
  const withoutHeadings = normalized.replace(/^#{1,6}\s+.+$/gm, "");
  return splitPublicSentences(withoutHeadings)
    .flatMap((sentence) => sentence.split(/\n+(?=[-*]\s+)/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.replace(/\[[^\]]+\]\([^\)]+\)/g, "").length > 20)
    // Mirror the chair-stage citation rule exactly: only digit-bearing factual
    // sentences are claims; the contract horizon phrase and the council's own
    // verdict line are conclusions, not external facts.
    .filter((sentence) => /[0-9%$€£]/.test(
      sentence
        .replace(/\[CITED\]/g, "")
        .replace(/\[[^\]]+\]\([^\)]+\)/g, "")
        .replace(/\b10\s*[–—-]\s*15\s+(?:trading\s+)?sessions?\b/gi, ""),
    ))
    .filter((sentence) => !/\b(?:UP|DOWN)\s*[—–-]+\s*(?:GENTLE|MODERATE|STRONG)\b/.test(sentence));
}

function countClaims(values: string[]): number {
  return values.reduce((total, value) => total + claimSentences(value).length, 0);
}

function countCitedClaims(values: string[]): number {
  return values.reduce(
    (total, value) =>
      total + claimSentences(value).filter((sentence) => sentence.includes("[CITED]")).length,
    0,
  );
}

export function calculateDossierCitationCoverage(
  dossier: Pick<Dossier, "headline" | "story" | "bulls" | "bears" | "risk" | "numbersRead" | "citations">,
): { claims: number; cited: number; primarySources: number } {
  const values = [
    dossier.headline,
    dossier.story,
    ...dossier.bulls,
    ...dossier.bears,
    dossier.risk,
    dossier.numbersRead,
  ];
  return {
    claims: countClaims(values),
    cited: countCitedClaims(values),
    primarySources: dossier.citations?.filter((source) => source.authority === "primary").length ?? 0,
  };
}

function exactRenderedCitation(source: DossierCitation, index: number): string {
  const title = `${source.title} — ${source.publishedDate}`.replace(/"/g, "'");
  return `[${index + 1} · ${source.publishedDate}](${source.url} "${title}")`;
}

/**
 * Re-validate a stored v5 artifact before a reader switch or cache hit.
 *
 * Generation-time counters are evidence, not authority: this recomputes
 * coverage from the rendered artifact and proves every public citation is the
 * exact direct link derived from the immutable citation manifest. A corrupt
 * stored counter or substituted link can therefore never make a dossier look
 * release-ready.
 */
export function dossierReleaseValidationError(
  value: Partial<Dossier> | null | undefined,
): string | null {
  if (!isDetailedDossier(value)) return "not an exact current dossier";
  if (!value.briefAuditId?.trim() || !value.councilRunId?.trim()) {
    return "missing immutable audit ids";
  }
  if (!value.citations?.length || !value.citationCoverage) {
    return "missing citation manifest or stored coverage";
  }
  const recomputed = calculateDossierCitationCoverage(value);
  if (recomputed.claims <= 0 || recomputed.claims !== recomputed.cited) {
    return `rendered dossier citation coverage is ${recomputed.cited}/${recomputed.claims}`;
  }
  if (
    recomputed.claims !== value.citationCoverage.claims ||
    recomputed.cited !== value.citationCoverage.cited ||
    recomputed.primarySources !== value.citationCoverage.primarySources
  ) {
    return "stored citation coverage does not match the rendered dossier";
  }

  const fields: Array<[string, string]> = [
    ["headline", value.headline], ["story", value.story],
    ...value.bulls.map((item): [string, string] => ["bulls", item]),
    ...value.bears.map((item): [string, string] => ["bears", item]),
    ["risk", value.risk], ["numbersRead", value.numbersRead],
    ["signalCase.mechanism", value.signalCase.mechanism],
    ["signalCase.invalidation", value.signalCase.invalidation],
    ["emailHook.whatChanged", value.emailHook.whatChanged],
    ["emailHook.thesis", value.emailHook.thesis],
    ["emailHook.primaryEvidence", value.emailHook.primaryEvidence],
    ...value.emailHook.secondaryEvidence.map((item): [string, string] => ["emailHook.secondaryEvidence", item]),
    ["emailHook.confidence.majorityReason", value.emailHook.confidence.majorityReason],
    ["emailHook.confidence.flipCondition", value.emailHook.confidence.flipCondition],
    ...(value.emailHook.confidence.dissentReason
      ? [["emailHook.confidence.dissentReason", value.emailHook.confidence.dissentReason] as [string, string]]
      : []),
    ...(value.emailHook.confidence.uncertaintyReason
      ? [["emailHook.confidence.uncertaintyReason", value.emailHook.confidence.uncertaintyReason] as [string, string]]
      : []),
    ...(value.emailHook.priorUpdate
      ? [["emailHook.priorUpdate", value.emailHook.priorUpdate.text] as [string, string]]
      : []),
  ];
  const exactLinks = value.citations.map(exactRenderedCitation);
  for (const [label, rendered] of fields) {
    let normalized = rendered;
    for (const link of exactLinks) normalized = normalized.split(link).join("[CITED]");
    if (/\[S\d+\]/.test(normalized) || /\[[^\]]+\]\([^\)]+\)/.test(normalized)) {
      return `${label} contains a raw, substituted, or unknown citation`;
    }
    const claims = countClaims([normalized]);
    const cited = countCitedClaims([normalized]);
    if (claims !== cited) return `${label} citation coverage is ${cited}/${claims}`;
  }
  return null;
}

/**
 * The post-market council run is intentionally dated for the market session
 * it closes, so its valid overnight read remains the desk's current research
 * after New York crosses midnight. Keep that hand-off bounded: one missed
 * daily run must never leave an old thesis looking current.
 */
export function isFreshDeskDossier(
  value: Partial<Dossier> | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = 36 * 60 * 60_000,
): value is Dossier {
  if (dossierReleaseValidationError(value) !== null) return false;
  const ageMs = nowMs - Number(value?.generatedAt);
  return ageMs >= -5 * 60_000 && ageMs <= maxAgeMs;
}

function sourceIndexFor(evidence: DossierCitation[]): string {
  return evidence
    .map((source) => `[${source.id}] ${source.authority.toUpperCase()} · ${source.publishedDate} · ${source.title} · ${source.url}`)
    .join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const raw = text.replace(/```json?|```/g, "").trim();
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}

function usageFromResponse(json: Record<string, unknown>): CouncilModelUsage | undefined {
  const raw = json.usage as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const usage: CouncilModelUsage = {};
  if (Number.isFinite(raw.prompt_tokens)) usage.inputTokens = Number(raw.prompt_tokens);
  if (Number.isFinite(raw.completion_tokens)) usage.outputTokens = Number(raw.completion_tokens);
  if (Number.isFinite(raw.total_tokens)) usage.totalTokens = Number(raw.total_tokens);
  if (Number.isFinite(raw.cost)) usage.costUsd = Number(raw.cost);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function substantiveLength(value: string): number {
  return value.replace(/\[S\d+\]/g, "").trim().length;
}

function mergeUsage(
  first?: CouncilModelUsage,
  second?: CouncilModelUsage,
): CouncilModelUsage | undefined {
  if (!first && !second) return undefined;
  const merged: CouncilModelUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const) {
    const values = [first?.[key], second?.[key]].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (values.length > 0) merged[key] = values.reduce((total, value) => total + value, 0);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

const WEBSITE_FIELDS = ["headline", "story", "bulls", "bears", "risk", "numbersRead", "signalCase"];
const EMAIL_DRAFT_FIELDS = [
  "subjectPunchline", "priorUpdate", "whatChanged", "thesis", "primaryEvidence", "secondaryEvidence",
];
const EMAIL_CONFIDENCE_FIELDS = ["majorityReason", "dissentReason", "uncertaintyReason", "flipCondition"];
const EMAIL_HOOK_FIELDS = [
  ...EMAIL_DRAFT_FIELDS,
  "question", "signal", "votesSupport", "votesOppose", "votesUncertain", "votesTotal", "votes", "confidence", "oracle", "editorialStrength",
];

function exactKeysError(value: Record<string, unknown>, expected: string[]): string | null {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0) return `unknown keys: ${unknown.join(", ")}`;
  if (missing.length > 0) return `missing keys: ${missing.join(", ")}`;
  return null;
}

function knownFields(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  if (!isRecord(value)) return {}; // never throw on a scalar where an object was promised
  return Object.fromEntries(fields.flatMap((field) => field in value ? [[field, value[field]]] : []));
}

export function sanitizeModelJson(text: string, kind: "website" | "email-draft" | "confidence" | "ballot"): string {
  const parsed = parseJsonObject(text);
  const fields = kind === "website" ? WEBSITE_FIELDS
    : kind === "email-draft" ? EMAIL_DRAFT_FIELDS
      : kind === "confidence" ? EMAIL_CONFIDENCE_FIELDS
        : ["position", "rationale", "flipEvidence", "fatalContradiction", "contradictionReason", "strength"];
  const clean = knownFields(parsed, fields);
  if (kind === "website" && isRecord(clean.signalCase)) {
    clean.signalCase = knownFields(clean.signalCase, ["eventType", "direction", "strength", "horizonSessions", "mechanism", "invalidation"]);
    if (isRecord((clean.signalCase as Record<string, unknown>).horizonSessions)) {
      (clean.signalCase as Record<string, unknown>).horizonSessions = knownFields(
        (clean.signalCase as Record<string, unknown>).horizonSessions as Record<string, unknown>, ["min", "max"],
      );
    }
  }
  if (kind === "email-draft" && isRecord(clean.priorUpdate)) {
    clean.priorUpdate = knownFields(clean.priorUpdate, ["status", "text"]);
  }
  if (kind === "ballot" && isRecord(clean.strength)) {
    clean.strength = knownFields(clean.strength, ["novelty", "materiality", "evidence", "asymmetry"]);
  }
  return JSON.stringify(clean);
}

function emailWords(value: string): number {
  return value.replace(/\[S\d+\]/g, "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The prior-thesis line is a continuity receipt, not a victory claim. Models
 * sometimes keep using "confirmed" even after a surgical repair. Demote that
 * wording without changing the model's factual content or citation markers.
 */
export function normalizePriorUpdateCertainty(value: string): string {
  return value
    .replace(/\b(?:has|have|is|was|were)\s+(?:not|never)\s+(?:yet\s+)?(?:been\s+)?confirm(?:ed|s|ing)?\b/gi, "remains unresolved")
    .replace(/\b(?:not|never)\s+(?:yet\s+)?confirm(?:ed|s|ing)?\b/gi, "remains unresolved")
    .replace(/\bunconfirmed\b/gi, "unresolved")
    .replace(/\bconfirmations?\b/gi, "support")
    .replace(/\bconfirmed\b/gi, "supported")
    .replace(/\bconfirming\b/gi, "supporting")
    .replace(/\bconfirms\b/gi, "indicates")
    .replace(/\bconfirm\b/gi, "indicate");
}

function normalizeEmailDraftCertainty(text: string): string {
  const parsed = parseJsonObject(text);
  if (isRecord(parsed.priorUpdate) && typeof parsed.priorUpdate.text === "string") {
    parsed.priorUpdate = {
      ...parsed.priorUpdate,
      text: normalizePriorUpdateCertainty(parsed.priorUpdate.text),
    };
  }
  return JSON.stringify(parsed);
}

function parseIsoDate(value: string): Date | null {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? parsed
    : null;
}

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addCalendarDays(value: string, days: number): string {
  const parsed = parseIsoDate(value);
  if (!parsed) throw new Error(`invalid ISO date: ${value}`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatIsoDate(parsed);
}

function addBusinessDays(value: string, sessions: number): string {
  const parsed = parseIsoDate(value);
  if (!parsed) throw new Error(`invalid ISO date: ${value}`);
  let remaining = sessions;
  while (remaining > 0) {
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    const day = parsed.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return formatIsoDate(parsed);
}

/** Stable public question: editorial wording comes from the already-approved punchline. */
export function dossierQuestionFromPunchline(subjectPunchline: string): string {
  const cleaned = subjectPunchline.trim().replace(/[.!?;:\s]+$/g, "");
  return `Is it true that ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}?`;
}

/**
 * Build the resolver contract without another generative pass. Filing-like
 * propositions stay open for the next reporting cycle but can resolve early
 * on a matching claim delta; tape questions settle at the recorded horizon.
 */
export function dossierQuestionOracle(
  signal: DossierQualitativeSignal,
  trigger: string,
  asOfDate: string,
): DossierQuestionOracle {
  // Citation labels/titles are provenance, not claim language. Classify the
  // oracle from the authored flip condition only so rendering a source titled
  // "earnings" cannot silently turn a tape oracle into a filing oracle.
  const authoredTrigger = trigger
    .replace(/\[\d+ · \d{4}-\d{2}-\d{2}\]\([^\n]*?"[^"]*"\)/g, "")
    .replace(/\[S\d+\]/g, "");
  const filingLike = ["earnings", "guidance", "capital"].includes(signal.eventType) ||
    /\b(?:filing|10-[kq]|quarter(?:ly)?|earnings|results|cash flow|margin|revenue|income|guidance)\b/i.test(
      authoredTrigger,
    );
  return {
    type: filingLike ? "filing" : "tape",
    trigger,
    dueBy: filingLike ? addCalendarDays(asOfDate, 120) : addBusinessDays(asOfDate, signal.horizonSessions.max),
  };
}

const PUBLIC_JARGON = /\b(?:decision-relevant|qualitative shift|proxy for operating momentum|admitted source|the tape|cash residual|tech-slump markdown|sector-generic repricing|company-specific break|marks-driven remeasurement|printed negative|unvalidated positive|re-anchoring|retire the read)\b/i;
const PUBLIC_PROCESS_JARGON = /\b(?:source bundle|evidence bundle|packet|lead draft|council seat|numbers seat|risk seat|global context seat|evidence marshal|kimi(?:'s)? seat)\b/i;
const FUTURE_CUE = String.raw`(?:could|may|might|should|will|would|likely|expected|forecast(?:ed)?|project(?:ed)?|set\s+to|on\s+track\s+to|poised\s+to)`;
const STRONG_FUTURE_CUE = String.raw`(?:will|expected|forecast(?:ed)?|project(?:ed)?|set\s+to|on\s+track\s+to|poised\s+to)`;
const WEAK_FUTURE_CUE = String.raw`(?:could|may|might|should|would|likely)`;
const NUMBER_WORD = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)`;
const NUMBER_TOKEN = String.raw`(?:\d+(?:\.\d+)?|${NUMBER_WORD}(?:[-\s]+${NUMBER_WORD})*)`;

/** Programmatic release gate: prompts are not trusted to police public claims. */
export function publicProseValidationError(value: string): string | null {
  const plain = value
    .replace(/\[S\d+\]/g, "")
    .replace(/\[\d+ · \d{4}-\d{2}-\d{2}\]\([^\n]*?"[^"]*"\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sharedIssue = publicResearchContentIssues({ subject: "", text: plain })[0];
  if (sharedIssue?.startsWith("recommendation language")) {
    return `contains action language — offending passage ${sharedIssue.slice("recommendation language".length + 1)}`;
  }
  if (sharedIssue === "price target") return "contains a price target or fair-value claim";
  if (sharedIssue?.startsWith("percentage forecast")) {
    return `contains a percentage forecast — offending passage ${sharedIssue.slice("percentage forecast".length + 1)}`;
  }
  if (/\b(?:price\s+(?:target|objective)|(?:target|objective)\s+price|target(?:s|ed|ing)?\s+(?:of|at|near)|fair\s+value|intrinsic\s+value|valuation\b[^.!?]{0,45}\bper\s+share)\b/i.test(plain)) {
    return "contains a price target or fair-value claim";
  }
  if (/\b(?:stock|equity|investment|analyst)\s+ratings?\b/i.test(plain) ||
      /\brated\s+(?:buy|sell|hold|outperform|underperform|neutral|market\s+perform|sector\s+perform)\b/i.test(plain) ||
      /\b(?:outperform|underperform|market\s+perform|sector\s+perform|neutral)\s+(?:rating|call)\b/i.test(plain)) {
    return "contains ratings language";
  }
  const explicitPercent = String.raw`${NUMBER_TOKEN}\s*(?:%|pct\.?|percent|per\s+cent)`;
  const numericRange = String.raw`${NUMBER_TOKEN}\s*(?:%|pct\.?|percent|per\s+cent)?\s*(?:-|–|—|to|through)\s*${NUMBER_TOKEN}\s*(?:%|pct\.?|percent|per\s+cent)`;
  // Weak modals ("should", "could") saturate historical analysis; they only
  // make a forecast when a move verb links them to the percentage.
  const forecastMove = String.raw`(?:reach|rise|fall|gain|climb|decline|rally|drop|slide|advance|move|swing|jump|surge|plunge|grow|contract|expand|increase|decrease)`;
  const forecastPatterns = [
    new RegExp(String.raw`\b(?:upside|downside|price\s+move|share\s+move|stock\s+move)\b[^.!?]{0,90}(?:${numericRange}|${explicitPercent})`, "i"),
    new RegExp(String.raw`\b${STRONG_FUTURE_CUE}\b[^.!?;,]{0,70}\b${forecastMove}\b[^.!?]{0,35}(?:${numericRange}|${explicitPercent})`, "i"),
    new RegExp(String.raw`\b${WEAK_FUTURE_CUE}\b[^.!?]{0,60}\b(?:reach|rise|fall|gain|climb|decline|rally|drop|slide|advance|move|swing|jump|surge|plunge)\b[^.!?]{0,40}(?:${numericRange}|${explicitPercent})`, "i"),
    new RegExp(String.raw`(?:${numericRange}|${explicitPercent})[^.!?]{0,35}\b(?:return|upside|downside|move|gain|drop|rise|fall|growth|contraction)\b[^.!?]{0,35}\b(?:within\s+the\s+next|in\s+the\s+next|over\s+the\s+(?:next|coming)|by\s+(?:early|mid|late|end|next))\b`, "i"),
  ];
  const forecastHits: string[] = [];
  for (const pattern of forecastPatterns) {
    const m = plain.match(pattern);
    if (m && forecastHits.length < 3) forecastHits.push(`"${m[0].slice(0, 100)}"`);
  }
  if (forecastHits.length) return `contains a percentage forecast — offending passage ${forecastHits.join("; ")}`;
  const priceDestPatterns = [
    new RegExp(String.raw`\b${FUTURE_CUE}\b[^.!?]{0,90}\b(?:reach|trade|move|rise|fall|climb|decline|rally|drop|finish|close|head|run)\b[^.!?]{0,35}(?:US\$|\$|£|€)?\s*\d{2,}(?:\.\d+)?\b`, "i"),
    new RegExp(String.raw`\b${FUTURE_CUE}\b[^.!?]{0,90}(?:US\$|\$|£|€)\s*\d+(?:\.\d+)?\s*(?:-|–|—|to|through)\s*(?:US\$|\$|£|€)?\s*\d+(?:\.\d+)?`, "i"),
    // A bare "$N" destination is only a claim when a future cue links the
    // subject to it — "last traded at $346.77" is the tape, not a target.
    new RegExp(String.raw`\b(?:shares?|stock|price)\b[^.!?]{0,50}\b${FUTURE_CUE}\b[^.!?]{0,50}\b(?:toward|to|at|above|below|near)\s*(?:US\$|\$|£|€)\s*\d+(?:\.\d+)?\b`, "i"),
  ];
  for (const pattern of priceDestPatterns) {
    const m = plain.match(pattern);
    if (m) return `contains an unlabeled future price destination — offending passage "${m[0].slice(0, 120)}"`;
  }
  const adviceMatch = plain.match(
    /\b(?:recommend(?:s|ed|ing|ation)?|investors?\s+should|readers?\s+should|you\s+should|position\s+siz(?:e|ing)|(?:your|portfolio|position)\s+allocation|allocation\s+(?:advice|decision|call))\b/i,
  );
  if (adviceMatch) {
    return `contains recommendation or allocation language — offending passage "${adviceMatch[0].slice(0, 100)}"`;
  }
  return null;
}

function readabilityFailure(value: string): string | null {
  const plain = value.replace(/\[S\d+\]/g, "").replace(/\s+/g, " ").trim();
  if (PUBLIC_JARGON.test(plain) || PUBLIC_PROCESS_JARGON.test(plain)) return "contains desk or generation-process jargon";
  const sentences = plain.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.some((sentence) => emailWords(sentence) > 45)) return "contains a sentence longer than 45 words";
  return null;
}

type WebsiteSynthesisInput = Pick<WebsiteDossierCards, "story" | "bulls" | "bears" | "risk" | "numbersRead">;

export interface WebsiteSynthesisIssue {
  fields: Array<"story" | "bulls" | "bears" | "risk" | "numbersRead">;
  message: string;
}

function plainResearchText(value: string): string {
  return value
    .replace(/\[S\d+\]/g, "")
    .replace(/\[\d+ · \d{4}-\d{2}-\d{2}\]\([^\n]*?"[^"]*"\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function distinctiveNumericAnchors(value: string): Set<string> {
  const plain = plainResearchText(value).toLowerCase();
  const matches = plain.match(
    /(?:[$€£]\s*\d+(?:\.\d+)?(?:\s*(?:billion|million|thousand|[bmk]))?|\b\d+(?:\.\d+)?\s*(?:%|pct\.?|percent|per\s+cent|billion|million|thousand|[bmk])\b)/gi,
  ) ?? [];
  return new Set(matches.map((match) => match
    .replace(/\s+/g, "")
    .replace(/billion/g, "b")
    .replace(/million/g, "m")
    .replace(/thousand/g, "k")
    .replace(/pct\.?|percent|per\s+cent/g, "%")));
}

const SYNTHESIS_STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "because", "before", "being", "between", "could", "from",
  "have", "into", "itself", "more", "most", "only", "other", "over", "same", "should", "than", "that", "their",
  "there", "these", "this", "those", "through", "under", "very", "what", "when", "where", "which", "while", "with",
  "would", "company", "reported", "source", "evidence",
]);

function sentenceTerms(value: string): Set<string> {
  return new Set(plainResearchText(value)
    .toLowerCase()
    .replace(/[^a-z0-9%$]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !SYNTHESIS_STOP_WORDS.has(word)));
}

function nearDuplicate(left: Set<string>, right: Set<string>): boolean {
  if (left.size < 8 || right.size < 8) return false;
  let intersection = 0;
  for (const term of left) if (right.has(term)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union > 0 && intersection / union >= 0.78;
}

/**
 * Existing-schema quality gate: preserve every unique insight, reject a
 * transcript-shaped artifact that repeats the same metric or sentence across
 * cards. The gate never imposes a token cap and never truncates content.
 */
export function websiteSynthesisIssues(
  value: WebsiteSynthesisInput,
  evidenceContext = "",
): WebsiteSynthesisIssue[] {
  const sections: Array<{ field: WebsiteSynthesisIssue["fields"][number]; values: string[] }> = [
    { field: "story", values: [value.story] },
    { field: "bulls", values: value.bulls },
    { field: "bears", values: value.bears },
    { field: "risk", values: [value.risk] },
    { field: "numbersRead", values: [value.numbersRead] },
  ];
  const issues: WebsiteSynthesisIssue[] = [];

  for (const section of sections) {
    const processLeak = section.values.find((text) => PUBLIC_PROCESS_JARGON.test(plainResearchText(text)));
    if (processLeak) issues.push({
      fields: [section.field],
      message: `${section.field} narrates the generation process instead of stating the corrected conclusion`,
    });
  }

  const anchors = new Map<string, Set<WebsiteSynthesisIssue["fields"][number]>>();
  for (const section of sections) {
    for (const anchor of distinctiveNumericAnchors(section.values.join(" "))) {
      const owners = anchors.get(anchor) ?? new Set<WebsiteSynthesisIssue["fields"][number]>();
      owners.add(section.field);
      anchors.set(anchor, owners);
    }
  }
  for (const [anchor, owners] of anchors) {
    if (owners.size <= 3) continue;
    issues.push({
      fields: [...owners],
      message: `distinctive figure ${anchor} is repeated across ${owners.size} cards; state it once and synthesise its implication elsewhere`,
    });
  }

  const sentences = sections.flatMap((section) => section.values.flatMap((text) =>
    plainResearchText(text).split(/(?<=[.!?])\s+/).map((sentence) => ({
      field: section.field,
      text: sentence,
      terms: sentenceTerms(sentence),
    })).filter((sentence) => sentence.terms.size >= 8),
  ));
  outer: for (let left = 0; left < sentences.length; left += 1) {
    for (let right = left + 1; right < sentences.length; right += 1) {
      if (sentences[left].field === sentences[right].field || !nearDuplicate(sentences[left].terms, sentences[right].terms)) continue;
      issues.push({
        fields: [...new Set([sentences[left].field, sentences[right].field])],
        message: `near-duplicate reasoning appears in ${sentences[left].field} and ${sentences[right].field}`,
      });
      if (issues.length >= 8) break outer;
    }
  }

  const availableButDenied: Array<{ available: RegExp; denied: RegExp; qualifiedGap: RegExp; name: string }> = [
    {
      available: /- Operating cash flow:/i,
      denied: /\b(?:no|without|lacks?|does not (?:include|provide|supply))\b[^.!?]{0,55}\b(?:operating\s+)?cash[ -]?flow\b/i,
      qualifiedGap: /\b(?:reconcil|bridge|detail|breakdown|component|quality|working[ -]?capital|comparison|prior[ -]?(?:year|quarter)|free[ -]?cash[ -]?flow|capital expenditure)\w*/i,
      name: "operating cash flow",
    },
    {
      available: /- (?:Cash and short-term investments|Total assets|Current debt|Long-term debt):/i,
      denied: /\b(?:no|without|lacks?|does not (?:include|provide|supply))\b[^.!?]{0,55}\bbalance[ -]?sheet\b/i,
      qualifiedGap: /\b(?:composition|detail|breakdown|liabilit|maturit|covenant|post[ -]?quarter|snapshot|reconcil|bridge)\w*/i,
      name: "balance-sheet",
    },
    {
      available: /- Capital expenditures:/i,
      denied: /\b(?:no|without|lacks?|does not (?:include|provide|supply))\b[^.!?]{0,55}\b(?:capex|capital expenditure)\b/i,
      qualifiedGap: /\b(?:detail|breakdown|guidance|growth|maintenance|segment|prior[ -]?(?:year|quarter)|comparison)\w*/i,
      name: "capital-spending",
    },
    {
      available: /- Equity-securities gain\/loss:/i,
      denied: /\b(?:no|without|lacks?|does not (?:include|provide|supply))\b[^.!?]{0,70}\b(?:securities[ -]?(?:gain|loss)|non[ -]?operating item|one[ -]?time item)\b/i,
      qualifiedGap: /\b(?:identif|composition|detail|breakdown|bridge|cause|reconcil)\w*/i,
      name: "securities-gain",
    },
  ];
  for (const check of availableButDenied) {
    if (!check.available.test(evidenceContext)) continue;
    for (const section of sections) {
      const falselyDeniesMetric = section.values.some((text) => plainResearchText(text)
        .split(/(?<=[.!?])\s+/)
        .some((sentence) => check.denied.test(sentence) && !check.qualifiedGap.test(sentence)));
      if (!falselyDeniesMetric) continue;
      issues.push({
        fields: [section.field],
        message: `${section.field} declares ${check.name} evidence missing although the filed metric is present`,
      });
    }
  }
  return issues;
}

function parseSignalCase(value: unknown): DossierSignalCase | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (exactKeysError(record, ["eventType", "direction", "strength", "horizonSessions", "mechanism", "invalidation"])) return null;
  const horizon = record.horizonSessions;
  if (!horizon || typeof horizon !== "object" || Array.isArray(horizon)) return null;
  const h = horizon as Record<string, unknown>;
  if (exactKeysError(h, ["min", "max"])) return null;
  const direction = String(record.direction ?? "").toUpperCase();
  const strength = String(record.strength ?? "").toUpperCase();
  const eventType = String(record.eventType ?? "").toLowerCase();
  if (!(["earnings", "guidance", "regulatory", "product", "legal", "capital", "leadership", "macro", "other"] as string[]).includes(eventType) ||
      !(["UP", "DOWN"] as string[]).includes(direction) ||
      !(["GENTLE", "MODERATE", "STRONG"] as string[]).includes(strength) ||
      Number(h.min) !== 10 || Number(h.max) !== 15) return null;
  return {
    eventType: eventType as DossierSignalEventType,
    direction: direction as DossierSignalDirection,
    strength: strength as DossierSignalStrength,
    horizonSessions: { min: 10, max: 15 },
    mechanism: String(record.mechanism ?? ""),
    invalidation: String(record.invalidation ?? ""),
  };
}

function validateWebsiteResponse(
  text: string,
  evidence: DossierCitation[],
  evidenceContext = "",
): ArtifactValidation<WebsiteDossierCards> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(text);
  } catch {
    return { error: "response is not a valid JSON object", fields: WEBSITE_FIELDS };
  }
  const keyError = exactKeysError(parsed, WEBSITE_FIELDS);
  if (keyError) return { error: `website response contract failure: ${keyError}`, fields: WEBSITE_FIELDS, parsed };
  const signalCase = parseSignalCase(parsed.signalCase);
  const rawCards: WebsiteDossierCards = {
    headline: String(parsed.headline ?? ""),
    story: String(parsed.story ?? ""),
    bulls: Array.isArray(parsed.bulls) ? parsed.bulls.map(String) : [],
    bears: Array.isArray(parsed.bears) ? parsed.bears.map(String) : [],
    risk: String(parsed.risk ?? ""),
    numbersRead: String(parsed.numbersRead ?? ""),
    signalCase: signalCase ?? {
      eventType: "other",
      direction: "DOWN",
      strength: "GENTLE",
      horizonSessions: { min: 10, max: 15 },
      mechanism: "",
      invalidation: "",
    },
  };

  const failures: string[] = [];
  const fields: string[] = [];
  const requireField = (ok: boolean, field: string, detail = field) => {
    if (!ok) { failures.push(detail); fields.push(field); }
  };
  requireField(Boolean(rawCards.headline.trim()), "headline");
  requireField(substantiveLength(rawCards.story) >= 1_200, "story", "story < 1,200 chars");
  requireField(rawCards.bulls.length >= 3 && rawCards.bulls.length <= 5, "bulls", "bulls need 3-5 items");
  requireField(rawCards.bears.length >= 3 && rawCards.bears.length <= 5, "bears", "bears need 3-5 items");
  requireField(substantiveLength(rawCards.risk) >= 700, "risk", "risk < 700 chars");
  requireField(substantiveLength(rawCards.numbersRead) >= 700, "numbersRead", "numbersRead < 700 chars");
  requireField(
    Boolean(signalCase),
    "signalCase",
    `signalCase must be exactly {eventType: earnings|guidance|regulatory|product|legal|capital|leadership|macro|other, direction: UP|DOWN, strength: GENTLE|MODERATE|STRONG, horizonSessions: {min: 10, max: 15}, mechanism, invalidation} — received ${JSON.stringify(parsed.signalCase ?? null).slice(0, 220)}`,
  );
  requireField(substantiveLength(rawCards.signalCase.mechanism) >= 80, "signalCase", "signalCase.mechanism too short");
  requireField(substantiveLength(rawCards.signalCase.invalidation) >= 45, "signalCase", "signalCase.invalidation too short");
  rawCards.bulls.forEach((item, index) => requireField(substantiveLength(item) >= 100, "bulls", `bulls[${index}] < 100 chars`));
  rawCards.bears.forEach((item, index) => requireField(substantiveLength(item) >= 100, "bears", `bears[${index}] < 100 chars`));
  const totalDetail = [rawCards.story, ...rawCards.bulls, ...rawCards.bears, rawCards.risk, rawCards.numbersRead]
    .reduce((total, value) => total + substantiveLength(value), 0);
  requireField(totalDetail >= 4_500, "story", `total detail ${totalDetail} < 4,500 chars`);
  if (failures.length > 0) return { error: `missing or insufficient fields: ${failures.join("; ")}`, fields: [...new Set(fields)], parsed };

  const synthesisIssues = websiteSynthesisIssues(rawCards, evidenceContext);
  if (synthesisIssues.length > 0) {
    return {
      error: `synthesis validation failed — ${synthesisIssues.map((issue) => issue.message).join(" | ")}`,
      fields: [...new Set(synthesisIssues.flatMap((issue) => issue.fields))],
      parsed,
    };
  }

  const citationFields: Array<[string, string]> = [
    ["headline", rawCards.headline], ["story", rawCards.story], ["risk", rawCards.risk],
    ["numbersRead", rawCards.numbersRead], ["signalCase", rawCards.signalCase.mechanism],
    ["signalCase", rawCards.signalCase.invalidation],
    ...rawCards.bulls.map((item): [string, string] => ["bulls", item]),
    ...rawCards.bears.map((item): [string, string] => ["bears", item]),
  ];
  const validationFailures = citationFields.flatMap(([field, value]) => {
    const citation = citationValidationError(value, evidence);
    const prohibited = publicProseValidationError(value);
    return [citation ? `${field}: ${citation}` : null, prohibited ? `${field}: ${prohibited}` : null].filter((x): x is string => Boolean(x));
  });
  if (validationFailures.length > 0) {
    return {
      error: `public/citation validation failed — ${validationFailures.join(" | ")}`,
      fields: [...new Set(validationFailures.map((failure) => failure.slice(0, failure.indexOf(":"))))],
      parsed,
    };
  }
  const render = (value: string): string => renderCitations(value, evidence)!;
  const output: WebsiteDossierCards = {
    headline: render(rawCards.headline), story: render(rawCards.story),
    bulls: rawCards.bulls.map(render), bears: rawCards.bears.map(render),
    risk: render(rawCards.risk), numbersRead: render(rawCards.numbersRead),
    signalCase: {
      ...rawCards.signalCase,
      mechanism: render(rawCards.signalCase.mechanism),
      invalidation: render(rawCards.signalCase.invalidation),
    },
  };
  return { output, compactOutput: rawCards };
}

function parsedPriorUpdate(value: unknown): DossierPriorUpdate | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (exactKeysError(record, ["status", "text"])) return undefined;
  const status = String(record.status ?? "") as DossierPriorUpdate["status"];
  if (!["strengthened", "weakened", "resolved", "invalidated", "replaced", "open"].includes(status)) return undefined;
  return { status, text: String(record.text ?? "") };
}

export function decisionThesisValidationError(
  thesis: string,
  signal: Pick<DossierQualitativeSignal, "direction" | "horizonSessions">,
): string | null {
  if (signal.horizonSessions.min !== 10 || signal.horizonSessions.max !== 15 ||
      !/\b10\s*[–—-]\s*15\s+(?:trading\s+)?sessions?\b/i.test(thesis)) {
    return "thesis must state the fixed 10-15-session horizon";
  }
  const up = /\bmore likely to\s+(?:support|lift|strengthen|benefit)\b[^.!?]{0,55}\b(?:shares?|stock)\b/i.test(thesis);
  const down = /\bmore likely to\s+(?:pressure|weigh on|weaken|hurt)\b[^.!?]{0,55}\b(?:shares?|stock)\b/i.test(thesis);
  if (signal.direction === "UP" && (!up || down)) return "UP thesis must say the change is more likely to support the shares";
  if (signal.direction === "DOWN" && (!down || up)) return "DOWN thesis must say the change is more likely to pressure the shares";
  return null;
}

function validateEmailDraftResponse(
  text: string,
  evidence: DossierCitation[],
  previousThesis: DossierPriorThesisContext | null | boolean,
  allowedSourceIds?: ReadonlySet<string>,
  expectedSignal?: DossierQualitativeSignal,
): ArtifactValidation<DossierEmailDraft> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(text);
  } catch {
    return { error: "response is not a valid JSON object", fields: EMAIL_DRAFT_FIELDS };
  }
  const keyError = exactKeysError(parsed, EMAIL_DRAFT_FIELDS);
  if (keyError) return { error: `email draft contract failure: ${keyError}`, fields: EMAIL_DRAFT_FIELDS, parsed };
  const priorUpdate = parsedPriorUpdate(parsed.priorUpdate);
  const raw: DossierEmailDraft = {
    subjectPunchline: String(parsed.subjectPunchline ?? ""),
    priorUpdate: priorUpdate === undefined ? null : priorUpdate,
    whatChanged: String(parsed.whatChanged ?? ""),
    thesis: String(parsed.thesis ?? ""),
    primaryEvidence: String(parsed.primaryEvidence ?? ""),
    secondaryEvidence: Array.isArray(parsed.secondaryEvidence) ? parsed.secondaryEvidence.map(String) : [],
  };
  const failures: string[] = [];
  const fields: string[] = [];
  const fail = (field: string, reason: string) => { fields.push(field); failures.push(reason); };
  const hasPreviousThesis = Boolean(previousThesis);
  const subjectWords = emailWords(raw.subjectPunchline);
  if (subjectWords < 6 || subjectWords > 12 || raw.subjectPunchline.length > 96 ||
      /\[S\d+\]|https?:\/\/|%|\?$/.test(raw.subjectPunchline) || /^(?:is|are|can|will|why|how|what|does|do)\b/i.test(raw.subjectPunchline)) {
    fail("subjectPunchline", "subjectPunchline must be a 6-12-word declarative proposition that also works after 'Is it true that'");
  }
  if (PUBLIC_JARGON.test(raw.subjectPunchline) || publicProseValidationError(raw.subjectPunchline)) {
    fail("subjectPunchline", "subjectPunchline failed public-prose gate");
  }
  if (priorUpdate === undefined || (hasPreviousThesis && !priorUpdate) || (!hasPreviousThesis && priorUpdate !== null)) {
    fail("priorUpdate", hasPreviousThesis ? "priorUpdate is required for the previous thesis" : "priorUpdate must be null without a previous thesis");
  }
  if (raw.priorUpdate && (emailWords(raw.priorUpdate.text) < 8 || emailWords(raw.priorUpdate.text) > 20)) {
    fail("priorUpdate", "priorUpdate.text must be 8-20 words");
  }
  if (raw.priorUpdate && /\bconfirm(?:s|ed|ing|ation)?\b/i.test(raw.priorUpdate.text)) {
    fail("priorUpdate", "priorUpdate must use the honest state, never auto-confirmed language");
  }
  if (previousThesis && typeof previousThesis === "object") {
    const continuityFailure = thesisContinuityValidationError({
      subjectPunchline: raw.subjectPunchline,
      priorUpdate: raw.priorUpdate,
      signal: expectedSignal ?? previousThesis.signal,
    }, previousThesis);
    if (continuityFailure) {
      fail(
        continuityFailure.includes("subjectPunchline") ? "subjectPunchline" : "priorUpdate",
        `active thesis continuity failure: ${continuityFailure}`,
      );
    }
  }
  for (const [field, value, min, max] of [
    ["whatChanged", raw.whatChanged, 20, 40], ["thesis", raw.thesis, 25, 45],
    ["primaryEvidence", raw.primaryEvidence, 20, 45],
  ] as Array<[string, string, number, number]>) {
    const count = emailWords(value);
    if (count < min || count > max) fail(field, `${field} ${count} words, need ${min}-${max}`);
  }
  if (raw.secondaryEvidence.length !== 2) {
    fail("secondaryEvidence", "secondaryEvidence must contain exactly 2 items");
  }
  raw.secondaryEvidence.forEach((item, index) => {
    const count = emailWords(item);
    if (count < 15 || count > 30) fail("secondaryEvidence", `secondaryEvidence[${index}] ${count} words, need 15-30`);
  });
  if (expectedSignal) {
    const directionalFailure = decisionThesisValidationError(raw.thesis, expectedSignal);
    if (directionalFailure) fail("thesis", directionalFailure);
  }
  const publicFields: Array<[string, string]> = [
    ["whatChanged", raw.whatChanged], ["thesis", raw.thesis], ["primaryEvidence", raw.primaryEvidence],
    ...raw.secondaryEvidence.map((item): [string, string] => ["secondaryEvidence", item]),
    ...(raw.priorUpdate ? [["priorUpdate", raw.priorUpdate.text] as [string, string]] : []),
  ];
  for (const [field, value] of publicFields) {
    const publicFailure = publicProseValidationError(value);
    const readability = readabilityFailure(value);
    const citation = citationValidationError(value, evidence);
    const scope = citationScopeError(value, allowedSourceIds);
    if (publicFailure) fail(field, `${field}: ${publicFailure}`);
    if (readability) fail(field, `${field}: ${readability}`);
    if (citation) fail(field, `${field}: ${citation}`);
    if (scope) fail(field, `${field}: ${scope}`);
  }
  if (failures.length > 0) return { error: `fixed-format/public validation failure: ${failures.join("; ")}`, fields: [...new Set(fields)], parsed };
  const render = (value: string): string => renderCitations(value, evidence)!;
  return {
    output: {
      ...raw,
      priorUpdate: raw.priorUpdate ? { ...raw.priorUpdate, text: render(raw.priorUpdate.text) } : null,
      whatChanged: render(raw.whatChanged), thesis: render(raw.thesis),
      primaryEvidence: render(raw.primaryEvidence), secondaryEvidence: raw.secondaryEvidence.map(render),
    },
    compactOutput: raw,
  };
}

function validateEmailConfidenceResponse(
  text: string,
  evidence: DossierCitation[],
  votesSupport: number,
  votesOppose: number,
  votesUncertain: number,
  allowedSourceIds?: ReadonlySet<string>,
): ArtifactValidation<DossierCouncilConfidence> {
  let parsed: Record<string, unknown>;
  try { parsed = parseJsonObject(text); } catch {
    return { error: "response is not a valid JSON object", fields: EMAIL_CONFIDENCE_FIELDS };
  }
  const keyError = exactKeysError(parsed, EMAIL_CONFIDENCE_FIELDS);
  if (keyError) return { error: `confidence contract failure: ${keyError}`, fields: EMAIL_CONFIDENCE_FIELDS, parsed };
  const nullable = (key: string): string | null => parsed[key] === null ? null : String(parsed[key] ?? "");
  const raw: DossierCouncilConfidence = {
    majorityReason: String(parsed.majorityReason ?? ""),
    dissentReason: nullable("dissentReason"),
    uncertaintyReason: nullable("uncertaintyReason"),
    flipCondition: String(parsed.flipCondition ?? ""),
  };
  const failures: string[] = [];
  const fields: string[] = [];
  const check = (key: keyof DossierCouncilConfidence, value: string | null, min: number, max: number, required: boolean) => {
    if (required && (!value || emailWords(value) < min || emailWords(value) > max)) { failures.push(`${key} must be ${min}-${max} words`); fields.push(key); }
    if (!required && value !== null) { failures.push(`${key} must be null for the recorded ballots`); fields.push(key); }
    if (value) {
      const publicFailure = publicProseValidationError(value);
      const citation = citationValidationError(value, evidence);
      const scope = citationScopeError(value, allowedSourceIds);
      if (publicFailure) { failures.push(`${key}: ${publicFailure}`); fields.push(key); }
      if (citation) { failures.push(`${key}: ${citation}`); fields.push(key); }
      if (scope) { failures.push(`${key}: ${scope}`); fields.push(key); }
    }
  };
  check("majorityReason", raw.majorityReason, 18, 35, true);
  check("dissentReason", raw.dissentReason, 15, 30, votesOppose > 0);
  check("uncertaintyReason", raw.uncertaintyReason, 15, 30, votesUncertain > 0);
  check("flipCondition", raw.flipCondition, 15, 30, true);
  if (votesSupport < 3 || votesSupport + votesOppose + votesUncertain !== 5) {
    failures.push("public confidence requires >=3 SUPPORT and exactly five ballots");
    fields.push("majorityReason");
  }
  if (failures.length > 0) return { error: `confidence validation failure: ${failures.join("; ")}`, fields: [...new Set(fields)], parsed };
  const render = (value: string | null): string | null => value ? renderCitations(value, evidence)! : null;
  return {
    output: {
      majorityReason: render(raw.majorityReason)!, dissentReason: render(raw.dissentReason),
      uncertaintyReason: render(raw.uncertaintyReason), flipCondition: render(raw.flipCondition)!,
    },
    compactOutput: raw,
  };
}

function parseQualitativeSignal(value: unknown): DossierQualitativeSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (exactKeysError(record, ["eventType", "direction", "strength", "horizonSessions"])) return null;
  const parsed = parseSignalCase({ ...record, mechanism: "placeholder", invalidation: "placeholder" });
  return parsed ? { eventType: parsed.eventType, direction: parsed.direction, strength: parsed.strength, horizonSessions: parsed.horizonSessions } : null;
}

/** Full public-contract verifier used by release tests and migration tooling. */
export function validateEmailResponse(
  text: string,
  evidence: DossierCitation[],
  expectedVotesTotal: number,
  expectedVotesSupport: number,
  expectedVotesOppose = 0,
  expectedSignal?: DossierQualitativeSignal,
  hasPreviousThesis = false,
  expectedAsOfDate?: string,
): ArtifactValidation<DossierEmailHook> {
  let parsed: Record<string, unknown>;
  try { parsed = parseJsonObject(text); } catch {
    return { error: "response is not a valid JSON object", fields: EMAIL_HOOK_FIELDS };
  }
  const keyError = exactKeysError(parsed, EMAIL_HOOK_FIELDS);
  if (keyError) return { error: `email hook contract failure: ${keyError}`, fields: EMAIL_HOOK_FIELDS, parsed };
  const expectedUncertain = expectedVotesTotal - expectedVotesSupport - expectedVotesOppose;
  if (expectedVotesTotal !== 5 || Number(parsed.votesTotal) !== 5) {
    return { error: "votesTotal must equal five completed ballots", fields: ["votesTotal"], parsed };
  }
  if (expectedVotesSupport < 3) return { error: "public email thesis requires at least three SUPPORT ballots", fields: ["votesSupport"], parsed };
  if (Number(parsed.votesSupport) !== expectedVotesSupport || Number(parsed.votesOppose) !== expectedVotesOppose || Number(parsed.votesUncertain) !== expectedUncertain) {
    return { error: "SUPPORT/OPPOSE/UNCERTAIN counts must match recorded ballots", fields: ["votesSupport", "votesOppose", "votesUncertain"], parsed };
  }
  const votes = parsed.votes;
  if (!isRecord(votes) || exactKeysError(votes, ["support", "oppose", "uncertain"]) ||
      Number(votes.support) !== expectedVotesSupport || Number(votes.oppose) !== expectedVotesOppose ||
      Number(votes.uncertain) !== expectedUncertain) {
    return { error: "nested votes must exactly mirror the recorded ballots", fields: ["votes"], parsed };
  }
  const signal = parseQualitativeSignal(parsed.signal);
  if (!signal || (expectedSignal && stableJson(signal) !== stableJson(expectedSignal))) {
    return { error: "signal must exactly match the qualitative 10-15-session artifact", fields: ["signal"], parsed };
  }
  const draft = validateEmailDraftResponse(
    JSON.stringify(Object.fromEntries(EMAIL_DRAFT_FIELDS.map((key) => [key, parsed[key]]))),
    evidence,
    hasPreviousThesis,
    undefined,
    signal,
  );
  if (!("output" in draft)) return draft;
  const question = String(parsed.question ?? "");
  if (question !== dossierQuestionFromPunchline(draft.compactOutput.subjectPunchline) ||
      emailWords(question) < 10 || emailWords(question) > 24 || publicProseValidationError(question)) {
    return { error: "question must be the deterministic 10-24-word scoreboard framing", fields: ["question"], parsed };
  }
  const confidence = validateEmailConfidenceResponse(JSON.stringify(parsed.confidence), evidence, expectedVotesSupport, expectedVotesOppose, expectedUncertain);
  if (!("output" in confidence)) return confidence;
  const oracle = parsed.oracle;
  if (!isRecord(oracle) || exactKeysError(oracle, ["type", "trigger", "dueBy"]) ||
      !["filing", "tape"].includes(String(oracle.type)) || parseIsoDate(String(oracle.dueBy ?? "")) === null ||
      String(oracle.trigger ?? "") !== confidence.compactOutput.flipCondition) {
    return { error: "oracle must contain a valid type/date and reuse confidence.flipCondition exactly", fields: ["oracle"], parsed };
  }
  const expectedOracle = dossierQuestionOracle(
    signal,
    confidence.compactOutput.flipCondition,
    expectedAsOfDate ?? "2000-01-03",
  );
  if (String(oracle.type) !== expectedOracle.type ||
      (expectedAsOfDate && String(oracle.dueBy) !== expectedOracle.dueBy)) {
    return { error: "oracle type/dueBy must match the deterministic resolver policy", fields: ["oracle"], parsed };
  }
  const strength = parsed.editorialStrength as Record<string, unknown> | undefined;
  const editorialStrength = {
    novelty: Number(strength?.novelty), materiality: Number(strength?.materiality),
    evidence: Number(strength?.evidence), asymmetry: Number(strength?.asymmetry), score: Number(strength?.score),
  };
  if (!strength || exactKeysError(strength, ["novelty", "materiality", "evidence", "asymmetry", "score"]) ||
      [editorialStrength.novelty, editorialStrength.materiality, editorialStrength.evidence, editorialStrength.asymmetry]
        .some((value) => !Number.isInteger(value) || value < 1 || value > 5)) {
    return { error: "editorialStrength must contain exact 1-5 dimensions", fields: ["editorialStrength"], parsed };
  }
  const score = Math.round(((editorialStrength.novelty * .30) + (editorialStrength.materiality * .25) +
    (editorialStrength.evidence * .25) + (editorialStrength.asymmetry * .20)) / 5 * 100);
  if (editorialStrength.score !== score) return { error: "editorialStrength score is not deterministic", fields: ["editorialStrength"], parsed };
  const compact: DossierEmailHook = {
    ...draft.compactOutput, question, signal, votesSupport: expectedVotesSupport, votesOppose: expectedVotesOppose,
    votesUncertain: expectedUncertain, votesTotal: 5,
    votes: { support: expectedVotesSupport, oppose: expectedVotesOppose, uncertain: expectedUncertain },
    confidence: confidence.compactOutput,
    oracle: { type: expectedOracle.type, trigger: confidence.compactOutput.flipCondition, dueBy: String(oracle.dueBy) },
    editorialStrength,
  };
  return {
    output: { ...draft.output, question, signal, votesSupport: expectedVotesSupport, votesOppose: expectedVotesOppose,
      votesUncertain: expectedUncertain, votesTotal: 5,
      votes: { support: expectedVotesSupport, oppose: expectedVotesOppose, uncertain: expectedUncertain },
      confidence: confidence.output,
      oracle: { type: expectedOracle.type, trigger: confidence.output.flipCondition, dueBy: String(oracle.dueBy) },
      editorialStrength },
    compactOutput: compact,
  };
}

export type ModelCallOptions = {
  /**
   * Provider output envelope for tightly structured tasks. Leave undefined for
   * research/council calls so their evidence work remains uncapped here.
   */
  maxTokens?: number;
};

export async function callModel(
  model: string,
  system: string,
  input: string,
  label: string,
  options: ModelCallOptions = {},
): Promise<{
  text: string;
  usage?: CouncilModelUsage;
} | null> {
  const key = process.env.OPENROUTER_API_KEY_AMM ?? process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const telemetryId = randomUUID();
  const startedAt = Date.now();
  const record = async (
    status: "succeeded" | "http_error" | "invalid_json" | "empty" | "transport_error",
    detail: {
      usage?: CouncilModelUsage;
      providerRequestId?: string;
      providerModel?: string;
      finishReason?: string;
      httpStatus?: number;
      error?: string;
    } = {},
  ) => {
    const telemetry = Object.fromEntries(Object.entries({
      id: telemetryId,
      product: "aftermarketmovers",
      pipeline: "dossier",
      label,
      requestedModel: model,
      status,
      startedAt,
      completedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      inputSha256: sha256(input),
      inputChars: input.length,
      systemSha256: sha256(system),
      maxTokens: options.maxTokens,
      ...detail,
    }).filter(([, value]) => value !== undefined));
    console.log(`[model-telemetry] ${JSON.stringify(telemetry)}`);
    if (useMemory || process.env.OPENROUTER_API_KEY === "test") return;
    try {
      await firestore().collection("model_call_telemetry").doc(telemetryId).set(telemetry);
    } catch (error) {
      console.error(`[model-telemetry] persist failed: ${String(error).slice(0, 180)}`);
    }
  };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aftermarketmovers.com",
        "X-Title": "AMM Research Pipeline",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input },
        ],
        ...(options.maxTokens == null ? {} : { max_tokens: options.maxTokens }),
        usage: { include: true },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[dossier] ${label} HTTP ${res.status}: ${body.slice(0, 200)}`);
      await record("http_error", { httpStatus: res.status, error: body.slice(0, 300) });
      return null;
    }
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch (error) {
      console.error(`[dossier] ${label} invalid provider JSON: ${String(error).slice(0, 160)}`);
      await record("invalid_json", { error: String(error).slice(0, 300) });
      return null;
    }
    const choices = json.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined;
    const text = choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      console.error(`[dossier] ${label} returned empty content (finish=${choices?.[0]?.finish_reason ?? "unknown"})`);
      await record("empty", {
        providerRequestId: typeof json.id === "string" ? json.id : undefined,
        providerModel: typeof json.model === "string" ? json.model : undefined,
        finishReason: choices?.[0]?.finish_reason ?? "unknown",
      });
      return null;
    }
    const usage = usageFromResponse(json);
    await record("succeeded", {
      ...(usage ? { usage } : {}),
      providerRequestId: typeof json.id === "string" ? json.id : undefined,
      providerModel: typeof json.model === "string" ? json.model : undefined,
      finishReason: choices?.[0]?.finish_reason ?? "unknown",
    });
    return { text, ...(usage ? { usage } : {}) };
  } catch (error) {
    console.error(`[dossier] ${label} transport/timeout failure: ${String(error).slice(0, 180)}`);
    await record("transport_error", { error: String(error).slice(0, 300) });
    return null;
  }
}

export function parseThesisShadowAudit(
  text: string,
  evidence: DossierCitation[],
): ThesisShadowAuditOutput | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(text);
  } catch {
    return null;
  }
  if (exactKeysError(parsed, ["status", "reason", "sourceIds", "contradiction"])) return null;
  const status = String(parsed.status) as ThesisShadowAuditStatus;
  if (!["aligned", "more_cautious", "more_aggressive", "boundary_candidate"].includes(status)) return null;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (reason.length < 20) return null;
  if (!Array.isArray(parsed.sourceIds) || parsed.sourceIds.length === 0 ||
      parsed.sourceIds.some((sourceId) => typeof sourceId !== "string")) return null;
  const validSourceIds = new Set(evidence.map((source) => source.id));
  const sourceIds = [...new Set(parsed.sourceIds as string[])];
  if (sourceIds.some((sourceId) => !validSourceIds.has(sourceId))) return null;
  if (!(parsed.contradiction === null || typeof parsed.contradiction === "string")) return null;
  const contradiction = typeof parsed.contradiction === "string" ? parsed.contradiction.trim() : null;
  if (contradiction !== null && contradiction.length < 12) return null;
  return { status, reason, sourceIds, contradiction };
}

async function runDailyThesisShadowAudit({
  dossier,
  previousThesis,
  bundle,
  websiteArtifact,
}: {
  dossier: Dossier;
  previousThesis: DossierPriorThesisContext;
  bundle: DossierContextBundle;
  websiteArtifact: ChairmanArtifact<WebsiteDossierCards>;
}): Promise<void> {
  if (process.env.AMM_THESIS_SHADOW_ENABLED === "false") return;
  const model = process.env.AMM_THESIS_SHADOW_MODEL?.trim() || THESIS_SHADOW_DEFAULT_MODEL;
  const payload = {
    schema: "amm-thesis-shadow-input-v1",
    authority: "non-publishing-shadow",
    ticker: dossier.ticker,
    date: dossier.date,
    priorCanonicalThesis: {
      lifecycleId: previousThesis.lifecycleId,
      openedDate: previousThesis.openedDate,
      subjectPunchline: previousThesis.subjectPunchline,
      thesis: previousThesis.thesis,
      canonicalSignal: previousThesis.canonicalSignal,
      latestSignal: previousThesis.signal,
      flipCondition: previousThesis.flipCondition,
    },
    publishedDailyObservation: {
      subjectPunchline: dossier.emailHook.subjectPunchline,
      priorUpdate: dossier.emailHook.priorUpdate,
      whatChanged: dossier.emailHook.whatChanged,
      thesis: dossier.emailHook.thesis,
      signal: dossier.emailHook.signal,
      votes: dossier.emailHook.votes,
      confidence: dossier.emailHook.confidence,
      signalCase: websiteArtifact.compactOutput.signalCase,
    },
    compactClaimLedger: bundle.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      eventType: claim.eventType,
      sourceIds: claim.sourceIds,
      authority: claim.authority,
      freshness: claim.freshness,
      relevance: claim.relevance,
      ...(claim.contradicts ? { contradicts: claim.contradicts } : {}),
    })),
    deterministicFacts: bundle.deterministicEvidence,
    sourceIndex: bundle.evidence.map((source) => ({
      id: source.id,
      authority: source.authority,
      publishedDate: source.publishedDate,
      title: source.title,
      url: source.url,
    })),
  };
  const input = JSON.stringify(payload);
  const inputSha256 = sha256(input);
  const auditId = `thesis-shadow-${sha256(JSON.stringify({
    ticker: dossier.ticker,
    date: dossier.date,
    lifecycleId: previousThesis.lifecycleId,
    model,
    inputSha256,
  })).slice(0, 48)}`;
  const result = await callModel(model, THESIS_SHADOW_PROMPT, input, "daily thesis shadow audit");
  const output = result ? parseThesisShadowAudit(result.text, bundle.evidence) : null;
  await saveImmutableGenerationAudit(auditId, {
    schema: "thesis-shadow-audit-v1",
    id: auditId,
    ticker: dossier.ticker,
    date: dossier.date,
    lifecycleId: previousThesis.lifecycleId,
    generatedAt: Date.now(),
    authority: "non-publishing-shadow",
    requestedModel: model,
    promptSha256: sha256(THESIS_SHADOW_PROMPT),
    input,
    inputSha256,
    status: result ? (output ? "valid" : "invalid") : "unavailable",
    output,
    rawResponse: result?.text ?? null,
    rawResponseSha256: result ? sha256(result.text) : null,
    usage: result?.usage ?? null,
  });
  if (!output) {
    console.error(
      `[dossier] ${dossier.ticker}: thesis shadow audit (${model}) ` +
      `${result ? "invalid" : "unavailable"}; public artifact unchanged`,
    );
    return;
  }
  console.log(
    `[dossier] ${dossier.ticker}: thesis shadow audit (${model}) ${output.status}; ` +
    `public artifact unchanged`,
  );
}

async function callWebsiteChairModel(
  system: string,
  input: string,
  label: string,
  model: string,
): Promise<{ model: string; result: NonNullable<Awaited<ReturnType<typeof callModel>>> } | null> {
  const result = await callModel(model, system, input, `${label} (${model})`);
  return result ? { model, result } : null;
}

function selectedJsonFields(parsed: Record<string, unknown> | undefined, fields: string[]): Record<string, unknown> {
  if (!parsed) return {};
  return Object.fromEntries(fields.flatMap((field) => field in parsed ? [[field, parsed[field]]] : []));
}

/**
 * Build a repair packet from the failed fields, never from the original
 * five-seat transcript. Citation/depth failures still receive the complete
 * verified evidence bundle; wording and synthesis repairs need only the
 * current fields plus the authoritative source index. This removes repeated
 * deliberation tokens without removing evidence from any repair that needs it.
 */
export function buildWebsiteRepairInput({
  question,
  error,
  fields,
  parsed,
  context,
  evidence,
}: {
  question: string;
  error: string;
  fields: string[];
  parsed?: Record<string, unknown>;
  context: string;
  evidence: DossierCitation[];
}): { instruction: string; input: string; includesFullEvidence: boolean } {
  const currentValues = JSON.stringify(selectedJsonFields(parsed, fields), null, 2);
  const includesFullEvidence = /(?:uncited factual|unknown source|invalid source|missing or insufficient|declares .+ evidence missing|contract failure|not a valid JSON)/i.test(error);
  const availabilityCorrection = /declares .+ evidence missing although the filed metric is present/i.test(error)
    ? "AUTHORITATIVE CORRECTION: the validator has confirmed that the named filed metric is present. " +
      "Do not repeat, paraphrase or imply that it is absent. State the available filed metric explicitly; " +
      "if a narrower composition, maturity, reconciliation or post-quarter detail is unavailable, name only that narrower gap.\n\n"
    : "";
  const instruction =
    `REPAIR ONLY THESE TOP-LEVEL FIELDS: ${fields.join(", ")}\n\n` +
    `=== CURRENT VALUES ===\n${currentValues}\n\n` +
    `=== VALIDATION FAILURE ===\n${error}\n\n`;
  const evidencePacket = includesFullEvidence
    ? `=== COMPLETE VERIFIED EVIDENCE FOR THIS REPAIR ===\n${context}`
    : `=== AUTHORITATIVE SOURCE INDEX ===\n${sourceIndexFor(evidence)}`;
  return {
    instruction: `${instruction}${availabilityCorrection}`,
    input: `${instruction}${availabilityCorrection}=== ORIGINAL RESEARCH QUESTION ===\n${question}\n\n${evidencePacket}`,
    includesFullEvidence,
  };
}

function mergeRepairFields(
  currentText: string,
  repairedText: string,
  fields: string[],
  allowedFields: string[],
): string {
  let current: Record<string, unknown>;
  try { current = parseJsonObject(currentText); } catch { current = {}; }
  const repaired = parseJsonObject(repairedText);
  for (const field of fields) {
    if (field in repaired) current[field] = repaired[field];
    else delete current[field];
  }
  for (const field of Object.keys(current)) if (!allowedFields.includes(field)) delete current[field];
  return JSON.stringify(current);
}

async function chairToWebsiteDossier(
  question: string,
  stage1: DossierSeatMaterial[],
  context: string,
  evidence: DossierCitation[],
  authority: WebsiteChairAuthority,
  chairUser?: string,
  onTerminalFailure?: (failure: DossierTerminalFailure) => Promise<void>,
): Promise<ChairmanArtifact<WebsiteDossierCards> | null> {
  const authorityModel = modelForWebsiteAuthority(authority);
  const sourceIndex = sourceIndexFor(evidence);
  const reportTerminalFailure = async (failure: DossierTerminalFailure): Promise<void> => {
    try {
      await onTerminalFailure?.(failure);
    } catch (error) {
      console.error(`[dossier] terminal failure receipt could not be stored: ${String(error).slice(0, 200)}`);
    }
  };
  const councilFormatter = chairUser ? "frontier-chair-user-v1" : "generic-seat-material-v1";
  const councilMaterial = chairUser ??
    `Question put to the council: ${question}\n\n` +
      stage1
        .map((seat, index) => `${seat.role} / ANSWER ${index + 1} (${seat.model}):\n${seat.response}`)
        .join("\n\n---\n\n");
  // The chairman gets the exact verified bundle as well as the complete
  // deliberation, so an omission by one seat cannot silently erase evidence.
  const input =
    `${councilMaterial}\n\n=== VERIFIED SOURCE BUNDLE ===\n${context}\n\n` +
    `=== AUTHORITATIVE SOURCE INDEX — only these markers are valid ===\n${sourceIndex}`;
  try {
    const initialCall = await callWebsiteChairModel(CHAIR_PROMPT, input, "website chair", authorityModel);
    if (!initialCall) return null;
    let producingModel = initialCall.model;
    const initial = initialCall.result;
    let finalResponse: string;
    try { finalResponse = sanitizeModelJson(initial.text, "website"); }
    catch { finalResponse = initial.text; }
    let validation = validateWebsiteResponse(finalResponse, evidence, context);
    const repairPrompt = `You repair named fields in a full-depth evidence-backed dossier. Return STRICT JSON with exactly the requested top-level keys and no others. Preserve substantive reasoning in those fields. Fix every named depth, structure, public-language and citation defect. SURGICAL RULE: where the validation failure quotes an offending passage, rewrite ONLY that passage (and any specific uncited sentences it lists) — reproduce every other sentence in the field VERBATIM; broad rewrites introduce new violations. Every factual sentence and array item needs a valid [S#] marker. The signal is qualitative only: UP/DOWN, GENTLE/MODERATE/STRONG, 10-15 sessions. No recommendation, price target, fair value or percentage forecast.`;
    let usage = initial.usage;
    const attempts: ChairmanArtifact<WebsiteDossierCards>["attempts"] = [{
      model: producingModel,
      inputSha256: sha256(input), instruction: null, rawResponse: initial.text, rawResponseSha256: sha256(initial.text),
      ...(!("output" in validation) ? { validationError: validation.error } : {}),
    }];
    for (let attempt = 1; !("output" in validation) && attempt <= 3; attempt += 1) {
      const validationError = validation.error;
      console.error(`[dossier] website chair validation failed; repair ${attempt}/3: ${validationError}`);
      const fields = [...new Set(validation.fields)];
      const repairPacket = buildWebsiteRepairInput({
        question,
        error: validationError,
        fields,
        parsed: validation.parsed,
        context,
        evidence,
      });
      const instruction = repairPacket.instruction;
      const repairInput = repairPacket.input;
      const repairCall = await callWebsiteChairModel(
        repairPrompt,
        repairInput,
        `website chair field repair ${attempt}`,
        authorityModel,
      );
      if (!repairCall) return null;
      producingModel = repairCall.model;
      const repair = repairCall.result;
      usage = mergeUsage(usage, repair.usage);
      attempts.push({
        model: producingModel,
        inputSha256: sha256(repairInput), instruction, rawResponse: repair.text, rawResponseSha256: sha256(repair.text),
        validationError, repairedFields: fields,
      });
      try { finalResponse = mergeRepairFields(finalResponse, sanitizeModelJson(repair.text, "website"), fields, WEBSITE_FIELDS); }
      catch { finalResponse = repair.text; }
      validation = validateWebsiteResponse(finalResponse, evidence, context);
    }
    if (!("output" in validation)) {
      console.error(`[dossier] website chair rejected after repairs: ${validation.error}`);
      await reportTerminalFailure(terminalFailureReceipt("website", validation.error, attempts, usage));
      return null;
    }
    return {
      model: producingModel,
      output: validation.output,
      compactOutput: validation.compactOutput,
      input: JSON.stringify({
        kind: "website-chair",
        authority,
        authorityModel,
        formatter: councilFormatter,
        sharedInputSha256: sha256(input),
      }),
      rawResponse: JSON.stringify({ finalResponseSha256: sha256(finalResponse), attemptResponseSha256: attempts.map((attempt) => attempt.rawResponseSha256) }),
      attempts,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    console.error(`[dossier] website chair failed: ${String(error).slice(0, 200)}`);
    await reportTerminalFailure(terminalFailureReceipt("website", `construction failure: ${String(error)}`));
    return null;
  }
}

function referencedEvidence(values: string[], evidence: DossierCitation[]): DossierCitation[] {
  const ids = new Set(values.flatMap((value) => [...value.matchAll(/\[(S\d+)\]/g)].map((match) => match[1])));
  return evidence.filter((source) => ids.has(source.id));
}

function compactEmailDossier(cards: WebsiteDossierCards): Record<string, unknown> {
  return {
    headline: cards.headline,
    story: cards.story,
    signalCase: cards.signalCase,
    strongestBullEvidence: cards.bulls.slice(0, 2),
    strongestBearEvidence: cards.bears.slice(0, 2),
    riskAndInvalidation: cards.risk,
    numbersRead: cards.numbersRead,
  };
}

export function buildBallotEvidencePacket(
  draft: Pick<DossierEmailHook, "whatChanged" | "thesis" | "primaryEvidence" | "secondaryEvidence">,
  signalCase: DossierSignalCase,
  evidence: DossierCitation[],
  independent: { claims?: LedgerClaim[]; deterministicEvidence?: DeterministicEvidenceFact[] } = {},
): string {
  const values = [draft.whatChanged, draft.thesis, draft.primaryEvidence, ...draft.secondaryEvidence,
    signalCase.mechanism, signalCase.invalidation];
  const sources = referencedEvidence(values, evidence);
  if (sources.length === 0) throw new Error("ballot packet has no independently traceable source records");
  const sourceIds = new Set(sources.map((source) => source.id));
  const sourceRecords = sources.map((source) => ({
    id: source.id,
    sourceDocumentId: source.sourceDocumentId,
    canonicalUrl: source.url,
    title: source.title,
    publisher: source.publisher,
    authority: source.authority,
    publishedDate: source.publishedDate,
    eventId: source.eventId ?? null,
    observationIds: source.observationIds ?? [],
    contentSha256: source.contentSha256 ?? null,
    recordSha256: sha256(JSON.stringify({
      id: source.id, sourceDocumentId: source.sourceDocumentId, canonicalUrl: source.url, title: source.title, publisher: source.publisher,
      authority: source.authority, publishedDate: source.publishedDate, eventId: source.eventId ?? null,
      observationIds: source.observationIds ?? [], contentSha256: source.contentSha256 ?? null,
    })),
  }));
  const candidateClaims = (independent.claims ?? [])
    .filter((claim) => claim.sourceIds.some((id) => sourceIds.has(id)))
    .sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id))
    .map((claim) => ({ ...claim, claimSha256: sha256(JSON.stringify(claim)) }));
  const candidateFacts = (independent.deterministicEvidence ?? [])
    .filter((fact) => fact.sourceIds.length === 0 || fact.sourceIds.some((id) => sourceIds.has(id)));
  const admitWhole = <T extends { id: string }>(records: T[], budget: number): { included: T[]; excludedIds: string[] } => {
    const included: T[] = [];
    const excludedIds: string[] = [];
    let used = 0;
    for (const record of records) {
      const chars = JSON.stringify(record).length;
      if (used + chars <= budget) { included.push(record); used += chars; }
      else excludedIds.push(record.id);
    }
    return { included, excludedIds };
  };
  // Records are only ever admitted whole; when the packet runs hot the claim/
  // fact budgets step down (lower-ranked records move to the audited
  // exclusions) rather than slicing any record. Source records always ship
  // complete — they are the [S#] traceability index.
  const buildPacket = (budget: number): string => {
    const admittedClaims = admitWhole(candidateClaims, budget);
    const admittedFacts = admitWhole(candidateFacts, budget);
    return JSON.stringify({
      packetVersion: "ballot-evidence-v2",
      chairmanPropositionEvidence: {
        trigger: draft.whatChanged,
        directEvidence: draft.primaryEvidence,
        corroboratingEvidence: draft.secondaryEvidence,
        mechanism: signalCase.mechanism,
        invalidation: signalCase.invalidation,
      },
      independentEvidence: {
        deterministicFacts: admittedFacts.included,
        extractedClaims: admittedClaims.included,
        sourceRecords,
      },
      auditableExclusions: {
        deterministicFactIds: admittedFacts.excludedIds,
        claimIds: admittedClaims.excludedIds,
        reason: "complete lower-ranked records withheld from the compact ballot packet; retained in the generation audit",
      },
    });
  };
  for (const budget of [3_200, 2_400, 1_600, 800, 0]) {
    const packet = buildPacket(budget);
    if (Buffer.byteLength(packet, "utf8") <= 18_000) {
      if (budget < 3_200) console.error(`[dossier] ballot packet ran hot; claim/fact budget stepped down to ${budget} (whole records, audited exclusions)`);
      return packet;
    }
  }
  throw new Error("complete ballot packet exceeds the compact shared-packet limit even with zero claim/fact budget; refusing to slice required traceability records");
}

export const EMAIL_BALLOT_LANES = [
  { family: "openai", models: [COUNCIL_MODELS.openai, COUNCIL_MODELS.openai] },
  { family: "anthropic", models: [COUNCIL_MODELS.anthropic, COUNCIL_MODELS.anthropicFallback] },
  { family: "google", models: [COUNCIL_MODELS.google, COUNCIL_MODELS.google] },
  { family: "xai", models: [COUNCIL_MODELS.xai, COUNCIL_MODELS.xai] },
  { family: "deepseek", models: [COUNCIL_MODELS.deepseek, COUNCIL_MODELS.deepseek] },
] as const;

function validateEmailBallotText(
  text: string,
  evidence: DossierCitation[],
  allowedSourceIds?: ReadonlySet<string>,
): ArtifactValidation<Pick<DossierEmailBallot, "position" | "rationale" | "flipEvidence" | "fatalContradiction" | "contradictionReason" | "strength">> {
  let parsed: Record<string, unknown>;
  try { parsed = parseJsonObject(text); } catch {
    return { error: "ballot is not valid JSON", fields: ["position", "rationale", "flipEvidence", "fatalContradiction", "contradictionReason", "strength"] };
  }
  const fields = ["position", "rationale", "flipEvidence", "fatalContradiction", "contradictionReason", "strength"];
  const keyError = exactKeysError(parsed, fields);
  if (keyError) return { error: `ballot contract failure: ${keyError}`, fields, parsed };
  const position = String(parsed.position ?? "").toUpperCase();
  const rationale = String(parsed.rationale ?? "");
  const flipEvidence = String(parsed.flipEvidence ?? "");
  const fatalContradiction = parsed.fatalContradiction;
  const contradictionReason = parsed.contradictionReason === null ? null : String(parsed.contradictionReason ?? "");
  const rawStrength = parsed.strength as Record<string, unknown> | undefined;
  if (!(position === "SUPPORT" || position === "OPPOSE" || position === "UNCERTAIN")) {
    return { error: "ballot position must be SUPPORT, OPPOSE or UNCERTAIN", fields: ["position"], parsed };
  }
  if (!rawStrength || exactKeysError(rawStrength, ["novelty", "materiality", "evidence", "asymmetry"])) {
    return { error: "ballot strength must contain exactly four dimensions", fields: ["strength"], parsed };
  }
  const strength = {
    novelty: Number(rawStrength.novelty), materiality: Number(rawStrength.materiality),
    evidence: Number(rawStrength.evidence), asymmetry: Number(rawStrength.asymmetry),
  };
  const failures: string[] = [];
  if (typeof fatalContradiction !== "boolean") failures.push("fatalContradiction must be boolean");
  if (fatalContradiction === true && position !== "OPPOSE") failures.push("a fatal contradiction requires an OPPOSE position");
  if (fatalContradiction === true && (!contradictionReason || emailWords(contradictionReason) < 15 || emailWords(contradictionReason) > 55)) {
    failures.push("fatal contradictionReason must be 15-55 cited words");
  }
  if (fatalContradiction === false && contradictionReason !== null) failures.push("contradictionReason must be null when fatalContradiction is false");
  if (Object.values(strength).some((value) => !Number.isInteger(value) || value < 1 || value > 5)) failures.push("strength ratings must be integers 1-5");
  if (emailWords(rationale) < 20 || emailWords(rationale) > 90) failures.push("rationale must be 20-90 words");
  if (emailWords(flipEvidence) < 15 || emailWords(flipEvidence) > 55) failures.push("flipEvidence must be 15-55 words");
  for (const value of [rationale, flipEvidence]) {
    const citation = citationValidationError(value, evidence);
    const scope = citationScopeError(value, allowedSourceIds);
    const publicFailure = publicProseValidationError(value);
    if (citation) failures.push(citation);
    if (scope) failures.push(scope);
    if (publicFailure) failures.push(publicFailure);
  }
  if (fatalContradiction === true && contradictionReason) {
    const citation = citationValidationError(contradictionReason, evidence);
    const scope = citationScopeError(contradictionReason, allowedSourceIds);
    const publicFailure = publicProseValidationError(contradictionReason);
    if (citation) failures.push(citation);
    if (scope) failures.push(scope);
    if (publicFailure) failures.push(publicFailure);
  }
  if (failures.length > 0) return { error: failures.join("; "), fields, parsed };
  const compact = {
    position,
    rationale,
    flipEvidence,
    fatalContradiction: fatalContradiction as boolean,
    contradictionReason,
    strength,
  } as Pick<DossierEmailBallot, "position" | "rationale" | "flipEvidence" | "fatalContradiction" | "contradictionReason" | "strength">;
  return {
    compactOutput: compact,
    output: {
      ...compact,
      rationale: renderCitations(rationale, evidence)!,
      flipEvidence: renderCitations(flipEvidence, evidence)!,
      contradictionReason: contradictionReason ? renderCitations(contradictionReason, evidence)! : null,
    },
  };
}

export async function castEmailBallot(
  lane: (typeof EMAIL_BALLOT_LANES)[number],
  draft: DossierEmailDraft,
  signal: DossierQualitativeSignal,
  evidencePacket: string,
  evidence: DossierCitation[],
  packetEvidence: DossierCitation[],
): Promise<DossierEmailBallot | null> {
  const propositionSha256 = sha256(JSON.stringify({ thesis: draft.thesis, signal }));
  const evidencePacketSha256 = sha256(evidencePacket);
  const input =
    `=== EXACT PUBLIC PROPOSITION ===\n${draft.thesis}\n\n` +
    `=== IMMUTABLE QUALITATIVE SIGNAL ===\n${JSON.stringify(signal)}\n\n` +
    `=== COMPACT SHARED EVIDENCE PACKET ===\n${evidencePacket}\n\n` +
    `PROPOSITION SHA256: ${propositionSha256}`;
  for (const model of lane.models) {
    const initial = await callModel(model, EMAIL_BALLOT_PROMPT, input, `email ballot ${lane.family}`);
    if (!initial) continue;
    let initialObject: Record<string, unknown>;
    try { initialObject = parseJsonObject(initial.text); }
    catch { continue; }
    const originalPosition = String(initialObject.position ?? "").toUpperCase();
    const originalFatalContradiction = typeof initialObject.fatalContradiction === "boolean"
      ? initialObject.fatalContradiction
      : null;
    if (!(originalPosition === "SUPPORT" || originalPosition === "OPPOSE" || originalPosition === "UNCERTAIN")) {
      console.error(`[dossier] ${lane.family} ballot rejected: original position is invalid and cannot be repaired`);
      continue;
    }
    const packetSourceIds = new Set(packetEvidence.map((source) => source.id));
    let sanitizedInitial: string;
    try { sanitizedInitial = sanitizeModelJson(initial.text, "ballot"); }
    catch { sanitizedInitial = initial.text; }
    let checked = validateEmailBallotText(sanitizedInitial, evidence, packetSourceIds);
    let usage = initial.usage;
    const attempts: DossierEmailBallot["attempts"] = [{
      inputSha256: sha256(input), instruction: null, rawResponse: initial.text, rawResponseSha256: sha256(initial.text),
      ...(!("output" in checked) ? { validationError: checked.error } : {}),
    }];
    if (!("output" in checked)) {
      const repairInstruction =
        `Repair only the JSON format/fields of this recorded ballot. Preserve the original ${originalPosition} position and reasoning. ` +
        `Return exactly position, rationale, flipEvidence, fatalContradiction, contradictionReason and strength. ` +
        `${originalFatalContradiction === null ? "Set the contradiction fields from the evidence." : `Preserve fatalContradiction=${originalFatalContradiction}.`} ` +
        `Fix: ${checked.error}. Keep source markers. ` +
        `No recommendation, target or percentage forecast.\n\n=== CURRENT BALLOT ===\n${initial.text}\n\n`;
      const repairInput = `${repairInstruction}=== COMPACT SHARED EVIDENCE PACKET ===\n${evidencePacket}`;
      const repair = await callModel(
        model,
        `Repair only malformed fields in a recorded ballot. The original position is immutable.`,
        repairInput,
        `email ballot repair ${lane.family}`,
      );
      if (repair) {
        let repairedText = repair.text;
        try {
          const repaired = parseJsonObject(sanitizeModelJson(repair.text, "ballot"));
          repaired.position = originalPosition;
          if (originalFatalContradiction !== null) {
            repaired.fatalContradiction = originalFatalContradiction;
            if (!originalFatalContradiction) repaired.contradictionReason = null;
          }
          repairedText = JSON.stringify(repaired);
        } catch { /* validator rejects it below */ }
        checked = validateEmailBallotText(repairedText, evidence, packetSourceIds);
        attempts.push({
          inputSha256: sha256(repairInput), instruction: repairInstruction, rawResponse: repair.text,
          rawResponseSha256: sha256(repair.text), ...(!("output" in checked) ? { validationError: checked.error } : {}),
        });
        usage = mergeUsage(usage, repair.usage);
      }
    }
    if ("output" in checked) {
      return {
        family: lane.family, model, propositionSha256, evidencePacketSha256,
        ...checked.compactOutput,
        input: JSON.stringify({ kind: "ballot", family: lane.family, propositionSha256, evidencePacketSha256 }),
        inputSha256: sha256(input),
        rawResponse: JSON.stringify({ attemptResponseSha256: attempts.map((attempt) => attempt.rawResponseSha256) }),
        attempts,
        ...(usage ? { usage } : {}),
      };
    }
  }
  return null;
}

function editorialStrengthFrom(ballots: DossierEmailBallot[]): DossierEmailHook["editorialStrength"] {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const novelty = median(ballots.map((ballot) => ballot.strength.novelty));
  const materiality = median(ballots.map((ballot) => ballot.strength.materiality));
  const evidence = median(ballots.map((ballot) => ballot.strength.evidence));
  const asymmetry = median(ballots.map((ballot) => ballot.strength.asymmetry));
  const score = Math.round(((novelty * .30) + (materiality * .25) + (evidence * .25) + (asymmetry * .20)) / 5 * 100);
  return { novelty, materiality, evidence, asymmetry, score };
}

interface EmailCheckpointPatch {
  emailDraft?: EmailDraftCheckpoint;
  emailBallots?: EmailBallotCheckpoint[];
  emailConfidence?: EmailConfidenceCheckpoint;
  emailRejected?: EmailRejectedCheckpoint;
  terminalFailure?: DossierTerminalFailure;
}
type EmailBuildResult = { artifact: ChairmanArtifact<DossierEmailHook> } | {
  rejected: EmailRejectedCheckpoint;
  ballots: DossierEmailBallot[];
};

async function chairToEmailHook(
  cards: WebsiteDossierCards,
  evidence: DossierCitation[],
  asOfDate: string,
  previousThesis: DossierPriorThesisContext | null,
  independentEvidence: { claims: LedgerClaim[]; deterministicEvidence: DeterministicEvidenceFact[] },
  checkpoint: EmailCheckpointPatch,
  persist: (patch: Partial<EmailCheckpointPatch>) => Promise<void>,
): Promise<EmailBuildResult | null> {
  const compactDossier = compactEmailDossier(cards);
  const canonicalSignal: DossierQualitativeSignal = {
    eventType: cards.signalCase.eventType,
    direction: cards.signalCase.direction,
    strength: cards.signalCase.strength,
    horizonSessions: { min: 10, max: 15 },
  };
  const relevantSources = referencedEvidence(
    [cards.headline, cards.story, ...cards.bulls.slice(0, 2), ...cards.bears.slice(0, 2), cards.risk, cards.numbersRead],
    evidence,
  );
  const draftInput =
    `=== COMPACT CANONICAL DOSSIER PACKET ===\n${JSON.stringify(compactDossier, null, 2)}\n\n` +
    `${previousThesis ? `=== ACTIVE THESIS — update this lifecycle, do not silently replace it ===\n${JSON.stringify(previousThesis, null, 2)}\n\n` : "=== ACTIVE THESIS ===\nnone — open the first lifecycle\n\n"}` +
    `=== RELEVANT SOURCE INDEX ===\n${sourceIndexFor(relevantSources)}`;
  const relevantSourceIds = new Set(relevantSources.map((source) => source.id));
  const draftKey = sha256(JSON.stringify({
    kind: "email-draft", modelPolicy: MODEL_POLICY_VERSION,
    prompt: sha256(EMAIL_HOOK_PROMPT), dossier: sha256(JSON.stringify(compactDossier)),
    previous: sha256(JSON.stringify(previousThesis ?? "none")), sources: relevantSources.map((source) => source.id),
  }));
  let draftArtifact = checkpoint.emailDraft?.key === draftKey ? checkpoint.emailDraft.artifact : null;
  const expectedDraftPropositionSha256 = draftArtifact
    ? sha256(JSON.stringify({ thesis: draftArtifact.compactOutput.thesis, signal: canonicalSignal }))
    : null;
  if (draftArtifact && checkpoint.emailDraft?.propositionSha256 !== expectedDraftPropositionSha256) draftArtifact = null;
  if (draftArtifact) {
    const resumed = validateEmailDraftResponse(
      JSON.stringify(draftArtifact.compactOutput), evidence, previousThesis, relevantSourceIds, canonicalSignal,
    );
    if ("output" in resumed) draftArtifact = { ...draftArtifact, output: resumed.output, compactOutput: resumed.compactOutput };
    else draftArtifact = null;
  }
  if (!draftArtifact) {
    const initial = await callModel(EMAIL_CHAIRMAN_MODEL, EMAIL_HOOK_PROMPT, draftInput, "email thesis chair");
    if (!initial) return null;
    let response: string;
    try { response = normalizeEmailDraftCertainty(sanitizeModelJson(initial.text, "email-draft")); }
    catch { response = initial.text; }
    let validation = validateEmailDraftResponse(response, evidence, previousThesis, relevantSourceIds, canonicalSignal);
    let usage = initial.usage;
    const attempts: ChairmanArtifact<DossierEmailDraft>["attempts"] = [{
      inputSha256: sha256(draftInput), instruction: null, rawResponse: initial.text, rawResponseSha256: sha256(initial.text),
      ...(!("output" in validation) ? { validationError: validation.error } : {}),
    }];
    const repairSystem = `Repair only named fields in AMM's fixed email draft. Return STRICT JSON with exactly the requested top-level fields and no others. Every requested field MUST be rewritten until it satisfies its field contract; do not repeat a value named as invalid. Preserve the verified proposition and evidence. Count words before responding. Fix every named word-limit, citation, plain-language, lifecycle-continuity and public-claim defect. SURGICAL RULE: where the validation failure quotes an offending passage, rewrite ONLY that passage (and any specific uncited sentences it lists) — reproduce every other sentence VERBATIM. priorUpdate is null only without an active thesis; otherwise use strengthened, weakened, resolved, invalidated, replaced or open, and NEVER use confirm, confirms, confirmed, confirming or confirmation. Open/strengthened/weakened must preserve the supplied canonical subjectPunchline verbatim and cannot reverse direction. No buy/sell/hold, target, fair value or percentage forecast.`;
    for (let attempt = 1; !("output" in validation) && attempt <= 3; attempt += 1) {
      const fields = [...new Set(validation.fields)];
      const directionalClause = canonicalSignal.direction === "UP"
        ? "more likely to support the shares over the next 10-15 sessions"
        : "more likely to pressure the shares over the next 10-15 sessions";
      const fieldRules = fields.map((field) => {
        if (field === "subjectPunchline") {
          return "subjectPunchline: 6-12 words; declarative; no ticker, citation, question, forecast, or sensationalism.";
        }
        if (field === "priorUpdate") {
          return previousThesis
            ? "priorUpdate: exactly {\"status\":\"strengthened|weakened|resolved|open\",\"text\":\"8-20 words with valid [S#] markers\"}; describe only the prior thesis's honest current state; all forms of the word confirm are forbidden."
            : "priorUpdate: exactly null.";
        }
        if (field === "whatChanged") return "whatChanged: 20-40 words; external change and timing only; valid [S#] markers.";
        if (field === "thesis") {
          return `thesis: 25-45 words; one falsifiable proposition; include the exact directional clause "${directionalClause}"; explain mechanism and main risk; valid [S#] markers.`;
        }
        if (field === "primaryEvidence") return "primaryEvidence: 20-45 words; strongest direct support; valid [S#] markers.";
        return "secondaryEvidence: exactly 2 distinct JSON strings; each 15-30 words with valid [S#] markers.";
      }).join("\n");
      const instruction =
        `REPAIR ONLY: ${fields.join(", ")}\n\n=== EXACT FIELD CONTRACTS ===\n${fieldRules}\n\n` +
        `=== CURRENT INVALID VALUES ===\n${JSON.stringify(selectedJsonFields(validation.parsed, fields), null, 2)}\n\n` +
        `=== VALIDATION FAILURE ===\n${validation.error}\n\n`;
      const repairInput = `${instruction}${draftInput}`;
      const repair = await callModel(EMAIL_CHAIRMAN_MODEL, repairSystem, repairInput, `email draft field repair ${attempt}`);
      if (!repair) return null;
      usage = mergeUsage(usage, repair.usage);
      attempts.push({
        inputSha256: sha256(repairInput), instruction, rawResponse: repair.text, rawResponseSha256: sha256(repair.text),
        validationError: validation.error, repairedFields: fields,
      });
      try {
        response = normalizeEmailDraftCertainty(
          mergeRepairFields(response, sanitizeModelJson(repair.text, "email-draft"), fields, EMAIL_DRAFT_FIELDS),
        );
      } catch (error) {
        console.error(`[dossier] email draft repair ${attempt} returned unusable JSON; retaining the last valid draft: ${String(error).slice(0, 160)}`);
      }
      validation = validateEmailDraftResponse(response, evidence, previousThesis, relevantSourceIds, canonicalSignal);
    }
    if (!("output" in validation)) {
      await persist({ terminalFailure: terminalFailureReceipt("email-draft", validation.error, attempts, usage) });
      return null;
    }
    draftArtifact = {
      output: validation.output, compactOutput: validation.compactOutput,
      input: JSON.stringify({ kind: "email-draft", draftKey, sharedInputSha256: sha256(draftInput) }),
      rawResponse: JSON.stringify({ finalResponseSha256: sha256(response), attemptResponseSha256: attempts.map((attempt) => attempt.rawResponseSha256) }),
      attempts, ...(usage ? { usage } : {}),
    };
    const propositionSha256 = sha256(JSON.stringify({ thesis: validation.compactOutput.thesis, signal: canonicalSignal }));
    await persist({ emailDraft: { key: draftKey, propositionSha256, artifact: draftArtifact }, emailBallots: [], emailConfidence: undefined, emailRejected: undefined });
  }

  const signal = canonicalSignal;
  const propositionSha256 = sha256(JSON.stringify({ thesis: draftArtifact.compactOutput.thesis, signal }));
  const ballotEvidence = referencedEvidence([
    draftArtifact.compactOutput.whatChanged,
    draftArtifact.compactOutput.thesis,
    draftArtifact.compactOutput.primaryEvidence,
    ...draftArtifact.compactOutput.secondaryEvidence,
    cards.signalCase.mechanism,
    cards.signalCase.invalidation,
  ], evidence);
  const ballotSourceIds = new Set(ballotEvidence.map((source) => source.id));
  let evidencePacket: string;
  try {
    evidencePacket = buildBallotEvidencePacket(draftArtifact.compactOutput, cards.signalCase, evidence, independentEvidence);
  } catch (error) {
    const message = `ballot evidence packet rejected: ${String(error).slice(0, 1_000)}`;
    console.error(`[dossier] ${message}`);
    await persist({ terminalFailure: terminalFailureReceipt("ballot-packet", message, draftArtifact.attempts, draftArtifact.usage) });
    return null;
  }
  const evidencePacketSha256 = sha256(evidencePacket);
  const existing = new Map((checkpoint.emailDraft?.key === draftKey ? checkpoint.emailBallots : [])?.map((item) => [item.family, item]) ?? []);
  const liveBallots = new Map<string, EmailBallotCheckpoint>();
  let ballotCheckpointWrites = Promise.resolve();
  await Promise.all(EMAIL_BALLOT_LANES.map(async (lane) => {
    const baseKey = sha256(JSON.stringify({ family: lane.family, propositionSha256, evidencePacketSha256, prompt: sha256(EMAIL_BALLOT_PROMPT) }));
    const saved = existing.get(lane.family);
    const savedIntegrityKey = saved ? sha256(JSON.stringify({
      baseKey, model: saved.ballot.model, position: saved.ballot.position, rationale: saved.ballot.rationale,
      flipEvidence: saved.ballot.flipEvidence, fatalContradiction: saved.ballot.fatalContradiction,
      contradictionReason: saved.ballot.contradictionReason, strength: saved.ballot.strength,
    })) : null;
    if (saved?.key === savedIntegrityKey && saved.ballot.propositionSha256 === propositionSha256 &&
        saved.ballot.evidencePacketSha256 === evidencePacketSha256 && (lane.models as readonly string[]).includes(saved.ballot.model)) {
      const resumed = validateEmailBallotText(JSON.stringify({
        position: saved.ballot.position,
        rationale: saved.ballot.rationale,
        flipEvidence: saved.ballot.flipEvidence,
        fatalContradiction: saved.ballot.fatalContradiction,
        contradictionReason: saved.ballot.contradictionReason,
        strength: saved.ballot.strength,
      }), evidence, ballotSourceIds);
      if ("output" in resumed) {
        liveBallots.set(lane.family, { ...saved, ballot: { ...saved.ballot, ...resumed.compactOutput } });
        return;
      }
    }
    const ballot = await castEmailBallot(lane, draftArtifact!.compactOutput, signal, evidencePacket, evidence, ballotEvidence);
    if (!ballot) return;
    const key = sha256(JSON.stringify({
      baseKey, model: ballot.model, position: ballot.position, rationale: ballot.rationale,
      flipEvidence: ballot.flipEvidence, fatalContradiction: ballot.fatalContradiction,
      contradictionReason: ballot.contradictionReason, strength: ballot.strength,
    }));
    liveBallots.set(lane.family, { key, family: lane.family, ballot });
    const snapshot = EMAIL_BALLOT_LANES.flatMap((candidate) => {
      const item = liveBallots.get(candidate.family);
      return item ? [item] : [];
    });
    ballotCheckpointWrites = ballotCheckpointWrites.then(() => persist({ emailBallots: snapshot }));
    await ballotCheckpointWrites;
  }));
  await ballotCheckpointWrites;
  const completed = EMAIL_BALLOT_LANES.flatMap((lane) => {
    const item = liveBallots.get(lane.family);
    return item ? [item] : [];
  });
  if (completed.length !== 5) {
    const partialBallots = completed.map((item) => item.ballot);
    const rejected: EmailRejectedCheckpoint = {
      key: sha256(JSON.stringify({
        propositionSha256, evidencePacketSha256, completedFamilies: completed.map((item) => item.family), reason: "incomplete-ballot",
      })),
      propositionSha256,
      rejectedAt: Date.now(),
      votesSupport: partialBallots.filter((ballot) => ballot.position === "SUPPORT").length,
      votesOppose: partialBallots.filter((ballot) => ballot.position === "OPPOSE").length,
      votesUncertain: partialBallots.filter((ballot) => ballot.position === "UNCERTAIN").length,
      reason: "incomplete-ballot",
      ballotResponseSha256: partialBallots.map((ballot) => sha256(ballot.rawResponse)),
    };
    await persist({ emailRejected: rejected });
    return { rejected, ballots: partialBallots };
  }
  const ballots = completed.map((item) => item.ballot);
  const votesSupport = ballots.filter((ballot) => ballot.position === "SUPPORT").length;
  const votesOppose = ballots.filter((ballot) => ballot.position === "OPPOSE").length;
  const votesUncertain = ballots.filter((ballot) => ballot.position === "UNCERTAIN").length;
  const ballotIntegrity = ballots.map((ballot) => sha256(JSON.stringify({
    family: ballot.family, model: ballot.model, position: ballot.position, rationale: ballot.rationale,
    flipEvidence: ballot.flipEvidence, fatalContradiction: ballot.fatalContradiction,
    contradictionReason: ballot.contradictionReason, strength: ballot.strength,
    attempts: ballot.attempts.map((attempt) => attempt.rawResponseSha256),
  })));
  const rejectionKey = sha256(JSON.stringify({ propositionSha256, ballots: ballotIntegrity }));
  if (ballots.some((ballot) => ballot.fatalContradiction)) {
    const rejected: EmailRejectedCheckpoint = {
      key: rejectionKey, propositionSha256, rejectedAt: Date.now(), votesSupport, votesOppose, votesUncertain,
      reason: "fatal-contradiction", ballotResponseSha256: ballots.map((ballot) => sha256(ballot.rawResponse)),
    };
    await persist({ emailRejected: rejected });
    return { rejected, ballots };
  }
  if (votesSupport < 3) {
    const rejected: EmailRejectedCheckpoint = {
      key: rejectionKey, propositionSha256, rejectedAt: Date.now(), votesSupport, votesOppose, votesUncertain,
      reason: "minority-support", ballotResponseSha256: ballots.map((ballot) => sha256(ballot.rawResponse)),
    };
    await persist({ emailRejected: rejected });
    return { rejected, ballots };
  }

  const confidenceKey = sha256(JSON.stringify({ propositionSha256, ballots: ballotIntegrity, prompt: sha256(EMAIL_CONFIDENCE_PROMPT) }));
  let confidenceArtifact = checkpoint.emailConfidence?.key === confidenceKey ? checkpoint.emailConfidence.artifact : null;
  if (confidenceArtifact) {
    const resumed = validateEmailConfidenceResponse(
      JSON.stringify(confidenceArtifact.compactOutput), evidence, votesSupport, votesOppose, votesUncertain, ballotSourceIds,
    );
    if ("output" in resumed) confidenceArtifact = { ...confidenceArtifact, output: resumed.output, compactOutput: resumed.compactOutput };
    else confidenceArtifact = null;
  }
  if (!confidenceArtifact) {
    const confidenceInput =
      `=== EXACT PUBLIC PROPOSITION ===\n${draftArtifact.compactOutput.thesis}\n\n` +
      `=== QUALITATIVE SIGNAL ===\n${JSON.stringify(signal)}\n\n` +
      `=== RECORDED BALLOTS ===\n${JSON.stringify(ballots.map((ballot) => ({
        family: ballot.family,
        position: ballot.position,
        rationale: ballot.rationale,
        flipEvidence: ballot.flipEvidence,
        fatalContradiction: ballot.fatalContradiction,
        contradictionReason: ballot.contradictionReason,
      })), null, 2)}\n\n` +
      `=== COMPACT SHARED EVIDENCE PACKET ===\n${evidencePacket}`;
    const initial = await callModel(EMAIL_CHAIRMAN_MODEL, EMAIL_CONFIDENCE_PROMPT, confidenceInput, "email confidence chair");
    if (!initial) return null;
    let response: string;
    try { response = sanitizeModelJson(initial.text, "confidence"); }
    catch { response = initial.text; }
    let validation = validateEmailConfidenceResponse(response, evidence, votesSupport, votesOppose, votesUncertain, ballotSourceIds);
    let usage = initial.usage;
    const attempts: ChairmanArtifact<DossierCouncilConfidence>["attempts"] = [{
      inputSha256: sha256(confidenceInput), instruction: null, rawResponse: initial.text, rawResponseSha256: sha256(initial.text),
      ...(!("output" in validation) ? { validationError: validation.error } : {}),
    }];
    for (let attempt = 1; !("output" in validation) && attempt <= 3; attempt += 1) {
      const fields = [...new Set(validation.fields)];
      const instruction = `REPAIR ONLY: ${fields.join(", ")}\n\nCURRENT: ${response}\n\nFAILURE: ${validation.error}\n\n`;
      const repairInput = `${instruction}${confidenceInput}`;
      const repair = await callModel(EMAIL_CHAIRMAN_MODEL, EMAIL_CONFIDENCE_PROMPT, repairInput, `email confidence field repair ${attempt}`);
      if (!repair) return null;
      usage = mergeUsage(usage, repair.usage);
      attempts.push({
        inputSha256: sha256(repairInput), instruction, rawResponse: repair.text, rawResponseSha256: sha256(repair.text),
        validationError: validation.error, repairedFields: fields,
      });
      try { response = mergeRepairFields(response, sanitizeModelJson(repair.text, "confidence"), fields, EMAIL_CONFIDENCE_FIELDS); }
      catch { response = repair.text; }
      validation = validateEmailConfidenceResponse(response, evidence, votesSupport, votesOppose, votesUncertain, ballotSourceIds);
    }
    if (!("output" in validation)) {
      await persist({ terminalFailure: terminalFailureReceipt("email-confidence", validation.error, attempts, usage) });
      return null;
    }
    confidenceArtifact = {
      output: validation.output, compactOutput: validation.compactOutput,
      input: JSON.stringify({ kind: "email-confidence", confidenceKey, sharedInputSha256: sha256(confidenceInput) }),
      rawResponse: JSON.stringify({ finalResponseSha256: sha256(response), attemptResponseSha256: attempts.map((attempt) => attempt.rawResponseSha256) }),
      attempts, ...(usage ? { usage } : {}),
    };
    await persist({ emailConfidence: { key: confidenceKey, artifact: confidenceArtifact } });
  }
  const editorialStrength = editorialStrengthFrom(ballots);
  const question = dossierQuestionFromPunchline(draftArtifact.compactOutput.subjectPunchline);
  const oracle = dossierQuestionOracle(signal, confidenceArtifact.compactOutput.flipCondition, asOfDate);
  const compactOutput: DossierEmailHook = {
    ...draftArtifact.compactOutput, question, signal, votesSupport, votesOppose, votesUncertain, votesTotal: 5,
    votes: { support: votesSupport, oppose: votesOppose, uncertain: votesUncertain },
    confidence: confidenceArtifact.compactOutput, oracle, editorialStrength,
  };
  let usage = mergeUsage(draftArtifact.usage, confidenceArtifact.usage);
  for (const ballot of ballots) usage = mergeUsage(usage, ballot.usage);
  const finalValidation = validateEmailResponse(
    JSON.stringify(compactOutput), evidence, 5, votesSupport, votesOppose, signal, Boolean(previousThesis), asOfDate,
  );
  if (!("output" in finalValidation)) {
    console.error(`[dossier] final hook revalidation failed: ${finalValidation.error}`);
    await persist({
      terminalFailure: terminalFailureReceipt(
        "email-final",
        finalValidation.error,
        [...draftArtifact.attempts, ...confidenceArtifact.attempts],
        usage,
      ),
    });
    return null;
  }
  return { artifact: {
    output: finalValidation.output, compactOutput: finalValidation.compactOutput,
    input: JSON.stringify({ draftKey, propositionSha256, evidencePacketSha256, confidenceKey }),
    rawResponse: JSON.stringify({
      draftAttemptResponseSha256: draftArtifact.attempts.map((attempt) => attempt.rawResponseSha256),
      ballotResponseSha256: ballots.map((ballot) => ballot.attempts.map((attempt) => attempt.rawResponseSha256)),
      confidenceAttemptResponseSha256: confidenceArtifact.attempts.map((attempt) => attempt.rawResponseSha256),
    }),
    attempts: [...draftArtifact.attempts, ...confidenceArtifact.attempts], ballots,
    ...(usage ? { usage } : {}),
  } };
}

const DOSSIER_VALIDATOR_POLICY = "dossier-validator-v6:manifest-release-daily-council-rejected-review-continuity";
export const DOSSIER_CONTRACT_VERSION = sha256(JSON.stringify({
  artifactVersion: DOSSIER_ARTIFACT_VERSION,
  modelPolicyVersion: MODEL_POLICY_VERSION,
  checkpointSchema: "dossier-checkpoint-v3-cas-deduplicated-inputs",
  prompts: [CHAIR_PROMPT, EMAIL_HOOK_PROMPT, EMAIL_BALLOT_PROMPT, EMAIL_CONFIDENCE_PROMPT],
  models: {
    canonicalWebsite: CANONICAL_THESIS_MODEL,
    continuityWebsite: DAILY_CONTINUITY_MODEL,
    email: EMAIL_CHAIRMAN_MODEL,
  },
  modelRouting: "canonical-on-open-or-boundary-daily-continuity-v1",
  ballotLanes: EMAIL_BALLOT_LANES,
  frontierPolicy: FRONTIER_CONTRACT_POLICY,
  validatorPolicy: DOSSIER_VALIDATOR_POLICY,
  validators: [
    validateWebsiteResponse.toString(), validateEmailDraftResponse.toString(), validateEmailBallotText.toString(),
    validateEmailConfidenceResponse.toString(), validateEmailResponse.toString(), splitPublicSentences.toString(),
    citationValidationError.toString(), publicProseValidationError.toString(), isDetailedDossier.toString(),
    thesisContinuityValidationError.toString(), buildDossierThesisLifecycle.toString(),
  ],
})).slice(0, 20);

function pendingCoreValidationError(run: PendingDossierRun): string | null {
  if (!run.context.trim() || !run.question.trim() || !run.sources.trim()) return "missing context/question/source summary";
  if (!Array.isArray(run.evidence) || run.evidence.length === 0 || run.evidence.some((source) =>
    !/^S\d+$/.test(source.id) || !source.sourceDocumentId || !source.publishedDate || !/^https?:\/\//.test(source.url))) {
    return "invalid evidence index";
  }
  if (!Array.isArray(run.stage1) || run.stage1.length === 0 || run.stage1.some((seat) =>
    !seat.model?.trim() || !seat.role?.trim() || !seat.response?.trim())) return "invalid or empty council seats";
  if (!Array.isArray(run.claims) || !Array.isArray(run.deterministicEvidence) ||
      !Number.isInteger(run.revision) || run.revision < 0 || !run.generationOwner) return "invalid checkpoint schema";
  if (run.claims.some((claim) => !claim.id || !claim.statement || !Array.isArray(claim.sourceIds) ||
      claim.sourceIds.some((id) => !/^S\d+$/.test(id)) || !Number.isFinite(claim.relevance))) return "invalid resumed claim ledger";
  if (run.deterministicEvidence.some((fact) => !fact.id || !fact.value || !fact.recordSha256 ||
      !Array.isArray(fact.sourceIds) || fact.sourceIds.some((id) => !/^S\d+$/.test(id)))) return "invalid deterministic evidence";
  const validAttempts = (artifact: ChairmanArtifact<unknown> | undefined): boolean => !artifact ||
    (Array.isArray(artifact.attempts) && artifact.attempts.length > 0 && artifact.attempts.every((attempt) =>
      /^[a-f0-9]{64}$/.test(attempt.inputSha256) && attempt.rawResponseSha256 === sha256(attempt.rawResponse) &&
      (attempt.instruction === null || typeof attempt.instruction === "string")));
  if (!validAttempts(run.websiteArtifact) || !validAttempts(run.emailDraft?.artifact) || !validAttempts(run.emailConfidence?.artifact) ||
      (run.emailBallots ?? []).some((item) => !item.ballot || !Array.isArray(item.ballot.attempts) ||
        item.ballot.attempts.length === 0 || item.ballot.attempts.some((attempt) => attempt.rawResponseSha256 !== sha256(attempt.rawResponse)))) {
    return "checkpoint attempt audit failed hash validation";
  }
  if (run.terminalFailure && (
    !run.terminalFailure.error.trim() || !Number.isFinite(run.terminalFailure.failedAt) ||
    !Array.isArray(run.terminalFailure.attempts) || run.terminalFailure.attempts.some((attempt) =>
      !/^[a-f0-9]{64}$/.test(attempt.inputSha256) || !/^[a-f0-9]{64}$/.test(attempt.rawResponseSha256))
  )) return "invalid terminal failure receipt";
  return null;
}

export interface EnsureDossierOptions {
  /** Reuse the exact immutable pack compiled by the daily research route. */
  evidencePack?: EvidencePack;
}

/**
 * Recover the newest admitted prior artifact even when the mutable current
 * pointer is absent, legacy, or failed by today's stricter release validator.
 */
export function selectLatestPriorDossier<T extends { date: string; generatedAt?: number }>(
  current: T | null,
  history: readonly T[],
  todayEt: string,
  isAdmitted: (candidate: T) => boolean,
): T | null {
  return [current, ...history]
    .filter((candidate): candidate is T => Boolean(
      candidate && candidate.date < todayEt && isAdmitted(candidate),
    ))
    .sort((left, right) =>
      right.date.localeCompare(left.date) || Number(right.generatedAt ?? 0) - Number(left.generatedAt ?? 0)
    )[0] ?? null;
}

/** Generate (or return today's cached) dossier for a ticker. ~90–150s when generating. */
export async function ensureDossier(
  ticker: string,
  todayEt: string,
  options: EnsureDossierOptions = {},
): Promise<Dossier | null> {
  const sym = ticker.toUpperCase();
  let cached = await getCachedDossier(sym);
  let cachedIsFullyCited = dossierReleaseValidationError(cached) === null;
  if (cached && cached.date === todayEt && cachedIsFullyCited) return cached;

  const lease: DossierGenerationLease = {
    id: `dossier-generation:${sym}:${todayEt}`,
    owner: randomUUID(),
    lost: false,
  };
  if (!(await acquirePipelineLease(lease.id, lease.owner, GENERATION_LEASE_TTL_MS))) {
    console.log(`[dossier] ${sym}: another request owns today's generation lease`);
    return null;
  }
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || lease.lost) return;
    heartbeatBusy = true;
    void renewPipelineLease(lease.id, lease.owner, GENERATION_LEASE_TTL_MS)
      .then((owned) => { if (!owned) lease.lost = true; })
      .catch(() => { lease.lost = true; })
      .finally(() => { heartbeatBusy = false; });
  }, 60_000);
  heartbeat.unref?.();

  try {
  // A prior request may have completed between our first cache read and lease acquisition.
  cached = await getCachedDossier(sym);
  cachedIsFullyCited = dossierReleaseValidationError(cached) === null;
  if (cached && cached.date === todayEt && cachedIsFullyCited) return cached;
  const isAdmittedPrior = (candidate: Dossier): boolean => dossierReleaseValidationError(candidate) === null;
  let priorDossier = selectLatestPriorDossier(cached, [], todayEt, isAdmittedPrior);
  if (!priorDossier) {
    const history = await getDossierHistory<Dossier>(sym, 14).catch(() => []);
    priorDossier = selectLatestPriorDossier(cached, history, todayEt, isAdmittedPrior);
  }
  const priorFromPublishedDossier: DossierPriorThesisContext | null = priorDossier
    ? priorThesisContextFromDossier(priorDossier)
    : null;
  const previousThesis = priorFromPublishedDossier
    ? priorThesisContextWithRejectedReviews(
        priorFromPublishedDossier,
        await getRejectedDossierFactualUpdatesBetween(
          sym,
          priorFromPublishedDossier.date,
          todayEt,
        ),
      )
    : null;
  let websiteAuthorityMode = websiteChairAuthority(previousThesis);

  let pending = await getPendingDossierRun(sym, todayEt);
  if (pending?.artifactVersion !== DOSSIER_ARTIFACT_VERSION || pending?.contractVersion !== DOSSIER_CONTRACT_VERSION) {
    pending = null;
  }
  if (pending) {
    const invalid = pendingCoreValidationError(pending);
    if (invalid) {
      console.error(`[dossier] ${sym}: rejected resumed checkpoint: ${invalid}`);
      pending = null;
    }
  }
  if (pending?.terminalFailure) {
    console.error(
      `[dossier] ${sym}: terminal ${pending.terminalFailure.stage} failure already recorded for this contract: ` +
      pending.terminalFailure.error.slice(0, 500),
    );
    return null;
  }
  if (pending && pending.generationOwner !== lease.owner) {
    await savePendingDossierRun(pending, lease); // atomic ownership hand-off after an expired predecessor
  }

  let bundle: DossierContextBundle;
  let question: string;
  let stage1: DossierSeatMaterial[];
  let winner: string | undefined;
  let consensus: number | undefined;

  if (pending) {
    bundle = {
      context: pending.context,
      sources: pending.sources,
      evidence: pending.evidence,
      claims: pending.claims,
      deterministicEvidence: pending.deterministicEvidence,
      ...(pending.evidenceManifest ? { evidenceManifest: pending.evidenceManifest } : {}),
    };
    question = pending.question;
    stage1 = pending.stage1;
    winner = pending.winner;
    consensus = pending.consensus;
    console.log(`[dossier] ${sym}: resuming checkpoint with ${stage1.length} completed seats`);
  } else {
    // Evidence Room first: full intake, deduplicated, claim-ledgered, budgeted.
    // Any failure falls back to the plain bundle — triage never blocks a note.
    const packed = options.evidencePack ?? await buildEvidencePack(sym, todayEt).catch((e) => {
      console.error(`[evidence] pack failed for ${sym}: ${String(e).slice(0, 150)}`);
      return null;
    });
    if (packed) {
      console.log(
        `[evidence] ${sym}: ${packed.manifest.itemsSeen} seen → ${packed.manifest.clustersFormed} clusters, ` +
          `${packed.manifest.duplicatesCollapsed} dupes collapsed, ${packed.claims.length} claims (${packed.newClaimCount} new)`
      );
    }
    const built: DossierContextBundle | null = packed
      ? {
          context: packed.context,
          sources: packed.sources,
          evidence: packed.evidence,
          claims: packed.claims,
          deterministicEvidence: packed.deterministicEvidence,
          evidenceManifest: packed.manifest,
        }
      : await buildContext(sym);
    if (!built) {
      console.error(`[dossier] ${sym}: buildContext returned null`);
      return null;
    }
    bundle = built;
    question =
      `Produce the research desk's daily dossier read on ${sym}: (1) business strategy & outlook and the single question this file is working, ` +
      `(2) the strongest bull-case and bear-case points — each developed and anchored to verifiable facts from the source bundle, ` +
      `(3) risk & uncertainty — what breaks the current read and what evidence would invalidate it, ` +
      `(4) a detailed interpretation of the filed fundamentals, their quality and their limitations. ` +
      `Use ONLY the verified source bundle provided. No advice, no price targets.` +
      (previousThesis
        ? `\n\nACTIVE THESIS CONTINUITY — do not reset this because a new day began:\n${JSON.stringify({
            lifecycleId: previousThesis.lifecycleId,
            openedDate: previousThesis.openedDate,
            subjectPunchline: previousThesis.subjectPunchline,
            thesis: previousThesis.thesis,
            canonicalSignal: previousThesis.canonicalSignal,
            signal: previousThesis.signal,
            question: previousThesis.question,
            oracle: previousThesis.oracle,
            votes: previousThesis.votes,
            observationIndex: previousThesis.observationIndex,
            lastAcceptedArtifactDate: previousThesis.date,
            outcomeContext: previousThesis.outcomeContext,
          })}\nTest this standing proposition against today's evidence. A no-directional prior review is non-admitted: it advances the review cursor but cannot itself change the canonical signal, strengthen or weaken the thesis, or authorize resolution, invalidation, or replacement. Continue, strengthen or weaken only from today's complete evidence and council. Resolve, invalidate or replace it only when today's evidence explicitly warrants that terminal transition.`
        : "");

    // Cost-controlled frontier council first: lead + every core auditor, with
    // the global-context shadow advisory when available. The independent
    // llmc3 machinery remains the fail-closed fallback if core coverage drops.
    const raw =
      (await runFrontierCouncil(question, bundle.context)) ??
      // Full peer review can legitimately take more than 160s when the council
      // replaces an unavailable frontier seat. Keep the client alive long
      // enough to receive that valid result instead of discarding it at the end.
      (await callLlmc3Council(question, bundle.context, 0));
    if (!raw) {
      console.error(`[dossier] ${sym}: both frontier council and llmc3 fallback returned null`);
      return null;
    }
    stage1 = raw.stage1
      .filter((seat) => seat.response && !seat.error)
      .map((seat, index) => ({
        model: seat.model,
        role: "role" in seat && typeof seat.role === "string" ? seat.role : `COUNCIL SEAT ${index + 1}`,
        response: seat.response,
        ...("usage" in seat && seat.usage ? { usage: seat.usage as CouncilModelUsage } : {}),
      }));
    if (stage1.length === 0) {
      console.error(`[dossier] ${sym}: council returned no valid seats`);
      return null;
    }
    winner = raw.winner;
    consensus = raw.consensus;
    const now = Date.now();
    pending = {
      ticker: sym,
      date: todayEt,
      artifactVersion: DOSSIER_ARTIFACT_VERSION,
      contractVersion: DOSSIER_CONTRACT_VERSION,
      generationOwner: lease.owner,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      question,
      context: bundle.context,
      sources: bundle.sources,
      evidence: bundle.evidence,
      claims: bundle.claims,
      deterministicEvidence: bundle.deterministicEvidence,
      ...(bundle.evidenceManifest ? { evidenceManifest: bundle.evidenceManifest } : {}),
      stage1,
      ...(winner != null ? { winner } : {}),
      ...(consensus != null ? { consensus } : {}),
    };
    await savePendingDossierRun(pending, lease);
    console.log(`[dossier] ${sym}: checkpointed ${stage1.length} completed seats`);
  }

  let websiteArtifact = pending.websiteArtifact;
  if (websiteArtifact) {
    const resumed = validateWebsiteResponse(JSON.stringify(websiteArtifact.compactOutput), bundle.evidence, bundle.context);
    if ("output" in resumed) websiteArtifact = { ...websiteArtifact, output: resumed.output, compactOutput: resumed.compactOutput };
    else {
      console.error(`[dossier] ${sym}: rejected resumed website artifact: ${resumed.error}`);
      websiteArtifact = undefined;
    }
  }
  if (!websiteArtifact) {
    websiteArtifact = await chairToWebsiteDossier(
      question,
      stage1,
      bundle.context,
      bundle.evidence,
      websiteAuthorityMode,
      stage1.some((seat) => seat.role === "LEAD ANALYST") ? buildFrontierChairUser(question, stage1) : undefined,
      async (failure) => {
        pending = { ...pending!, updatedAt: Date.now(), terminalFailure: failure };
        await savePendingDossierRun(pending, lease);
      },
    ) ?? undefined;
    if (!websiteArtifact) {
      console.error(`[dossier] ${sym}: website artifact failed; council checkpoint retained`);
      return null;
    }
    pending = { ...pending, updatedAt: Date.now(), websiteArtifact };
    await savePendingDossierRun(pending, lease);
    console.log(`[dossier] ${sym}: checkpointed validated website artifact`);
  }
  // The daily chair receives a compact dossier packet. Each family ballot receives the
  // same smaller evidence packet, and every completed stage is checkpointed.
  let checkpoint: EmailCheckpointPatch = {
    ...(pending.emailDraft ? { emailDraft: pending.emailDraft } : {}),
    ...(pending.emailBallots ? { emailBallots: pending.emailBallots } : {}),
    ...(pending.emailConfidence ? { emailConfidence: pending.emailConfidence } : {}),
    ...(pending.emailRejected ? { emailRejected: pending.emailRejected } : {}),
  };
  const buildEmailArtifact = async (
    artifact: ChairmanArtifact<WebsiteDossierCards>,
  ): Promise<EmailBuildResult | null> => {
    try {
      return await chairToEmailHook(
        artifact.compactOutput,
        bundle.evidence,
        todayEt,
        previousThesis,
        { claims: bundle.claims, deterministicEvidence: bundle.deterministicEvidence },
        checkpoint,
        async (patch) => {
          const next = { ...pending! } as PendingDossierRun;
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
            else (next as unknown as Record<string, unknown>)[key] = value;
          }
          pending = { ...next, updatedAt: Date.now() };
          await savePendingDossierRun(pending, lease);
        },
      );
    } catch (error) {
      console.error(`[dossier] ${sym}: email stage threw — website checkpoint retained: ${String(error).slice(0, 200)}`);
      return null;
    }
  };
  let emailBuild = await buildEmailArtifact(websiteArtifact);
  if (!emailBuild) {
    console.error(`[dossier] ${sym}: email artifact failed; website checkpoint retained`);
    return null;
  }

  // The cost-controlled daily chair may identify that the standing proposition reached a real lifecycle
  // boundary, but it cannot close or replace the canonical thesis by itself.
  // Re-run the complete verified packet through the distinct canonical chair, then rebuild the fixed
  // public hook and ballots from that canonical artifact before publication.
  const proposedBoundary = pending.emailDraft?.artifact.compactOutput.priorUpdate ??
    ("artifact" in emailBuild ? emailBuild.artifact.output?.priorUpdate : null);
  if (
    previousThesis &&
    websiteAuthorityMode === "continuity" &&
    requiresCanonicalBoundaryAuthorization(proposedBoundary)
  ) {
    console.log(
      `[dossier] ${sym}: ${proposedBoundary!.status} boundary proposed; ` +
      `requiring canonical authorization from ${CANONICAL_THESIS_MODEL}`,
    );
    websiteAuthorityMode = "canonical";
    const canonicalWebsiteArtifact = await chairToWebsiteDossier(
      question,
      stage1,
      bundle.context,
      bundle.evidence,
      websiteAuthorityMode,
      stage1.some((seat) => seat.role === "LEAD ANALYST") ? buildFrontierChairUser(question, stage1) : undefined,
      async (failure) => {
        pending = { ...pending!, updatedAt: Date.now(), terminalFailure: failure };
        await savePendingDossierRun(pending, lease);
      },
    );
    if (!canonicalWebsiteArtifact) {
      console.error(`[dossier] ${sym}: canonical boundary authorization failed; continuity checkpoint retained`);
      return null;
    }
    websiteArtifact = canonicalWebsiteArtifact;
    const resetPending = { ...pending, websiteArtifact, updatedAt: Date.now() } as PendingDossierRun;
    delete resetPending.emailDraft;
    delete resetPending.emailBallots;
    delete resetPending.emailConfidence;
    delete resetPending.emailRejected;
    delete resetPending.terminalFailure;
    pending = resetPending;
    checkpoint = {};
    await savePendingDossierRun(pending, lease);
    emailBuild = await buildEmailArtifact(websiteArtifact);
    if (!emailBuild) {
      console.error(`[dossier] ${sym}: canonical boundary email rebuild failed; canonical website checkpoint retained`);
      return null;
    }
  }
  if ("rejected" in emailBuild) {
    const rejectionAuditId = sha256(JSON.stringify({
      ticker: sym,
      date: todayEt,
      contractVersion: DOSSIER_CONTRACT_VERSION,
      contextSha256: sha256(bundle.context),
      websiteAttempts: websiteArtifact.attempts.map((attempt) => attempt.rawResponseSha256),
      draftAttempts: pending.emailDraft?.artifact.attempts.map((attempt) => attempt.rawResponseSha256) ?? [],
      rejectionKey: emailBuild.rejected.key,
    })).slice(0, 48);
    await saveImmutableGenerationAudit(rejectionAuditId, {
      schema: "dossier-generation-audit-v1",
      status: "rejected",
      ticker: sym,
      date: todayEt,
      contractVersion: DOSSIER_CONTRACT_VERSION,
      shared: {
        question,
        context: bundle.context,
        evidence: bundle.evidence,
        claims: bundle.claims,
        deterministicEvidence: bundle.deterministicEvidence,
        evidenceManifest: bundle.evidenceManifest ?? null,
        seats: stage1,
        priorThesis: previousThesis,
      },
      website: websiteArtifact,
      emailDraft: pending.emailDraft ?? null,
      ballots: emailBuild.ballots,
      confidence: null,
      rejection: emailBuild.rejected,
    });
    const compactWhatChanged = pending.emailDraft?.artifact.compactOutput.whatChanged;
    if (!compactWhatChanged) throw new Error("rejected proposition is missing its factual change checkpoint");
    await saveRejectedDossierFactualUpdate(buildRejectedDossierFactualUpdate({
      ticker: sym,
      date: todayEt,
      generatedAt: emailBuild.rejected.rejectedAt,
      rejectionAuditId,
      compactWhatChanged,
      evidence: bundle.evidence,
      rejected: emailBuild.rejected,
      previousThesis,
      compactPriorUpdate: pending.emailDraft?.artifact.compactOutput.priorUpdate ?? null,
    }), lease);
    console.log(`[dossier] ${sym}: exact public proposition rejected ${emailBuild.rejected.votesSupport}/5; outcome checkpointed`);
    return null;
  }
  const emailArtifact = emailBuild.artifact;
  const cards = websiteArtifact.output!;

  const citationCoverage = calculateDossierCitationCoverage({
    ...cards,
    citations: bundle.evidence,
  });
  const citationManifest = bundle.evidence.map((source) => ({
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
  const evidenceSha256 = sha256(JSON.stringify(citationManifest));
  const websiteSha256 = sha256(JSON.stringify(cards));
  const emailHookSha256 = sha256(JSON.stringify(emailArtifact.output!));
  const contentSha256 = sha256(JSON.stringify({
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    ticker: sym,
    date: todayEt,
    websiteSha256,
    emailHookSha256,
  }));
  const councilRunId = sha256(JSON.stringify({
    ticker: sym,
    date: todayEt,
    contextSha256: sha256(bundle.context),
    seats: stage1.map((seat) => ({ model: seat.model, responseSha256: sha256(seat.response) })),
    websiteResponseSha256: sha256(websiteArtifact.rawResponse),
    emailResponseSha256: sha256(emailArtifact.rawResponse),
  })).slice(0, 48);
  const briefAuditId = sha256(`${sym}:${todayEt}:${contentSha256}:${evidenceSha256}`).slice(0, 48);
  const generatedAt = Date.now();
  const thesisLifecycle = buildDossierThesisLifecycle({
    ticker: sym,
    date: todayEt,
    generatedAt,
    hook: emailArtifact.output!,
    previousThesis,
  });
  // Firestore rejects undefined values — omit absent fields entirely (the
  // audited room has a lead but no peer vote, so consensus is legitimately
  // absent there).
  const dossier: Dossier = {
    ticker: sym,
    date: todayEt,
    generatedAt,
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    ...cards,
    emailHook: emailArtifact.output!,
    thesisLifecycle,
    sources: bundle.sources,
    citations: bundle.evidence,
    ...(bundle.evidenceManifest ? { evidenceManifest: bundle.evidenceManifest } : {}),
    citationCoverage,
    briefAuditId,
    councilRunId,
    seats: stage1.length,
    ...(winner != null
      ? { winner: winner.includes("/") ? winner.split("/")[1] : winner }
      : {}),
    ...(consensus != null ? { consensus } : {}),
  };
  const finalValidationError = dossierReleaseValidationError(dossier);
  if (finalValidationError) {
    throw new Error(`final dossier failed the exact v5 release gate: ${finalValidationError}`);
  }
  const socialScorecard = buildSocialEvidenceScorecard({
    dossier,
    citations: bundle.evidence,
    councilSeatResponses: stage1.map((seat) => seat.response),
    manifest: bundle.evidenceManifest,
    recordedAt: generatedAt,
  });
  await saveImmutableGenerationAudit(councilRunId, {
    schema: "dossier-generation-audit-v1",
    status: "published",
    ticker: sym,
    date: todayEt,
    generatedAt,
    contractVersion: DOSSIER_CONTRACT_VERSION,
    shared: {
      question,
      context: bundle.context,
      evidence: bundle.evidence,
      claims: bundle.claims,
      deterministicEvidence: bundle.deterministicEvidence,
      evidenceManifest: bundle.evidenceManifest ?? null,
      socialEvidence: socialScorecard,
      seats: stage1,
      priorThesis: previousThesis,
    },
    website: websiteArtifact,
    emailDraft: pending.emailDraft ?? null,
    ballots: emailArtifact.ballots ?? [],
    confidence: pending.emailConfidence ?? null,
    rejection: null,
    final: { dossier, contentSha256, evidenceSha256, websiteSha256, emailHookSha256 },
  });
  const websiteAuditRaw = JSON.stringify({ attempts: websiteArtifact.attempts });
  const emailAuditRaw = JSON.stringify({
    draftAndConfidenceAttempts: emailArtifact.attempts,
    ballots: (emailArtifact.ballots ?? []).map((ballot) => ({
      family: ballot.family, model: ballot.model, position: ballot.position,
      propositionSha256: ballot.propositionSha256, evidencePacketSha256: ballot.evidencePacketSha256,
      attempts: ballot.attempts,
    })),
  });
  let councilAudit = {
    id: councilRunId,
    ticker: sym,
    date: todayEt,
    generatedAt,
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    question,
    selectedEvidence: {
      context: bundle.context,
      contextSha256: sha256(bundle.context),
      contextChars: bundle.context.length,
      citationIds: bundle.evidence.map((source) => source.id),
    },
    seats: stage1.map((seat) => ({
      role: seat.role,
      model: seat.model,
      response: seat.response,
      responseSha256: sha256(seat.response),
      ...(seat.usage ? { usage: seat.usage } : {}),
    })),
    websiteChairman: {
      model: websiteArtifact.model ?? modelForWebsiteAuthority(websiteAuthorityMode),
      promptVersion: sha256(CHAIR_PROMPT).slice(0, 16),
      input: websiteArtifact.input,
      inputSha256: websiteArtifact.attempts[0]?.inputSha256 ?? sha256(websiteArtifact.input),
      rawResponse: websiteAuditRaw,
      responseSha256: sha256(websiteAuditRaw),
      ...(websiteArtifact.usage ? { usage: websiteArtifact.usage } : {}),
    },
    emailChairman: {
      model: EMAIL_CHAIRMAN_MODEL,
      promptVersion: sha256(`${EMAIL_HOOK_PROMPT}\n${EMAIL_BALLOT_PROMPT}\n${EMAIL_CONFIDENCE_PROMPT}`).slice(0, 16),
      input: emailArtifact.input,
      inputSha256: pending.emailDraft?.artifact.attempts[0]?.inputSha256 ?? sha256(emailArtifact.input),
      rawResponse: emailAuditRaw,
      responseSha256: sha256(emailAuditRaw),
      ...(emailArtifact.usage ? { usage: emailArtifact.usage } : {}),
    },
  };
  if (Buffer.byteLength(JSON.stringify(councilAudit), "utf8") > FIRESTORE_SAFE_DOCUMENT_BYTES) {
    const immutableRef = `dossier_generation_audits/${councilRunId}`;
    councilAudit = {
      ...councilAudit,
      selectedEvidence: {
        ...councilAudit.selectedEvidence,
        context: `[exact context stored in ${immutableRef}]`,
      },
      seats: councilAudit.seats.map((seat) => ({
        ...seat, response: `[exact response stored in ${immutableRef}; sha256 ${seat.responseSha256}]`,
      })),
      websiteChairman: {
        ...councilAudit.websiteChairman,
        rawResponse: `[exact attempts stored in ${immutableRef}]`,
      },
      emailChairman: {
        ...councilAudit.emailChairman,
        rawResponse: `[exact attempts and ballots stored in ${immutableRef}]`,
      },
    };
  }
  await saveDossierCouncilRun(councilAudit);
  await saveGeneratedBriefAudit({
    id: briefAuditId,
    ticker: sym,
    date: todayEt,
    generatedAt,
    kind: "dossier",
    contentSha256,
    evidenceSha256,
    sourceDocumentIds: [...new Set(bundle.evidence.map((source) => source.sourceDocumentId))],
    eventIds: [...new Set(bundle.evidence.flatMap((source) => source.eventId ? [source.eventId] : []))],
    observationIds: [...new Set(bundle.evidence.flatMap((source) => source.observationIds ?? []))],
    citationIds: bundle.evidence.map((source) => source.id),
    citationManifest,
    citationCoverage,
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    websiteSha256,
    emailHookSha256,
    councilRunId,
    generator: {
      council: "frontier-or-llmc3",
      chairman: websiteArtifact.model ?? modelForWebsiteAuthority(websiteAuthorityMode),
      emailChairman: EMAIL_CHAIRMAN_MODEL,
      promptVersion: sha256(CHAIR_PROMPT).slice(0, 16),
      emailPromptVersion: sha256(`${EMAIL_HOOK_PROMPT}\n${EMAIL_BALLOT_PROMPT}\n${EMAIL_CONFIDENCE_PROMPT}`).slice(0, 16),
      pipelineVersion: NEWS_PIPELINE_VERSION,
    },
  });
  const privateSignalOutboxId = await saveDossier(dossier, lease, socialScorecard);
  if (privateSignalOutboxId) {
    // Publication is already durable. Process the immutable forecast only when
    // a lifecycle opens; daily observations update the thesis without creating
    // overlapping 10-15-session bets.
    try {
      const { processPrivateSignalOutboxItem } = await import("./privateSignalRuntime");
      await processPrivateSignalOutboxItem({
        id: privateSignalOutboxId,
        workerId: `dossier-immediate:${lease.owner}`,
      });
    } catch (error) {
      console.error(
        `[private-signal] ${sym}: immediate processing queued for retry: ${String(error).slice(0, 300)}`,
      );
    }
  } else {
    console.log(
      `[private-signal] ${sym}: lifecycle ${dossier.thesisLifecycle?.id ?? "legacy"} observation ` +
      `${dossier.thesisLifecycle?.observationIndex ?? 1}; no duplicate forecast opened`,
    );
  }
  if (previousThesis && websiteAuthorityMode === "continuity") {
    // The public artifact and lifecycle update are already durable. This
    // bounded, non-publishing audit can therefore fail without changing or
    // delaying what the customer sees.
    try {
      await runDailyThesisShadowAudit({
        dossier,
        previousThesis,
        bundle,
        websiteArtifact,
      });
    } catch (error) {
      console.error(
        `[dossier] ${sym}: thesis shadow audit failed after publication; ` +
        `public artifact unchanged: ${String(error).slice(0, 300)}`,
      );
    }
  }
  await deletePendingDossierRun(sym, todayEt, lease);
  return dossier;
  } finally {
    clearInterval(heartbeat);
    await releasePipelineLease(lease.id, lease.owner).catch(() => {});
  }
}

// ---- card markdown for the company file ----

export function dossierCards(d: Dossier): Array<{ name: string; content: string }> {
  const footer = `\n\n---\n_${d.seats} AI analysts · ${
    d.consensus != null
      ? `agreement ${Math.round(d.consensus * 100)}%`
      : `independently reviewed`
  } · sources: ${d.sources} · no advice, no price targets._`;
  return [
    {
      name: `Story — ${d.date}`,
      content: `# ${d.headline}\n\n${d.story}${footer}`,
    },
    {
      name: `Card — Bulls & Bears · ${d.date}`,
      content:
        `# Bulls say / Bears say — ${d.ticker}\n\n## Bulls say\n` +
        d.bulls.map((b) => `- ${b}`).join("\n") +
        `\n\n## Bears say\n` +
        d.bears.map((b) => `- ${b}`).join("\n") +
        footer,
    },
    {
      name: `Card — Risk · ${d.date}`,
      content: `# Risk & uncertainty — ${d.ticker}\n\n${d.risk}${footer}`,
    },
    {
      name: `Card — The numbers read · ${d.date}`,
      content: `# The numbers, read — ${d.ticker}\n\n${d.numbersRead}${footer}`,
    },
  ];
}
