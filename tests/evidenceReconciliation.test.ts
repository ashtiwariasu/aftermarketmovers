import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import type { Desk } from "../src/lib/desk";
import type { Dossier, DossierCitation } from "../src/lib/dossier";
import type { ClaimLedgerSnapshot } from "../src/lib/evidenceRoom";
import type { DossierCouncilRunAudit, GeneratedBriefAudit } from "../src/lib/newsTypes";
import type { LoadedDossierGenerationAudit } from "../src/lib/evidenceReconciliation";

process.env.DESK_STORE = "memory";

interface Fixture {
  dossier: Dossier;
  ledger: ClaimLedgerSnapshot;
  brief: GeneratedBriefAudit;
  council: DossierCouncilRunAudit;
  generationAudit: LoadedDossierGenerationAudit;
}

async function fixture(ticker = "AAPL"): Promise<Fixture> {
  const {
    DAILY_CONTINUITY_MODEL,
    DOSSIER_ARTIFACT_VERSION,
    calculateDossierCitationCoverage,
  } = await import("../src/lib/dossier");
  const { claimLedgerKey, claimLedgerRevisionId } = await import("../src/lib/evidenceRoom");
  const { sha256 } = await import("../src/lib/newsNormalize");
  const citation: DossierCitation = {
    id: "S1",
    title: `${ticker} Form 8-K`,
    url: `https://www.sec.gov/Archives/${ticker.toLowerCase()}-8k.htm`,
    publisher: "SEC",
    authority: "primary",
    publishedAt: Date.parse("2026-07-16T20:04:00Z"),
    publishedDate: "2026-07-16",
    retrievedAt: Date.parse("2026-07-16T20:05:00Z"),
    contentSha256: sha256(`${ticker}:filing`),
    sourceDocumentId: `sec-${ticker.toLowerCase()}-8k`,
    eventId: `event-${ticker.toLowerCase()}`,
    observationIds: [`observation-${ticker.toLowerCase()}`],
  };
  const rendered = `${ticker} filed updated operating guidance for Q3 2026. [1 · 2026-07-16](${citation.url} "${citation.title} — 2026-07-16")`;
  const long = (count: number) => Array.from({ length: count }, () => rendered).join(" ");
  const generatedAt = Date.parse("2026-07-16T20:05:00Z");
  const dossier: Dossier = {
    ticker,
    date: "2026-07-16",
    generatedAt,
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    headline: rendered,
    story: long(24),
    bulls: [long(2), long(2), long(2)],
    bears: [long(2), long(2), long(2)],
    risk: long(14),
    numbersRead: long(14),
    signalCase: {
      eventType: "guidance",
      direction: "DOWN",
      strength: "MODERATE",
      horizonSessions: { min: 10, max: 15 },
      mechanism: long(2),
      invalidation: rendered,
    },
    sources: "SEC filing",
    citations: [citation],
    emailHook: {
      subjectPunchline: "The guidance reset exposes the operating test",
      priorUpdate: null,
      whatChanged: long(2),
      thesis: long(3),
      question: "Is it true that the guidance reset exposes the operating test?",
      primaryEvidence: long(2),
      secondaryEvidence: [rendered, rendered],
      signal: {
        eventType: "guidance",
        direction: "DOWN",
        strength: "MODERATE",
        horizonSessions: { min: 10, max: 15 },
      },
      votesSupport: 3,
      votesOppose: 1,
      votesUncertain: 1,
      votesTotal: 5,
      votes: { support: 3, oppose: 1, uncertain: 1 },
      confidence: {
        majorityReason: long(2),
        dissentReason: rendered,
        uncertaintyReason: rendered,
        flipCondition: rendered,
      },
      oracle: { type: "filing", trigger: rendered, dueBy: "2026-11-13" },
      editorialStrength: { novelty: 4, materiality: 4, evidence: 5, asymmetry: 4, score: 85 },
    },
    citationCoverage: { claims: 0, cited: 0, primarySources: 0 },
    briefAuditId: "pending",
    councilRunId: `council-${ticker.toLowerCase()}`,
    seats: 5,
  };
  dossier.citationCoverage = calculateDossierCitationCoverage(dossier);
  const citationManifest: GeneratedBriefAudit["citationManifest"] = [{
    id: citation.id,
    title: citation.title,
    url: citation.url,
    publisher: citation.publisher,
    authority: citation.authority,
    publishedAt: citation.publishedAt,
    retrievedAt: citation.retrievedAt,
    sourceDocumentId: citation.sourceDocumentId,
    contentSha256: citation.contentSha256,
    eventId: citation.eventId,
    observationIds: citation.observationIds,
  }];
  const evidenceSha256 = sha256(JSON.stringify(citationManifest));
  const websiteSha256 = sha256(JSON.stringify({
    headline: dossier.headline,
    story: dossier.story,
    bulls: dossier.bulls,
    bears: dossier.bears,
    risk: dossier.risk,
    numbersRead: dossier.numbersRead,
    signalCase: dossier.signalCase,
  }));
  const emailHookSha256 = sha256(JSON.stringify(dossier.emailHook));
  const contentSha256 = sha256(JSON.stringify({
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    ticker,
    date: dossier.date,
    websiteSha256,
    emailHookSha256,
  }));
  const claim = {
    id: "C1",
    statement: `${ticker} updated operating guidance`,
    eventType: "guidance",
    sourceIds: [citation.id],
    authority: "primary" as const,
    freshness: "today" as const,
    relevance: 0.9,
    duplicatesCollapsed: 0,
  };
  const ledger: ClaimLedgerSnapshot = {
    ticker,
    date: dossier.date,
    claims: [claim],
    keys: [claimLedgerKey(claim.statement)],
    manifest: {
      itemsSeen: 1,
      clustersFormed: 1,
      duplicatesCollapsed: 0,
      included: 1,
      excluded: [],
    },
    savedAt: generatedAt - 1,
  };
  const context = `${ticker} verified context with [C1] ${claim.statement} [S1]`;
  ledger.contextSha256 = sha256(context);
  ledger.revisionId = claimLedgerRevisionId(ledger);
  const seats = Array.from({ length: 5 }, (_, index) => ({
    role: `role-${index + 1}`,
    model: `model-${index + 1}`,
    response: `response-${ticker}-${index + 1}`,
  }));
  const attempt = (label: string) => ({
    inputSha256: sha256(`${label}:input`),
    instruction: null,
    rawResponse: `${label}:response`,
    rawResponseSha256: sha256(`${label}:response`),
  });
  const websiteArtifact = {
    compactOutput: {},
    input: "website compact input",
    rawResponse: `website-artifact-${ticker}`,
    attempts: [attempt(`${ticker}:website`)],
  };
  const draftArtifact = {
    compactOutput: {},
    input: "draft compact input",
    rawResponse: `draft-artifact-${ticker}`,
    attempts: [attempt(`${ticker}:draft`)],
  };
  const confidenceArtifact = {
    compactOutput: {},
    input: "confidence compact input",
    rawResponse: `confidence-artifact-${ticker}`,
    attempts: [attempt(`${ticker}:confidence`)],
  };
  const ballots = Array.from({ length: 5 }, (_, index) => ({
    family: `family-${index + 1}`,
    model: `ballot-model-${index + 1}`,
    position: index < 3 ? "SUPPORT" : index === 3 ? "OPPOSE" : "UNCERTAIN",
    propositionSha256: sha256(`${ticker}:proposition`),
    evidencePacketSha256: sha256(`${ticker}:packet`),
    attempts: [attempt(`${ticker}:ballot:${index + 1}`)],
  }));
  const emailArtifactRaw = JSON.stringify({
    draftAttemptResponseSha256: draftArtifact.attempts.map((item) => item.rawResponseSha256),
    ballotResponseSha256: ballots.map((ballot) => ballot.attempts.map((item) => item.rawResponseSha256)),
    confidenceAttemptResponseSha256: confidenceArtifact.attempts.map((item) => item.rawResponseSha256),
  });
  dossier.councilRunId = sha256(JSON.stringify({
    ticker,
    date: dossier.date,
    contextSha256: sha256(context),
    seats: seats.map((seat) => ({ model: seat.model, responseSha256: sha256(seat.response) })),
    websiteResponseSha256: sha256(websiteArtifact.rawResponse),
    emailResponseSha256: sha256(emailArtifactRaw),
  })).slice(0, 48);
  dossier.briefAuditId = sha256(`${ticker}:${dossier.date}:${contentSha256}:${evidenceSha256}`).slice(0, 48);
  const websiteChairAuditRaw = JSON.stringify({ attempts: websiteArtifact.attempts });
  const emailChairAuditRaw = JSON.stringify({
    draftAndConfidenceAttempts: [...draftArtifact.attempts, ...confidenceArtifact.attempts],
    ballots: ballots.map((ballot) => ({
      family: ballot.family,
      model: ballot.model,
      position: ballot.position,
      propositionSha256: ballot.propositionSha256,
      evidencePacketSha256: ballot.evidencePacketSha256,
      attempts: ballot.attempts,
    })),
  });
  const council: DossierCouncilRunAudit = {
    id: dossier.councilRunId,
    ticker,
    date: dossier.date,
    generatedAt,
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    question: "What changed?",
    selectedEvidence: { context, contextSha256: sha256(context), contextChars: context.length, citationIds: [citation.id] },
    seats: seats.map((seat) => ({ ...seat, responseSha256: sha256(seat.response) })),
    websiteChairman: {
      model: "chair-model", promptVersion: "website-v1", input: websiteArtifact.input,
      inputSha256: websiteArtifact.attempts[0].inputSha256, rawResponse: websiteChairAuditRaw,
      responseSha256: sha256(websiteChairAuditRaw),
    },
    emailChairman: {
      model: DAILY_CONTINUITY_MODEL, promptVersion: "email-v1",
      input: JSON.stringify({
        draftKey: "draft",
        propositionSha256: sha256(`${ticker}:proposition`),
        evidencePacketSha256: sha256(`${ticker}:packet`),
        confidenceKey: "confidence",
      }),
      inputSha256: draftArtifact.attempts[0].inputSha256, rawResponse: emailChairAuditRaw,
      responseSha256: sha256(emailChairAuditRaw),
    },
  };
  const brief: GeneratedBriefAudit = {
    id: dossier.briefAuditId,
    ticker,
    date: dossier.date,
    generatedAt,
    kind: "dossier",
    contentSha256,
    evidenceSha256,
    sourceDocumentIds: [citation.sourceDocumentId],
    eventIds: [citation.eventId!],
    observationIds: citation.observationIds!,
    citationIds: [citation.id],
    citationManifest,
    citationCoverage: dossier.citationCoverage,
    generator: {
      council: "frontier-or-llmc3", chairman: "chair-model", emailChairman: DAILY_CONTINUITY_MODEL,
      promptVersion: "website-v1", emailPromptVersion: "email-v1", pipelineVersion: "pipeline-v1",
    },
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    websiteSha256,
    emailHookSha256,
    councilRunId: dossier.councilRunId,
  };
  const generationRecord = {
    schema: "dossier-generation-audit-v1",
    status: "published",
    ticker,
    date: dossier.date,
    generatedAt,
    shared: {
      question: "What changed?",
      context,
      evidence: [citation],
      claims: [claim],
      deterministicEvidence: [],
      evidenceManifest: ledger.manifest,
      seats,
      priorThesis: null,
    },
    website: websiteArtifact,
    emailDraft: { key: "draft", propositionSha256: sha256(`${ticker}:proposition`), artifact: draftArtifact },
    ballots,
    confidence: { key: "confidence", artifact: confidenceArtifact },
    rejection: null,
    final: { dossier, contentSha256, evidenceSha256, websiteSha256, emailHookSha256 },
  };
  const generationAudit: LoadedDossierGenerationAudit = {
    record: generationRecord,
    payloadSha256: sha256(JSON.stringify(generationRecord)),
    storage: "memory",
  };
  return { dossier, ledger, brief, council, generationAudit };
}

test("reconciliation validates the canonical ledger, brief, council and every lineage hash", async () => {
  const { reconcileEvidenceArtifacts } = await import("../src/lib/evidenceReconciliation");
  const current = await fixture();
  const audit = reconcileEvidenceArtifacts({ ...current, checkedAt: Date.parse("2026-07-19T08:23:00Z") });
  assert.equal(audit.result, "consistent");
  assert.equal(audit.checks.some((check) => check.status === "fail"), false);
  assert.deepEqual(audit.lineage.citationIds, ["S1"]);
  assert.deepEqual(audit.lineage.claimIds, ["C1"]);

  const tampered = reconcileEvidenceArtifacts({
    ...current,
    brief: { ...current.brief, evidenceSha256: "0".repeat(64) },
    checkedAt: Date.parse("2026-07-19T08:24:00Z"),
  });
  assert.equal(tampered.result, "inconsistent");
  assert.ok(tampered.checks.some((check) => check.code === "brief.evidence-hash" && check.status === "fail"));
});

test("the published ledger snapshot survives a newer failed-gate latest pointer", async () => {
  const { reconcileEvidenceArtifacts } = await import("../src/lib/evidenceReconciliation");
  const { claimLedgerKey, claimLedgerRevisionId } = await import("../src/lib/evidenceRoom");
  const { sha256 } = await import("../src/lib/newsNormalize");
  const current = await fixture();
  const laterClaim = {
    ...current.ledger.claims[0],
    statement: "A later same-day attempt reused S1 but never cleared publication",
  };
  const advancedLedger: ClaimLedgerSnapshot = {
    ...current.ledger,
    claims: [laterClaim],
    keys: [claimLedgerKey(laterClaim.statement)],
    savedAt: current.dossier.generatedAt + 1,
    contextSha256: sha256("later failed attempt context"),
  };
  advancedLedger.revisionId = claimLedgerRevisionId(advancedLedger);
  const advanced = reconcileEvidenceArtifacts({
    ...current,
    ledger: advancedLedger,
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(advanced.result, "consistent", "a newer mutable pointer cannot rewrite published lineage");
  assert.notEqual(advanced.lineage.latestClaimLedgerSha256, advanced.lineage.publishedClaimLedgerSha256);

  const malformedAdvanced: ClaimLedgerSnapshot = { ...advancedLedger, manifest: undefined };
  malformedAdvanced.revisionId = claimLedgerRevisionId(malformedAdvanced);
  const malformedAudit = reconcileEvidenceArtifacts({
    ...current,
    ledger: malformedAdvanced,
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(malformedAudit.result, "inconsistent");
  assert.ok(malformedAudit.checks.some((check) => check.code === "ledger.current-manifest-shape" && check.status === "fail"));

  const futureLedger: ClaimLedgerSnapshot = {
    ...advancedLedger,
    date: "2099-01-01",
    savedAt: Date.parse("2099-01-01T00:00:00Z"),
  };
  futureLedger.revisionId = claimLedgerRevisionId(futureLedger);
  const futureAudit = reconcileEvidenceArtifacts({
    ...current,
    ledger: futureLedger,
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(futureAudit.result, "inconsistent");
  assert.ok(futureAudit.checks.some((check) => check.code === "ledger.saved-at" && check.status === "fail"));

  const nanLedger: ClaimLedgerSnapshot = {
    ...advancedLedger,
    claims: [{ ...advancedLedger.claims[0], relevance: Number.NaN, duplicatesCollapsed: -1 }],
  };
  nanLedger.revisionId = claimLedgerRevisionId(nanLedger);
  const nanAudit = reconcileEvidenceArtifacts({
    ...current,
    ledger: nanLedger,
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(nanAudit.result, "inconsistent");
  assert.ok(nanAudit.checks.some((check) => check.code === "ledger.current-shape" && check.status === "fail"));

  const impossibleDateLedger: ClaimLedgerSnapshot = {
    ...advancedLedger,
    date: "2026-07-32",
    savedAt: Date.parse("2026-07-20T00:00:00Z"),
  };
  impossibleDateLedger.revisionId = claimLedgerRevisionId(impossibleDateLedger);
  const impossibleDateAudit = reconcileEvidenceArtifacts({
    ...current,
    ledger: impossibleDateLedger,
    checkedAt: Date.parse("2026-08-01T08:23:00Z"),
  });
  assert.equal(impossibleDateAudit.result, "inconsistent");
  assert.ok(impossibleDateAudit.checks.some((check) => check.code === "ledger.identity" && check.status === "fail"));

  const unboundLedger: ClaimLedgerSnapshot = { ...advancedLedger, savedAt: current.ledger.savedAt };
  unboundLedger.revisionId = claimLedgerRevisionId(unboundLedger);
  const unbound = reconcileEvidenceArtifacts({
    ...current,
    ledger: unboundLedger,
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(unbound.result, "inconsistent", "an unadvanced ledger must equal the bound published snapshot");
  assert.ok(unbound.checks.some((check) => check.code === "ledger.latest-pointer-binding" && check.status === "fail"));
});

test("ledger revision IDs survive Firestore-style recursive map reordering", async () => {
  const { claimLedgerRevisionId } = await import("../src/lib/evidenceRoom");
  const current = await fixture();
  const reordered: ClaimLedgerSnapshot = {
    contextSha256: current.ledger.contextSha256,
    manifest: current.ledger.manifest ? {
      excluded: current.ledger.manifest.excluded.map((item) => ({ reason: item.reason, title: item.title })),
      included: current.ledger.manifest.included,
      duplicatesCollapsed: current.ledger.manifest.duplicatesCollapsed,
      clustersFormed: current.ledger.manifest.clustersFormed,
      itemsSeen: current.ledger.manifest.itemsSeen,
    } : undefined,
    keys: current.ledger.keys,
    claims: current.ledger.claims.map((claim) => ({
      duplicatesCollapsed: claim.duplicatesCollapsed,
      relevance: claim.relevance,
      freshness: claim.freshness,
      authority: claim.authority,
      sourceIds: claim.sourceIds,
      eventType: claim.eventType,
      statement: claim.statement,
      id: claim.id,
      ...(claim.contradicts ? { contradicts: claim.contradicts } : {}),
    })),
    date: current.ledger.date,
    ticker: current.ledger.ticker,
    savedAt: current.ledger.savedAt,
    revisionId: current.ledger.revisionId,
  };
  assert.equal(claimLedgerRevisionId(reordered), current.ledger.revisionId);
});

test("oversized council pointers are dereferenced through the immutable generation audit", async () => {
  const { reconcileEvidenceArtifacts } = await import("../src/lib/evidenceReconciliation");
  const current = await fixture();
  const ref = `dossier_generation_audits/${current.council.id}`;
  const pointedCouncil: DossierCouncilRunAudit = {
    ...current.council,
    selectedEvidence: {
      ...current.council.selectedEvidence,
      context: `[exact context stored in ${ref}]`,
    },
    seats: current.council.seats.map((seat) => ({
      ...seat,
      response: `[exact response stored in ${ref}; sha256 ${seat.responseSha256}]`,
    })),
    websiteChairman: { ...current.council.websiteChairman, rawResponse: `[exact attempts stored in ${ref}]` },
    emailChairman: { ...current.council.emailChairman, rawResponse: `[exact attempts and ballots stored in ${ref}]` },
  };
  const verified = reconcileEvidenceArtifacts({
    ...current,
    council: pointedCouncil,
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(verified.result, "consistent");
  assert.equal(verified.checks.some((check) => check.status === "deferred"), false);

  const corrupt = reconcileEvidenceArtifacts({
    ...current,
    council: {
      ...pointedCouncil,
      selectedEvidence: { ...pointedCouncil.selectedEvidence, context: "[exact context stored somewhere else]" },
    },
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(corrupt.result, "inconsistent");
  assert.ok(corrupt.checks.some((check) => check.code === "council.context-hash" && check.status === "fail"));
});

test("non-pointer context substitution cannot pass by replacing its copied hash", async () => {
  const { reconcileEvidenceArtifacts } = await import("../src/lib/evidenceReconciliation");
  const { sha256 } = await import("../src/lib/newsNormalize");
  const current = await fixture();
  const replacement = "substituted context with internally matching metadata";
  const audit = reconcileEvidenceArtifacts({
    ...current,
    council: {
      ...current.council,
      selectedEvidence: {
        ...current.council.selectedEvidence,
        context: replacement,
        contextSha256: sha256(replacement),
        contextChars: replacement.length,
      },
    },
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(audit.result, "inconsistent");
  assert.ok(audit.checks.some((check) => check.code === "council.context-hash" && check.status === "fail"));
});

test("inline generation audits retain and verify the exact serialized preimage", async () => {
  const { decodeInlineDossierGenerationAudit } = await import("../src/lib/evidenceReconciliation");
  const { sha256 } = await import("../src/lib/newsNormalize");
  const serialized = JSON.stringify({ z: 1, a: { second: 2, first: 1 } });
  const envelope = {
    encoding: "json-string-inline-v2",
    payloadJson: serialized,
    payloadSha256: sha256(serialized),
    payloadBytes: Buffer.byteLength(serialized, "utf8"),
  };
  assert.deepEqual(decodeInlineDossierGenerationAudit(envelope).record, JSON.parse(serialized));
  assert.throws(
    () => decodeInlineDossierGenerationAudit({ ...envelope, payloadJson: `${serialized} ` }),
    /reconstruction hash/,
  );
});

test("the council content-addressed ID is recomputed from the immutable preimage", async () => {
  const { reconcileEvidenceArtifacts } = await import("../src/lib/evidenceReconciliation");
  const { sha256 } = await import("../src/lib/newsNormalize");
  const current = await fixture();
  const changedResponse = "substituted response with a matching copied hash";
  const generationRecord = structuredClone(current.generationAudit.record) as {
    shared: { seats: Array<{ response: string }> };
  };
  generationRecord.shared.seats[0].response = changedResponse;
  const changed = reconcileEvidenceArtifacts({
    ...current,
    council: {
      ...current.council,
      seats: current.council.seats.map((seat, index) => index === 0
        ? { ...seat, response: changedResponse, responseSha256: sha256(changedResponse) }
        : seat),
    },
    generationAudit: {
      record: generationRecord,
      payloadSha256: sha256(JSON.stringify(generationRecord)),
      storage: "memory",
    },
    checkedAt: Date.parse("2026-07-19T08:23:00Z"),
  });
  assert.equal(changed.result, "inconsistent");
  assert.ok(changed.checks.some((check) => check.code === "council.content-addressed-id" && check.status === "fail"));
});

test("chair model, prompt and exact input provenance are immutable", async () => {
  const { reconcileEvidenceArtifacts } = await import("../src/lib/evidenceReconciliation");
  const { sha256 } = await import("../src/lib/newsNormalize");
  const current = await fixture();
  const variants: DossierCouncilRunAudit[] = [
    { ...current.council, websiteChairman: { ...current.council.websiteChairman, model: "substituted-model" } },
    { ...current.council, websiteChairman: { ...current.council.websiteChairman, promptVersion: "substituted-prompt" } },
    { ...current.council, websiteChairman: { ...current.council.websiteChairman, input: "substituted input" } },
    { ...current.council, websiteChairman: { ...current.council.websiteChairman, inputSha256: sha256("substituted input") } },
    { ...current.council, emailChairman: { ...current.council.emailChairman, model: "substituted-email-model" } },
  ];
  for (const council of variants) {
    const audit = reconcileEvidenceArtifacts({
      ...current,
      council,
      checkedAt: Date.parse("2026-07-19T08:23:00Z"),
    });
    assert.equal(audit.result, "inconsistent");
    assert.ok(audit.checks.some((check) => /chair-hash$/.test(check.code) && check.status === "fail"));
  }
});

test("weekly receipts are idempotent within a day and durable across weeks", async () => {
  const { reconcileEvidenceArtifacts } = await import("../src/lib/evidenceReconciliation");
  const current = await fixture();
  const first = reconcileEvidenceArtifacts({ ...current, checkedAt: Date.parse("2026-07-19T08:23:00Z") });
  const retry = reconcileEvidenceArtifacts({ ...current, checkedAt: Date.parse("2026-07-19T08:25:00Z") });
  const nextWeek = reconcileEvidenceArtifacts({ ...current, checkedAt: Date.parse("2026-07-26T08:23:00Z") });
  assert.equal(first.id, retry.id);
  assert.notEqual(first.id, nextWeek.id);
  assert.equal(first.checkedDate, "2026-07-19");
  assert.equal(nextWeek.checkedDate, "2026-07-26");
});

test("watched-ticker reconciliation consumes the exhaustive desk result and isolates failures", async () => {
  const { runEvidenceReconciliation } = await import("../src/lib/evidenceReconciliation");
  const fixtures = new Map<string, Fixture>();
  for (const ticker of ["AAPL", "MSFT", "NVDA"]) fixtures.set(ticker, await fixture(ticker));
  const desks = Array.from({ length: 601 }, (_, index): Desk => ({
    id: `desk-${String(index).padStart(4, "0")}`,
    email: `${index}@example.test`,
    tickers: [index === 500 ? "MSFT" : index === 600 ? "NVDA" : "AAPL"],
    createdAt: 1,
    activity: [],
    tier: "pro",
    stripeSubscriptionId: `sub_${index}`,
  }));
  const saved: string[] = [];
  const dependencies = {
    listAllDesks: async () => desks,
    getCachedDossier: async (ticker: string) => fixtures.get(ticker)?.dossier ?? null,
    getClaimLedgerSnapshot: async (ticker: string) => fixtures.get(ticker)?.ledger ?? null,
    getGeneratedBriefAudit: async (id: string) =>
      [...fixtures.values()].find((value) => value.brief.id === id)?.brief ?? null,
    getDossierCouncilRun: async (id: string) =>
      [...fixtures.values()].find((value) => value.council.id === id)?.council ?? null,
    getDossierGenerationAudit: async (id: string) =>
      [...fixtures.values()].find((value) => value.council.id === id)?.generationAudit ?? null,
    saveAudit: async (audit: { id: string }) => { saved.push(audit.id); },
    now: () => Date.parse("2026-07-19T08:23:00Z"),
  };
  const complete = await runEvidenceReconciliation({}, dependencies);
  assert.deepEqual(complete.processed, ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(complete.consistent, ["AAPL", "MSFT", "NVDA"]);
  assert.equal(saved.length, 3);
  const filtered = await runEvidenceReconciliation({ ticker: " nvda " }, dependencies);
  assert.deepEqual(filtered.processed, ["NVDA"]);
  await assert.rejects(
    runEvidenceReconciliation({ ticker: "TSLA" }, dependencies),
    (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 404),
  );

  const isolated = await runEvidenceReconciliation({}, {
    ...dependencies,
    getDossierGenerationAudit: async (id: string) => {
      const found = [...fixtures.values()].find((value) => value.council.id === id);
      return found?.dossier.ticker === "MSFT" ? null : found?.generationAudit ?? null;
    },
  });
  assert.deepEqual(isolated.processed, ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(isolated.consistent, ["AAPL", "NVDA"]);
  assert.ok(isolated.errors.some((error: string) => error === "MSFT:missing immutable dossier generation audit"));
});

test("weekly cron requires the exact token and returns non-2xx for an invalid watched universe", async () => {
  const previous = process.env.CRON_TOKEN;
  process.env.CRON_TOKEN = "evidence-reconciliation-secret";
  try {
    const { POST } = await import(
      "../src/app/api/cron/evidence/reconcile/route"
    );
    const { requestCronTokenAuthorized } = await import("../src/lib/cronAuth");
    const missing = new NextRequest("https://example.test/api/cron/evidence/reconcile", { method: "POST" });
    const wrong = new NextRequest("https://example.test/api/cron/evidence/reconcile", {
      method: "POST",
      headers: { "x-cron-token": "wrong" },
    });
    const valid = new NextRequest("https://example.test/api/cron/evidence/reconcile", {
      method: "POST",
      headers: { "x-cron-token": "evidence-reconciliation-secret" },
    });
    assert.equal(requestCronTokenAuthorized(missing), false);
    assert.equal(requestCronTokenAuthorized(wrong), false);
    assert.equal(requestCronTokenAuthorized(valid), true);
    assert.equal((await POST(missing)).status, 403);
    assert.equal((await POST(wrong)).status, 403);

    const { createDesk } = await import("../src/lib/desk");
    await createDesk("bad@example.test", ["bad ticker"], [], "evidence_bad_desk_01");
    assert.equal((await POST(valid)).status, 503);
  } finally {
    if (previous == null) delete process.env.CRON_TOKEN;
    else process.env.CRON_TOKEN = previous;
  }
});
