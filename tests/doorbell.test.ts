import assert from "node:assert/strict";
import test from "node:test";
import {
  dossierArtifactKey,
  compareHeroRank,
  lifecycleFromSessionDates,
  previousPublishedSignal,
  renderDoorbell,
  renderNoThesisDoorbell,
  unsubToken,
  validUnsubToken,
} from "../src/lib/doorbell";
import {
  buildDossierThesisLifecycle,
  buildRejectedDossierFactualUpdate,
  calculateDossierCitationCoverage,
  dossierReleaseValidationError,
  type Dossier,
  type DossierPriorThesisContext,
} from "../src/lib/dossier";
import type { Desk } from "../src/lib/desk";
import type { ThesisMovementView } from "../src/lib/thesisMovement";
import type { TickerSnapshot } from "../src/lib/ticker";

const desk: Desk = {
  id: "user_doorbell_test",
  email: "reader@example.com",
  tickers: ["GOOGL", "MSFT"],
  createdAt: Date.parse("2026-07-01T00:00:00Z"),
  activity: [],
  noteTime: "07:00",
  tz: "Australia/Brisbane",
};

const cited =
  `Cloud operating income accelerated 34% while capital spending rose. [1 · 2026-07-16]` +
  `(https://www.sec.gov/filing "SEC filing — 2026-07-16")`;

function citedClaim(text: string): string {
  return `${text} [1 · 2026-07-16]` +
    `(https://www.sec.gov/filing "SEC filing — 2026-07-16")`;
}

function dossier(overrides: Record<string, unknown> = {}): Dossier {
  const result = {
    ticker: "GOOGL",
    date: "2026-07-17",
    generatedAt: Date.parse("2026-07-17T00:00:00Z"),
    artifactVersion: 5,
    headline: cited,
    story: Array.from({ length: 24 }, (_, index) => citedClaim(
      `The core synthesis connects cloud demand with the heavier capacity commitment in observation ${index + 1}.`,
    )).join(" "),
    bulls: [
      citedClaim("Enterprise contract growth supports the constructive demand case."),
      citedClaim("Customer expansion adds an independent sign of product adoption."),
      citedClaim("Operating leverage gives the business room to absorb deployment costs."),
    ],
    bears: [
      citedClaim("Long construction lead times leave near-term returns exposed to execution."),
      citedClaim("Capacity arriving before demand would weaken asset productivity."),
      citedClaim("A slower workload mix could defer the expected margin conversion."),
    ],
    risk: Array.from({ length: 14 }, (_, index) => citedClaim(
      `The failure case turns on utilisation, delivery timing and contract durability in risk test ${index + 1}.`,
    )).join(" "),
    numbersRead: Array.from({ length: 14 }, (_, index) => citedClaim(
      `The filed arithmetic separates operating profit, cash generation and investment intensity in bridge ${index + 1}.`,
    )).join(" "),
    signalCase: {
      eventType: "earnings",
      direction: "DOWN",
      strength: "MODERATE",
      horizonSessions: { min: 10, max: 15 },
      mechanism: cited,
      invalidation: cited,
    },
    sources: "SEC",
    emailHook: {
      subjectPunchline: "Cloud acceleration now carries a much heavier bill",
      priorUpdate: { status: "weakened", text: cited },
      whatChanged: cited,
      thesis: cited,
      question: "Is it true that cloud acceleration now carries a much heavier bill?",
      primaryEvidence: cited,
      secondaryEvidence: [cited, cited],
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
        majorityReason: cited,
        dissentReason: cited,
        uncertaintyReason: cited,
        flipCondition: cited,
      },
      oracle: { type: "filing", trigger: cited, dueBy: "2026-11-14" },
      editorialStrength: {
        novelty: 4,
        materiality: 4,
        evidence: 4,
        asymmetry: 3,
        score: 76,
      },
      ...overrides,
    },
    citations: [{
      id: "S1",
      title: "SEC filing",
      url: "https://www.sec.gov/filing",
      publisher: "SEC",
      authority: "primary",
      publishedAt: Date.parse("2026-07-16T20:00:00Z"),
      publishedDate: "2026-07-16",
      retrievedAt: Date.parse("2026-07-16T20:05:00Z"),
      sourceDocumentId: "sec-googl-filing",
    }],
    citationCoverage: { claims: 0, cited: 0, primarySources: 0 },
    briefAuditId: "brief-audit-test",
    councilRunId: "council-run-test",
    seats: 5,
  } as Dossier;
  result.citationCoverage = calculateDossierCitationCoverage(result);
  return result;
}

function continuingDossier(): Dossier {
  const result = dossier();
  result.emailHook = {
    ...result.emailHook,
    priorUpdate: null,
  };
  result.thesisLifecycle = buildDossierThesisLifecycle({
    ticker: result.ticker,
    date: result.date,
    generatedAt: result.generatedAt,
    hook: result.emailHook,
    previousThesis: null,
  });
  result.citationCoverage = calculateDossierCitationCoverage(result);
  return result;
}

const snapshot: TickerSnapshot = {
  symbol: "GOOGL",
  name: "Alphabet Inc.",
  exchange: "NASDAQ",
  price: 354.46,
  previousClose: 370.92,
  dayChangePercent: -4.44,
  afterHoursPrice: 356.98,
  afterHoursChangePercent: 0.68,
  fiftyTwoWeekHigh: 409,
  fiftyTwoWeekLow: 180,
  volume: 41_000_000,
  marketState: "POST",
  nextEvent: "Q2 2026 earnings — Jul 22 after close",
};

const thesisMovement: ThesisMovementView = {
  observations: [
    {
      schemaVersion: 1,
      date: "2026-04-30",
      observedAt: Date.parse("2026-04-30T20:00:00Z"),
      index: 1,
      status: "opened",
      score: -1,
      support: 3,
      oppose: 1,
      uncertain: 1,
      unavailable: 0,
    },
    {
      schemaVersion: 1,
      date: "2026-07-15",
      observedAt: Date.parse("2026-07-15T20:00:00Z"),
      index: 2,
      status: "strengthened",
      score: -1.5,
      support: 3,
      oppose: 1,
      uncertain: 1,
      unavailable: 0,
    },
  ],
  window: {
    startDate: "2026-04-30",
    startLabel: "Q1 2026 RESULTS · APR 30",
    endDate: "2026-07-22",
    endLabel: "Q2 2026 EARNINGS · JUL 22",
  },
  currentScore: -1.5,
  currentLabel: "MODERATE DOWNSIDE",
  currentSupport: 3,
  currentTotal: 5,
};

function withAddress<T>(run: () => T): T {
  const previous = process.env.COMPANY_POSTAL_ADDRESS;
  process.env.COMPANY_POSTAL_ADDRESS = "123 Test Street, Brisbane QLD 4000, Australia";
  try {
    return run();
  } finally {
    if (previous == null) delete process.env.COMPANY_POSTAL_ADDRESS;
    else process.env.COMPANY_POSTAL_ADDRESS = previous;
  }
}

test("doorbell keeps the ritual and renders the exact four-beat proposition", () => {
  const activeDossier = continuingDossier();
  assert.equal(dossierReleaseValidationError(activeDossier), null);
  const note = withAddress(() =>
    renderDoorbell({
      desk,
      hero: activeDossier,
      heroSnapshot: snapshot,
      priorSignal: {
        date: "2026-07-15",
        direction: "UP",
        strength: "GENTLE",
      },
      thesisMovement,
      updates: 2,
      others: ["MSFT"],
      now: new Date("2026-07-16T21:00:00Z"),
    }),
  );

  assert.equal(note.subject, "🦊 GOOGL: Cloud acceleration now carries a much heavier bill");
  assert.match(note.html, /fox-note\.png/);
  assert.match(note.html, /PRE-OPEN ET/);
  assert.doesNotMatch(note.html, /7:00 AM/);
  assert.match(note.html, /tri-on\.png/);
  assert.match(note.html, /#DDD8CB/);
  assert.match(note.html, /WHAT CHANGED TODAY/);
  assert.match(note.html, /ACTIVE THESIS · OPENED APR 30/);
  assert.match(note.html, /OPENED TODAY/);
  assert.match(note.html, /Cloud acceleration now carries a much heavier bill/);
  assert.match(note.html, /NEW EVIDENCE/);
  assert.match(note.html, /ANALYST AGREEMENT/);
  assert.match(note.html, /GENTLE DOWNSIDE/);
  assert.doesNotMatch(note.html, /THESIS MOVEMENT/);
  assert.doesNotMatch(note.html, /CURRENT · GENTLE DOWNSIDE · 3\/5/);
  assert.doesNotMatch(note.html, /MODERATE/);
  assert.doesNotMatch(note.html, /Q1 2026 RESULTS · APR 30/);
  assert.doesNotMatch(note.html, /Q2 2026 EARNINGS · JUL 22/);
  assert.doesNotMatch(note.text, /THESIS MOVEMENT/);
  assert.doesNotMatch(note.html, /width:(?:7|12)px;height:(?:7|12)px;background:#2B4BF2/);
  assert.doesNotMatch(note.html, /border-left:1px solid #B9B4AA/);
  assert.doesNotMatch(note.html, /border-top:1px dotted #DDD8CB/);
  assert.doesNotMatch(note.html, /EXPECTED IMPACT/);
  assert.doesNotMatch(note.html, /Moved from/);
  assert.match(note.html, /CURRENT DIRECTIONAL READ/);
  assert.doesNotMatch(note.html, /UPDATED READ/);
  assert.match(note.html, />1 Signal</);
  assert.doesNotMatch(note.html, /DOWNSIDE[^<]{0,80}%/);
  assert.match(note.html, /3\/5 AGREE/);
  assert.match(note.html, /2 analysts want more evidence/);
  assert.match(note.html, /tri-brand-flat\.png[^>]+title="SUPPORT"/);
  assert.doesNotMatch(note.html, /tri-on\.png" width="16" height="15"/);
  assert.doesNotMatch(note.html, /PRIOR THESIS · WEAKENED/);
  assert.doesNotMatch(note.html, /WHAT TO WATCH/);
  assert.doesNotMatch(note.html, /desk signal/i);
  assert.doesNotMatch(note.html, />Filed</i);
  assert.doesNotMatch(note.html, /MAJORITY|RESERVATION|DISSENT/);
  assert.doesNotMatch(note.html, /alt="▲ SUPPORT"|alt="△ UNCERTAIN"/);
  assert.doesNotMatch(note.html, /href="https:\/\/www\.sec\.gov\/filing"/);
  assert.doesNotMatch(note.html, /sec\.gov\/filing/);
  assert.doesNotMatch(note.text, /sec\.gov\/filing/);
  assert.doesNotMatch(note.html, /\[1 · 2026-07-16\]/);
  assert.match(note.html, /View Full Research in AMM Desk/);
  assert.doesNotMatch(note.html, /Open the Full Dossier/);
  assert.match(note.html, /\/stock\/googl\?utm_source=morning_note/);
  assert.match(note.html, /Evolo Pty Ltd/);
  assert.match(note.html, /123 Test Street/);
  assert.match(note.headers["List-Unsubscribe"], /\/api\/email\/unsub\?/);

  const firstPublished = withAddress(() =>
    renderDoorbell({
      desk,
      hero: dossier(),
      heroSnapshot: snapshot,
      priorSignal: null,
      thesisMovement,
      updates: 2,
      others: ["MSFT"],
      now: new Date("2026-07-16T21:00:00Z"),
    }),
  );
  assert.doesNotMatch(firstPublished.html, /FIRST PUBLISHED/);
  assert.doesNotMatch(firstPublished.html, /no prior published read/i);
  assert.match(firstPublished.html, /CURRENT DIRECTIONAL READ/);
  assert.match(firstPublished.html, /STRONG<br>DOWNSIDE/);
  assert.match(firstPublished.html, /GENTLE<br>DOWNSIDE/);
  assert.match(firstPublished.html, /NEUTRAL/);
  assert.match(firstPublished.html, /GENTLE<br>UPSIDE/);
  assert.match(firstPublished.html, /STRONG<br>UPSIDE/);
  assert.match(firstPublished.html, /tri-brand-flat\.png\?v=2/);
  assert.doesNotMatch(firstPublished.html, /THESIS MOVEMENT/);
  assert.doesNotMatch(firstPublished.html, /CURRENT · GENTLE DOWNSIDE · 3\/5/);
  assert.doesNotMatch(firstPublished.html, /MODERATE/);
  assert.doesNotMatch(firstPublished.html, /EXPECTED IMPACT/);
});

test("a partial desk note names incomplete research without calling it unchanged", () => {
  const note = withAddress(() =>
    renderDoorbell({
      desk,
      hero: dossier(),
      heroSnapshot: snapshot,
      updates: 1,
      others: [],
      researchIncomplete: {
        trackingDate: "2026-07-16",
        tickers: ["MSFT"],
      },
      now: new Date("2026-07-17T13:00:00Z"),
    }),
  );

  const rendered = `${note.subject}\n${note.html}\n${note.text}`;
  assert.match(note.html, /1\/2 stocks/);
  assert.match(note.html, /RESEARCH INCOMPLETE · MSFT/);
  assert.match(rendered, /last valid thesis for each affected company is carried forward as prior research only/);
  assert.match(rendered, /no current-day ruling was produced/);
  assert.doesNotMatch(rendered, /unchanged/i);
});

test("an all-incomplete desk carries the prior thesis as history without inventing a ruling", () => {
  const note = withAddress(() =>
    renderNoThesisDoorbell({
      desk,
      snapshots: [],
      latestValid: {
        ticker: "MSFT",
        date: "2026-07-15",
        thesis: cited,
        votesSupport: 3,
        votesTotal: 5,
        lifecycle: "open",
        sessionsElapsed: 1,
      },
      updates: 0,
      reason: "research-incomplete",
      researchIncomplete: {
        trackingDate: "2026-07-16",
        tickers: ["GOOGL", "MSFT"],
      },
      now: new Date("2026-07-17T13:00:00Z"),
    }),
  );

  const rendered = `${note.subject}\n${note.html}\n${note.text}`;
  assert.match(note.subject, /research incomplete for GOOGL, MSFT; prior thesis carried forward/i);
  assert.match(rendered, /RESEARCH INCOMPLETE · GOOGL · MSFT/);
  assert.match(rendered, /0\/2 stocks completed/);
  assert.match(rendered, /MSFT · 2026-07-15 · 3\/5 SUPPORT/);
  assert.match(rendered, /prior research only/);
  assert.match(rendered, /no current-day ruling was produced/);
  assert.doesNotMatch(rendered, /unchanged/i);
});

test("doorbell omits thesis movement history even when observations are supplied", () => {
  const lateMovement: ThesisMovementView = {
    ...thesisMovement,
    observations: [{
      ...thesisMovement.observations[0],
      date: "2026-07-20",
      score: -1.5,
    }],
    currentScore: -1.5,
  };
  const note = withAddress(() =>
    renderDoorbell({
      desk,
      hero: continuingDossier(),
      heroSnapshot: snapshot,
      priorSignal: null,
      thesisMovement: lateMovement,
      updates: 1,
      others: [],
      now: new Date("2026-07-20T21:00:00Z"),
    }),
  );
  assert.doesNotMatch(note.html, /THESIS MOVEMENT/);
  assert.doesNotMatch(note.html, /Q1 2026 RESULTS · APR 30/);
  assert.doesNotMatch(note.html, /Q2 2026 EARNINGS · JUL 22/);
});

test("doorbell keeps unchanged thesis history out of the compact email", () => {
  const earlyMovement: ThesisMovementView = {
    observations: [
      {
        ...thesisMovement.observations[0],
        date: "2026-07-23",
        score: -1,
      },
      {
        ...thesisMovement.observations[1],
        date: "2026-07-25",
        score: -1,
      },
    ],
    window: {
      startDate: "2026-07-23",
      startLabel: "Q1 2026 RESULTS · JUL 23",
      endDate: "2026-10-29",
      endLabel: "NEXT RESULTS · DATE PENDING",
    },
    currentScore: -1,
    currentLabel: "GENTLE DOWNSIDE",
    currentSupport: 3,
    currentTotal: 5,
  };
  const note = withAddress(() =>
    renderDoorbell({
      desk,
      hero: continuingDossier(),
      heroSnapshot: snapshot,
      priorSignal: null,
      thesisMovement: earlyMovement,
      updates: 1,
      others: [],
      now: new Date("2026-07-25T21:00:00Z"),
    }),
  );
  assert.doesNotMatch(note.html, /THESIS MOVEMENT/);
  assert.doesNotMatch(note.html, /2 OBSERVATIONS · UNCHANGED/);
  assert.doesNotMatch(note.html, /NEXT RESULTS · DATE PENDING/);
});

test("doorbell strips complete source links before sentence compaction", () => {
  const sourceWithSentence =
    `Amazon fell with its peers while its own report remained several days away. ` +
    `[2 · 2026-07-16](https://www.sec.gov/filing-2 ` +
    `"Amazon Fell Today. It Reports Next Week. — 2026-07-16")`;
  const hero = dossier({ whatChanged: sourceWithSentence });
  hero.citations = [...(hero.citations ?? []), {
    id: "S2",
    title: "Amazon Fell Today. It Reports Next Week.",
    url: "https://www.sec.gov/filing-2",
    publisher: "SEC",
    authority: "primary",
    publishedAt: Date.parse("2026-07-16T20:00:00Z"),
    publishedDate: "2026-07-16",
    retrievedAt: Date.parse("2026-07-16T20:05:00Z"),
    sourceDocumentId: "sec-amzn-filing",
  }];
  hero.citationCoverage = calculateDossierCitationCoverage(hero);
  const note = withAddress(() =>
    renderDoorbell({
      desk,
      hero,
      heroSnapshot: snapshot,
      updates: 1,
      others: [],
    }),
  );
  assert.match(note.html, /Amazon fell with its peers while its own report remained several days away\./);
  assert.doesNotMatch(note.html, /Amazon Fell Today/);
  assert.doesNotMatch(note.html, /sec\.gov\/filing/);
  assert.doesNotMatch(note.text, /sec\.gov\/filing/);
});

test("hero ranking puts council agreement ahead of editorial punchiness", () => {
  const ranked = [
    { ticker: "AMD", date: "2026-07-24", votesSupport: 3, votesOppose: 0, editorialStrength: 60, absoluteMove: 0.7 },
    { ticker: "MSFT", date: "2026-07-24", votesSupport: 5, votesOppose: 0, editorialStrength: 59, absoluteMove: 0.1 },
  ].sort(compareHeroRank);
  assert.equal(ranked[0].ticker, "MSFT");
});

test("hero ranking never promotes an older stronger ballot above fresher research", () => {
  const ranked = [
    { ticker: "NVDA", date: "2026-07-23", votesSupport: 5, votesOppose: 0, editorialStrength: 95, absoluteMove: 8.1 },
    { ticker: "AMZN", date: "2026-07-24", votesSupport: 3, votesOppose: 1, editorialStrength: 62, absoluteMove: 0.7 },
  ].sort(compareHeroRank);
  assert.equal(ranked[0].ticker, "AMZN");
});

test("doorbell refuses recommendation language before delivery", () => {
  assert.throws(
    () =>
      withAddress(() =>
        renderDoorbell({
          desk,
          hero: dossier({ thesis: "Readers should buy this security now." }),
          heroSnapshot: snapshot,
          updates: 1,
          others: [],
        }),
      ),
    /v5 hook|recommendation language/,
  );
});

test("failed gates produce an honest fixed-format note and carry the last valid thesis", () => {
  const previousDossier = dossier();
  const previousThesis: DossierPriorThesisContext = {
    lifecycleId: "c".repeat(48),
    openedDate: "2026-07-16",
    openedAt: Date.parse("2026-07-16T00:00:00Z"),
    observationIndex: 1,
    date: "2026-07-16",
    subjectPunchline: previousDossier.emailHook.subjectPunchline,
    thesis: previousDossier.emailHook.thesis,
    canonicalSignal: previousDossier.emailHook.signal,
    signal: previousDossier.emailHook.signal,
    question: previousDossier.emailHook.question,
    flipCondition: previousDossier.emailHook.confidence.flipCondition,
    oracle: previousDossier.emailHook.oracle,
    votes: { ...previousDossier.emailHook.votes, total: 5 },
    state: "open",
    outcomeContext: {
      status: "unresolved",
      asOfDate: "2026-07-16",
      note: "The active thesis remains unresolved.",
    },
  };
  const factualUpdate = buildRejectedDossierFactualUpdate({
    ticker: "GOOGL",
    date: "2026-07-17",
    generatedAt: Date.parse("2026-07-17T00:00:00Z"),
    rejectionAuditId: "a".repeat(48),
    compactWhatChanged: "Cloud operating income accelerated while capital spending rose. [S1]",
    evidence: dossier().citations!,
    rejected: {
      key: "rejected-key",
      propositionSha256: "b".repeat(64),
      rejectedAt: Date.parse("2026-07-17T00:00:00Z"),
      votesSupport: 2,
      votesOppose: 2,
      votesUncertain: 1,
      reason: "minority-support",
      ballotResponseSha256: [],
    },
    previousThesis,
    compactPriorUpdate: {
      status: "weakened",
      text: "The new spending evidence weakens the standing cash-coverage thesis today. [S1]",
    },
  });
  const note = withAddress(() =>
    renderNoThesisDoorbell({
      desk,
      snapshots: [snapshot],
      factualUpdates: [factualUpdate],
      latestValid: {
        ticker: "GOOGL",
        date: "2026-07-16",
        thesis: cited,
        votesSupport: 3,
        votesTotal: 5,
        lifecycle: "open",
        sessionsElapsed: 4,
      },
      updates: 2,
      reason: "publication-gate",
      now: new Date("2026-07-16T21:00:00Z"),
    }),
  );

  assert.match(note.subject, /no new directional read; prior thesis remains on file/i);
  assert.match(note.html, /NO NEW THESIS CLEARED 3\/5/);
  assert.match(note.html, /Cloud operating income accelerated/);
  assert.match(note.html, /href="https:\/\/www\.sec\.gov\/filing"/);
  assert.match(note.html, /LATEST VALID THESIS · OPEN/);
  assert.match(note.html, /did not admit a new directional state/);
  assert.doesNotMatch(note.html, /new spending evidence weakens/);
  assert.match(note.html, /did not pass the evidence checks/);
  assert.doesNotMatch(note.html, /Fewer than three of five analysts/);
  assert.match(note.html, /GOOGL closed at \$354\.46/);
  assert.match(note.html, /\/stock\/googl\?utm_source=morning_note/);
  assert.doesNotMatch(note.html, /(?:GENTLE|MODERATE|STRONG) (?:UP|DOWN)SIDE/);
});

test("unsubscribe tokens remain compatible and reject tampering", () => {
  const previous = {
    cron: process.env.CRON_TOKEN,
    unsubscribe: process.env.UNSUBSCRIBE_SECRET,
  };
  process.env.CRON_TOKEN = "test-cron-secret";
  try {
    delete process.env.UNSUBSCRIBE_SECRET;
    const legacy = unsubToken(desk.id);
    process.env.UNSUBSCRIBE_SECRET = "dedicated-unsubscribe-secret";
    const token = unsubToken(desk.id);
    assert.equal(validUnsubToken(desk.id, token), true);
    assert.equal(validUnsubToken(desk.id, legacy), true, "old CRON_TOKEN links remain valid during migration");
    const replacement = token.endsWith("0") ? "1" : "0";
    assert.equal(validUnsubToken(desk.id, `${token.slice(0, -1)}${replacement}`), false);
    assert.equal(validUnsubToken("user_different", token), false);
  } finally {
    if (previous.cron == null) delete process.env.CRON_TOKEN;
    else process.env.CRON_TOKEN = previous.cron;
    if (previous.unsubscribe == null) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = previous.unsubscribe;
  }
});

test("prior thesis lifecycle is based on observed market sessions", () => {
  const dates = [
    "2026-07-01", "2026-07-02", "2026-07-06", "2026-07-07", "2026-07-08",
    "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14", "2026-07-15",
    "2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21", "2026-07-22",
    "2026-07-23",
  ];
  assert.deepEqual(lifecycleFromSessionDates("2026-07-01", dates.slice(0, 15)), {
    lifecycle: "open",
    sessionsElapsed: 14,
  });
  assert.deepEqual(lifecycleFromSessionDates("2026-07-01", dates), {
    lifecycle: "expired",
    sessionsElapsed: 15,
  });
  assert.deepEqual(lifecycleFromSessionDates("2026-07-01", [], false), {
    lifecycle: "unknown",
    sessionsElapsed: null,
  });
  assert.deepEqual(lifecycleFromSessionDates("2026-07-01", dates, true), {
    lifecycle: "resolved",
    sessionsElapsed: null,
  });
});

test("prior signal markers come only from an earlier publishable public dossier", () => {
  const current = {
    ...dossier(),
    date: "2026-07-18",
    generatedAt: Date.parse("2026-07-18T00:00:00Z"),
  };
  const validEarlier = dossier();
  const laterButRejected = {
    ...dossier({ votesSupport: 2, votesOppose: 2, votesUncertain: 1 }),
    date: "2026-07-17",
    generatedAt: Date.parse("2026-07-17T12:00:00Z"),
  };

  assert.deepEqual(previousPublishedSignal(current, [laterButRejected, validEarlier]), {
    date: "2026-07-17",
    direction: "DOWN",
    strength: "MODERATE",
  });
  assert.equal(previousPublishedSignal(validEarlier, [current]), null);
});

test("dossier artifact keys distinguish versions and generations", () => {
  const first = dossier();
  const second = { ...first, generatedAt: first.generatedAt + 1 };
  assert.notEqual(dossierArtifactKey(first), dossierArtifactKey(second));
  assert.match(dossierArtifactKey(first), /^dossier-v5:GOOGL:/);
});
