import assert from "node:assert/strict";
import test from "node:test";
import {
  assessEvidenceMateriality,
  normalizeExtractedClaim,
  packEvidenceSections,
  stableResearchEvidenceFingerprint,
  type EvidencePackMateriality,
} from "../src/lib/evidenceRoom";
import { fundamentalsFromCompanyFacts, fundamentalsMd } from "../src/lib/sec";

test("evidence packing admits complete sections and never slices source text", () => {
  const result = packEvidenceSections([
    { id: "core", priority: 0, text: "CORE-EVIDENCE" },
    { id: "large", priority: 1, text: "L".repeat(80) },
    { id: "small", priority: 2, text: "SMALL-EVIDENCE" },
  ], 35);

  assert.deepEqual(result.includedIds, ["core", "small"]);
  assert.deepEqual(result.excludedIds, ["large"]);
  assert.deepEqual(result.requiredExcludedIds, []);
  assert.equal(result.text, "CORE-EVIDENCE\n\nSMALL-EVIDENCE");
  assert.equal(result.text.includes("LLLL"), false);
});

test("evidence packing spends prompt space on higher priority evidence first", () => {
  const result = packEvidenceSections([
    { id: "news", priority: 2, text: "N".repeat(20) },
    { id: "claim-ledger", priority: 0, text: "C".repeat(20) },
    { id: "contradiction", priority: 0, text: "D".repeat(20) },
  ], 42);

  assert.deepEqual(result.includedIds, ["claim-ledger", "contradiction"]);
  assert.deepEqual(result.excludedIds, ["news"]);
});

test("evidence packing reports an excluded required section instead of slicing it", () => {
  const result = packEvidenceSections([
    { id: "required-filing", priority: 0, required: true, text: "F".repeat(80) },
    { id: "small", priority: 1, text: "small" },
  ], 20);
  assert.deepEqual(result.requiredExcludedIds, ["required-filing"]);
  assert.equal(result.text, "small");
  assert.equal(result.text.includes("FFFF"), false);
});

test("claim extraction normalizes model drift to the reconciliation contract", () => {
  const normalized = normalizeExtractedClaim({
    statement: "The regulator opened a new review of the proposed transaction.",
    eventType: "regulatory",
    sourceIds: ["S2", "S2", "bad"],
    authority: "primary",
    freshness: "today",
    relevance: 1.4,
    contradicts: "x".repeat(1_001),
  });
  assert.ok(normalized);
  assert.equal(normalized.eventType, "other");
  assert.deepEqual(normalized.sourceIds, ["S2"]);
  assert.equal(normalized.relevance, 1);
  assert.equal(normalized.contradicts, undefined);
});

test("claim extraction preserves social as an explicit low-grade authority family", () => {
  const normalized = normalizeExtractedClaim({
    statement: "Retail attention around the product event increased during the session.",
    eventType: "analyst",
    sourceIds: ["S8"],
    authority: "social",
    freshness: "today",
    relevance: 0.4,
  });
  assert.ok(normalized);
  assert.equal(normalized.authority, "social");
});

function evidenceState(
  citations: Array<{
    authority: "primary" | "company" | "independent" | "market-data" | "social";
    sourceDocumentId: string;
    url: string;
    publishedDate: string;
    contentSha256?: string;
  }>,
  dayChangePercent: number | null = 0.4,
  afterHoursChangePercent: number | null = 0.1,
  referencePrice: number | null = 100,
): EvidencePackMateriality {
  const stable = stableResearchEvidenceFingerprint(citations);
  return {
    stableEvidenceFingerprint: stable.fingerprint,
    stableEvidenceKeys: stable.keys,
    referencePrice,
    dayChangePercent,
    afterHoursChangePercent,
  };
}

test("materiality audit classifies routine market snapshots as unchanged", () => {
  const citations = [{
    authority: "primary" as const,
    sourceDocumentId: "sec-10q-2026q2",
    url: "https://www.sec.gov/example",
    publishedDate: "2026-07-30",
    contentSha256: "a".repeat(64),
  }];
  const prior = evidenceState(citations);
  const current = evidenceState([
    ...citations,
    {
      authority: "market-data" as const,
      sourceDocumentId: "daily-price-2026-08-04",
      url: "https://example.test/price",
      publishedDate: "2026-08-04",
      contentSha256: "b".repeat(64),
    },
  ]);

  const assessment = assessEvidenceMateriality({ materiality: current }, prior, 123);
  assert.equal(assessment.needsCouncil, false);
  assert.deepEqual(assessment.reasons, ["evidence-unchanged"]);
  assert.deepEqual(assessment.newStableEvidenceKeys, []);
  assert.equal(assessment.checkedAt, 123);
});

test("newly admitted social evidence still receives the full frontier council", () => {
  const primary = {
    authority: "primary" as const,
    sourceDocumentId: "sec-10q-2026q2",
    url: "https://www.sec.gov/example",
    publishedDate: "2026-07-30",
    contentSha256: "a".repeat(64),
  };
  const prior = evidenceState([primary]);
  const current = evidenceState([primary, {
    authority: "social" as const,
    sourceDocumentId: "x-post-123",
    url: "https://x.com/example/status/123",
    publishedDate: "2026-08-04",
    contentSha256: "c".repeat(64),
  }]);

  const assessment = assessEvidenceMateriality({ materiality: current }, prior);
  assert.equal(assessment.needsCouncil, true);
  assert.ok(assessment.reasons.includes("new-stable-evidence"));
  assert.equal(assessment.newStableEvidenceKeys.length, 1);
});

test("material price moves rerun the council even without new stable evidence", () => {
  const citations = [{
    authority: "company" as const,
    sourceDocumentId: "ir-release",
    url: "https://example.test/ir",
    publishedDate: "2026-08-01",
    contentSha256: "d".repeat(64),
  }];
  const prior = evidenceState(citations);
  const current = evidenceState(citations, -2.1, 1.05);

  const assessment = assessEvidenceMateriality({ materiality: current }, prior);
  assert.equal(assessment.needsCouncil, true);
  assert.ok(assessment.reasons.includes("material-day-move"));
  assert.ok(assessment.reasons.includes("material-after-hours-move"));
  assert.deepEqual(assessment.newStableEvidenceKeys, []);
});

test("cumulative quiet moves eventually rerun the council", () => {
  const citations = [{
    authority: "primary" as const,
    sourceDocumentId: "sec-10q",
    url: "https://www.sec.gov/example",
    publishedDate: "2026-07-30",
    contentSha256: "e".repeat(64),
  }];
  const prior = evidenceState(citations, 0.4, 0.1, 100);
  const current = evidenceState(citations, 0.6, 0.1, 102.1);

  const assessment = assessEvidenceMateriality({ materiality: current }, prior);
  assert.equal(assessment.needsCouncil, true);
  assert.ok(assessment.reasons.includes("material-cumulative-move"));
  assert.ok((assessment.cumulativeChangePercent ?? 0) >= 2);
});

test("removed admitted evidence reruns the council", () => {
  const primary = {
    authority: "primary" as const,
    sourceDocumentId: "sec-10q",
    url: "https://www.sec.gov/example",
    publishedDate: "2026-07-30",
    contentSha256: "f".repeat(64),
  };
  const company = {
    authority: "company" as const,
    sourceDocumentId: "ir-release",
    url: "https://example.test/ir",
    publishedDate: "2026-08-01",
    contentSha256: "a".repeat(64),
  };
  const assessment = assessEvidenceMateriality(
    { materiality: evidenceState([primary]) },
    evidenceState([primary, company]),
  );
  assert.equal(assessment.needsCouncil, true);
  assert.ok(assessment.reasons.includes("stable-evidence-removed"));
  assert.equal(assessment.removedStableEvidenceKeys.length, 1);
});

test("filed fundamentals expose the operating, cash, securities and debt bridge already present in SEC XBRL", () => {
  const duration = (start: string, end: string, val: number, fy = 2026, filed = `${fy}-04-30`) => ({
    start, end, val, form: "10-Q", fp: "Q1", fy, filed,
  });
  const instant = (end: string, val: number) => ({ end, val, form: "10-Q", fp: "Q1", fy: 2026 });
  const facts = fundamentalsFromCompanyFacts({
    facts: { "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
        duration("2025-01-01", "2025-03-31", 90_230_000_000, 2025),
      ] } },
      // Alphabet migrated back to the broader Revenues tag. The current filing
      // repeats the prior-year comparison with its own FY label; the combined
      // series must preserve the original period and continue across the tag.
      Revenues: { units: { USD: [
        // Later comparative contexts can carry the current filing's FY label;
        // the original period label must win for the historical series.
        duration("2025-01-01", "2025-03-31", 90_230_000_000, 2026, "2026-04-30"),
        duration("2026-01-01", "2026-03-31", 109_900_000_000),
      ] } },
      NetIncomeLoss: { units: { USD: [
        duration("2025-01-01", "2025-03-31", 34_575_000_000, 2025),
        duration("2026-01-01", "2026-03-31", 62_580_000_000),
      ] } },
      EarningsPerShareDiluted: { units: { "USD/shares": [
        duration("2025-01-01", "2025-03-31", 2.81, 2025),
        duration("2026-01-01", "2026-03-31", 5.11),
      ] } },
      OperatingIncomeLoss: { units: { USD: [duration("2026-01-01", "2026-03-31", 39_696_000_000)] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [duration("2026-01-01", "2026-03-31", 45_790_000_000)] } },
      PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [duration("2026-01-01", "2026-03-31", 35_674_000_000)] } },
      EquitySecuritiesFvNiGainLoss: { units: { USD: [duration("2026-01-01", "2026-03-31", 36_915_000_000)] } },
      IncomeTaxExpenseBenefit: { units: { USD: [duration("2026-01-01", "2026-03-31", 14_834_000_000)] } },
      CashCashEquivalentsAndShortTermInvestments: { units: { USD: [instant("2026-03-31", 126_840_000_000)] } },
      Assets: { units: { USD: [instant("2026-03-31", 703_919_000_000)] } },
      LongTermDebtCurrent: { units: { USD: [instant("2026-03-31", 1_998_000_000)] } },
      LongTermDebtNoncurrent: { units: { USD: [instant("2026-03-31", 77_501_000_000)] } },
    } },
  });
  assert.ok(facts);
  assert.equal(facts.schemaVersion, 2);
  assert.equal(facts.securitiesGainLoss?.value, 36_915_000_000);
  assert.equal(facts.operatingCashFlow?.value, 45_790_000_000);
  assert.equal(facts.longTermDebt?.value, 77_501_000_000);

  const rendered = fundamentalsMd("GOOGL", facts);
  assert.match(rendered, /Equity-securities gain\/loss: \$36\.92B/);
  assert.match(rendered, /Operating cash flow less capital expenditures: \$10\.12B/);
  assert.match(rendered, /Current plus long-term debt: \$79\.50B/);
  assert.match(rendered, /may be non-consecutive/);
  assert.match(rendered, /Q1 FY2025 \(2025-03-31\)/);
  assert.doesNotMatch(rendered, /last \d+ quarters/i);
});
