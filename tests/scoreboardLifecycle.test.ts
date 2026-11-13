import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentReference, Transaction } from "@google-cloud/firestore";
import type { ThesisMovementObservation } from "../src/lib/thesisMovement";

process.env.DESK_STORE = "memory";

const openedAt = Date.parse("2026-07-23T21:00:00Z");
const lifecycleId = "a".repeat(48);
const replacementId = "b".repeat(48);

test("Firestore rejected-review transaction rewrites a same-audit legacy movement", async () => {
  const { stageRejectedMovementWrite } = await import("../src/lib/scoreboard");
  const normalized: ThesisMovementObservation = {
    schemaVersion: 1,
    date: "2026-07-25",
    observedAt: openedAt + 2 * 86_400_000,
    index: 3,
    status: "open",
    score: 1,
    support: 1,
    oppose: 0,
    uncertain: 3,
    unavailable: 1,
    auditId: "c".repeat(48),
  };
  const legacy: ThesisMovementObservation = {
    ...normalized,
    status: "weakened",
    score: 0,
  };
  const movementRef = { path: `activeQuestions/MSFT:${lifecycleId}/observations/2026-07-25` } as
    unknown as DocumentReference;
  const writes: Array<{ operation: "create" | "set"; movement: ThesisMovementObservation }> = [];
  const transaction = {
    create: (_reference: DocumentReference, movement: ThesisMovementObservation) => {
      writes.push({ operation: "create", movement });
    },
    set: (_reference: DocumentReference, movement: ThesisMovementObservation) => {
      writes.push({ operation: "set", movement });
    },
  } as unknown as Pick<Transaction, "create" | "set">;

  assert.equal(
    stageRejectedMovementWrite(
      transaction,
      movementRef,
      legacy,
      normalized,
      normalized.auditId!,
    ),
    "set",
    "an existing movement owned by this rejection must be replaced in the transaction",
  );
  assert.deepEqual(writes, [{ operation: "set", movement: normalized }]);
  assert.equal(
    stageRejectedMovementWrite(
      transaction,
      movementRef,
      null,
      normalized,
      normalized.auditId!,
    ),
    "create",
  );
  assert.equal(
    stageRejectedMovementWrite(
      transaction,
      movementRef,
      { ...legacy, auditId: "d".repeat(48) },
      normalized,
      normalized.auditId!,
    ),
    null,
    "a different immutable audit keeps ownership of the date slot",
  );
  assert.deepEqual(writes, [
    { operation: "set", movement: normalized },
    { operation: "create", movement: normalized },
  ]);
});

function hook(subject: string, strength: "GENTLE" | "MODERATE" = "GENTLE") {
  return {
    subjectPunchline: subject,
    question: `Is it true that ${subject.charAt(0).toLowerCase()}${subject.slice(1)}?`,
    thesis: `${subject} because the cited operating evidence remains intact.`,
    votesSupport: 4,
    votesOppose: 0,
    votesUncertain: 1,
    votesTotal: 5,
    votes: { support: 4, oppose: 0, uncertain: 1 },
    signal: {
      eventType: "earnings" as const,
      direction: "UP" as const,
      strength,
      horizonSessions: { min: 10 as const, max: 15 as const },
    },
    oracle: {
      type: "filing" as const,
      trigger: "The next filed earnings release resolves the proposition.",
      dueBy: "2026-10-31",
    },
  };
}

function lifecycleDossier(input: {
  date: string;
  generatedAt: number;
  observationIndex: number;
  observationStatus: "opened" | "strengthened" | "weakened" | "open";
  id?: string;
  subject?: string;
  previousLifecycle?: {
    id: string;
    openedDate: string;
    status: "resolved" | "invalidated" | "replaced";
    text: string;
  };
}) {
  const subject = input.subject ?? "Filed cash flow can support the current investment cycle";
  const currentHook = hook(subject, input.observationStatus === "strengthened" ? "MODERATE" : "GENTLE");
  const id = input.id ?? lifecycleId;
  return {
    ticker: "MSFT",
    date: input.date,
    generatedAt: input.generatedAt,
    briefAuditId: `audit-${input.observationIndex}`,
    emailHook: currentHook,
    thesisLifecycle: {
      schemaVersion: 1,
      id,
      openedDate: id === lifecycleId ? "2026-07-23" : input.date,
      openedAt: id === lifecycleId ? openedAt : input.generatedAt,
      observationDate: input.date,
      observationIndex: input.observationIndex,
      observationStatus: input.observationStatus,
      canonicalSubjectPunchline: subject,
      canonicalThesis: currentHook.thesis,
      canonicalQuestion: currentHook.question,
      canonicalSignal: hook(subject).signal,
      canonicalOracle: currentHook.oracle,
      canonicalVotes: { support: 4, oppose: 0, uncertain: 1, total: 5 },
      latestSignal: currentHook.signal,
      ...(input.previousLifecycle ? { previousLifecycle: input.previousLifecycle } : {}),
    },
  };
}

test("scoreboard keeps one record through daily observations and closes it only on replacement", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    chart: {
      result: [{
        meta: {
          regularMarketPrice: 100,
          chartPreviousClose: 99,
          regularMarketTime: 0,
          longName: "Microsoft",
        },
        timestamp: [],
        indicators: { quote: [{ close: [] }] },
      }],
    },
  }), { status: 200 });

  try {
    const dossierStore = ((globalThis as Record<string, unknown>).__dossierStore ??=
      new Map<string, unknown>()) as Map<string, unknown>;
    const scoreboard = ((globalThis as Record<string, unknown>).__scoreboard ??=
      new Map<string, unknown>()) as Map<string, unknown>;
    const movement = ((globalThis as Record<string, unknown>).__scoreboardMovement ??=
      new Map<string, unknown>()) as Map<string, unknown>;
    const rejectedStore = ((globalThis as Record<string, unknown>).__rejectedDossierUpdates ??=
      new Map<string, unknown>()) as Map<string, unknown>;
    dossierStore.clear();
    scoreboard.clear();
    movement.clear();
    rejectedStore.clear();

    const {
      getQuestion,
      getThesisMovementObservations,
      listQuestions,
      recordFromDossiers,
    } = await import("../src/lib/scoreboard");
    const { buildRejectedDossierFactualUpdate } = await import("../src/lib/dossier");

    dossierStore.set("MSFT", lifecycleDossier({
      date: "2026-07-23",
      generatedAt: openedAt,
      observationIndex: 1,
      observationStatus: "opened",
    }));
    assert.equal(await recordFromDossiers(["MSFT"], "2026-07-23"), 1);
    const first = await getQuestion(`MSFT:${lifecycleId}`);
    assert.equal(first?.publishedDate, "2026-07-23");
    assert.equal(first?.observationCount, 1);
    assert.equal(first?.priceAtPublish, 100);
    assert.deepEqual(
      (await getThesisMovementObservations({
        ticker: "MSFT",
        lifecycleId,
        openedDate: "2026-07-23",
      })).map((item) => [item.date, item.score]),
      [["2026-07-23", 1]],
    );

    dossierStore.set("MSFT", lifecycleDossier({
      date: "2026-07-24",
      generatedAt: openedAt + 86_400_000,
      observationIndex: 2,
      observationStatus: "strengthened",
    }));
    assert.equal(await recordFromDossiers(["MSFT"], "2026-07-24"), 0);
    const continued = await getQuestion(`MSFT:${lifecycleId}`);
    assert.equal(continued?.status, "strengthened");
    assert.equal(continued?.observationCount, 2);
    assert.equal(continued?.publishedDate, "2026-07-23");
    assert.equal(continued?.votesYes, 4);
    assert.equal((await listQuestions({ status: "open", ticker: "MSFT" })).length, 1);
    assert.deepEqual(
      (await getThesisMovementObservations({
        ticker: "MSFT",
        lifecycleId,
        openedDate: "2026-07-23",
      })).map((item) => [item.date, item.score]),
      [["2026-07-23", 1], ["2026-07-24", 1]],
    );
    assert.equal(await recordFromDossiers(["MSFT"], "2026-07-24"), 0);
    assert.equal(
      (await getThesisMovementObservations({
        ticker: "MSFT",
        lifecycleId,
        openedDate: "2026-07-23",
      })).length,
      2,
    );

    const rejectedDate = "2026-07-25";
    const rejectedAt = openedAt + 2 * 86_400_000;
    const priorHook = hook("Filed cash flow can support the current investment cycle", "MODERATE");
    const rejected = buildRejectedDossierFactualUpdate({
      ticker: "MSFT",
      date: rejectedDate,
      generatedAt: rejectedAt,
      rejectionAuditId: "c".repeat(48),
      compactWhatChanged: "Microsoft filed an update that leaves the spending bridge unresolved. [S1]",
      evidence: [{
        id: "S1",
        title: "Microsoft Form 8-K",
        url: "https://www.sec.gov/Archives/msft-8k.htm",
        publisher: "SEC",
        authority: "primary",
        publishedAt: rejectedAt,
        publishedDate: rejectedDate,
        retrievedAt: rejectedAt + 1_000,
        sourceDocumentId: "sec-msft-8k",
      }],
      rejected: {
        key: "rejected-msft-2026-07-25",
        propositionSha256: "d".repeat(64),
        rejectedAt,
        votesSupport: 1,
        votesOppose: 0,
        votesUncertain: 3,
        reason: "incomplete-ballot",
        ballotResponseSha256: [],
      },
      previousThesis: {
        lifecycleId,
        openedDate: "2026-07-23",
        openedAt,
        observationIndex: 2,
        date: "2026-07-24",
        subjectPunchline: priorHook.subjectPunchline,
        thesis: priorHook.thesis,
        canonicalSignal: hook(priorHook.subjectPunchline).signal,
        signal: priorHook.signal,
        question: priorHook.question,
        flipCondition: "A later filing showing negative cash conversion would defeat the read. [S1]",
        oracle: priorHook.oracle,
        votes: { support: 4, oppose: 0, uncertain: 1, total: 5 },
        state: "open",
        outcomeContext: {
          status: "unresolved",
          asOfDate: "2026-07-24",
          note: "The active thesis remains unresolved.",
        },
      },
      compactPriorUpdate: {
        status: "weakened",
        text: "The unresolved spending bridge weakens the standing cash-flow thesis today. [S1]",
      },
    });
    rejectedStore.set(`MSFT_${rejectedDate}`, rejected);
    assert.equal(await recordFromDossiers(["MSFT"], rejectedDate), 0);
    const reviewed = await getQuestion(`MSFT:${lifecycleId}`);
    assert.equal(
      reviewed?.status,
      "strengthened",
      "a rejected proposition must not replace the last admitted lifecycle state",
    );
    assert.equal(reviewed?.observationCount, 3);
    assert.deepEqual(
      (await getThesisMovementObservations({
        ticker: "MSFT",
        lifecycleId,
        openedDate: "2026-07-23",
      })).map((item) => [item.date, item.score, item.support, item.unavailable]),
      [
        ["2026-07-23", 1, 4, 0],
        ["2026-07-24", 1, 4, 0],
        ["2026-07-25", 1, 1, 1],
      ],
    );
    assert.equal(
      (await getThesisMovementObservations({
        ticker: "MSFT",
        lifecycleId,
        openedDate: "2026-07-23",
      }))[2]?.status,
      "open",
      "the completed review is retained without claiming an unadmitted directional change",
    );

    // Simulate the pre-fix production movement shape. An idempotent catch-up
    // must restore the last admitted score instead of preserving the rejected
    // chair proposal as a directional point.
    const questionKey = `MSFT:${lifecycleId}`;
    const movementKey = `${questionKey}:${rejectedDate}`;
    movement.set(movementKey, {
      ...(movement.get(movementKey) as Record<string, unknown>),
      status: "weakened",
      score: 0,
      auditId: rejected.rejectionAuditId,
    });
    assert.equal(await recordFromDossiers(["MSFT"], rejectedDate), 0);
    assert.equal((await getQuestion(questionKey))?.status, "strengthened");
    const repairedMovement = (await getThesisMovementObservations({
      ticker: "MSFT",
      lifecycleId,
      openedDate: "2026-07-23",
    })).at(-1);
    assert.equal(repairedMovement?.status, "open");
    assert.equal(repairedMovement?.score, 1);
    assert.equal(
      (await getThesisMovementObservations({
        ticker: "MSFT",
        lifecycleId,
        openedDate: "2026-07-23",
      })).length,
      3,
    );

    scoreboard.set(questionKey, {
      ...(scoreboard.get(questionKey) as Record<string, unknown>),
      status: "resolved_no",
    });
    dossierStore.set("MSFT", lifecycleDossier({
      date: "2026-07-26",
      generatedAt: openedAt + 3 * 86_400_000,
      observationIndex: 4,
      observationStatus: "open",
    }));
    assert.equal(await recordFromDossiers(["MSFT"], "2026-07-26"), 0);
    assert.equal(
      (await getQuestion(questionKey))?.status,
      "open",
      "a terminal state without a real resolution receipt self-heals on the next admitted same-lifecycle review",
    );

    const replacementDate = "2026-07-27";
    const replacementSubject = "New guidance supersedes the old cash-flow proposition";
    dossierStore.set("MSFT", lifecycleDossier({
      date: replacementDate,
      generatedAt: openedAt + 4 * 86_400_000,
      observationIndex: 1,
      observationStatus: "opened",
      id: replacementId,
      subject: replacementSubject,
      previousLifecycle: {
        id: lifecycleId,
        openedDate: "2026-07-23",
        status: "replaced",
        text: "The new filed guidance replaces the prior proposition. [1 · 2026-07-27](https://example.com/filing)",
      },
    }));
    assert.equal(await recordFromDossiers(["MSFT"], replacementDate), 1);
    assert.equal((await getQuestion(`MSFT:${lifecycleId}`))?.status, "reframed");
    assert.equal((await getQuestion(`MSFT:${replacementId}`))?.status, "open");
    assert.equal((await listQuestions({ status: "open", ticker: "MSFT" })).length, 1);
    assert.equal((await listQuestions({ status: "closed", ticker: "MSFT" })).length, 1);

    const closedBeforeRetry = await getQuestion(`MSFT:${lifecycleId}`);
    const closedMovementCount = (await getThesisMovementObservations({
      ticker: "MSFT",
      lifecycleId,
      openedDate: "2026-07-23",
    })).length;
    assert.equal(await recordFromDossiers(["MSFT"], rejectedDate), 0);
    const closedAfterRetry = await getQuestion(`MSFT:${lifecycleId}`);
    assert.equal(closedAfterRetry?.status, "reframed");
    assert.equal(closedAfterRetry?.resolvedAt, closedBeforeRetry?.resolvedAt);
    assert.equal(
      (await getThesisMovementObservations({
        ticker: "MSFT",
        lifecycleId,
        openedDate: "2026-07-23",
      })).length,
      closedMovementCount,
      "a late rejected receipt cannot append to or reopen a terminal lifecycle",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
