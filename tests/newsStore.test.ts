import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";

test("accepted articles upsert idempotently and retain run provenance", async () => {
  const { assessRelevance } = await import("../src/lib/newsNormalize");
  const { getArticle, getCompanyNews, upsertAcceptedArticle } = await import("../src/lib/newsStore");
  const now = Date.now();
  const candidate = {
    provider: "sec" as const,
    tier: "authoritative" as const,
    providerId: "0001",
    title: "AAPL filed 8-K: quarterly guidance",
    url: "https://sec.gov/Archives/aapl-8k.htm",
    publishedAt: now - 10_000,
    publisher: "SEC",
    symbols: ["AAPL"],
    sourceType: "primary" as const,
    query: "AAPL",
    fetchedAt: now,
    raw: { accession: "0001" },
  };
  const assessment = assessRelevance(candidate, "AAPL", "Apple Inc.", now);
  const first = await upsertAcceptedArticle({ runId: "run-1", ticker: "AAPL", candidate, assessment });
  const second = await upsertAcceptedArticle({ runId: "run-2", ticker: "AAPL", candidate, assessment });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal((await getCompanyNews("AAPL"))[0].runIds.length, 2);
  assert.equal((await getArticle(first.article.id))?.provenance.length, 1);
  assert.equal((await getArticle(first.article.id))?.observationCount, 2);
});

test("leases reject overlapping owners and allow release", async () => {
  const { acquirePipelineLease, releasePipelineLease } = await import("../src/lib/newsStore");
  assert.equal(await acquirePipelineLease("news-test", "one", 60_000), true);
  assert.equal(await acquirePipelineLease("news-test", "two", 60_000), false);
  await releasePipelineLease("news-test", "one");
  assert.equal(await acquirePipelineLease("news-test", "two", 60_000), true);
  await releasePipelineLease("news-test", "two");
});

test("discovery remains labelled until an admissible source corroborates it", async () => {
  const { assessRelevance } = await import("../src/lib/newsNormalize");
  const { getArticle, upsertAcceptedArticle } = await import("../src/lib/newsStore");
  const now = Date.now();
  const base = {
    title: "NVDA announces quarterly earnings",
    url: "https://example.com/nvda-earnings",
    publishedAt: now,
    publisher: "Example publisher",
    symbols: ["NVDA"],
    query: "NVDA",
    fetchedAt: now,
  };
  const discovery = {
    ...base,
    provider: "yahoo" as const,
    tier: "discovery" as const,
    sourceType: "aggregator" as const,
    raw: { id: "discovery" },
  };
  const discoveryAssessment = assessRelevance(discovery, "NVDA", "NVIDIA", now);
  const first = await upsertAcceptedArticle({
    runId: "tier-run-1",
    ticker: "NVDA",
    candidate: discovery,
    assessment: discoveryAssessment,
  });
  assert.equal(first.article.evidenceTier, "discovery");

  const corroboration = {
    ...base,
    provider: "rss" as const,
    tier: "authoritative" as const,
    sourceType: "primary" as const,
    publisher: "NVIDIA Investor Relations",
    raw: { id: "primary" },
  };
  const corroborationAssessment = assessRelevance(corroboration, "NVDA", "NVIDIA", now);
  const second = await upsertAcceptedArticle({
    runId: "tier-run-2",
    ticker: "NVDA",
    candidate: corroboration,
    assessment: corroborationAssessment,
  });
  assert.equal(second.article.evidenceTier, "authoritative");
  assert.equal((await getArticle(second.article.id))?.provenance.length, 2);
});

test("dead letters retain a replayable observation without retaining the raw body", async () => {
  const { assessRelevance, rawPayloadHash } = await import("../src/lib/newsNormalize");
  const {
    claimPendingDeadLetters,
    getArticle,
    resolveDeadLetter,
    saveDeadLetter,
    upsertAcceptedArticle,
  } = await import("../src/lib/newsStore");
  const now = Date.now();
  const candidate = {
    provider: "sec" as const,
    tier: "authoritative" as const,
    providerId: "dead-letter-1",
    title: "MSFT filed 8-K: updated guidance",
    url: "https://sec.gov/Archives/msft-dead-letter.htm",
    publishedAt: now,
    publisher: "SEC",
    symbols: ["MSFT"],
    sourceType: "primary" as const,
    query: "MSFT",
    fetchedAt: now,
    raw: { accession: "dead-letter-1", body: "not retained" },
  };
  const assessment = assessRelevance(candidate, "MSFT", "Microsoft Corporation", now);
  const decision = { runId: "failed-run", ticker: "MSFT", candidate, assessment };
  await saveDeadLetter({
    runId: "failed-run",
    ticker: "MSFT",
    stage: "persist-candidate",
    error: "temporary write failure",
    payloadHash: rawPayloadHash(candidate.raw),
    decision,
    retryDelayMs: 0,
  });
  const [letter] = await claimPendingDeadLetters("recovery-run", 1);
  assert.ok(letter);
  assert.equal(letter.decision?.candidate.raw, undefined);
  assert.equal(letter.decision?.candidate.rawSha256, rawPayloadHash(candidate.raw));
  const recovered = await upsertAcceptedArticle({ ...letter.decision!, runId: "recovery-run" });
  await resolveDeadLetter(letter.id, "recovery-run");
  assert.equal((await getArticle(recovered.article.id))?.provenance[0].rawSha256, rawPayloadHash(candidate.raw));
});

test("material events require primary evidence or two independent licensed families", async () => {
  const { assessRelevance } = await import("../src/lib/newsNormalize");
  const {
    getNewsEvent,
    getSourceDocument,
    getSourceObservation,
    upsertAcceptedArticle,
  } = await import("../src/lib/newsStore");
  const now = Date.now();
  const base = {
    title: "ZZTOP reports quarterly earnings and updated guidance",
    publishedAt: now,
    symbols: ["ZZTOP"],
    query: "ZZTOP",
    fetchedAt: now,
  };
  const benzinga = {
    ...base,
    provider: "benzinga" as const,
    sourceFamily: "benzinga",
    tier: "licensed" as const,
    providerId: "bz-1",
    url: "https://benzinga.com/news/zztop-results",
    publisher: "Benzinga Newsdesk",
    sourceType: "publisher" as const,
    raw: { id: "bz-1", body: "licensed body is hash-only" },
  };
  const first = await upsertAcceptedArticle({
    runId: "evidence-run-1",
    ticker: "ZZTOP",
    candidate: benzinga,
    assessment: assessRelevance(benzinga, "ZZTOP", "ZZTOP Holdings", now),
  });
  const firstEvent = await getNewsEvent(first.article.eventId);
  assert.equal(firstEvent?.evidenceState, "reported");
  assert.equal(firstEvent?.eligibleForBrief, false);
  assert.equal(firstEvent?.independentLicensedSources, 1);

  const observation = await getSourceObservation(first.article.observationIds[0]);
  assert.equal(observation?.payloadPolicy, "hash-only");
  assert.equal(observation?.rawPayload, undefined);

  const alpaca = {
    ...benzinga,
    provider: "alpaca" as const,
    providerId: "alpaca-1",
    raw: { id: "alpaca-1" },
  };
  const second = await upsertAcceptedArticle({
    runId: "evidence-run-2",
    ticker: "ZZTOP",
    candidate: alpaca,
    assessment: assessRelevance(alpaca, "ZZTOP", "ZZTOP Holdings", now),
  });
  assert.equal((await getNewsEvent(second.article.eventId))?.independentLicensedSources, 1);

  const tiingo = {
    ...base,
    provider: "tiingo" as const,
    sourceFamily: "publisher:reliable.example",
    tier: "licensed" as const,
    providerId: "tiingo-1",
    url: "https://reliable.example/zztop-results",
    publisher: "Reliable News",
    sourceType: "aggregator" as const,
    raw: { id: "tiingo-1" },
  };
  const third = await upsertAcceptedArticle({
    runId: "evidence-run-3",
    ticker: "ZZTOP",
    candidate: tiingo,
    assessment: assessRelevance(tiingo, "ZZTOP", "ZZTOP Holdings", now),
  });
  const corroborated = await getNewsEvent(third.article.eventId);
  assert.equal(corroborated?.evidenceState, "corroborated");
  assert.equal(corroborated?.eligibleForBrief, true);
  assert.equal(corroborated?.sourceDocumentIds.length, 2);
  assert.equal((await getSourceDocument(third.article.sourceDocumentId))?.status, "active");
});

test("source documents preserve correction revisions and public observation payloads", async () => {
  const { assessRelevance, rawPayloadHash } = await import("../src/lib/newsNormalize");
  const {
    getSourceDocument,
    getSourceObservation,
    upsertAcceptedArticle,
  } = await import("../src/lib/newsStore");
  const now = Date.now();
  const original = {
    provider: "sec" as const,
    tier: "authoritative" as const,
    providerId: "revision-test",
    title: "REVCO filed 8-K with updated guidance",
    url: "https://sec.gov/Archives/revco-8k.htm",
    publishedAt: now,
    updatedAt: now,
    publisher: "SEC",
    symbols: ["REVCO"],
    sourceType: "primary" as const,
    query: "REVCO",
    fetchedAt: now,
    raw: { accession: "revision-test", revision: 1 },
  };
  const first = await upsertAcceptedArticle({
    runId: "revision-run-1",
    ticker: "REVCO",
    candidate: original,
    assessment: assessRelevance(original, "REVCO", "Revision Company", now),
  });
  const corrected = {
    ...original,
    updatedAt: now + 60_000,
    fetchedAt: now + 60_000,
    raw: { accession: "revision-test", revision: 2 },
  };
  await upsertAcceptedArticle({
    runId: "revision-run-2",
    ticker: "REVCO",
    candidate: corrected,
    assessment: assessRelevance(corrected, "REVCO", "Revision Company", now + 60_000),
  });
  const document = await getSourceDocument(first.article.sourceDocumentId);
  assert.equal(document?.revisions.length, 2);
  assert.equal(document?.currentRawSha256, rawPayloadHash(corrected.raw));
  const observation = await getSourceObservation(document!.observationIds[0]);
  assert.equal(observation?.payloadPolicy, "public-payload");
  assert.deepEqual(observation?.rawPayload, original.raw);
});

test("generated brief audits retain the complete evidence manifest", async () => {
  const { getGeneratedBriefAudit, saveGeneratedBriefAudit } = await import("../src/lib/newsStore");
  const audit = {
    id: "brief-audit-test",
    ticker: "AAPL",
    date: "2026-07-16",
    generatedAt: Date.now(),
    kind: "dossier" as const,
    contentSha256: "content-hash",
    evidenceSha256: "evidence-hash",
    sourceDocumentIds: ["document-1"],
    eventIds: ["event-1"],
    observationIds: ["observation-1"],
    citationIds: ["S1"],
    citationManifest: [{
      id: "S1",
      title: "Primary filing",
      url: "https://sec.gov/example",
      publisher: "SEC",
      authority: "primary" as const,
      publishedAt: Date.now(),
      retrievedAt: Date.now(),
      sourceDocumentId: "document-1",
      eventId: "event-1",
      observationIds: ["observation-1"],
    }],
    citationCoverage: { claims: 1, cited: 1, primarySources: 1 },
    generator: {
      council: "test-council",
      chairman: "test-chairman",
      promptVersion: "prompt-v1",
      pipelineVersion: "test-pipeline",
    },
  };
  await saveGeneratedBriefAudit(audit);
  assert.deepEqual(await getGeneratedBriefAudit(audit.id), audit);
});

test("dossier council runs retain full evidence, seats, chairman inputs, and usage", async () => {
  const { getDossierCouncilRun, saveDossierCouncilRun } = await import("../src/lib/newsStore");
  const run = {
    id: "dossier-run-test",
    ticker: "AAPL",
    date: "2026-07-16",
    generatedAt: Date.now(),
    artifactVersion: 2,
    question: "Write the full dossier",
    selectedEvidence: {
      context: "Complete selected evidence",
      contextSha256: "context-hash",
      contextChars: 26,
      citationIds: ["S1"],
    },
    seats: [{
      role: "LEAD ANALYST",
      model: "test/lead",
      response: "Complete lead response",
      responseSha256: "lead-hash",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }],
    websiteChairman: {
      model: "test/chair",
      promptVersion: "website-v1",
      input: "Complete council and evidence",
      inputSha256: "website-input-hash",
      rawResponse: "Full website dossier JSON",
      responseSha256: "website-output-hash",
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    },
    emailChairman: {
      model: "test/chair",
      promptVersion: "email-v1",
      input: "Completed website dossier",
      inputSha256: "email-input-hash",
      rawResponse: "Short email hook JSON",
      responseSha256: "email-output-hash",
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    },
  };
  await saveDossierCouncilRun(run);
  assert.deepEqual(await getDossierCouncilRun(run.id), run);
});
