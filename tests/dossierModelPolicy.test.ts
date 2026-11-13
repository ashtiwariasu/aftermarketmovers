import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_THESIS_MODEL,
  DAILY_CONTINUITY_MODEL,
  THESIS_SHADOW_DEFAULT_MODEL,
  modelForWebsiteAuthority,
  parseThesisShadowAudit,
  requiresCanonicalBoundaryAuthorization,
  selectLatestPriorDossier,
  websiteChairAuthority,
  type DossierCitation,
  type DossierPriorThesisContext,
} from "../src/lib/dossier";

const citation: DossierCitation = {
  id: "S1",
  title: "Filed quarterly report",
  url: "https://www.sec.gov/example",
  publisher: "SEC",
  authority: "primary",
  publishedAt: Date.UTC(2026, 7, 5),
  publishedDate: "2026-08-05",
  retrievedAt: Date.UTC(2026, 7, 5),
  sourceDocumentId: "sec-example",
};

test("routes thesis creation and daily continuity to their intended models", () => {
  assert.equal(websiteChairAuthority(null), "canonical");
  assert.equal(
    websiteChairAuthority({} as DossierPriorThesisContext),
    "continuity",
  );
  assert.equal(modelForWebsiteAuthority("canonical"), CANONICAL_THESIS_MODEL);
  assert.equal(modelForWebsiteAuthority("continuity"), DAILY_CONTINUITY_MODEL);
  assert.equal(CANONICAL_THESIS_MODEL, "anthropic/claude-sonnet-5");
  assert.equal(DAILY_CONTINUITY_MODEL, "anthropic/claude-sonnet-4.6");
  assert.notEqual(CANONICAL_THESIS_MODEL, DAILY_CONTINUITY_MODEL);
  assert.equal(THESIS_SHADOW_DEFAULT_MODEL, "qwen/qwen3-max");
});

test("requires canonical authorization only for lifecycle boundaries", () => {
  for (const status of ["resolved", "invalidated", "replaced"] as const) {
    assert.equal(
      requiresCanonicalBoundaryAuthorization({ status, text: "Evidence crossed the lifecycle boundary." }),
      true,
    );
  }
  for (const status of ["open", "strengthened", "weakened"] as const) {
    assert.equal(
      requiresCanonicalBoundaryAuthorization({ status, text: "The standing thesis continues." }),
      false,
    );
  }
  assert.equal(requiresCanonicalBoundaryAuthorization(null), false);
});

test("recovers the newest admitted historical thesis when the current pointer is invalid", () => {
  const current = { date: "2026-08-06", generatedAt: 6, admitted: false };
  const older = [
    { date: "2026-08-05", generatedAt: 5, admitted: true },
    { date: "2026-08-04", generatedAt: 4, admitted: true },
    { date: "2026-08-07", generatedAt: 7, admitted: true },
  ];
  assert.deepEqual(
    selectLatestPriorDossier(current, older, "2026-08-07", (candidate) => candidate.admitted),
    older[0],
  );
  assert.equal(
    selectLatestPriorDossier(current, [], "2026-08-07", (candidate) => candidate.admitted),
    null,
  );
});

test("shadow audit can flag a boundary but cannot express a publishing decision", () => {
  assert.deepEqual(
    parseThesisShadowAudit(
      JSON.stringify({
        status: "boundary_candidate",
        reason: "The dated primary filing materially conflicts with the standing thesis and warrants canonical review.",
        sourceIds: ["S1"],
        contradiction: "The filed result contradicts the standing thesis mechanism.",
      }),
      [citation],
    ),
    {
      status: "boundary_candidate",
      reason: "The dated primary filing materially conflicts with the standing thesis and warrants canonical review.",
      sourceIds: ["S1"],
      contradiction: "The filed result contradicts the standing thesis mechanism.",
    },
  );
  assert.equal(
    parseThesisShadowAudit(
      JSON.stringify({
        status: "resolved",
        reason: "The dated primary filing materially conflicts with the standing thesis and closes it.",
        sourceIds: ["S1"],
        contradiction: "The filed result contradicts the standing thesis mechanism.",
      }),
      [citation],
    ),
    null,
  );
});

test("accepts a traceable, non-publishing shadow audit", () => {
  assert.deepEqual(
    parseThesisShadowAudit(
      JSON.stringify({
        status: "more_cautious",
        reason: "The primary filing supports the base case, but the new evidence is not yet decisive.",
        sourceIds: ["S1", "S1"],
        contradiction: "The dated source does not establish the proposed causal mechanism.",
      }),
      [citation],
    ),
    {
      status: "more_cautious",
      reason: "The primary filing supports the base case, but the new evidence is not yet decisive.",
      sourceIds: ["S1"],
      contradiction: "The dated source does not establish the proposed causal mechanism.",
    },
  );
});

test("rejects untraceable or structurally loose shadow output", () => {
  assert.equal(
    parseThesisShadowAudit(
      JSON.stringify({
        status: "aligned",
        reason: "The admitted filing supports the already published daily observation.",
        sourceIds: ["UNKNOWN"],
        contradiction: null,
      }),
      [citation],
    ),
    null,
  );
  assert.equal(
    parseThesisShadowAudit(
      JSON.stringify({
        status: "aligned",
        reason: "The admitted filing supports the already published daily observation.",
        sourceIds: ["S1"],
        contradiction: null,
        recommendation: "publish",
      }),
      [citation],
    ),
    null,
  );
});
