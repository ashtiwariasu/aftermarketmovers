import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";

function filingDueBy(date: string): string {
  const due = new Date(`${date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 120);
  return due.toISOString().slice(0, 10);
}

function hook(tag: string, date: string) {
  const subjectPunchline = `A concrete signal punchline ${tag}`;
  const flipCondition = `A named filing fact would invalidate ${tag}.`;
  return {
    subjectPunchline,
    priorUpdate: null,
    whatChanged: `A newly admitted external signal changed for ${tag}.`,
    thesis: `The exact falsifiable thesis for ${tag} should persist without the full dossier corpus.`,
    question: `Is it true that ${subjectPunchline.charAt(0).toLowerCase()}${subjectPunchline.slice(1)}?`,
    primaryEvidence: `The primary source directly supports ${tag}.`,
    secondaryEvidence: [
      `A first corroborating source supports ${tag}.`,
      `A second corroborating source supports ${tag}.`,
    ],
    signal: {
      eventType: "earnings" as const,
      direction: "UP" as const,
      strength: "MODERATE" as const,
      horizonSessions: { min: 10 as const, max: 15 as const },
    },
    votesSupport: 3,
    votesOppose: 1,
    votesUncertain: 1,
    votesTotal: 5 as const,
    votes: { support: 3, oppose: 1, uncertain: 1 },
    confidence: {
      majorityReason: `The majority supports ${tag}.`,
      dissentReason: `One analyst opposes ${tag}.`,
      uncertaintyReason: `One analyst remains uncertain about ${tag}.`,
      flipCondition,
    },
    oracle: { type: "filing" as const, trigger: flipCondition, dueBy: filingDueBy(date) },
    editorialStrength: {
      novelty: 4,
      materiality: 4,
      evidence: 4,
      asymmetry: 4,
      score: 80,
    },
  };
}

function dossierProjection(tag: string, generatedAt = Date.now() - 60_000) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(generatedAt));
  return {
    ticker: `Q${tag.replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 7) || "TEST"}`,
    date,
    generatedAt,
    artifactVersion: 5,
    briefAuditId: `brief-${tag}`,
    councilRunId: `council-${tag}`,
    emailHook: hook(tag, date),
    story: `FULL-DOSSIER-SENTINEL-${tag}`,
    citations: [{ huge: `FULL-EVIDENCE-SENTINEL-${tag}` }],
  };
}

async function privateRecordForProjection(
  projection: ReturnType<typeof dossierProjection>,
) {
  const {
    createPrivateSignalResearchRecord,
    researchHash,
  } = await import("../src/lib/privateSignalResearch");
  const created = createPrivateSignalResearchRecord({
    ticker: projection.ticker,
    thesis: projection.emailHook.thesis,
    eventType: projection.emailHook.signal.eventType,
    direction: projection.emailHook.signal.direction,
    strength: projection.emailHook.signal.strength,
    issuedAt: projection.generatedAt,
    sourceArtifact: {
      dossierArtifactVersion: projection.artifactVersion,
      dossierDate: projection.date,
      councilRunId: projection.councilRunId,
      briefAuditId: projection.briefAuditId,
      emailHookSha256: researchHash(projection.emailHook),
    },
    stockBars: [],
    spyBars: [],
    historicalEvents: [],
  });
  assert.equal(created.ok, true, created.ok ? undefined : created.reason);
  return created.record;
}

function businessDates(count: number): string[] {
  const dates: string[] = [];
  let cursor = new Date("2025-01-02T00:00:00Z");
  while (dates.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

test("outbox stores only the exact v5 hook, issuance metadata, and immutable ids", async () => {
  const {
    buildPrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
    getPrivateSignalOutboxItem,
  } = await import("../src/lib/privateSignalOutbox");
  const dossier = dossierProjection("COMPACT");
  const item = buildPrivateSignalOutboxItem(dossier);
  assert.deepEqual(Object.keys(item.payload).sort(), [
    "artifactVersion", "briefAuditId", "councilRunId", "date", "emailHook", "generatedAt", "ticker",
  ]);
  assert.deepEqual(item.payload.emailHook, dossier.emailHook);
  assert.equal(JSON.stringify(item).includes("FULL-DOSSIER-SENTINEL"), false);
  assert.equal(JSON.stringify(item).includes("FULL-EVIDENCE-SENTINEL"), false);
  assert.equal(item.id, item.payloadSha256.digest.slice(0, 48));
  assert.equal(item.emailHookSha256.digest.length, 64);
  assert.equal(await enqueuePrivateSignalOutbox(item), "created");
  assert.equal(await enqueuePrivateSignalOutbox(structuredClone(item)), "exists");
  assert.deepEqual(await getPrivateSignalOutboxItem(item.id), item);

  assert.throws(
    () => buildPrivateSignalOutboxItem({ ...dossier, artifactVersion: 4 }),
    /only exact v5/,
  );
  assert.throws(
    () => buildPrivateSignalOutboxItem({ ...dossier, briefAuditId: undefined }),
    /immutable audit ids/,
  );
  assert.throws(
    () => buildPrivateSignalOutboxItem({ ...dossier, date: "2026-02-30" }),
    /invalid dossier date/,
  );
  assert.throws(
    () => buildPrivateSignalOutboxItem({ ...dossier, date: "2026-01-01" }),
    /America\/New_York generation date/,
  );
  assert.throws(
    () => buildPrivateSignalOutboxItem({
      ...dossier,
      emailHook: { ...dossier.emailHook, votesSupport: 4 },
    }),
    /exact nested v5 email hook schema/,
  );
  const tampered = structuredClone(item);
  tampered.payload.emailHook.thesis += " tampered";
  await assert.rejects(() => enqueuePrivateSignalOutbox(tampered), /integrity failure/);
  const expanded = { ...structuredClone(item), fullDossier: "forbidden-sentinel" };
  await assert.rejects(
    () => enqueuePrivateSignalOutbox(expanded as never),
    /invalid status-specific keys/,
  );
});

test("outbox retains but does not process research for companies with no watchers", async () => {
  const {
    buildPrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
    getPrivateSignalOutboxItem,
  } = await import("../src/lib/privateSignalOutbox");
  const { processPrivateSignalOutboxPage } = await import(
    "../src/lib/privateSignalRuntime"
  );
  const projection = dossierProjection(`paused-${Date.now()}`);
  const item = buildPrivateSignalOutboxItem(projection);
  await enqueuePrivateSignalOutbox(item);
  let ensureCalled = false;

  const result = await processPrivateSignalOutboxPage({
    pageSize: 500,
    activeTickers: new Set(["A-DIFFERENT-COMPANY"]),
    ensure: async () => {
      ensureCalled = true;
      throw new Error("paused company must not enter research processing");
    },
  });

  assert.equal(ensureCalled, false);
  assert.ok((result.paused ?? 0) >= 1);
  assert.equal((await getPrivateSignalOutboxItem(item.id))?.status, "queued");
});

test("claim leases recover, stale tokens lose CAS, retries back off, and completion is idempotent", async () => {
  const {
    buildPrivateSignalOutboxItem,
    claimPrivateSignalOutboxItem,
    completePrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
    failPrivateSignalOutboxItem,
    getPrivateSignalOutboxItem,
    listPrivateSignalOutboxPage,
  } = await import("../src/lib/privateSignalOutbox");
  const item = buildPrivateSignalOutboxItem(dossierProjection("LEASE", Date.now() - 20_000));
  await enqueuePrivateSignalOutbox(item);
  const firstNow = item.createdAt + 100;
  const first = await claimPrivateSignalOutboxItem({
    id: item.id, workerId: "worker-a", leaseToken: "lease-a", now: firstNow, leaseMs: 1_000,
  });
  assert.equal(first.status, "claimed");
  const busy = await claimPrivateSignalOutboxItem({
    id: item.id, workerId: "worker-b", leaseToken: "lease-b", now: firstNow + 999,
  });
  assert.equal(busy.status, "busy");
  const recovered = await claimPrivateSignalOutboxItem({
    id: item.id, workerId: "worker-b", leaseToken: "lease-b", now: firstNow + 1_001,
  });
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.item?.attempts, 2);

  await assert.rejects(() => completePrivateSignalOutboxItem({
    id: item.id,
    workerId: "worker-a",
    leaseToken: "lease-a",
    privateSignalId: "private-one",
  }), /lease is not owned/);
  await assert.rejects(() => failPrivateSignalOutboxItem({
    id: item.id,
    workerId: "worker-a",
    leaseToken: "lease-a",
    error: "stale",
  }), /lease is not owned/);

  const failedAt = firstNow + 1_100;
  const queued = await failPrivateSignalOutboxItem({
    id: item.id,
    workerId: "worker-b",
    leaseToken: "lease-b",
    error: "transient vendor failure",
    failedAt,
    retryDelayMs: 2_000,
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.availableAt, failedAt + 2_000);
  assert.match(queued.lastError ?? "", /transient vendor failure/);
  assert.equal((await claimPrivateSignalOutboxItem({
    id: item.id,
    workerId: "worker-c",
    now: queued.availableAt - 1,
  })).status, "not_due");
  const third = await claimPrivateSignalOutboxItem({
    id: item.id,
    workerId: "worker-c",
    leaseToken: "lease-c",
    now: queued.availableAt,
  });
  assert.equal(third.status, "claimed");
  const complete = await completePrivateSignalOutboxItem({
    id: item.id,
    workerId: "worker-c",
    leaseToken: "lease-c",
    privateSignalId: "private-one",
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.queueKey, undefined);
  assert.equal((await completePrivateSignalOutboxItem({
    id: item.id,
    workerId: "stale-is-fine-after-identical-completion",
    leaseToken: "stale-token",
    privateSignalId: "private-one",
  })).status, "complete");
  await assert.rejects(() => completePrivateSignalOutboxItem({
    id: item.id,
    workerId: "worker-c",
    leaseToken: "lease-c",
    privateSignalId: "different-private-id",
  }), /completion conflict/);
  assert.equal((await listPrivateSignalOutboxPage({ limit: 500 })).records.some((v) => v.id === item.id), false);
  assert.equal((await getPrivateSignalOutboxItem(item.id))?.status, "complete");
});

test("outbox cursor paging is exhaustive and deterministic beyond 500 records", async () => {
  const {
    buildPrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
    listPrivateSignalOutboxPage,
  } = await import("../src/lib/privateSignalOutbox");
  const issuedAt = Date.now() - 120_000;
  const items = Array.from({ length: 525 }, (_, index) =>
    buildPrivateSignalOutboxItem({
      ...dossierProjection(`PAGE${index}`, issuedAt),
      ticker: "QPAGING",
      briefAuditId: `page-brief-${index}`,
      councilRunId: `page-council-${index}`,
    }));
  await Promise.all([...items].reverse().map((item) => enqueuePrivateSignalOutbox(item)));
  const expected = [...items].sort((left, right) => left.id.localeCompare(right.id)).map((item) => item.id);
  const seen: string[] = [];
  let after: { createdAt: number; id: string } | null = null;
  do {
    const page = await listPrivateSignalOutboxPage({ after, limit: 73 });
    seen.push(...page.records.filter((item) => item.payload.ticker === "QPAGING").map((item) => item.id));
    after = page.nextCursor;
  } while (after);
  assert.deepEqual(seen, expected);
});

test("processor failure remains queued and a content-addressed retry completes once", async () => {
  const {
    buildPrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
    getPrivateSignalOutboxItem,
  } = await import("../src/lib/privateSignalOutbox");
  const { processPrivateSignalOutboxItem } = await import("../src/lib/privateSignalRuntime");
  const item = buildPrivateSignalOutboxItem(dossierProjection("PROCESS", Date.now() - 20_000));
  await enqueuePrivateSignalOutbox(item);
  await assert.rejects(() => processPrivateSignalOutboxItem({
    id: item.id,
    workerId: "processor-a",
    retryDelayMs: 1_000,
    ensure: async () => { throw new Error("licensed feed temporarily unavailable"); },
  }), /licensed feed temporarily unavailable/);
  const queued = await getPrivateSignalOutboxItem(item.id);
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.attempts, 1);
  assert.match(queued?.lastError ?? "", /licensed feed temporarily unavailable/);
  let ensureCalls = 0;
  const tooEarly = await processPrivateSignalOutboxItem({
    id: item.id,
    workerId: "processor-b",
    now: Number(queued?.availableAt) - 1,
    ensure: async () => {
      ensureCalls += 1;
      return privateRecordForProjection(dossierProjection("NEVER")) as never;
    },
  });
  assert.equal(tooEarly.status, "not_due");
  assert.equal(ensureCalls, 0);
  const completed = await processPrivateSignalOutboxItem({
    id: item.id,
    workerId: "processor-b",
    now: Number(queued?.availableAt),
    ensure: async (projection) => {
      ensureCalls += 1;
      assert.equal(Object.keys(projection).includes("story"), false);
      return privateRecordForProjection(projection as ReturnType<typeof dossierProjection>);
    },
  });
  assert.equal(completed.status, "complete");
  assert.equal(ensureCalls, 1);
  assert.equal(
    (await getPrivateSignalOutboxItem(item.id))?.privateSignalId,
    completed.status === "complete" ? completed.privateSignalId : null,
  );
});

test("same-ticker workers materialize strict predecessor order even when invoked concurrently", async () => {
  const {
    buildPrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
    getPrivateSignalOutboxItem,
  } = await import("../src/lib/privateSignalOutbox");
  const { processPrivateSignalOutboxItem } = await import("../src/lib/privateSignalRuntime");
  const base = Date.now() - 30_000;
  const olderProjection = { ...dossierProjection("ORDER-OLDER", base), ticker: "QORDER" };
  const newerProjection = { ...dossierProjection("ORDER-NEWER", base + 1_000), ticker: "QORDER" };
  const older = buildPrivateSignalOutboxItem(olderProjection);
  const newer = buildPrivateSignalOutboxItem(newerProjection);
  // Reverse insertion reproduces backfill/current discovery order; the
  // indexed per-ticker key, not insertion order, governs materialization.
  await enqueuePrivateSignalOutbox(newer);
  await enqueuePrivateSignalOutbox(older);
  const ensureOrder: string[] = [];
  const ensure = async (projection: typeof older.payload) => {
    ensureOrder.push(projection.briefAuditId);
    return privateRecordForProjection(projection as ReturnType<typeof dossierProjection>);
  };
  const [newerAttempt, olderAttempt] = await Promise.all([
    processPrivateSignalOutboxItem({ id: newer.id, workerId: "newer-worker", ensure }),
    processPrivateSignalOutboxItem({ id: older.id, workerId: "older-worker", ensure }),
  ]);
  assert.equal(newerAttempt.status, "blocked_predecessor");
  assert.equal(olderAttempt.status, "complete");
  assert.deepEqual(ensureOrder, [older.payload.briefAuditId]);
  assert.equal((await getPrivateSignalOutboxItem(older.id))?.status, "complete");
  assert.equal((await getPrivateSignalOutboxItem(newer.id))?.status, "queued");

  const retried = await processPrivateSignalOutboxItem({
    id: newer.id,
    workerId: "newer-worker-retry",
    ensure,
  });
  assert.equal(retried.status, "complete");
  assert.deepEqual(ensureOrder, [older.payload.briefAuditId, newer.payload.briefAuditId]);
});

test("a valid but mismatched private record cannot acknowledge an outbox item", async () => {
  const {
    buildPrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
    getPrivateSignalOutboxItem,
  } = await import("../src/lib/privateSignalOutbox");
  const { processPrivateSignalOutboxItem } = await import("../src/lib/privateSignalRuntime");
  const generatedAt = Date.now() - 20_000;
  const expectedProjection = dossierProjection("BIND-EXPECTED", generatedAt);
  const otherProjection = dossierProjection("BIND-OTHER", generatedAt);
  const item = buildPrivateSignalOutboxItem(expectedProjection);
  await enqueuePrivateSignalOutbox(item);
  const mismatchedRecord = await privateRecordForProjection(otherProjection);
  await assert.rejects(
    () => processPrivateSignalOutboxItem({
      id: item.id,
      workerId: "binding-worker",
      retryDelayMs: 1_000,
      ensure: async () => mismatchedRecord,
    }),
    /does not bind exactly to outbox/,
  );
  const queued = await getPrivateSignalOutboxItem(item.id);
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.privateSignalId, undefined);
  assert.match(queued?.lastError ?? "", /does not bind exactly to outbox/);
});

test("exact hook whitespace remains hash-bound while the private thesis is canonical", async () => {
  const {
    buildPrivateSignalOutboxItem,
    enqueuePrivateSignalOutbox,
  } = await import("../src/lib/privateSignalOutbox");
  const { processPrivateSignalOutboxItem } = await import("../src/lib/privateSignalRuntime");
  const projection = dossierProjection("BIND-WHITESPACE", Date.now() - 20_000);
  projection.emailHook.thesis = `  ${projection.emailHook.thesis}  `;
  const item = buildPrivateSignalOutboxItem(projection);
  await enqueuePrivateSignalOutbox(item);
  const result = await processPrivateSignalOutboxItem({
    id: item.id,
    workerId: "binding-whitespace-worker",
    ensure: async (payload) => privateRecordForProjection(
      payload as ReturnType<typeof dossierProjection>,
    ),
  });
  assert.equal(result.status, "complete");
});

test("a later signal hydrates a cold predecessor before freezing its historical cohort", async () => {
  const {
    conservativeUsSessionCloseAt,
    createPrivateSignalResearchRecord,
    researchHash,
  } = await import("../src/lib/privateSignalResearch");
  const {
    getPrivateSignalResearch,
    savePrivateSignalResearch,
  } = await import("../src/lib/privateSignalStore");
  const {
    hydratePrivateSignalPredecessors,
  } = await import("../src/lib/privateSignalRuntime");
  const { buildPrivateSignalOutboxItem } = await import("../src/lib/privateSignalOutbox");

  const dates = businessDates(125);
  let stockPrice = 100;
  let spyPrice = 500;
  const spy = dates.map((date, index) => {
    const dailyReturn = 0.0005 + Math.sin(index * 0.31) * 0.002;
    spyPrice *= 1 + dailyReturn;
    return { date, close: spyPrice, adjustedClose: spyPrice, source: "restored-adjusted" };
  });
  const stock = dates.map((date, index) => {
    const spyReturn = index === 0
      ? 0
      : Number(spy[index].adjustedClose) / Number(spy[index - 1].adjustedClose) - 1;
    stockPrice *= 1 + spyReturn * 1.15 + Math.cos(index * 0.47) * 0.001;
    return { date, close: stockPrice, adjustedClose: stockPrice, source: "restored-adjusted" };
  });
  const olderIndex = 79;
  const laterIndex = 110;
  const olderIssuedAt = conservativeUsSessionCloseAt(dates[olderIndex]) + 1;
  const laterIssuedAt = conservativeUsSessionCloseAt(dates[laterIndex]) + 1;
  const ticker = "QCOLDSEQ";
  const olderProjection = {
    ...dossierProjection("COLD-OLDER", olderIssuedAt),
    ticker,
  };
  const laterProjection = {
    ...dossierProjection("COLD-LATER", laterIssuedAt),
    ticker,
  };
  const older = await privateRecordForProjection(olderProjection);
  assert.equal(older.entryStatus, "pending");
  await savePrivateSignalResearch(older);

  const laterDossier = buildPrivateSignalOutboxItem(laterProjection).payload;
  const predecessorState = await hydratePrivateSignalPredecessors({
    dossier: laterDossier,
    priorRecords: [older],
    stockBars: stock.slice(0, laterIndex + 1),
    spyBars: spy.slice(0, laterIndex + 1),
    boundAt: laterIssuedAt,
  });
  assert.equal(predecessorState.records.length, 1);
  assert.equal(predecessorState.records[0].entryStatus, "bound");
  assert.equal(predecessorState.records[0].entryBinding?.sessionDate, dates[olderIndex]);
  assert.deepEqual(
    predecessorState.historicalEvents.map((event) => event.id),
    [older.id],
  );
  assert.equal((await getPrivateSignalResearch(older.id))?.entryStatus, "bound");

  const laterCreated = createPrivateSignalResearchRecord({
    ticker,
    thesis: laterDossier.emailHook.thesis,
    eventType: laterDossier.emailHook.signal.eventType,
    direction: laterDossier.emailHook.signal.direction,
    strength: laterDossier.emailHook.signal.strength,
    issuedAt: laterDossier.generatedAt,
    sourceArtifact: {
      dossierArtifactVersion: laterDossier.artifactVersion,
      dossierDate: laterDossier.date,
      councilRunId: laterDossier.councilRunId,
      briefAuditId: laterDossier.briefAuditId,
      emailHookSha256: researchHash(laterDossier.emailHook),
    },
    stockBars: stock.slice(0, laterIndex + 1),
    spyBars: spy.slice(0, laterIndex + 1),
    historicalEvents: predecessorState.historicalEvents,
    config: {
      betaLookbackSessions: 60,
      minimumBetaSessions: 40,
      minimumEffectiveSamples: 20,
    },
  });
  assert.equal(laterCreated.ok, true, laterCreated.ok ? undefined : laterCreated.reason);
  assert.equal(
    laterCreated.record.calibrationFailure?.sampleAccounting?.historicalEventsSeen,
    1,
  );
  assert.equal(
    laterCreated.record.calibrationFailure?.sampleAccounting?.exactEventAndDirectionMatches,
    1,
  );

  // An idempotent retry sees its own stored record in ticker history. It must
  // not turn that exact current artifact into its own historical observation.
  const retryState = await hydratePrivateSignalPredecessors({
    dossier: laterDossier,
    priorRecords: [older, laterCreated.record],
    stockBars: stock.slice(0, laterIndex + 1),
    spyBars: spy.slice(0, laterIndex + 1),
    boundAt: laterIssuedAt,
  });
  assert.deepEqual(retryState.records.map((record) => record.id), [older.id]);
  assert.deepEqual(retryState.historicalEvents.map((event) => event.id), [older.id]);
});

test("drain follows every outbox cursor before every settlement cursor", async () => {
  const { drainPrivateSignalWork } = await import("../src/lib/privateSignalRuntime");
  const calls: string[] = [];
  const outboxCursor = { createdAt: 1, id: "outbox-cursor" };
  const settlementCursor = { issuedAt: 2, id: "settlement-cursor" };
  let outboxCalls = 0;
  let settlementCalls = 0;
  const result = await drainPrivateSignalWork({
    deadlineAt: 10_000,
    now: () => 0,
    processOutboxPage: async (pageInput = {}) => {
      const { after } = pageInput;
      calls.push(`outbox:${after?.id ?? "start"}`);
      outboxCalls += 1;
      return {
        scanned: 1,
        completed: 1,
        busy: 0,
        notDue: 0,
        blockedPredecessor: 0,
        alreadyComplete: 0,
        missing: 0,
        errors: outboxCalls === 1
          ? [{ id: "outbox-error", ticker: "SAFE", error: "bounded failure" }]
          : [],
        nextCursor: outboxCalls === 1 ? outboxCursor : null,
      };
    },
    settlePage: async (pageInput = {}) => {
      const { after } = pageInput;
      calls.push(`settlement:${after?.id ?? "start"}`);
      settlementCalls += 1;
      return {
        attempted: 2,
        completed: 1,
        stillOpen: 1,
        errors: [],
        nextCursor: settlementCalls === 1 ? settlementCursor : null,
      };
    },
  });
  assert.deepEqual(calls, [
    "outbox:start",
    "outbox:outbox-cursor",
    "settlement:start",
    "settlement:settlement-cursor",
  ]);
  assert.equal(result.completeSweep, true);
  assert.equal(result.outbox.pages, 2);
  assert.equal(result.outbox.completed, 2);
  assert.equal(result.outbox.errors.length, 1);
  assert.equal(result.settlement.pages, 2);
  assert.equal(result.settlement.attempted, 4);
});

test("drain stops honestly between pages when its safe deadline is reached", async () => {
  const { drainPrivateSignalWork } = await import("../src/lib/privateSignalRuntime");
  const cursor = { createdAt: 7, id: "remaining-outbox" };
  const clock = [0, 10];
  let settlementCalled = false;
  const result = await drainPrivateSignalWork({
    deadlineAt: 5,
    now: () => clock.shift() ?? 10,
    processOutboxPage: async () => ({
      scanned: 1,
      completed: 1,
      busy: 0,
      notDue: 0,
      blockedPredecessor: 0,
      alreadyComplete: 0,
      missing: 0,
      errors: [],
      nextCursor: cursor,
    }),
    settlePage: async () => {
      settlementCalled = true;
      return { attempted: 0, completed: 0, stillOpen: 0, errors: [], nextCursor: null };
    },
  });
  assert.equal(result.completeSweep, false);
  assert.equal(result.stoppedPhase, "outbox");
  assert.deepEqual(result.outbox.nextCursor, cursor);
  assert.equal(result.outbox.hasMore, true);
  assert.equal(result.settlement.hasMore, true);
  assert.equal(settlementCalled, false);
});

test("drain reports unscanned work honestly when deadline expires before page one", async () => {
  const { drainPrivateSignalWork } = await import("../src/lib/privateSignalRuntime");
  let outboxCalled = false;
  let settlementCalled = false;
  const result = await drainPrivateSignalWork({
    deadlineAt: 5,
    now: () => 5,
    processOutboxPage: async () => {
      outboxCalled = true;
      throw new Error("must not fetch after deadline");
    },
    settlePage: async () => {
      settlementCalled = true;
      throw new Error("must not fetch after deadline");
    },
  });
  assert.equal(result.completeSweep, false);
  assert.equal(result.stoppedPhase, "outbox");
  assert.equal(result.outbox.nextCursor, null);
  assert.equal(result.outbox.hasMore, true);
  assert.equal(result.settlement.hasMore, true);
  assert.equal(outboxCalled, false);
  assert.equal(settlementCalled, false);
});
