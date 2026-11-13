import assert from "node:assert/strict";
import test from "node:test";
import {
  assessDailyShort,
  dailyShortSelectionValidationError,
  dailyShortArtifactKey,
  evaluateDailyShortFleetGate,
  evaluateDailyShortReadiness,
  selectDailyShorts,
} from "../src/lib/dailyShorts";
import {
  calculateDossierCitationCoverage,
  type Dossier,
} from "../src/lib/dossier";

const filingUrl = "https://www.sec.gov/filing";
const companyUrl = "https://investor.example.com/results";

function cite(text: string): string {
  return `${text} [1 · 2026-07-23](${filingUrl} "SEC 10-Q filing — 2026-07-23")`;
}

function companyCite(text: string): string {
  return `${text} [2 · 2026-07-23](${companyUrl} "Investor results — 2026-07-23")`;
}

export function dossier(
  ticker: string,
  overrides: {
    support?: number;
    oppose?: number;
    uncertain?: number;
    score?: number;
    novelty?: number;
    materiality?: number;
    evidence?: number;
    asymmetry?: number;
    date?: string;
  } = {},
): Dossier {
  const support = overrides.support ?? 4;
  const oppose = overrides.oppose ?? 0;
  const uncertain = overrides.uncertain ?? 5 - support - oppose;
  const novelty = overrides.novelty ?? 4;
  const materiality = overrides.materiality ?? 4;
  const evidence = overrides.evidence ?? 4;
  const asymmetry = overrides.asymmetry ?? 4;
  const score = overrides.score ??
    Math.round(((novelty * .30) + (materiality * .25) + (evidence * .25) + (asymmetry * .20)) / 5 * 100);
  const repeated = (label: string, count: number) =>
    Array.from({ length: count }, (_, index) => cite(`${label} ${index + 1} remains grounded in the admitted filing.`)).join(" ");
  const value = {
    ticker,
    date: overrides.date ?? "2026-07-23",
    generatedAt: Date.parse("2026-07-23T02:00:00Z") + ticker.charCodeAt(0),
    artifactVersion: 5,
    headline: cite("A new operating development changed the evidence balance."),
    story: repeated("The company story observation", 24),
    bulls: [
      cite("Operating progress supports the constructive mechanism."),
      cite("Customer activity corroborates the operating change."),
      cite("Cash generation gives the company room to execute."),
    ],
    bears: [
      cite("Execution risk can still weaken the mechanism."),
      cite("Demand could arrive later than the spending programme."),
      cite("A weaker mix would pressure the operating bridge."),
    ],
    risk: repeated("The principal risk test", 14),
    numbersRead: repeated("The filed arithmetic bridge", 14),
    signalCase: {
      eventType: "earnings",
      direction: "UP",
      strength: "GENTLE",
      horizonSessions: { min: 10, max: 15 },
      mechanism: cite("The operating change can support the shares over the fixed horizon."),
      invalidation: cite("The next filing can invalidate the mechanism."),
    },
    sources: "SEC; company investor relations",
    citations: [
      {
        id: "S1",
        title: "SEC 10-Q filing",
        url: filingUrl,
        publisher: "SEC",
        authority: "primary",
        publishedAt: Date.parse("2026-07-23T00:00:00Z"),
        publishedDate: "2026-07-23",
        retrievedAt: Date.parse("2026-07-23T00:05:00Z"),
        sourceDocumentId: "sec-test",
      },
      {
        id: "S2",
        title: "Investor results",
        url: companyUrl,
        publisher: "Company investor relations",
        authority: "company",
        publishedAt: Date.parse("2026-07-23T00:00:00Z"),
        publishedDate: "2026-07-23",
        retrievedAt: Date.parse("2026-07-23T00:05:00Z"),
        sourceDocumentId: "company-test",
      },
    ],
    citationCoverage: { claims: 0, cited: 0, primarySources: 0 },
    briefAuditId: `brief-${ticker}`,
    councilRunId: `council-${ticker}`,
    emailHook: {
      subjectPunchline: "Operating evidence now outweighs the headline concern",
      priorUpdate: null,
      whatChanged: cite("A new operating development changed the evidence balance."),
      thesis: cite("The operating evidence now supports the shares over the fixed horizon."),
      question: "Is it true that operating evidence now outweighs the headline concern?",
      primaryEvidence: cite("Cash generation directly supports the mechanism."),
      secondaryEvidence: [
        cite("Revenue growth corroborates the operating change."),
        companyCite("Balance-sheet capacity supports execution."),
      ],
      signal: {
        eventType: "earnings",
        direction: "UP",
        strength: "GENTLE",
        horizonSessions: { min: 10, max: 15 },
      },
      votesSupport: support,
      votesOppose: oppose,
      votesUncertain: uncertain,
      votesTotal: 5,
      votes: { support, oppose, uncertain },
      confidence: {
        majorityReason: cite("The majority relies on operating cash and reported growth."),
        dissentReason: oppose ? cite("The opposing analyst needs fresher company evidence.") : null,
        uncertaintyReason: uncertain ? cite("The uncertain analyst needs confirmation in the next filing.") : null,
        flipCondition: cite("A weaker next filing would retire the thesis."),
      },
      oracle: {
        type: "filing",
        trigger: cite("A weaker next filing would retire the thesis."),
        dueBy: "2026-11-20",
      },
      editorialStrength: { novelty, materiality, evidence, asymmetry, score },
    },
    seats: 5,
  } as Dossier;
  value.thesisLifecycle = {
    schemaVersion: 1,
    id: "a".repeat(48),
    openedDate: "2026-07-20",
    openedAt: Date.parse("2026-07-20T02:00:00Z"),
    observationDate: value.date,
    observationIndex: 4,
    observationStatus: "open",
    canonicalSubjectPunchline: value.emailHook.subjectPunchline,
    canonicalThesis: value.emailHook.thesis,
    canonicalQuestion: value.emailHook.question,
    canonicalSignal: value.emailHook.signal,
    canonicalOracle: value.emailHook.oracle,
    canonicalVotes: {
      support: value.emailHook.votesSupport,
      oppose: value.emailHook.votesOppose,
      uncertain: value.emailHook.votesUncertain,
      total: 5,
    },
    latestSignal: value.emailHook.signal,
  };
  value.citationCoverage = calculateDossierCitationCoverage(value);
  return value;
}

test("daily Shorts uses recognizable-stock priors only during audience-data cold start", () => {
  const nvda = dossier("NVDA", { support: 5 });
  const meta = dossier("META", { support: 4, novelty: 5 });
  const aapl = dossier("AAPL", { support: 4 });
  const result = selectDailyShorts({
    dossiers: [aapl, meta, nvda],
    date: "2026-07-23",
  });
  assert.deepEqual(
    result.selected.map((item) => item.ticker),
    ["NVDA", "AAPL"],
    JSON.stringify(result.assessments.map(({ ticker, reasons }) => ({ ticker, reasons }))),
  );
  assert.equal(result.selected.length, 2);
});

test("novelty ranks the pair but cannot veto an evidence-cleared second Short", () => {
  const novel = dossier("GOOGL", { support: 3, novelty: 5, asymmetry: 5 });
  const lessNovel = dossier("MSFT", { support: 3, novelty: 2, asymmetry: 2, score: 60 });
  const result = selectDailyShorts({
    dossiers: [lessNovel, novel],
    date: "2026-07-23",
    audienceSignals: new Map([
      ["GOOGL", {
        ticker: "GOOGL",
        currentInterest: 50,
        historicalEngagement: 50,
        demandAcceleration: 50,
        conversionIntent: 50,
        sampleSize: 1,
      }],
      ["MSFT", {
        ticker: "MSFT",
        currentInterest: 50,
        historicalEngagement: 50,
        demandAcceleration: 50,
        conversionIntent: 50,
        sampleSize: 1,
      }],
    ]),
  });

  assert.deepEqual(result.selected.map((item) => item.ticker), ["GOOGL", "MSFT"]);
  assert.equal(result.selected[1].eligible, true);
  assert.equal(result.selected[1].reasons.length, 0);
  assert.equal(result.rules.noveltyRole, "ranking-only");
  assert.equal(result.rules.asymmetryRole, "ranking-only");
});

test("selection admits every supported US-stock dossier but refuses weak research", () => {
  const releasedMajority = assessDailyShort(dossier("NVDA", { support: 3 }), "2026-07-23");
  assert.equal(releasedMajority.eligible, true);

  const lowConfidence = assessDailyShort(
    dossier("NVDA", { support: 2, oppose: 1 }),
    "2026-07-23",
  );
  assert.equal(lowConfidence.eligible, false);
  assert.match(lowConfidence.reasons.join(" "), /only 2\/5/);

  const lowValue = assessDailyShort(
    dossier("META", { novelty: 2, materiality: 3, evidence: 3, asymmetry: 3, score: 40 }),
    "2026-07-23",
  );
  assert.equal(lowValue.eligible, false);
  assert.match(lowValue.reasons.join(" "), /editorial strength/);

  const unknown = assessDailyShort(dossier("XYZ"), "2026-07-23");
  assert.equal(unknown.eligible, true);
  assert.equal(unknown.reasons.length, 0);
});

test("measured audience demand can outrank the recognizable-stock cold-start prior", () => {
  const result = selectDailyShorts({
    dossiers: [dossier("NVDA"), dossier("XYZ"), dossier("META")],
    date: "2026-07-23",
    audienceSignals: new Map([
      ["NVDA", {
        ticker: "NVDA",
        currentInterest: 40,
        historicalEngagement: 40,
        demandAcceleration: 40,
        conversionIntent: 40,
        sampleSize: 8,
      }],
      ["XYZ", {
        ticker: "XYZ",
        currentInterest: 100,
        historicalEngagement: 95,
        demandAcceleration: 100,
        conversionIntent: 90,
        sampleSize: 3,
      }],
      ["META", {
        ticker: "META",
        currentInterest: 60,
        historicalEngagement: 65,
        demandAcceleration: 55,
        conversionIntent: 60,
        sampleSize: 5,
      }],
    ]),
  });

  assert.deepEqual(result.selected.map((item) => item.ticker), ["XYZ", "META"]);
  assert.equal(result.selected[0].selectionRole, "audience-magnet");
  assert.equal(result.selected[1].selectionRole, "breakout-opportunity");
  assert.equal(result.selected[0].ranking.usedMeasuredAudience, true);
});

test("fatigue blocks a third appearance in five trading days unless the thesis materially changed", () => {
  const history = [
    { ticker: "NVDA", publicationDate: "2026-07-21" },
    { ticker: "NVDA", publicationDate: "2026-07-22" },
  ];
  const unchanged = dossier("NVDA");
  const blocked = assessDailyShort(unchanged, "2026-07-23", new Set(), {
    publicationHistory: history,
  });
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join(" "), /already appeared 2 times/);

  const changed = dossier("NVDA");
  changed.thesisLifecycle!.observationStatus = "strengthened";
  const admitted = assessDailyShort(changed, "2026-07-23", new Set(), {
    publicationHistory: history,
  });
  assert.equal(admitted.eligible, true);
  assert.equal(admitted.ranking.fatiguePenalty, 0);
});

test("the production contract rejects a partial trading-day pair", () => {
  const complete = selectDailyShorts({
    dossiers: [dossier("NVDA"), dossier("META")],
    date: "2026-07-23",
  });
  assert.equal(dailyShortSelectionValidationError(complete), null);

  const partial = selectDailyShorts({
    dossiers: [dossier("NVDA")],
    date: "2026-07-23",
  });
  assert.match(
    dailyShortSelectionValidationError(partial) ?? "",
    /requires exactly 2 evidence-cleared stocks; 1 qualified/,
  );
});

test("a qualified pair cannot hide incomplete followed-stock tracking", () => {
  const selection = selectDailyShorts({
    dossiers: [dossier("GOOGL"), dossier("MSFT")],
    date: "2026-07-23",
  });
  const decision = evaluateDailyShortFleetGate({
    selection,
    pendingTickers: ["pltr", "META", "pltr"],
  });

  assert.deepEqual(decision, {
    mayProceed: false,
    partialFleet: true,
    excludedPendingTickers: ["META", "PLTR"],
    error: "daily tracking incomplete for META, PLTR",
  });
});

test("readiness keeps waiting for the full followed-stock fleet after a pair qualifies", () => {
  const selection = selectDailyShorts({
    dossiers: [dossier("GOOGL"), dossier("INTC")],
    date: "2026-07-23",
  });
  const decision = evaluateDailyShortReadiness({
    selection,
    pendingTickers: ["PLTR", "QCOM"],
    deadlineReached: false,
  });

  assert.deepEqual(decision, {
    shouldFinishWaiting: false,
    reason: "waiting",
    selectionError: null,
  });
});

test("readiness waits for a second qualified dossier without weakening the gate", () => {
  const selection = selectDailyShorts({
    dossiers: [dossier("GOOGL")],
    date: "2026-07-23",
  });
  const waiting = evaluateDailyShortReadiness({
    selection,
    pendingTickers: ["INTC"],
    deadlineReached: false,
  });
  const expired = evaluateDailyShortReadiness({
    selection,
    pendingTickers: ["INTC"],
    deadlineReached: true,
  });

  assert.equal(waiting.shouldFinishWaiting, false);
  assert.equal(waiting.reason, "waiting");
  assert.match(waiting.selectionError ?? "", /1 qualified/);
  assert.equal(expired.shouldFinishWaiting, true);
  assert.equal(expired.reason, "deadline");
  assert.match(expired.selectionError ?? "", /1 qualified/);
});

test("pending tickers never lower the exact-two quality gate", () => {
  const selection = selectDailyShorts({
    dossiers: [dossier("GOOGL")],
    date: "2026-07-23",
  });
  const decision = evaluateDailyShortFleetGate({
    selection,
    pendingTickers: ["MSFT", "META"],
  });

  assert.equal(decision.mayProceed, false);
  assert.equal(decision.partialFleet, true);
  assert.match(
    decision.error ?? "",
    /requires exactly 2 evidence-cleared stocks; 1 qualified; daily tracking incomplete for META, MSFT/,
  );
});

test("selection refuses a dossier that cannot prove continuous-thesis lineage", () => {
  const legacy = dossier("META");
  delete legacy.thesisLifecycle;
  const assessment = assessDailyShort(legacy, "2026-07-23");
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reasons.join(" "), /continuous-thesis lifecycle receipt/);
});

test("the exact dossier cannot be published twice", () => {
  const meta = dossier("META");
  const key = dailyShortArtifactKey(meta);
  const result = selectDailyShorts({
    dossiers: [meta],
    date: "2026-07-23",
    alreadyPublishedArtifactKeys: new Set([key]),
  });
  assert.equal(result.selected.length, 0);
  assert.match(result.assessments[0].reasons.join(" "), /already published/);
});
