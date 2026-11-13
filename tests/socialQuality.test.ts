import assert from "node:assert/strict";
import test from "node:test";
import type { Dossier, DossierCitation } from "../src/lib/dossier";
import { buildSocialEvidenceScorecard, citationIdsFromText } from "../src/lib/socialQuality";

function citation(id: string, authority: DossierCitation["authority"]): DossierCitation {
  return {
    id,
    title: `${authority} source`,
    url: authority === "social" ? `https://x.com/i/status/${id.slice(1)}` : `https://example.com/${id}`,
    publisher: authority,
    authority,
    publishedAt: Date.UTC(2026, 6, 22),
    publishedDate: "2026-07-22",
    retrievedAt: Date.UTC(2026, 6, 22, 1),
    sourceDocumentId: `${authority}-${id}`,
  };
}

function dossier(): Dossier {
  return {
    ticker: "MSFT",
    date: "2026-07-22",
    generatedAt: Date.UTC(2026, 6, 22, 2),
    artifactVersion: 5,
    headline: "Attention around the launch accelerated [S3].",
    story: "The filing confirms the product release [S1]. Social attention accelerated around it [S3].",
    bulls: ["Bull one [S1].", "Bull two [S1].", "Bull three [S1]."],
    bears: ["Bear one [S1].", "Bear two [S1].", "Bear three [S1]."],
    risk: "Risk text [S1].",
    numbersRead: "Numbers text [S1].",
    signalCase: {
      eventType: "product",
      direction: "UP",
      strength: "GENTLE",
      horizonSessions: { min: 10, max: 15 },
      mechanism: "Verified launch plus rising attention may support awareness [S1][S3].",
      invalidation: "Attention falls without adoption evidence [S3].",
    },
    sources: "test",
    citations: [citation("S1", "primary"), citation("S3", "social"), citation("S4", "social")],
    emailHook: {
      subjectPunchline: "Launch attention accelerated",
      priorUpdate: null,
      whatChanged: "Discussion accelerated after the launch [S3].",
      thesis: "The verified launch is earning unusual attention [S1][S3].",
      question: "Will launch attention translate into adoption?",
      primaryEvidence: "The launch was filed [S1].",
      secondaryEvidence: ["Attention increased [S3].", "Another source remained quiet [S1]."],
      signal: { eventType: "product", direction: "UP", strength: "GENTLE", horizonSessions: { min: 10, max: 15 } },
      votesSupport: 3,
      votesOppose: 1,
      votesUncertain: 1,
      votesTotal: 5,
      votes: { support: 3, oppose: 1, uncertain: 1 },
      confidence: {
        majorityReason: "The filing and attention align [S1][S3].",
        dissentReason: "Attention is not adoption [S3].",
        uncertaintyReason: "Adoption is not yet reported [S1].",
        flipCondition: "Attention fades [S3].",
      },
      oracle: { type: "tape", trigger: "Attention fades [S3].", dueBy: "2026-08-12" },
      editorialStrength: { novelty: 4, materiality: 3, evidence: 4, asymmetry: 3, score: 72 },
    },
    seats: 4,
    councilRunId: "council-run",
  };
}

test("social evidence scorecard records admission, council use, public use and higher-grade co-citation", () => {
  const value = dossier();
  const scorecard = buildSocialEvidenceScorecard({
    dossier: value,
    citations: value.citations ?? [],
    councilSeatResponses: ["Seat cited attention [S3].", "Seat cited only the filing [S1].", "Another cited [S3]."],
    manifest: {
      itemsSeen: 20,
      clustersFormed: 8,
      duplicatesCollapsed: 12,
      included: 3,
      excluded: [],
      social: {
        qualifiedPosts: 14,
        narrativeClusters: 2,
        duplicatesCollapsed: 12,
        admittedNarratives: 1,
        admittedCitationIds: ["S3"],
      },
    },
    recordedAt: Date.UTC(2026, 6, 22, 3),
  });

  assert.deepEqual(citationIdsFromText("Repeated [S3][S3] plus [S4]."), ["S3", "S4"]);
  assert.equal(scorecard.admission.qualifiedPosts, 14);
  assert.equal(scorecard.admission.narrativeClusters, 2);
  assert.equal(scorecard.admission.admittedNarratives, 1);
  assert.deepEqual(scorecard.admission.citationIds, ["S3"]);
  assert.equal(scorecard.usage.councilSeatCount, 2);
  assert.deepEqual(scorecard.usage.councilCitationIds, ["S3"]);
  assert.equal(scorecard.usage.influencedThesis, true);
  assert.ok(scorecard.usage.publicFields.includes("emailHook.thesis"));
  assert.ok(scorecard.usage.coCitedWithHigherGradeCitationIds.includes("S3"));
  assert.equal(scorecard.evaluation.status, "pending");
  assert.match(scorecard.fingerprintSha256, /^[a-f0-9]{64}$/);
});
