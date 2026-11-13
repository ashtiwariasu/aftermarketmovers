import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBallotEvidencePacket,
  buildDossierThesisLifecycle,
  buildRejectedDossierFactualUpdate,
  buildWebsiteRepairInput,
  callModel,
  castEmailBallot,
  calculateDossierCitationCoverage,
  dossierQuestionFromPunchline,
  dossierQuestionOracle,
  dossierReleaseValidationError,
  decisionThesisValidationError,
  DOSSIER_ARTIFACT_VERSION,
  EMAIL_BALLOT_LANES,
  fatalCouncilContradictionIssue,
  isFreshDeskDossier,
  isDetailedDossier,
  isRejectedDossierFactualUpdate,
  publicProseValidationError,
  renderCitations,
  sanitizeModelJson,
  normalizePriorUpdateCertainty,
  validateEmailResponse,
  websiteSynthesisIssues,
  type Dossier,
  type DossierCitation,
  type DossierQualitativeSignal,
  type DossierPriorThesisContext,
  type DossierSignalCase,
} from "../src/lib/dossier";

const evidence: DossierCitation[] = [{
  id: "S1",
  title: "Apple Form 8-K",
  url: "https://www.sec.gov/Archives/apple-8k.htm",
  publisher: "SEC",
  authority: "primary",
  publishedAt: Date.parse("2026-07-16T20:04:00Z"),
  publishedDate: "2026-07-16",
  retrievedAt: Date.parse("2026-07-16T20:05:00Z"),
  sourceDocumentId: "sec-apple-8k",
}];

test("citations become dated direct links to the original source", () => {
  assert.equal(
    renderCitations("Apple filed updated guidance. [S1]", evidence),
    "Apple filed updated guidance. [1 · 2026-07-16](https://www.sec.gov/Archives/apple-8k.htm \"Apple Form 8-K — 2026-07-16\")",
  );
});

test("scoreboard fields reuse the audited thesis, ballots and flip condition deterministically", () => {
  const localSignal: DossierQualitativeSignal = {
    eventType: "earnings",
    direction: "DOWN",
    strength: "MODERATE",
    horizonSessions: { min: 10, max: 15 },
  };
  assert.equal(
    dossierQuestionFromPunchline("Cloud acceleration now carries a heavier bill."),
    "Is it true that cloud acceleration now carries a heavier bill?",
  );
  assert.deepEqual(
    dossierQuestionOracle(localSignal, "A later filing supplies the missing margin bridge. [S1]", "2026-07-17"),
    {
      type: "filing",
      trigger: "A later filing supplies the missing margin bridge. [S1]",
      dueBy: "2026-11-14",
    },
  );
  assert.deepEqual(
    dossierQuestionOracle({ ...localSignal, eventType: "product" }, "The launch fails to hold user demand. [S1]", "2026-07-17"),
    {
      type: "tape",
      trigger: "The launch fails to hold user demand. [S1]",
      dueBy: "2026-08-07",
    },
  );
});

test("rendered citation titles cannot change the deterministic oracle policy", () => {
  const signal: DossierQualitativeSignal = {
    eventType: "macro",
    direction: "DOWN",
    strength: "MODERATE",
    horizonSessions: { min: 10, max: 15 },
  };
  const rawTrigger = "AMD firms while the sector stays weak. [S1]";
  const renderedTrigger = renderCitations(rawTrigger, [{
    ...evidence[0],
    title: "Chip stocks fall before quarterly earnings",
  }])!;
  const rawOracle = dossierQuestionOracle(signal, rawTrigger, "2026-07-30");
  const renderedOracle = dossierQuestionOracle(signal, renderedTrigger, "2026-07-30");
  assert.equal(renderedOracle.type, rawOracle.type);
  assert.equal(renderedOracle.dueBy, rawOracle.dueBy);
  assert.equal(renderedOracle.type, "tape");
});

test("a rejected ballot preserves only its cited factual change for the honest fallback", () => {
  const signal: DossierQualitativeSignal = {
    eventType: "earnings",
    direction: "UP",
    strength: "GENTLE",
    horizonSessions: { min: 10, max: 15 },
  };
  const previousThesis: DossierPriorThesisContext = {
    lifecycleId: "c".repeat(48),
    openedDate: "2026-07-16",
    openedAt: 1_721_173_600_000,
    observationIndex: 1,
    date: "2026-07-16",
    subjectPunchline: "Filed cash generation continues to fund the capacity build",
    thesis: "The filed change is more likely to support the shares over the next 10-15 sessions. [S1]",
    canonicalSignal: signal,
    signal,
    question: "Is it true that filed cash generation continues to fund the capacity build?",
    flipCondition: "A later filing showing negative cash conversion would defeat the read. [S1]",
    oracle: {
      type: "filing",
      trigger: "A later filing showing negative cash conversion would defeat the read. [S1]",
      dueBy: "2026-11-14",
    },
    votes: { support: 4, oppose: 0, uncertain: 1, total: 5 },
    state: "open",
    outcomeContext: {
      status: "unresolved",
      asOfDate: "2026-07-16",
      note: "The active thesis remains unresolved.",
    },
  };
  const update = buildRejectedDossierFactualUpdate({
    ticker: "AAPL",
    date: "2026-07-17",
    generatedAt: 1_721_260_000_000,
    rejectionAuditId: "a".repeat(48),
    compactWhatChanged: "Apple filed updated operating guidance after the market closed. [S1]",
    evidence,
    rejected: {
      key: "rejected-key",
      propositionSha256: "b".repeat(64),
      rejectedAt: 1_721_260_000_000,
      votesSupport: 2,
      votesOppose: 2,
      votesUncertain: 1,
      reason: "minority-support",
      ballotResponseSha256: [],
    },
    previousThesis,
    compactPriorUpdate: {
      status: "weakened",
      text: "New operating guidance weakens the standing capacity thesis without resolving it. [S1]",
    },
  });
  assert.equal(isRejectedDossierFactualUpdate(update), true);
  assert.match(update.whatChanged, /https:\/\/www\.sec\.gov\/Archives\/apple-8k\.htm/);
  assert.equal(update.votesUnavailable, 0);
  assert.equal(update.thesisObservation?.status, "weakened");
  assert.match(update.thesisObservation?.updateText ?? "", /https:\/\/www\.sec\.gov\/Archives\/apple-8k\.htm/);
  assert.equal(isRejectedDossierFactualUpdate({ ...update, whatChanged: "substituted" }), false);
  assert.equal(isRejectedDossierFactualUpdate({ ...update, votesUnavailable: 1 }), false);
});

test("an incomplete ballot records the unavailable family instead of imputing a vote", () => {
  const update = buildRejectedDossierFactualUpdate({
    ticker: "AAPL",
    date: "2026-07-17",
    generatedAt: 1_721_260_000_000,
    rejectionAuditId: "d".repeat(48),
    compactWhatChanged: "Apple filed updated operating guidance after the market closed. [S1]",
    evidence,
    rejected: {
      key: "incomplete-key",
      propositionSha256: "e".repeat(64),
      rejectedAt: 1_721_260_000_000,
      votesSupport: 1,
      votesOppose: 0,
      votesUncertain: 3,
      reason: "incomplete-ballot",
      ballotResponseSha256: [],
    },
  });
  assert.equal(update.votesUnavailable, 1);
  assert.equal(isRejectedDossierFactualUpdate(update), true);
});

test("uncited numeric claims are rejected; connective prose passes", () => {
  // Per-claim citation contract: sentences carrying numbers/money need [S#].
  assert.equal(renderCitations("Revenue grew 14% in the quarter.", evidence), null);
  assert.equal(renderCitations("Revenue grew 14% in the quarter. [S9]", evidence), null);
  assert.equal(
    renderCitations("Revenue grew 14%. [S1] Margins reached 71.2% as well.", evidence),
    null,
  );
  // Connective prose without figures needs no receipt.
  assert.notEqual(
    renderCitations("The central tension is timing. Revenue grew 14%. [S1]", evidence),
    null,
  );
});

test("citations reject non-web source schemes", () => {
  assert.equal(
    renderCitations("Revenue grew 10%. [S1]", [{ ...evidence[0], url: "javascript:alert(1)" }]),
    null,
  );
});

test("coverage assigns rendered after-punctuation links to the preceding claim", () => {
  const cited = renderCitations("Apple filed updated guidance for Q3 2026. [S1]", evidence)!;
  const coverage = calculateDossierCitationCoverage({
    headline: cited,
    story: cited,
    bulls: [cited, cited, cited],
    bears: [cited, cited, cited],
    risk: cited,
    numbersRead: cited,
    citations: evidence,
  });
  assert.deepEqual(coverage, { claims: 10, cited: 10, primarySources: 1 });
});

test("final coverage keeps U.S. initialisms inside the cited factual claim", () => {
  const cited = renderCitations(
    "A reported $1.5B agreement supports continued U.S. expansion. [S1]",
    evidence,
  )!;
  const coverage = calculateDossierCitationCoverage({
    headline: cited,
    story: cited,
    bulls: [cited, cited, cited],
    bears: [cited, cited, cited],
    risk: cited,
    numbersRead: cited,
    citations: evidence,
  });
  assert.deepEqual(coverage, { claims: 10, cited: 10, primarySources: 1 });
});

test("only the full two-artifact dossier satisfies the current cache contract", () => {
  assert.equal(isDetailedDossier({
    date: "2026-07-16",
    story: "short legacy brief",
  }), false);

  assert.equal(isDetailedDossier({
    ticker: "AAPL",
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    generatedAt: Date.now(),
    date: "2026-07-16",
    headline: "A fully developed evidence-backed company read",
    story: "s".repeat(1_200),
    risk: "r".repeat(700),
    numbersRead: "n".repeat(700),
    bulls: ["bull 1", "bull 2", "bull 3"],
    bears: ["bear 1", "bear 2", "bear 3"],
    sources: "SEC filing",
    seats: 5,
    signalCase: {
      eventType: "earnings",
      direction: "DOWN",
      strength: "MODERATE",
      horizonSessions: { min: 10, max: 15 },
      mechanism: "Reported profit quality is weaker than the headline suggests while recurring operating evidence remains incomplete.",
      invalidation: "A later filing supplies a clean recurring earnings and cash bridge.",
    },
    emailHook: {
      subjectPunchline: "The profit headline hides the real operating test",
      priorUpdate: null,
      whatChanged: "What changed",
      thesis: "The thesis",
      question: "Is it true that the profit headline hides the real operating test?",
      primaryEvidence: "The primary evidence",
      secondaryEvidence: ["Secondary evidence one", "Secondary evidence two"],
      signal: {
        eventType: "earnings",
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
        majorityReason: "The majority supports the mechanism because the filed evidence is direct.",
        dissentReason: "The dissenter reads the distortion as temporary rather than structural.",
        uncertaintyReason: "One analyst cannot yet separate recurring economics from accounting effects.",
        flipCondition: "A clean cash and segment bridge would reverse the read.",
      },
      oracle: {
        type: "filing",
        trigger: "A clean cash and segment bridge would reverse the read.",
        dueBy: "2026-11-13",
      },
      editorialStrength: { novelty: 4, materiality: 4, evidence: 5, asymmetry: 4, score: 85 },
    },
  }), true);
});

function citedWords(count: number): string {
  return `${Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ")}. [S1]`;
}

const signal: DossierQualitativeSignal = {
  eventType: "earnings",
  direction: "DOWN",
  strength: "MODERATE",
  horizonSessions: { min: 10, max: 15 },
};

function validEmailObject(): Record<string, unknown> {
  const flipCondition = citedWords(20);
  return {
    subjectPunchline: "The profit headline hides the real operating test",
    priorUpdate: null,
    whatChanged: citedWords(35),
    thesis: "The filed change is more likely to pressure the shares over the next 10–15 sessions because recurring operating evidence remains too weak to support the headline profit, while a clean earnings bridge would invalidate the read. [S1]",
    question: "Is it true that the profit headline hides the real operating test?",
    primaryEvidence: citedWords(35),
    secondaryEvidence: [citedWords(20), citedWords(22)],
    signal,
    votesSupport: 3,
    votesOppose: 0,
    votesUncertain: 2,
    votesTotal: 5,
    votes: { support: 3, oppose: 0, uncertain: 2 },
    confidence: {
      majorityReason: citedWords(30),
      dissentReason: null,
      uncertaintyReason: citedWords(22),
      flipCondition,
    },
    oracle: { type: "filing", trigger: flipCondition, dueBy: "2026-11-13" },
    editorialStrength: { novelty: 4, materiality: 4, evidence: 5, asymmetry: 4, score: 85 },
  };
}

function releaseReadyDossier(): Dossier {
  const rendered = renderCitations("Apple filed updated guidance for Q3 2026. [S1]", evidence)!;
  const long = (sentence: string, count: number) => Array.from({ length: count }, (_, index) =>
    renderCitations(`${sentence} Observation ${index + 1} concerns Q3 2026. [S1]`, evidence)!,
  ).join(" ");
  const email = validateEmailResponse(
    JSON.stringify(validEmailObject()), evidence, 5, 3, 0, signal,
  );
  assert.ok("output" in email, "error" in email ? email.error : "missing output");
  if (!("output" in email)) throw new Error("valid hook fixture was rejected");
  const dossier: Dossier = {
    ticker: "AAPL",
    artifactVersion: DOSSIER_ARTIFACT_VERSION,
    generatedAt: Date.parse("2026-07-16T20:05:00Z"),
    date: "2026-07-16",
    headline: rendered,
    story: long("The core synthesis connects demand, distribution and the new guidance", 24),
    risk: long("The failure case turns on supply timing and contract cancellation", 14),
    numbersRead: long("The filed arithmetic separates recurring revenue from deferred consideration", 14),
    bulls: [
      long("Enterprise bookings support the constructive side", 2),
      long("Renewal activity adds independent operating support", 2),
      long("Product adoption strengthens the durable demand case", 2),
    ],
    bears: [
      long("Implementation costs weaken the near-term margin bridge", 2),
      long("Customer concentration raises the downside sensitivity", 2),
      long("Execution timing leaves the forward mechanism exposed", 2),
    ],
    sources: "SEC filing",
    seats: 5,
    signalCase: {
      ...signal,
      mechanism: long("The reported change creates a time-bounded operating mechanism", 2),
      invalidation: rendered,
    },
    emailHook: email.output,
    citations: evidence,
    citationCoverage: { claims: 0, cited: 0, primarySources: 0 },
    briefAuditId: "brief-audit-1",
    councilRunId: "council-run-1",
  };
  dossier.citationCoverage = calculateDossierCitationCoverage(dossier);
  return dossier;
}

function releaseReadyEvidenceManifest(): NonNullable<Dossier["evidenceManifest"]> {
  return {
    itemsSeen: 8,
    clustersFormed: 3,
    duplicatesCollapsed: 2,
    included: 1,
    excluded: [{ title: "duplicate-company-release", reason: "collapsed into the primary filing" }],
    social: {
      qualifiedPosts: 2,
      narrativeClusters: 1,
      duplicatesCollapsed: 1,
      admittedNarratives: 0,
      admittedCitationIds: [],
    },
    materiality: {
      stableEvidenceFingerprint: "a".repeat(64),
      stableEvidenceKeys: ["primary:sec-apple-8k:2026-07-16:"],
      referencePrice: 204.12,
      dayChangePercent: 0.7,
      afterHoursChangePercent: null,
    },
  };
}

test("release-ready dossiers accept only the exact evidence manifest shape", () => {
  const dossier = {
    ...releaseReadyDossier(),
    evidenceManifest: releaseReadyEvidenceManifest(),
  };
  assert.equal(isDetailedDossier(dossier), true);
  assert.equal(dossierReleaseValidationError(dossier), null);

  const untrackedCounter = {
    ...dossier,
    evidenceManifest: { ...dossier.evidenceManifest, untrackedCounter: 1 },
  };
  assert.equal(isDetailedDossier(untrackedCounter), false);
  const untrackedExclusionField = {
    ...dossier,
    evidenceManifest: {
      ...dossier.evidenceManifest,
      excluded: [{ ...dossier.evidenceManifest.excluded[0], sourceUrl: "https://example.test" }],
    },
  };
  assert.equal(isDetailedDossier(untrackedExclusionField), false);
  assert.equal(isDetailedDossier({
    ...dossier,
    evidenceManifest: {
      ...dossier.evidenceManifest,
      materiality: {
        ...dossier.evidenceManifest.materiality!,
        stableEvidenceFingerprint: "not-a-sha256-fingerprint",
      },
    },
  }), false);
});

test("a release-ready dossier accepts the exact stable lifecycle receipt", () => {
  const dossier = releaseReadyDossier();
  const thesisLifecycle = buildDossierThesisLifecycle({
    ticker: dossier.ticker,
    date: dossier.date,
    generatedAt: dossier.generatedAt,
    hook: dossier.emailHook,
    previousThesis: null,
  });
  const lifecycleDossier = { ...dossier, thesisLifecycle };
  assert.equal(isDetailedDossier(lifecycleDossier), true);
  assert.equal(dossierReleaseValidationError(lifecycleDossier), null);
});

test("Firestore map-key reordering cannot invalidate an unchanged thesis lifecycle", () => {
  const dossier = releaseReadyDossier();
  const lifecycle = buildDossierThesisLifecycle({
    ticker: dossier.ticker,
    date: dossier.date,
    generatedAt: dossier.generatedAt,
    hook: dossier.emailHook,
    previousThesis: null,
  });
  const reorderedSignal: DossierQualitativeSignal = {
    horizonSessions: { max: 15, min: 10 },
    strength: dossier.emailHook.signal.strength,
    direction: dossier.emailHook.signal.direction,
    eventType: dossier.emailHook.signal.eventType,
  };
  const reorderedOracle = {
    dueBy: dossier.emailHook.oracle.dueBy,
    trigger: dossier.emailHook.oracle.trigger,
    type: dossier.emailHook.oracle.type,
  };
  const reordered: Dossier = {
    ...dossier,
    emailHook: { ...dossier.emailHook, signal: reorderedSignal, oracle: reorderedOracle },
    thesisLifecycle: {
      ...lifecycle,
      canonicalSignal: { ...reorderedSignal },
      latestSignal: { ...reorderedSignal },
      canonicalOracle: { ...reorderedOracle },
    },
  };
  assert.equal(dossierReleaseValidationError(reordered), null);
  assert.notEqual(dossierReleaseValidationError({
    ...reordered,
    thesisLifecycle: {
      ...reordered.thesisLifecycle!,
      latestSignal: { ...reorderedSignal, strength: "STRONG" },
    },
  }), null);
});

test("stored v5 release readiness recomputes coverage and binds every rendered citation", () => {
  const dossier = releaseReadyDossier();
  assert.equal(dossierReleaseValidationError(dossier), null);

  assert.match(
    dossierReleaseValidationError({
      ...dossier,
      citationCoverage: { ...dossier.citationCoverage!, claims: dossier.citationCoverage!.claims + 1 },
    }) ?? "",
    /stored citation coverage/,
  );
  assert.match(
    dossierReleaseValidationError({
      ...dossier,
      story: dossier.story.replace(evidence[0].url, "https://example.test/substituted"),
    }) ?? "",
    /substituted|unknown citation/,
  );
  assert.match(
    dossierReleaseValidationError({
      ...dossier,
      signalCase: { ...dossier.signalCase, mechanism: "This mechanism leans on a 34% margin figure with no traceable source." },
    }) ?? "",
    /signalCase\.mechanism citation coverage/,
  );
});

test("social-enriched dossiers remain release-ready low-grade evidence artifacts", () => {
  const dossier = releaseReadyDossier();
  const socialCitation: DossierCitation = {
    id: "S2",
    title: "Public discussion sampled from X",
    url: "https://x.com/i/status/2079602841124319329",
    publisher: "X",
    authority: "social",
    publishedAt: Date.parse("2026-07-16T20:04:00Z"),
    publishedDate: "2026-07-16",
    retrievedAt: Date.parse("2026-07-16T20:05:00Z"),
    sourceDocumentId: "x-status-2079602841124319329",
    evidenceState: "discovery",
  };
  dossier.citations = [...(dossier.citations ?? []), socialCitation];
  dossier.citationCoverage = calculateDossierCitationCoverage(dossier);

  assert.equal(isDetailedDossier(dossier), true);
  assert.equal(dossierReleaseValidationError(dossier), null);
});

test("the latest validated post-market dossier survives the bounded overnight hand-off", () => {
  const dossier = releaseReadyDossier();
  const generatedAt = dossier.generatedAt;
  const overnight = dossier;

  assert.equal(isFreshDeskDossier(overnight, generatedAt + 24 * 60 * 60_000), true);
  assert.equal(isFreshDeskDossier(overnight, generatedAt + 36 * 60 * 60_000), true);
  assert.equal(isFreshDeskDossier(overnight, generatedAt + 36 * 60 * 60_000 + 1), false);
  assert.equal(isFreshDeskDossier({ ...overnight, citations: [] }, generatedAt + 60_000), false);
});

test("four-beat hook accepts only the audited five-family qualitative signal", () => {
  const response = validEmailObject();
  const valid = validateEmailResponse(JSON.stringify(response), evidence, 5, 3, 0, signal);
  assert.ok("output" in valid, "error" in valid ? valid.error : "missing output");
  if ("output" in valid) {
    assert.equal(valid.output.votesSupport, 3);
    assert.equal(valid.output.votesUncertain, 2);
    assert.equal(valid.output.signal.eventType, "earnings");
    assert.deepEqual(valid.output.signal.horizonSessions, { min: 10, max: 15 });
    assert.equal(valid.output.secondaryEvidence.length, 2);
  }

  const minority = { ...response, votesSupport: 2, votesUncertain: 3 };
  const rejected = validateEmailResponse(JSON.stringify(minority), evidence, 5, 2, 0, signal);
  assert.ok("error" in rejected);
  if ("error" in rejected) assert.match(rejected.error, /at least three SUPPORT/);
});

test("citation validation keeps U.S. initialisms inside the cited factual sentence", () => {
  const response = validEmailObject();
  response.secondaryEvidence = [
    "A reported $1.5B packaging agreement signals continued U.S. expansion while the filing still shows adequate liquidity for the program. [S1]",
    citedWords(22),
  ];
  const result = validateEmailResponse(JSON.stringify(response), evidence, 5, 3, 0, signal);
  assert.ok("output" in result, "error" in result ? result.error : "missing output");
});

test("decision thesis binds direction and horizon while fatal factual dissent blocks the premise", () => {
  const thesis = String(validEmailObject().thesis);
  assert.equal(decisionThesisValidationError(thesis, signal), null);
  assert.match(
    decisionThesisValidationError(thesis.replace("pressure", "support"), signal) ?? "",
    /DOWN thesis/,
  );
  assert.match(
    fatalCouncilContradictionIssue({
      dissentReason: "The scale claim is arithmetically wrong: the stated proceeds equal almost all quarterly operating cash flow, not one quarter. [S1]",
      uncertaintyReason: null,
    }) ?? "",
    /fatal factual contradiction/,
  );
  assert.equal(fatalCouncilContradictionIssue({
    dissentReason: "The filing does not disclose the use of proceeds, so the directional mechanism remains uncertain. [S1]",
    uncertaintyReason: null,
  }), null);
});

test("public contract rejects percentage bands, recommendations, targets and invented fields", () => {
  for (const thesis of [
    `${citedWords(55)} Investors should buy the shares. [S1]`,
    `${citedWords(55)} Fair value is $420. [S1]`,
    `${citedWords(55)} The stock could rise 8% over the next 12 sessions. [S1]`,
  ]) {
    const object = { ...validEmailObject(), thesis };
    const result = validateEmailResponse(JSON.stringify(object), evidence, 5, 3, 0, signal);
    assert.ok("error" in result);
    if ("error" in result) assert.match(result.error, /public|buy\/sell|target|percentage/i);
  }

  const nestedBand = validEmailObject();
  nestedBand.signal = { ...signal, moveBand: { lowPct: 3, highPct: 6 } };
  const rangeRejected = validateEmailResponse(JSON.stringify(nestedBand), evidence, 5, 3, 0);
  assert.ok("error" in rangeRejected);
  if ("error" in rangeRejected) assert.match(rangeRejected.error, /qualitative/);

  const extra = { ...validEmailObject(), priceTarget: 420 };
  const extraRejected = validateEmailResponse(JSON.stringify(extra), evidence, 5, 3, 0, signal);
  assert.ok("error" in extraRejected);
  if ("error" in extraRejected) assert.match(extraRejected.error, /unknown keys: priceTarget/);

  assert.equal(publicProseValidationError("Revenue rose 22% in the filed quarter. [S1]"), null);

  // 2026-07-18 false-positive families — historical analysis must pass.
  for (const prose of [
    "The 81% growth rate implies a prior net margin near 38%. [S1]",
    "The stock last traded at $346.77. [S2]",
    "Margins should have been near 32% under the old cost structure. [S1]",
    "Shares closed at $340.12 after the print. [S3]",
    "Insider selling accelerated after the lockup expired. [S1]",
    "The company bought back $70 billion of stock. [S2]",
    "Institutions sold into the rally through June. [S3]",
    "Meta would sell excess AI compute, according to a report. [S1]",
    "Macquarie reiterated an outperform stance during the pullback. [S1]",
    "The product is set to launch July 28, with shares up 9% today. [S1]",
    "The stock had a 30.74% monthly drawdown, and extending pressure into the next 10–15 sessions remains the qualitative risk. [S1]",
  ]) assert.equal(publicProseValidationError(prose), null, prose);
  // ...while genuine forward claims stay blocked, with the passage quoted.
  for (const prose of [
    "Shares could climb 3-10% over the next 15 sessions. [S1]",
    "The stock will reach $400 by early August. [S1]",
    "The stock could trade to $400 on a beat. [S1]",
    "Sell NVDA. [S1]",
    "This is a buy at these levels. [S1]",
    "Revenue is expected to grow 20% next quarter. [S1]",
    "The shares will rise 8% over the next 10 sessions. [S1]",
  ]) {
    const err = publicProseValidationError(prose);
    assert.ok(err && /offending passage|percentage forecast/.test(err), prose);
  }
});

test("website synthesis gate rejects transcript jargon, repeated figures and false missing-data claims", () => {
  const repeated = "Revenue was $109.90B and the shares fell 4.68%.";
  const issues = websiteSynthesisIssues({
    story: `The source bundle provides no cash-flow data. ${repeated}`,
    bulls: [`Filed strength remains visible. ${repeated}`],
    bears: [`The regulatory timing is unresolved. ${repeated}`],
    risk: `The causal link remains uncertain. ${repeated}`,
    numbersRead: `The arithmetic needs one home. ${repeated}`,
  }, "- Operating cash flow: $45.79B (quarter 2026-01-01 to 2026-03-31)");

  assert.ok(issues.some((issue) => /generation process/.test(issue.message)));
  assert.ok(issues.some((issue) => /distinctive figure/.test(issue.message)));
  assert.ok(issues.some((issue) => /declares operating cash flow evidence missing/.test(issue.message)));
});

test("website synthesis gate preserves detailed but non-repetitive card reasoning", () => {
  assert.deepEqual(websiteSynthesisIssues({
    story: "The new order adds a regulatory process to weakness that began before the headline. The timing makes the event a possible accelerant rather than a proven cause.",
    bulls: ["The latest filing shows strong operating income, giving the business capacity to absorb a slow compliance process."],
    bears: ["The order targets distribution surfaces that competitors need, so a dated remedy could change access before revenue visibly moves."],
    risk: "The read fails if the order is stayed or if benchmark data shows the decline was broad market movement rather than company-specific pressure.",
    numbersRead: "Operating income and securities gains explain different parts of reported profit; cash generation must be compared with capital spending over the same filed period.",
  }), []);
});

test("website synthesis gate distinguishes missing metrics from missing reconciliation detail", () => {
  const issues = websiteSynthesisIssues({
    story: "The filing supplies operating cash flow, but it does not provide a cash-flow reconciliation detail that explains the working-capital contribution.",
    bulls: ["Reported cash generation gives the company funding capacity while demand remains intact."],
    bears: ["The absence of a working-capital bridge makes the quality of that cash conversion harder to judge."],
    risk: "The read weakens if a later filing shows the cash conversion came from temporary working-capital timing." ,
    numbersRead: "Operating cash flow is present and should be compared with capital expenditure over the same filed period.",
  }, "- Operating cash flow: $45.79B (quarter 2026-01-01 to 2026-03-31)");
  assert.ok(!issues.some((issue) => /declares operating cash flow evidence missing/.test(issue.message)));
});

test("website synthesis gate rejects a false missing balance-sheet claim but permits narrower filed gaps", () => {
  const evidenceContext = [
    "- Cash and short-term investments: $2.24B",
    "- Total assets: $55.57B",
    "- Current debt: $7.55B",
    "- Long-term debt: $17.31B",
  ].join("\n");
  const common = {
    story: "The company is funding a capital build while reported demand continues to grow.",
    bulls: ["Cash and assets provide some capacity to fund the build while customers ramp."],
    bears: ["Debt is material relative to the current operating base and raises financing risk."],
    risk: "The read weakens if later filings show lower demand or materially higher financing costs.",
  };

  const falseDenial = websiteSynthesisIssues({
    ...common,
    numbersRead: "The filing provides no balance-sheet evidence with which to assess funding capacity.",
  }, evidenceContext);
  assert.ok(falseDenial.some((issue) =>
    issue.fields.includes("numbersRead") &&
    /declares balance-sheet evidence missing although the filed metric is present/.test(issue.message)));

  const qualifiedGap = websiteSynthesisIssues({
    ...common,
    numbersRead: "The filing supplies a balance-sheet snapshot, but no debt-maturity breakdown or covenant detail.",
  }, evidenceContext);
  assert.ok(!qualifiedGap.some((issue) => /declares balance-sheet evidence missing/.test(issue.message)));
});

test("website repairs never replay the council and retain full evidence for citation failures", () => {
  const base = {
    question: "What changed?",
    fields: ["story"],
    parsed: { story: "A current failed value. [S1]", bears: ["untouched"] },
    context: "UNIQUE_VERIFIED_EVIDENCE_PACKET",
    evidence,
  };
  const wording = buildWebsiteRepairInput({ ...base, error: "story contains prohibited public language" });
  assert.equal(wording.includesFullEvidence, false);
  assert.doesNotMatch(wording.input, /UNIQUE_VERIFIED_EVIDENCE_PACKET/);
  assert.match(wording.input, /Apple Form 8-K/);
  assert.doesNotMatch(wording.input, /LEAD ANALYST|COUNCIL SEAT|ANSWER 1/);

  const citation = buildWebsiteRepairInput({ ...base, error: "story has uncited factual sentences" });
  assert.equal(citation.includesFullEvidence, true);
  assert.match(citation.input, /UNIQUE_VERIFIED_EVIDENCE_PACKET/);
  assert.doesNotMatch(citation.input, /LEAD ANALYST|COUNCIL SEAT|ANSWER 1/);

  const filedMetric = buildWebsiteRepairInput({
    ...base,
    fields: ["numbersRead"],
    error: "numbersRead declares balance-sheet evidence missing although the filed metric is present",
  });
  assert.equal(filedMetric.includesFullEvidence, true);
  assert.match(filedMetric.input, /validator has confirmed that the named filed metric is present/);
  assert.match(filedMetric.input, /State the available filed metric explicitly/);
  assert.match(filedMetric.input, /composition, maturity, reconciliation or post-quarter detail/);
});

test("email punchline must be a declarative proposition, not a rhetorical question", () => {
  const object = validEmailObject();
  object.subjectPunchline = "Why regulators target the doors Alphabet never opened?";
  object.question = dossierQuestionFromPunchline(String(object.subjectPunchline));
  const result = validateEmailResponse(JSON.stringify(object), evidence, 5, 3, 0, signal);
  assert.ok("error" in result);
  if ("error" in result) assert.match(result.error, /declarative proposition/);
});

test("prior-thesis payoff loop requires honest states and never auto-confirms", () => {
  const missing = validateEmailResponse(JSON.stringify(validEmailObject()), evidence, 5, 3, 0, signal, true);
  assert.ok("error" in missing);
  if ("error" in missing) assert.match(missing.error, /priorUpdate is required/);

  const confirmed = validEmailObject();
  confirmed.priorUpdate = { status: "strengthened", text: `${citedWords(12)} confirmed. [S1]` };
  const rejected = validateEmailResponse(JSON.stringify(confirmed), evidence, 5, 3, 0, signal, true);
  assert.ok("error" in rejected);
  if ("error" in rejected) assert.match(rejected.error, /never auto-confirmed/);

  const open = validEmailObject();
  open.priorUpdate = { status: "open", text: citedWords(14) };
  const accepted = validateEmailResponse(JSON.stringify(open), evidence, 5, 3, 0, signal, true);
  assert.ok("output" in accepted, "error" in accepted ? accepted.error : "missing output");
});

test("prior-thesis certainty normalization preserves citations while demoting false certainty", () => {
  assert.equal(
    normalizePriorUpdateCertainty("New evidence confirms the prior read remains intact. [S1]"),
    "New evidence indicates the prior read remains intact. [S1]",
  );
  assert.equal(
    normalizePriorUpdateCertainty("The prior read has not yet been confirmed by the filing. [S1]"),
    "The prior read remains unresolved by the filing. [S1]",
  );
});

test("ballots use five unique families and one bounded shared evidence packet", () => {
  assert.deepEqual(EMAIL_BALLOT_LANES.map((lane) => lane.family), ["openai", "anthropic", "google", "xai", "deepseek"]);
  for (const lane of EMAIL_BALLOT_LANES) {
    assert.equal(new Set(lane.models.map((model) => model.split("/")[0])).size, 1);
  }
  const signalCase: DossierSignalCase = {
    ...signal,
    mechanism: "The reported earnings quality weakens while the recurring operating bridge remains incomplete. [S1]",
    invalidation: "A clean cash and segment bridge would reverse the read. [S1]",
  };
  const object = validEmailObject();
  const packet = buildBallotEvidencePacket({
    whatChanged: String(object.whatChanged), thesis: String(object.thesis),
    primaryEvidence: String(object.primaryEvidence), secondaryEvidence: object.secondaryEvidence as string[],
  }, signalCase, evidence, {
    claims: [{
      id: "C1", statement: "Filed profit includes a non-operating component.", eventType: "earnings",
      sourceIds: ["S1"], authority: "primary", freshness: "today", relevance: .9, duplicatesCollapsed: 0,
    }],
    deterministicEvidence: [{
      id: "D1", kind: "filed-metric", value: "Net income: $62.58B", period: "2026-03-31",
      sourceIds: ["S1"], recordSha256: "deterministic-hash",
    }],
  });
  assert.match(packet, /COMPACT|directEvidence|sourceRecords/i);
  assert.match(packet, /Apple Form 8-K/);
  assert.match(packet, /Filed profit includes a non-operating component/);
  assert.match(packet, /Net income: \$62\.58B/);
  assert.match(packet, /recordSha256|claimSha256|sourceDocumentId/);
  assert.doesNotMatch(packet, /bulls|bears|numbersRead|full dossier/i);
  assert.ok(packet.length < 12_000);
});

test("model JSON cleanup strips unknown keys locally without replacing valid fields", () => {
  const cleaned = JSON.parse(sanitizeModelJson(JSON.stringify({
    subjectPunchline: "The profit headline hides the real operating test",
    priorUpdate: null,
    whatChanged: citedWords(35),
    thesis: citedWords(60),
    primaryEvidence: citedWords(35),
    secondaryEvidence: [citedWords(20), citedWords(20)],
    priceTarget: 420,
  }), "email-draft"));
  assert.equal(cleaned.priceTarget, undefined);
  assert.equal(cleaned.thesis, citedWords(60));
});

test("public gate catches inflected advice, spelled forecasts and unlabeled destinations", () => {
  for (const prose of [
    "Readers should be buying the shares.",
    "The stock could rise three to six percent over the next two weeks.",
    "The shares may reach $420 within the measured window.",
    "The expected range is $130 to $145.",
    "The price objective is $140.",
    "Our valuation is $140 per share.",
    "The shares are rated outperform.",
    "Avoid GOOGL.",
    "Exit GOOGL.",
    "Reduce GOOGL exposure.",
    "This is a conviction long.",
    "The expected move is eight pct over 10 sessions.",
  ]) assert.ok(publicProseValidationError(prose), prose);
});

test("provider transport and JSON failures return null so a family lane can continue", async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test";
  try {
    globalThis.fetch = async () => { throw new Error("network down"); };
    assert.equal(await callModel("anthropic/one", "system", "input", "test"), null);
    globalThis.fetch = async () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } });
    assert.equal(await callModel("anthropic/one", "system", "input", "test"), null);

    let calls = 0;
    let observedHeaders: Record<string, string | null> = {};
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) throw new Error("first family model unavailable");
      const headers = new Headers(init?.headers);
      observedHeaders = {
        referer: headers.get("HTTP-Referer"),
        title: headers.get("X-Title"),
      };
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        position: "SUPPORT",
        rationale: citedWords(25),
        flipEvidence: citedWords(20),
        fatalContradiction: false,
        contradictionReason: null,
        strength: { novelty: 4, materiality: 4, evidence: 4, asymmetry: 4 },
      }) } }] });
    };
    const packet = buildBallotEvidencePacket({
      whatChanged: citedWords(35), thesis: citedWords(60), primaryEvidence: citedWords(35),
      secondaryEvidence: [citedWords(20), citedWords(20)],
    }, { ...signal, mechanism: citedWords(35), invalidation: citedWords(20) }, evidence);
    const ballot = await castEmailBallot(
      { family: "anthropic", models: ["anthropic/one", "anthropic/two"] } as never,
      { subjectPunchline: "The profit headline hides the real operating test", priorUpdate: null,
        whatChanged: citedWords(35), thesis: citedWords(60), primaryEvidence: citedWords(35), secondaryEvidence: [citedWords(20), citedWords(20)] },
      signal, packet, evidence, evidence,
    );
    assert.equal(ballot?.model, "anthropic/two");
    assert.equal(ballot?.position, "SUPPORT");
    assert.equal(observedHeaders.referer, "https://aftermarketmovers.com");
    assert.equal(observedHeaders.title, "AMM Research Pipeline");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test("structured model calls send an explicit output envelope without changing uncapped research calls", async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test";
  const bodies: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
      });
    };
    assert.ok(await callModel("anthropic/one", "system", "input", "research"));
    assert.ok(await callModel(
      "anthropic/one",
      "system",
      "input",
      "short-copy",
      { maxTokens: 8192 },
    ));
    assert.equal("max_tokens" in bodies[0]!, false);
    assert.equal(bodies[1]!.max_tokens, 8192);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test("ballot field repair cannot change the analyst's original position", async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test";
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(calls === 1 ? {
        position: "SUPPORT", rationale: "too short. [S1]", flipEvidence: "too short. [S1]",
        fatalContradiction: false, contradictionReason: null,
        strength: { novelty: 4, materiality: 4, evidence: 4, asymmetry: 4 },
      } : {
        position: "OPPOSE", rationale: citedWords(25), flipEvidence: citedWords(20),
        fatalContradiction: true, contradictionReason: citedWords(20),
        strength: { novelty: 4, materiality: 4, evidence: 4, asymmetry: 4 },
      }) } }] });
    };
    const packet = buildBallotEvidencePacket({
      whatChanged: citedWords(35), thesis: citedWords(60), primaryEvidence: citedWords(35),
      secondaryEvidence: [citedWords(20), citedWords(20)],
    }, { ...signal, mechanism: citedWords(35), invalidation: citedWords(20) }, evidence);
    const ballot = await castEmailBallot(
      { family: "anthropic", models: ["anthropic/one"] } as never,
      { subjectPunchline: "The profit headline hides the real operating test", priorUpdate: null,
        whatChanged: citedWords(35), thesis: citedWords(60), primaryEvidence: citedWords(35), secondaryEvidence: [citedWords(20), citedWords(20)] },
      signal, packet, evidence, evidence,
    );
    assert.equal(ballot?.position, "SUPPORT");
    assert.equal(ballot?.fatalContradiction, false);
    assert.equal(ballot?.attempts.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});
