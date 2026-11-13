import { Firestore } from "@google-cloud/firestore";
import type { Dossier, DossierCitation } from "@/lib/dossier";
import type { EvidenceManifest } from "@/lib/evidenceRoom";
import { sha256 } from "@/lib/newsNormalize";

export const SOCIAL_EVIDENCE_SCORECARD_SCHEMA = "social-evidence-scorecard-v1" as const;
export const SOCIAL_EVIDENCE_SCORECARD_COLLECTION = "social_evidence_scorecards";

export interface SocialEvidenceScorecard {
  id: string;
  schema: typeof SOCIAL_EVIDENCE_SCORECARD_SCHEMA;
  ticker: string;
  dossierDate: string;
  dossierGeneratedAt: number;
  councilRunId: string;
  recordedAt: number;
  admission: {
    qualifiedPosts: number;
    narrativeClusters: number;
    duplicatesCollapsed: number;
    admittedNarratives: number;
    citationIds: string[];
    sourceDocumentIds: string[];
  };
  usage: {
    councilSeatCount: number;
    councilCitationIds: string[];
    publicCitationIds: string[];
    publicFields: string[];
    coCitedWithHigherGradeCitationIds: string[];
    influencedThesis: boolean;
  };
  evaluation: {
    status: "pending";
    signalOutcomeKey: string;
  };
  fingerprintSha256: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function citationIdsFromText(text: string): string[] {
  return unique([...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]));
}

function citationIdsFromTexts(values: string[]): string[] {
  return unique(values.flatMap(citationIdsFromText));
}

function socialIdsIn(text: string, socialIds: Set<string>): string[] {
  return citationIdsFromText(text).filter((id) => socialIds.has(id));
}

function coCitedSocialIds(
  texts: string[],
  citations: DossierCitation[],
  socialIds: Set<string>,
): string[] {
  const strongerIds = new Set(citations.filter((citation) => citation.authority !== "social").map((citation) => citation.id));
  return unique(texts.flatMap((text) =>
    text.split(/(?<=[.!?])\s+|\n+/).flatMap((sentence) => {
      const ids = citationIdsFromText(sentence);
      return ids.some((id) => strongerIds.has(id)) ? ids.filter((id) => socialIds.has(id)) : [];
    })
  ));
}

export function buildSocialEvidenceScorecard(input: {
  dossier: Dossier;
  citations: DossierCitation[];
  councilSeatResponses: string[];
  manifest?: EvidenceManifest;
  recordedAt?: number;
}): SocialEvidenceScorecard {
  const { dossier, citations, councilSeatResponses, manifest } = input;
  const admittedIds = manifest?.social?.admittedCitationIds;
  const socialCitations = citations.filter((citation) =>
    citation.authority === "social" && (!admittedIds || admittedIds.includes(citation.id))
  );
  const socialIds = new Set(socialCitations.map((citation) => citation.id));
  const fields: Array<[string, string]> = [
    ["headline", dossier.headline],
    ["story", dossier.story],
    ...dossier.bulls.map((value, index) => [`bulls.${index}`, value] as [string, string]),
    ...dossier.bears.map((value, index) => [`bears.${index}`, value] as [string, string]),
    ["risk", dossier.risk],
    ["numbersRead", dossier.numbersRead],
    ["signalCase.mechanism", dossier.signalCase.mechanism],
    ["signalCase.invalidation", dossier.signalCase.invalidation],
    ["emailHook.whatChanged", dossier.emailHook.whatChanged],
    ["emailHook.thesis", dossier.emailHook.thesis],
    ["emailHook.primaryEvidence", dossier.emailHook.primaryEvidence],
    ...dossier.emailHook.secondaryEvidence.map((value, index) => [`emailHook.secondaryEvidence.${index}`, value] as [string, string]),
    ["emailHook.confidence.majorityReason", dossier.emailHook.confidence.majorityReason],
    ["emailHook.confidence.dissentReason", dossier.emailHook.confidence.dissentReason ?? ""],
    ["emailHook.confidence.uncertaintyReason", dossier.emailHook.confidence.uncertaintyReason ?? ""],
    ["emailHook.confidence.flipCondition", dossier.emailHook.confidence.flipCondition],
  ];
  const publicFields = fields.filter(([, text]) => socialIdsIn(text, socialIds).length > 0).map(([name]) => name);
  const publicCitationIds = unique(fields.flatMap(([, text]) => socialIdsIn(text, socialIds)));
  const councilCitationIds = citationIdsFromTexts(councilSeatResponses).filter((id) => socialIds.has(id));
  const councilSeatCount = councilSeatResponses.filter((text) => socialIdsIn(text, socialIds).length > 0).length;
  const thesisFields = new Set(["headline", "signalCase.mechanism", "emailHook.whatChanged", "emailHook.thesis"]);
  const social = manifest?.social;
  const base = {
    id: `${dossier.ticker}_${dossier.date}`,
    schema: SOCIAL_EVIDENCE_SCORECARD_SCHEMA,
    ticker: dossier.ticker,
    dossierDate: dossier.date,
    dossierGeneratedAt: dossier.generatedAt,
    councilRunId: dossier.councilRunId ?? "",
    recordedAt: input.recordedAt ?? Date.now(),
    admission: {
      qualifiedPosts: social?.qualifiedPosts ?? socialCitations.length,
      narrativeClusters: social?.narrativeClusters ?? socialCitations.length,
      duplicatesCollapsed: social?.duplicatesCollapsed ?? 0,
      admittedNarratives: social?.admittedNarratives ?? socialCitations.length,
      citationIds: socialCitations.map((citation) => citation.id),
      sourceDocumentIds: socialCitations.map((citation) => citation.sourceDocumentId),
    },
    usage: {
      councilSeatCount,
      councilCitationIds,
      publicCitationIds,
      publicFields,
      coCitedWithHigherGradeCitationIds: coCitedSocialIds(fields.map(([, text]) => text), citations, socialIds),
      influencedThesis: publicFields.some((field) => thesisFields.has(field)),
    },
    evaluation: {
      status: "pending" as const,
      signalOutcomeKey: `${dossier.ticker}:${dossier.date}`,
    },
  };
  return { ...base, fingerprintSha256: sha256(JSON.stringify(base)) };
}

const useMemory = process.env.DESK_STORE === "memory";
const memoryScorecards = ((globalThis as Record<string, unknown>).__socialEvidenceScorecards ??=
  new Map<string, SocialEvidenceScorecard>()) as Map<string, SocialEvidenceScorecard>;

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) db = new Firestore();
  return db;
}

export function saveSocialEvidenceScorecardInMemory(scorecard: SocialEvidenceScorecard): void {
  memoryScorecards.set(scorecard.id, structuredClone(scorecard));
}

export async function getSocialEvidenceScorecard(id: string): Promise<SocialEvidenceScorecard | null> {
  if (useMemory) return memoryScorecards.get(id) ?? null;
  const snapshot = await firestore().collection(SOCIAL_EVIDENCE_SCORECARD_COLLECTION).doc(id).get();
  return snapshot.exists ? snapshot.data() as SocialEvidenceScorecard : null;
}
