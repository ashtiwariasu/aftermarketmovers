import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIVATE_SIGNAL_HASH_VERSION,
  PRIVATE_SIGNAL_METHOD_VERSION,
  calibratePrivateSignal,
  conservativeUsSessionCloseAt,
  createPrivateSignalResearchRecord,
  hydratePrivateSignalResearchRecord,
  historicalEventsFromPrivateSignals,
  researchHash,
  resolvePrivateSignalOutcomes,
  selectLatestIssuanceEligibleSession,
  verifyPrivateSignalRecordIntegrity,
  type HistoricalSignalEvent,
  type PrivateSignalResearchRecord,
  type ResearchPriceBar,
} from "../src/lib/privateSignalResearch";

const DAY_MS = 86_400_000;

function businessDates(count: number, start = "2022-01-03"): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return dates;
}

function syntheticResearchHistory(): {
  stock: ResearchPriceBar[];
  spy: ResearchPriceBar[];
  events: HistoricalSignalEvent[];
  issueSessionDate: string;
  issuedAt: number;
  issueIndex: number;
} {
  const dates = businessDates(1_000);
  const upIndices = Array.from({ length: 22 }, (_, index) => 170 + index * 30);
  const downIndices = Array.from({ length: 22 }, (_, index) => 185 + index * 30);
  const events: HistoricalSignalEvent[] = [
    ...upIndices.map((index, sequence) => ({
      id: `earnings-up-${sequence}`,
      ticker: "ACME",
      signalSessionDate: dates[index],
      eventType: "earnings",
      direction: "UP" as const,
      issuedAt: conservativeUsSessionCloseAt(dates[index]) + 1,
    })),
    ...downIndices.map((index, sequence) => ({
      id: `regulatory-down-${sequence}`,
      ticker: "ACME",
      signalSessionDate: dates[index],
      eventType: "regulatory",
      direction: "DOWN" as const,
      issuedAt: conservativeUsSessionCloseAt(dates[index]) + 1,
    })),
    {
      id: "wrong-ticker",
      ticker: "OTHER",
      signalSessionDate: dates[300],
      eventType: "earnings",
      direction: "UP",
      issuedAt: conservativeUsSessionCloseAt(dates[300]) + 1,
    },
  ];
  let stockPrice = 100;
  let spyPrice = 400;
  const stock: ResearchPriceBar[] = [];
  const spy: ResearchPriceBar[] = [];

  for (let index = 0; index < dates.length; index += 1) {
    const spyReturn = 0.0002 + Math.sin(index * 0.31) * 0.004;
    let residual = Math.sin(index * 0.77) * 0.0007;
    if (upIndices.some((eventIndex) => index > eventIndex && index <= eventIndex + 15)) {
      residual += 0.0045;
    }
    if (downIndices.some((eventIndex) => index > eventIndex && index <= eventIndex + 15)) {
      residual -= 0.0048;
    }
    spyPrice *= 1 + spyReturn;
    stockPrice *= 1 + 1.18 * spyReturn + residual;
    spy.push({
      date: dates[index],
      close: spyPrice,
      adjustedClose: spyPrice,
      source: "tiingo-adjusted-eod",
    });
    stock.push({
      date: dates[index],
      close: stockPrice,
      adjustedClose: stockPrice,
      source: "tiingo-adjusted-eod",
    });
  }
  return {
    stock,
    spy,
    events,
    issueSessionDate: dates[900],
    issuedAt: conservativeUsSessionCloseAt(dates[900]) + 1,
    issueIndex: 900,
  };
}

function requireCalibration(input: Parameters<typeof calibratePrivateSignal>[0]) {
  const result = calibratePrivateSignal(input);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.calibration;
}

function requireRecord(input: Parameters<typeof createPrivateSignalResearchRecord>[0]): PrivateSignalResearchRecord {
  const result = createPrivateSignalResearchRecord(input);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.record;
}

function sourceArtifact(date: string) {
  return {
    dossierArtifactVersion: 5,
    dossierDate: date,
    councilRunId: `council-${date}`,
    briefAuditId: `audit-${date}`,
    emailHookSha256: researchHash({ date, hook: "exact gated hook" }),
  };
}

test("calibration is signed, exact-event-conditioned, SPY-relative, and walk-forward", () => {
  const history = syntheticResearchHistory();
  const up = requireCalibration({
    ticker: "ACME",
    eventType: "earnings",
    direction: "UP",
    issueSessionDate: history.issueSessionDate,
    issuedAt: history.issuedAt,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: history.events,
  });
  const down = requireCalibration({
    ticker: "ACME",
    eventType: "regulatory",
    direction: "DOWN",
    issueSessionDate: history.issueSessionDate,
    issuedAt: history.issuedAt,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: history.events,
  });

  assert.equal(up.methodVersion, PRIVATE_SIGNAL_METHOD_VERSION);
  assert.deepEqual(up.condition, {
    eventType: "earnings",
    direction: "UP",
    fallbackToPooledEvents: false,
  });
  assert.equal(up.semantics.measure, "stock_total_return_minus_beta_times_spy_total_return");
  assert.equal(up.semantics.signPreserved, true);
  assert.equal(up.semantics.magnitudeOnly, false);
  assert.equal(up.walkForward.noLookAhead, true);
  assert.equal(up.walkForward.overlappingOutcomeWindowsExcludedFromEffectiveSample, true);
  assert.ok(up.bands[10].signedSpyRelativeReturnPct.median > 0);
  assert.ok(up.bands[15].signedSpyRelativeReturnPct.median > 0);
  assert.ok(down.bands[10].signedSpyRelativeReturnPct.median < 0);
  assert.ok(down.bands[15].signedSpyRelativeReturnPct.median < 0);
  assert.ok(up.bands[10].predictedDirectionHitRate > 0.5);
  assert.ok(down.bands[10].predictedDirectionHitRate > 0.5);
  assert.equal(up.sampleAccounting.exactEventAndDirectionMatches, 22);
  assert.equal(up.sampleAccounting.uniqueMatchedSignalSessions, 22);
  assert.ok(up.sampleAccounting.horizons[15].effectiveNonOverlapping >= 20);
  assert.deepEqual(up.sources.stock, ["tiingo-adjusted-eod"]);
  assert.deepEqual(up.sources.benchmark, ["tiingo-adjusted-eod"]);
});

test("future prices cannot leak into a current calibration", () => {
  const history = syntheticResearchHistory();
  const input = {
    ticker: "ACME",
    eventType: "earnings",
    direction: "UP" as const,
    issueSessionDate: history.issueSessionDate,
    issuedAt: history.issuedAt,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: history.events,
  };
  const baseline = requireCalibration(input);
  const rewrittenFuture = history.stock.map((bar, index) => index > history.issueIndex
    ? { ...bar, close: Number(bar.close) * 8, adjustedClose: Number(bar.adjustedClose) * 8 }
    : bar);
  const afterRewrite = requireCalibration({ ...input, stockBars: rewrittenFuture });
  assert.deepEqual(afterRewrite, baseline);
  assert.equal(afterRewrite.walkForward.evaluationCutoffSession, history.stock[899].date);
});

test("duplicate and overlapping event windows are counted but not treated as independent", () => {
  const history = syntheticResearchHistory();
  const clustered: HistoricalSignalEvent[] = [
    ...history.events,
    {
      id: "duplicate-same-session",
      ticker: "ACME",
      signalSessionDate: history.events[0].signalSessionDate,
      eventType: "earnings",
      direction: "UP",
      issuedAt: history.events[0].issuedAt + 1,
    },
    {
      id: "overlap-two-sessions-later",
      ticker: "ACME",
      signalSessionDate: history.stock[172].date,
      eventType: "earnings",
      direction: "UP",
      issuedAt: conservativeUsSessionCloseAt(history.stock[172].date) + 1,
    },
  ];
  const calibration = requireCalibration({
    ticker: "ACME",
    eventType: "earnings",
    direction: "UP",
    issueSessionDate: history.issueSessionDate,
    issuedAt: history.issuedAt,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: clustered,
  });
  assert.equal(calibration.sampleAccounting.exactEventAndDirectionMatches, 24);
  assert.equal(calibration.sampleAccounting.uniqueMatchedSignalSessions, 23);
  assert.ok(
    calibration.sampleAccounting.horizons[15].effectiveNonOverlapping <
      calibration.sampleAccounting.horizons[15].resolvedBeforeIssue,
  );
  assert.equal(
    calibration.bands[15].effectiveNonOverlappingSamples,
    calibration.sampleAccounting.horizons[15].effectiveNonOverlapping,
  );
});

test("a private log is content-addressed per exact thesis and never marked publishable", () => {
  const history = syntheticResearchHistory();
  const base = {
    ticker: "ACME",
    thesis: "Recurring cloud demand should outweigh near-term capacity costs over the measured window.",
    eventType: "earnings",
    direction: "UP" as const,
    strength: "MODERATE" as const,
    sourceArtifact: sourceArtifact(history.issueSessionDate),
    issuedAt: history.issuedAt,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: history.events,
  };
  const first = requireRecord(base);
  const repeated = requireRecord({
    ...base,
    stockBars: [...history.stock].reverse(),
    spyBars: [...history.spy].reverse(),
  });
  const changed = requireRecord({ ...base, thesis: `${base.thesis} New evidence changes the test.` });

  assert.deepEqual(repeated, first);
  assert.notEqual(changed.id, first.id);
  assert.notEqual(changed.thesisSha256.digest, first.thesisSha256.digest);
  assert.equal(first.visibility, "private-research-only");
  assert.equal(first.publicationStatus, "withheld-pending-track-record-and-legal-review");
  assert.equal(first.publicUseProhibited, true);
  assert.equal(first.calibrationStatus, "calibrated");
  assert.equal(first.entryStatus, "bound");
  assert.equal(first.issuanceBetaStatus, "available");
  assert.ok(first.calibration);
  assert.equal(first.thesisSha256.canonicalization, PRIVATE_SIGNAL_HASH_VERSION);
  assert.equal(first.immutableRecordSha256.digest.length, 64);
  assert.equal(first.id, first.immutableRecordSha256.digest.slice(0, 48));
  assert.deepEqual(researchHash({ b: 2, a: 1 }), researchHash({ a: 1, b: 2 }));
  assert.equal(verifyPrivateSignalRecordIntegrity(first).ok, true);
  assert.equal(first.sourceArtifact.councilRunId, `council-${history.issueSessionDate}`);
});

test("outcomes resolve after exactly 10 and 15 aligned sessions with frozen SPY semantics", () => {
  const history = syntheticResearchHistory();
  const record = requireRecord({
    ticker: "ACME",
    thesis: "Recurring cloud demand should support relative performance over the measured window.",
    eventType: "earnings",
    direction: "UP",
    strength: "MODERATE",
    issuedAt: Date.parse(`${history.issueSessionDate}T21:00:00Z`),
    sourceArtifact: sourceArtifact(history.issueSessionDate),
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: history.events,
  });
  const unresolved = resolvePrivateSignalOutcomes(
    record,
    history.stock.slice(0, history.issueIndex + 10),
    history.spy.slice(0, history.issueIndex + 10),
  );
  assert.equal(unresolved.resolutionStatus, "pending");

  const partial = resolvePrivateSignalOutcomes(
    record,
    history.stock.slice(0, history.issueIndex + 11),
    history.spy.slice(0, history.issueIndex + 11),
    conservativeUsSessionCloseAt(history.stock[history.issueIndex + 10].date) + 1,
  );
  assert.equal(partial.resolutionStatus, "partial");
  assert.ok(partial.outcomes[10]);
  assert.equal(partial.outcomes[15], undefined);
  assert.equal(partial.outcomes[10]?.exitSessionDate, history.stock[history.issueIndex + 10].date);
  const expectedSigned = partial.outcomes[10]!.stockTotalReturnPct -
    record.issuanceBeta!.value * partial.outcomes[10]!.spyTotalReturnPct;
  assert.ok(Math.abs(partial.outcomes[10]!.signedSpyRelativeReturnPct - expectedSigned) < 0.001);

  const complete = resolvePrivateSignalOutcomes(
    partial,
    history.stock.slice(0, history.issueIndex + 16),
    history.spy.slice(0, history.issueIndex + 16),
    conservativeUsSessionCloseAt(history.stock[history.issueIndex + 15].date) + 1,
  );
  assert.equal(complete.resolutionStatus, "complete");
  assert.equal(complete.resolutionQueueKey, undefined);
  assert.ok(complete.outcomes[15]);
  assert.equal(
    complete.outcomes[10]?.resolvedAt,
    conservativeUsSessionCloseAt(history.stock[history.issueIndex + 10].date) + 1,
    "a later pass must not rewrite the 10-session result",
  );
  assert.equal(
    complete.outcomes[15]?.resolvedAt,
    conservativeUsSessionCloseAt(history.stock[history.issueIndex + 15].date) + 1,
  );
  assert.equal(complete.outcomes[15]?.sourceBarsSha256.canonicalization, PRIVATE_SIGNAL_HASH_VERSION);
  assert.match(complete.outcomes[15]!.outcomeSha256.digest, /^[0-9a-f]{64}$/);
});

test("calibration fails closed when the effective event sample is too small", () => {
  const history = syntheticResearchHistory();
  const result = calibratePrivateSignal({
    ticker: "ACME",
    eventType: "earnings",
    direction: "UP",
    issueSessionDate: history.issueSessionDate,
    issuedAt: history.issuedAt,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: history.events.slice(0, 3),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "insufficient-effective-event-samples");
    assert.ok((result.sampleAccounting?.horizons[10].effectiveNonOverlapping ?? 99) < 20);
  }
});

test("cold start still logs and resolves every thesis without inventing a band", () => {
  const history = syntheticResearchHistory();
  const created = createPrivateSignalResearchRecord({
    ticker: "ACME",
    thesis: "A new product event may change relative performance, but the cohort is still immature.",
    eventType: "product",
    direction: "UP",
    strength: "GENTLE",
    issuedAt: Date.parse(`${history.issueSessionDate}T21:00:00Z`),
    sourceArtifact: sourceArtifact(history.issueSessionDate),
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: [],
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.record.calibrationStatus, "insufficient-sample");
  assert.equal(created.record.calibration, undefined);
  assert.equal(created.record.calibrationFailure?.reason, "insufficient-effective-event-samples");
  assert.ok(Number.isFinite(created.record.issuanceBeta?.value));

  const resolved = resolvePrivateSignalOutcomes(
    created.record,
    history.stock.slice(0, history.issueIndex + 16),
    history.spy.slice(0, history.issueIndex + 16),
  );
  assert.equal(resolved.resolutionStatus, "complete");
  assert.equal(resolved.outcomes[10]?.insideCalibratedBand, null);
  assert.equal(resolved.outcomes[15]?.insideCalibratedBand, null);
  assert.ok(Number.isFinite(resolved.outcomes[15]?.signedSpyRelativeReturnPct));
});

test("a no-data cold start is logged pending and can bind only an issuance-eligible close", () => {
  const history = syntheticResearchHistory();
  const issuedAt = conservativeUsSessionCloseAt(history.issueSessionDate) + 60_000;
  const pending = requireRecord({
    ticker: "ACME",
    thesis: "A newly admitted signal must be recorded even while its research bars are still unavailable.",
    eventType: "product",
    direction: "DOWN",
    strength: "GENTLE",
    issuedAt,
    sourceArtifact: sourceArtifact(history.issueSessionDate),
    stockBars: [],
    spyBars: [],
    historicalEvents: [],
  });
  assert.equal(pending.entryStatus, "pending");
  assert.match(pending.resolutionQueueKey ?? "", /^\d{16}\|[0-9a-f]{48}$/);
  assert.equal(pending.entryPendingReason, "no-aligned-close-observable-at-issuance");
  assert.equal(pending.entryBinding, undefined);
  assert.equal(pending.issuanceBetaStatus, "pending-entry");
  assert.equal(pending.calibrationStatus, "pending-entry");
  assert.equal(verifyPrivateSignalRecordIntegrity(pending).ok, true);

  const bound = hydratePrivateSignalResearchRecord({
    record: pending,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: [],
    boundAt: issuedAt + DAY_MS,
  });
  assert.equal(bound.entryStatus, "bound");
  assert.equal(bound.entryBinding?.sessionDate, history.issueSessionDate);
  assert.ok((bound.entryBinding?.sessionClosedAt ?? Infinity) <= issuedAt);
  assert.equal(bound.calibrationStatus, "insufficient-sample");
  assert.equal(verifyPrivateSignalRecordIntegrity(bound).ok, true);
  assert.deepEqual(historicalEventsFromPrivateSignals([pending, bound]), [{
    id: bound.id,
    ticker: "ACME",
    signalSessionDate: history.issueSessionDate,
    eventType: "product",
    direction: "DOWN",
    strength: "GENTLE",
    thesisSha256: bound.thesisSha256.digest,
    issuedAt,
  }]);
});

test("Tuesday after a Monday market holiday defers with zero bars then binds Friday", () => {
  const friday = "2026-09-04";
  const tuesday = "2026-09-08";
  const issuedAt = Date.parse("2026-09-08T12:00:00Z"); // 08:00 America/New_York
  const pending = requireRecord({
    ticker: "ACME",
    thesis: "A holiday-adjacent premarket thesis must wait for bars without guessing Monday or Tuesday.",
    eventType: "macro",
    direction: "DOWN",
    strength: "MODERATE",
    issuedAt,
    sourceArtifact: sourceArtifact(tuesday),
    stockBars: [],
    spyBars: [],
    historicalEvents: [],
  });
  assert.equal(pending.entryStatus, "pending");
  assert.equal(pending.entryBinding, undefined);

  const stock: ResearchPriceBar[] = [
    { date: friday, close: 100, adjustedClose: 100, source: "test-adjusted" },
    { date: tuesday, close: 95, adjustedClose: 95, source: "test-adjusted" },
  ];
  const spy: ResearchPriceBar[] = [
    { date: friday, close: 500, adjustedClose: 500, source: "test-adjusted" },
    { date: tuesday, close: 490, adjustedClose: 490, source: "test-adjusted" },
  ];
  const bound = hydratePrivateSignalResearchRecord({
    record: pending,
    stockBars: stock,
    spyBars: spy,
    historicalEvents: [],
    boundAt: conservativeUsSessionCloseAt(tuesday) + DAY_MS,
  });
  assert.equal(bound.id, pending.id);
  assert.equal(bound.immutableRecordSha256.digest, pending.immutableRecordSha256.digest);
  assert.equal(bound.entryStatus, "bound");
  assert.equal(bound.entryBinding?.sessionDate, friday);
  assert.ok((bound.entryBinding?.sessionClosedAt ?? Infinity) <= issuedAt);
  assert.equal(verifyPrivateSignalRecordIntegrity(bound).ok, true);
});

test("eligible-session selection never chooses a close later than issuance", () => {
  const history = syntheticResearchHistory();
  const currentClose = conservativeUsSessionCloseAt(history.issueSessionDate);
  const selected = selectLatestIssuanceEligibleSession({
    stockBars: history.stock,
    spyBars: history.spy,
    issuedAt: currentClose - 1,
  });
  assert.equal(selected?.sessionDate, history.stock[history.issueIndex - 1].date);
  assert.ok((selected?.sessionClosedAt ?? Infinity) <= currentClose - 1);
});

test("Friday premarket binds Thursday while the Friday close remains ineligible", () => {
  const friday = "2026-07-17";
  const thursday = "2026-07-16";
  const issuedAt = Date.parse("2026-07-17T12:00:00Z"); // 08:00 America/New_York
  const stock: ResearchPriceBar[] = [
    { date: thursday, close: 100, adjustedClose: 100, source: "test-adjusted" },
    { date: friday, close: 101, adjustedClose: 101, source: "test-adjusted" },
  ];
  const spy: ResearchPriceBar[] = [
    { date: thursday, close: 500, adjustedClose: 500, source: "test-adjusted" },
    { date: friday, close: 502, adjustedClose: 502, source: "test-adjusted" },
  ];
  const record = requireRecord({
    ticker: "ACME",
    thesis: "Premarket issuance must never borrow the still-future closing price from the same session.",
    eventType: "earnings",
    direction: "UP",
    strength: "MODERATE",
    issuedAt,
    sourceArtifact: sourceArtifact(friday),
    stockBars: stock,
    spyBars: spy,
    historicalEvents: [],
  });
  assert.equal(record.entryStatus, "bound");
  assert.equal(record.sourceArtifact.dossierDate, friday);
  assert.equal(record.entryBinding?.sessionDate, thursday);
  assert.ok((record.entryBinding?.sessionClosedAt ?? Infinity) <= record.issuedAt);
  const retried = hydratePrivateSignalResearchRecord({
    record,
    stockBars: stock,
    spyBars: spy,
    historicalEvents: [],
    boundAt: conservativeUsSessionCloseAt(friday) + DAY_MS,
  });
  assert.equal(retried.entryStatus, "bound");
  assert.equal(retried.entryBinding?.sessionDate, thursday);
  assert.equal(retried.entryBinding?.bindingSha256.digest, record.entryBinding?.bindingSha256.digest);
  assert.equal(verifyPrivateSignalRecordIntegrity(retried).ok, true);
});

test("an eligible entry can bind while beta and calibration remain explicitly unavailable", () => {
  const history = syntheticResearchHistory();
  const stock = history.stock.slice(history.issueIndex - 4, history.issueIndex + 1);
  const spy = history.spy.slice(history.issueIndex - 4, history.issueIndex + 1);
  const record = requireRecord({
    ticker: "ACME",
    thesis: "The observation exists even when the beta lookback has not yet been backfilled.",
    eventType: "legal",
    direction: "DOWN",
    strength: "GENTLE",
    issuedAt: conservativeUsSessionCloseAt(history.issueSessionDate) + 1,
    sourceArtifact: sourceArtifact(history.issueSessionDate),
    stockBars: stock,
    spyBars: spy,
    historicalEvents: [],
  });
  assert.equal(record.entryStatus, "bound");
  assert.equal(record.issuanceBetaStatus, "unavailable");
  assert.equal(record.issuanceBeta, undefined);
  assert.equal(record.calibrationStatus, "unavailable");
  assert.equal(record.calibrationFailure?.reason, "insufficient-beta-history");
  assert.equal(verifyPrivateSignalRecordIntegrity(record).ok, true);
});

test("future events are excluded from accounting and every issuance hash", () => {
  const history = syntheticResearchHistory();
  const futureEvent: HistoricalSignalEvent = {
    id: "future-event",
    ticker: "ACME",
    signalSessionDate: history.stock[history.issueIndex + 20].date,
    eventType: "earnings",
    direction: "UP",
    issuedAt: Date.parse(`${history.stock[history.issueIndex + 20].date}T21:00:00Z`),
  };
  const lateBackfill: HistoricalSignalEvent = {
    id: "late-backfill",
    ticker: "ACME",
    signalSessionDate: history.stock[300].date,
    eventType: "earnings",
    direction: "UP",
    issuedAt: history.issuedAt + DAY_MS,
  };
  const calibrationInput = {
    ticker: "ACME",
    eventType: "earnings",
    direction: "UP" as const,
    issueSessionDate: history.issueSessionDate,
    issuedAt: conservativeUsSessionCloseAt(history.issueSessionDate) + 1,
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: history.events,
  };
  const baseline = requireCalibration(calibrationInput);
  const withFuture = requireCalibration({
    ...calibrationInput,
    historicalEvents: [...history.events, futureEvent, lateBackfill],
  });
  assert.deepEqual(withFuture, baseline);

  const recordInput = {
    ...calibrationInput,
    thesis: "Future signals must not alter the recorded accounting or the content address of this thesis.",
    strength: "MODERATE" as const,
    sourceArtifact: sourceArtifact(history.issueSessionDate),
  };
  const first = requireRecord(recordInput);
  const second = requireRecord({
    ...recordInput,
    historicalEvents: [...history.events, futureEvent, lateBackfill],
  });
  assert.deepEqual(second, first);
});

test("integrity verification recomputes immutable and append-only hashes", () => {
  const history = syntheticResearchHistory();
  const record = requireRecord({
    ticker: "ACME",
    thesis: "Cryptographic verification must detect stored content changes instead of trusting its digest field.",
    eventType: "capital",
    direction: "DOWN",
    strength: "STRONG",
    issuedAt: conservativeUsSessionCloseAt(history.issueSessionDate) + 1,
    sourceArtifact: sourceArtifact(history.issueSessionDate),
    stockBars: history.stock,
    spyBars: history.spy,
    historicalEvents: [],
  });
  const tampered = { ...record, thesis: `${record.thesis} tampered` };
  const verified = verifyPrivateSignalRecordIntegrity(tampered);
  assert.equal(verified.ok, false);
  if (!verified.ok) assert.equal(verified.reason, "thesis-hash-mismatch");
  const queueTampered = { ...record, resolutionQueueKey: "0000000000000000|wrong" };
  const queueVerified = verifyPrivateSignalRecordIntegrity(queueTampered);
  assert.equal(queueVerified.ok, false);
  if (!queueVerified.ok) assert.equal(queueVerified.reason, "resolution-queue-key-mismatch");
});
