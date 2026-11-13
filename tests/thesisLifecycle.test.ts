import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDossierThesisLifecycle,
  priorThesisContextWithRejectedReviews,
  shouldIssuePrivateSignalForDossier,
  thesisContinuityValidationError,
  type Dossier,
  type DossierEmailHook,
  type DossierPriorThesisContext,
  type RejectedDossierFactualUpdate,
} from "../src/lib/dossier";

function hook(overrides: Partial<DossierEmailHook> = {}): DossierEmailHook {
  const subjectPunchline = overrides.subjectPunchline ?? "Cloud demand now funds the capacity build";
  const signal = overrides.signal ?? {
    eventType: "earnings" as const,
    direction: "UP" as const,
    strength: "GENTLE" as const,
    horizonSessions: { min: 10 as const, max: 15 as const },
  };
  const flipCondition = "A later filing showing cash below capital spending would defeat the read. [S1]";
  return {
    subjectPunchline,
    priorUpdate: null,
    whatChanged: "The company published a new quarterly filing with updated cash-flow figures. [S1]",
    thesis: "The verified change is more likely to support the shares over the next 10-15 sessions because cash covers the build. [S1]",
    question: `Is it true that ${subjectPunchline.charAt(0).toLowerCase()}${subjectPunchline.slice(1)}?`,
    primaryEvidence: "Operating cash flow covered capital spending and left a positive remainder in the filed quarter. [S1]",
    secondaryEvidence: [
      "Revenue and operating income both increased in the filed quarter. [S1]",
      "Cash remained above debt at the reported period end. [S1]",
    ],
    signal,
    votesSupport: 4,
    votesOppose: 0,
    votesUncertain: 1,
    votesTotal: 5,
    votes: { support: 4, oppose: 0, uncertain: 1 },
    confidence: {
      majorityReason: "Four analysts support the cash-coverage mechanism. [S1]",
      dissentReason: null,
      uncertaintyReason: "One analyst awaits a second quarter of evidence. [S1]",
      flipCondition,
    },
    oracle: { type: "filing", trigger: flipCondition, dueBy: "2026-11-21" },
    editorialStrength: { novelty: 4, materiality: 4, evidence: 4, asymmetry: 3, score: 76 },
    ...overrides,
  };
}

function prior(): DossierPriorThesisContext {
  const active = hook();
  return {
    lifecycleId: "a".repeat(48),
    openedDate: "2026-07-23",
    openedAt: 1_721_692_800_000,
    observationIndex: 1,
    date: "2026-07-23",
    subjectPunchline: active.subjectPunchline,
    thesis: active.thesis,
    canonicalSignal: active.signal,
    signal: active.signal,
    question: active.question,
    flipCondition: active.confidence.flipCondition,
    oracle: active.oracle,
    votes: { ...active.votes, total: 5 },
    state: "open",
    outcomeContext: {
      status: "unresolved",
      asOfDate: "2026-07-23",
      note: "The active thesis remains unresolved.",
    },
  };
}

function rejectedReview(input: {
  date: string;
  index: number;
  lifecycleId?: string;
  openedDate?: string;
  subjectPunchline?: string;
  status?: "open" | "weakened" | "replaced" | "invalidated";
}): RejectedDossierFactualUpdate {
  const previous = prior();
  return {
    schema: "rejected-dossier-factual-update-v1",
    ticker: "MSFT",
    date: input.date,
    generatedAt: Date.parse(`${input.date}T13:00:00Z`),
    rejectionAuditId: input.date.replaceAll("-", "").padEnd(48, "a"),
    compactWhatChanged: "The daily evidence changed but no directional proposition cleared.",
    whatChanged: "The daily evidence changed but no directional proposition cleared.",
    citations: [],
    votesSupport: 2,
    votesOppose: 1,
    votesUncertain: 2,
    votesUnavailable: 0,
    reason: "minority-support",
    thesisObservation: {
      lifecycleId: input.lifecycleId ?? previous.lifecycleId,
      openedDate: input.openedDate ?? previous.openedDate,
      observationIndex: input.index,
      status: input.status ?? "open",
      subjectPunchline: input.subjectPunchline ?? previous.subjectPunchline,
      signal: previous.signal,
      compactUpdateText: "The prior thesis did not receive an admitted directional update.",
      updateText: "The prior thesis did not receive an admitted directional update.",
    },
    contentSha256: "b".repeat(64),
  };
}

test("an open daily observation keeps one lifecycle and does not open another forecast", () => {
  const previous = prior();
  const current = hook({
    priorUpdate: { status: "open", text: "The standing cash-coverage thesis remains open after the latest filing. [S1]" },
  });
  assert.equal(thesisContinuityValidationError(current, previous), null);
  const lifecycle = buildDossierThesisLifecycle({
    ticker: "MSFT",
    date: "2026-07-24",
    generatedAt: 1_721_779_200_000,
    hook: current,
    previousThesis: previous,
  });
  assert.equal(lifecycle.id, previous.lifecycleId);
  assert.equal(lifecycle.openedDate, previous.openedDate);
  assert.equal(lifecycle.observationIndex, 2);
  assert.equal(lifecycle.observationStatus, "open");
  assert.equal(
    shouldIssuePrivateSignalForDossier({ thesisLifecycle: lifecycle } as Dossier),
    false,
  );
});

test("continuing a thesis rejects silent proposition, direction, and strength resets", () => {
  const previous = prior();
  const renamed = hook({
    subjectPunchline: "A different headline becomes the daily proposition",
    priorUpdate: { status: "open", text: "The standing thesis remains open against the current evidence. [S1]" },
  });
  assert.match(thesisContinuityValidationError(renamed, previous) ?? "", /canonical subjectPunchline/);

  const reversed = hook({
    priorUpdate: { status: "weakened", text: "New contrary evidence weakens the standing cash-coverage thesis today. [S1]" },
    signal: { ...previous.signal, direction: "DOWN" },
  });
  assert.match(thesisContinuityValidationError(reversed, previous) ?? "", /cannot reverse direction/);

  const silentlyStronger = hook({
    priorUpdate: { status: "open", text: "The standing thesis remains open against the current evidence. [S1]" },
    signal: { ...previous.signal, strength: "MODERATE" },
  });
  assert.match(thesisContinuityValidationError(silentlyStronger, previous) ?? "", /must keep its canonical strength/);
});

test("an unchanged observation compares with the latest admitted strength, not the original forecast", () => {
  const previous = prior();
  previous.canonicalSignal = { ...previous.signal, strength: "GENTLE" };
  previous.signal = { ...previous.signal, strength: "MODERATE" };
  previous.observationIndex = 2;
  const current = hook({
    priorUpdate: { status: "open", text: "The strengthened thesis remains open against the latest evidence. [S1]" },
    signal: { ...previous.signal },
  });
  assert.equal(thesisContinuityValidationError(current, previous), null);
  const lifecycle = buildDossierThesisLifecycle({
    ticker: "MSFT",
    date: "2026-07-25",
    generatedAt: 1_721_865_600_000,
    hook: current,
    previousThesis: previous,
  });
  assert.equal(lifecycle.canonicalSignal.strength, "GENTLE");
  assert.equal(lifecycle.latestSignal.strength, "MODERATE");
  assert.equal(lifecycle.observationIndex, 3);
});

test("rejected reviews advance the cursor without mutating the admitted thesis", () => {
  const accepted = prior();
  accepted.observationIndex = 2;
  accepted.signal = { ...accepted.signal, strength: "MODERATE" };
  const acceptedSnapshot = structuredClone(accepted);
  const reviewed = priorThesisContextWithRejectedReviews(accepted, [
    rejectedReview({ date: "2026-07-24", index: 3, status: "weakened" }),
    // This stale index reproduces the former cached-dossier-only bug. The
    // chronological fold must still count both completed reviews.
    rejectedReview({ date: "2026-07-25", index: 3, status: "replaced" }),
    rejectedReview({ date: "2026-07-26", index: 9, lifecycleId: "f".repeat(48) }),
  ]);

  assert.equal(reviewed.observationIndex, 4);
  assert.equal(reviewed.date, acceptedSnapshot.date, "accepted artifact date remains canonical");
  assert.deepEqual(reviewed.signal, acceptedSnapshot.signal);
  assert.deepEqual(reviewed.canonicalSignal, acceptedSnapshot.canonicalSignal);
  assert.equal(reviewed.subjectPunchline, acceptedSnapshot.subjectPunchline);
  assert.equal(reviewed.outcomeContext.asOfDate, "2026-07-25");
  assert.match(reviewed.outcomeContext.note, /without enough support to admit/);

  const next = buildDossierThesisLifecycle({
    ticker: "MSFT",
    date: "2026-07-27",
    generatedAt: Date.parse("2026-07-27T13:00:00Z"),
    hook: hook({
      priorUpdate: { status: "open", text: "The standing thesis remains open against the current evidence. [S1]" },
      signal: reviewed.signal,
    }),
    previousThesis: reviewed,
  });
  assert.equal(next.id, accepted.lifecycleId);
  assert.equal(next.observationIndex, 5);
  assert.equal(next.previousLifecycle, undefined);
  assert.equal(shouldIssuePrivateSignalForDossier({ thesisLifecycle: next } as Dossier), false);
});

test("explicit replacement closes the old lifecycle and opens exactly one new forecast", () => {
  const previous = prior();
  const replacement = hook({
    subjectPunchline: "Guidance withdrawal replaces the cash coverage thesis",
    priorUpdate: { status: "replaced", text: "Withdrawn guidance materially replaces the earlier cash-coverage proposition. [S1]" },
    signal: { ...previous.signal, direction: "DOWN", strength: "MODERATE" },
  });
  assert.equal(thesisContinuityValidationError(replacement, previous), null);
  const lifecycle = buildDossierThesisLifecycle({
    ticker: "MSFT",
    date: "2026-07-24",
    generatedAt: 1_721_779_200_000,
    hook: replacement,
    previousThesis: previous,
  });
  assert.notEqual(lifecycle.id, previous.lifecycleId);
  assert.equal(lifecycle.observationIndex, 1);
  assert.equal(lifecycle.observationStatus, "opened");
  assert.deepEqual(lifecycle.previousLifecycle, {
    id: previous.lifecycleId,
    openedDate: previous.openedDate,
    status: "replaced",
    text: replacement.priorUpdate!.text,
  });
  assert.equal(
    shouldIssuePrivateSignalForDossier({ thesisLifecycle: lifecycle } as Dossier),
    true,
  );
});

test("legacy dossiers without lifecycle metadata retain their existing private-signal behavior", () => {
  assert.equal(shouldIssuePrivateSignalForDossier({} as Dossier), true);
});
