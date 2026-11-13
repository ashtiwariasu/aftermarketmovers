import assert from "node:assert/strict";
import test from "node:test";
import {
  conservativeUsSessionCloseAt,
  createPrivateSignalResearchRecord,
  researchHash,
  type PrivateSignalResearchRecord,
  type ResearchPriceBar,
} from "../src/lib/privateSignalResearch";

process.env.DESK_STORE = "memory";

const DAY_MS = 86_400_000;

function businessDates(count: number): string[] {
  const dates: string[] = [];
  let cursor = new Date("2025-01-02T00:00:00Z");
  while (dates.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return dates;
}

function history(): { stock: ResearchPriceBar[]; spy: ResearchPriceBar[]; dates: string[] } {
  const dates = businessDates(110);
  let stockPrice = 100;
  let spyPrice = 500;
  const stock = dates.map((date, index) => {
    const spyReturn = 0.0004 + Math.sin(index * 0.4) * 0.003;
    spyPrice *= 1 + spyReturn;
    stockPrice *= 1 + spyReturn * 1.1 + Math.cos(index * 0.7) * 0.001;
    return { date, close: stockPrice, adjustedClose: stockPrice, source: "test-adjusted" };
  });
  spyPrice = 500;
  const spy = dates.map((date, index) => {
    const spyReturn = 0.0004 + Math.sin(index * 0.4) * 0.003;
    spyPrice *= 1 + spyReturn;
    return { date, close: spyPrice, adjustedClose: spyPrice, source: "test-adjusted" };
  });
  return { stock, spy, dates };
}

function fixture(tag: string, options?: {
  ticker?: string;
  issuedAt?: number;
  noBars?: boolean;
}): { record: PrivateSignalResearchRecord; stock: ResearchPriceBar[]; spy: ResearchPriceBar[]; issueIndex: number } {
  const bars = history();
  const issueIndex = 79;
  const issueDate = bars.dates[issueIndex];
  const result = createPrivateSignalResearchRecord({
    ticker: options?.ticker ?? "ACME",
    thesis: `A sufficiently long private thesis fixture ${tag} for persistence and settlement testing.`,
    eventType: "earnings",
    direction: "UP",
    strength: "MODERATE",
    issuedAt: options?.issuedAt ?? conservativeUsSessionCloseAt(issueDate) + 1,
    sourceArtifact: {
      dossierArtifactVersion: 5,
      dossierDate: issueDate,
      councilRunId: `council-${tag}`,
      briefAuditId: `audit-${tag}`,
      emailHookSha256: researchHash({ tag, hook: "exact" }),
    },
    stockBars: options?.noBars ? [] : bars.stock.slice(0, issueIndex + 1),
    spyBars: options?.noBars ? [] : bars.spy.slice(0, issueIndex + 1),
    historicalEvents: [],
    config: { betaLookbackSessions: 60, minimumBetaSessions: 40 },
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return { record: result.record, stock: bars.stock, spy: bars.spy, issueIndex };
}

test("private signal creation is idempotent and cryptographic tampering fails closed", async () => {
  const { getPrivateSignalResearch, savePrivateSignalResearch } = await import("../src/lib/privateSignalStore");
  const { record } = fixture("idempotent");
  assert.equal(await savePrivateSignalResearch(record), "created");
  assert.equal(await savePrivateSignalResearch(structuredClone(record)), "exists");
  assert.deepEqual(await getPrivateSignalResearch(record.id), record);

  const tampered = { ...record, thesis: `${record.thesis} altered without rehashing` };
  await assert.rejects(() => savePrivateSignalResearch(tampered), /integrity failure: thesis-hash-mismatch/);
});

test("unresolved records are deterministically oldest-first and ticker history is exposed", async () => {
  const {
    listPrivateSignalsByTicker,
    listUnresolvedPrivateSignalPage,
    listUnresolvedPrivateSignals,
    savePrivateSignalResearch,
  } = await import("../src/lib/privateSignalStore");
  const older = fixture("queue-older", { ticker: "QUEUE", issuedAt: 1_800_000_000_000 }).record;
  const newer = fixture("queue-newer", { ticker: "QUEUE", issuedAt: 1_800_000_100_000 }).record;
  await savePrivateSignalResearch(newer);
  await savePrivateSignalResearch(older);

  const unresolved = await listUnresolvedPrivateSignals(500);
  assert.deepEqual(
    unresolved.filter((record) => [older.id, newer.id].includes(record.id)).map((record) => record.id),
    [older.id, newer.id],
  );
  const byTicker = await listPrivateSignalsByTicker("queue");
  assert.deepEqual(byTicker.map((record) => record.id), [older.id, newer.id]);
  const firstPage = await listUnresolvedPrivateSignalPage({ limit: 1 });
  assert.ok(firstPage.nextCursor);
  const secondPage = await listUnresolvedPrivateSignalPage({
    limit: 500,
    after: firstPage.nextCursor,
  });
  assert.equal(
    secondPage.records.some((candidate) => candidate.id === newer.id),
    true,
    "following the cursor sweeps past old pending observations",
  );
});

test("transactional settlement never overwrites an already-settled horizon from a stale caller", async () => {
  const {
    getPrivateSignalResearch,
    listUnresolvedPrivateSignals,
    resolveAndSavePrivateSignal,
    savePrivateSignalResearch,
  } = await import("../src/lib/privateSignalStore");
  const { record, stock, spy, issueIndex } = fixture("append-only-outcomes", { ticker: "SETTLE" });
  await savePrivateSignalResearch(record);
  const tenClose = conservativeUsSessionCloseAt(stock[issueIndex + 10].date) + 1;
  const partial = await resolveAndSavePrivateSignal({
    record,
    stockBars: stock.slice(0, issueIndex + 11),
    spyBars: spy.slice(0, issueIndex + 11),
    resolvedAt: tenClose,
  });
  assert.equal(partial.resolutionStatus, "partial");
  const settledTen = partial.outcomes[10]!;

  const revised = stock.map((bar, index) => index === issueIndex + 10
    ? { ...bar, close: Number(bar.close) * 4, adjustedClose: Number(bar.adjustedClose) * 4 }
    : bar);
  const complete = await resolveAndSavePrivateSignal({
    record, // deliberately stale: it has no 10-session outcome
    stockBars: revised.slice(0, issueIndex + 16),
    spyBars: spy.slice(0, issueIndex + 16),
    resolvedAt: conservativeUsSessionCloseAt(stock[issueIndex + 15].date) + 1,
  });
  assert.equal(complete.resolutionStatus, "complete");
  assert.equal(complete.outcomes[10]?.outcomeSha256.digest, settledTen.outcomeSha256.digest);
  assert.equal(complete.outcomes[10]?.resolvedAt, settledTen.resolvedAt);
  assert.ok(complete.outcomes[15]);
  assert.deepEqual(await getPrivateSignalResearch(record.id), complete);
  assert.equal(
    (await listUnresolvedPrivateSignals(500)).some((candidate) => candidate.id === record.id),
    false,
  );
});

test("a pending cold-start entry can be bound transactionally without changing its content address", async () => {
  const {
    hydrateAndSavePrivateSignal,
    savePrivateSignalResearch,
  } = await import("../src/lib/privateSignalStore");
  const fixtureData = fixture("pending-bind", { ticker: "PENDING", noBars: true });
  assert.equal(fixtureData.record.entryStatus, "pending");
  await savePrivateSignalResearch(fixtureData.record);
  const hydrated = await hydrateAndSavePrivateSignal({
    record: fixtureData.record,
    stockBars: fixtureData.stock.slice(0, fixtureData.issueIndex + 1),
    spyBars: fixtureData.spy.slice(0, fixtureData.issueIndex + 1),
    historicalEvents: [],
    boundAt: fixtureData.record.issuedAt + DAY_MS,
    config: { betaLookbackSessions: 60, minimumBetaSessions: 40 },
  });
  assert.equal(hydrated.id, fixtureData.record.id);
  assert.equal(hydrated.immutableRecordSha256.digest, fixtureData.record.immutableRecordSha256.digest);
  assert.equal(hydrated.entryStatus, "bound");
  assert.equal(hydrated.issuanceBetaStatus, "available");
});

test("ticker history is exhaustive and pageable beyond the former 500-record cap", async () => {
  const {
    listPrivateSignalsByTicker,
    listPrivateSignalsByTickerPage,
    listUnresolvedPrivateSignalPage,
    savePrivateSignalResearch,
  } = await import("../src/lib/privateSignalStore");
  const records = Array.from({ length: 525 }, (_, index) =>
    fixture(`long-history-${index}`, {
      ticker: "LONG",
      issuedAt: 1_900_000_000_000 + index,
    }).record);
  await Promise.all(records.map((record) => savePrivateSignalResearch(record)));

  const exhaustive = await listPrivateSignalsByTicker("LONG");
  assert.equal(exhaustive.length, 525);
  assert.equal(exhaustive[0].id, records[0].id);
  assert.equal(exhaustive.at(-1)?.id, records.at(-1)?.id);

  const paged: string[] = [];
  let after: { issuedAt: number; id: string } | null = null;
  do {
    const page = await listPrivateSignalsByTickerPage({ ticker: "LONG", pageSize: 73, after });
    paged.push(...page.records.map((record) => record.id));
    after = page.nextCursor;
  } while (after);
  assert.deepEqual(paged, records.map((record) => record.id));

  const queuedLong: string[] = [];
  let queueAfter: { issuedAt: number; id: string } | null = null;
  do {
    const page = await listUnresolvedPrivateSignalPage({ limit: 97, after: queueAfter });
    queuedLong.push(...page.records.filter((record) => record.ticker === "LONG").map((record) => record.id));
    queueAfter = page.nextCursor;
  } while (queueAfter);
  assert.deepEqual(queuedLong, records.map((record) => record.id));
});
