import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";
process.env.OPENROUTER_API_KEY_AMM = "test-key";

const DAY = 86_400_000;
const baseTime = Date.parse("2026-07-20T12:00:00Z");

function citation(input: {
  id: string;
  date: string;
  authority?: "primary" | "company" | "independent" | "social";
  hash?: string;
}) {
  const publishedAt = Date.parse(`${input.date}T12:00:00Z`);
  return {
    id: input.id,
    title: `${input.id} evidence`,
    url: `https://example.com/${input.id}`,
    publisher: input.authority === "company" ? "Company IR" : "SEC",
    authority: input.authority ?? "primary",
    publishedAt,
    publishedDate: input.date,
    retrievedAt: publishedAt + 1_000,
    contentSha256: input.hash ?? input.id.repeat(8).slice(0, 64),
    sourceDocumentId: input.id,
    evidenceState: "verified" as const,
  };
}

function dossier(ticker: string, date: string, citations: ReturnType<typeof citation>[]) {
  return {
    ticker,
    date,
    generatedAt: Date.parse(`${date}T13:00:00Z`),
    artifactVersion: 5,
    headline: `${ticker} audited research`,
    story: "The complete audited story remains available to the adjudicator.",
    bulls: ["The primary filing supports the constructive interpretation."],
    bears: ["The primary filing also preserves a material risk."],
    risk: "The proposition remains falsifiable against the next filing.",
    numbersRead: "Revenue, operating income and cash flow were recomputed from filed values.",
    signalCase: {
      eventType: "earnings" as const,
      direction: "UP" as const,
      strength: "GENTLE" as const,
      horizonSessions: { min: 10 as const, max: 15 as const },
      mechanism: "Filed cash conversion supports the standing proposition.",
      invalidation: "A later filing showing negative conversion invalidates it.",
    },
    sources: "Every claim is mapped to the admitted manifest.",
    citations,
    briefAuditId: `audit-${ticker}-${date}`,
    seats: 5,
    emailHook: {
      subjectPunchline: `${ticker} filed cash conversion remains intact`,
      priorUpdate: null,
      whatChanged: "A new filing entered the record.",
      thesis: "The filed cash conversion supports the standing proposition.",
      question: "Will filed cash conversion remain positive?",
      primaryEvidence: "The filing reports positive operating cash flow.",
      secondaryEvidence: [],
      signal: {
        eventType: "earnings" as const,
        direction: "UP" as const,
        strength: "GENTLE" as const,
        horizonSessions: { min: 10 as const, max: 15 as const },
        mechanism: "Filed cash conversion supports the standing proposition.",
        invalidation: "A later filing showing negative conversion invalidates it.",
      },
      votesSupport: 4,
      votesOppose: 0,
      votesUncertain: 1,
      votesTotal: 5 as const,
      votes: { support: 4, oppose: 0, uncertain: 1 },
      confidence: {
        majority: "Four analysts support the standing proposition.",
        reservation: "One analyst requires a second filed period.",
        flipCondition: "Negative filed conversion would change the read.",
      },
      oracle: {
        type: "filing" as const,
        trigger: "The next filed earnings release resolves the proposition.",
        dueBy: "2026-10-31",
      },
      editorialStrength: {
        novelty: 4,
        materiality: 4,
        evidence: 5,
        asymmetry: 3,
        score: 4,
      },
    },
  };
}

function question(ticker: string) {
  return {
    id: `${ticker}:quality-test`,
    ticker,
    question: "Will filed cash conversion remain positive?",
    thesis: "The filed cash conversion supports the standing proposition.",
    votesYes: 4,
    votesTotal: 5,
    publishedAt: baseTime,
    publishedDate: "2026-07-20",
    oracle: {
      type: "filing" as const,
      trigger: "The next filed earnings release resolves the proposition.",
      dueBy: "2026-10-31",
    },
    status: "open" as const,
  };
}

async function cleanMemory() {
  const global = globalThis as Record<string, unknown>;
  for (const key of [
    "__dossierStore",
    "__scoreboard",
    "__scoreboardMovement",
    "__scoreboardResolverTelemetry",
  ]) {
    ((global[key] ??= new Map()) as Map<unknown, unknown>).clear();
  }
  const scoreboard = global.__scoreboard as Map<string, unknown>;
  const dossiers = global.__dossierStore as Map<string, unknown>;
  return { scoreboard, dossiers };
}

test("unchanged authoritative evidence is baselined once and never re-adjudicated", async () => {
  const { scoreboard, dossiers } = await cleanMemory();
  const q = question("AAPL");
  scoreboard.set(q.id, q);
  dossiers.set("AAPL", dossier("AAPL", "2026-07-20", [
    citation({ id: "aapl-10q", date: "2026-07-20" }),
    citation({ id: "aapl-news", date: "2026-07-21", authority: "independent" }),
  ]));

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("resolver should not run");
  };
  try {
    const { getQuestion, resolveDue } = await import("../src/lib/scoreboard");
    await resolveDue("2026-07-21");
    await resolveDue("2026-07-21");
    assert.equal(calls, 0);
    const saved = await getQuestion(q.id);
    assert.equal(saved?.resolver?.evidenceDocuments.length, 1);
    assert.ok(saved?.resolver?.lastEvidenceFingerprint);
    assert.ok(saved?.resolver?.lastFullReconciliationAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new primary evidence is adjudicated once across concurrent resolver calls", async () => {
  const { scoreboard, dossiers } = await cleanMemory();
  const q = question("MSFT");
  scoreboard.set(q.id, q);
  const first = citation({ id: "msft-10q", date: "2026-07-20" });
  dossiers.set("MSFT", dossier("MSFT", "2026-07-20", [first]));

  const { getQuestion, resolveDue } = await import("../src/lib/scoreboard");
  await resolveDue("2026-07-20");

  const second = citation({ id: "msft-8k", date: "2026-07-22" });
  dossiers.set("MSFT", dossier("MSFT", "2026-07-22", [first, second]));

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({
      id: "openrouter-quality-test",
      choices: [{
        message: {
          content: JSON.stringify({
            status: "strengthened",
            resolution: "The July 22 primary filing strengthened the cash-conversion proposition.",
            sources: [second.url],
          }),
        },
      }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        cost: 0.42,
      },
    }), {
      status: 200,
      headers: { "x-request-id": "request-quality-test" },
    });
  };
  try {
    await Promise.all([
      resolveDue("2026-07-22"),
      resolveDue("2026-07-22"),
    ]);
    await resolveDue("2026-07-22");
    assert.equal(calls, 1);
    const saved = await getQuestion(q.id);
    assert.equal(saved?.status, "strengthened");
    assert.equal(saved?.resolver?.lastAttemptOutcome, "succeeded");
    assert.equal(saved?.resolver?.lastRulingSources?.[0], second.url);
    assert.equal(saved?.resolver?.failureCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily receipts do not eliminate the independent weekly frontier reconciliation", async () => {
  const { scoreboard, dossiers } = await cleanMemory();
  const q = question("META");
  scoreboard.set(q.id, q);
  const primary = citation({ id: "meta-10q", date: "2026-07-20" });
  dossiers.set("META", dossier("META", "2026-07-24", [primary]));

  const { getQuestion, resolveDue } = await import("../src/lib/scoreboard");
  await resolveDue("2026-07-24");
  const baselined = await getQuestion(q.id);
  assert.ok(baselined?.resolver);
  scoreboard.set(q.id, {
    ...baselined,
    resolver: {
      ...baselined?.resolver,
      lastRuledDossierDate: "2026-07-24",
      lastRuledAt: Date.now(),
      lastFullReconciliationAt: Date.now() - 8 * DAY,
    },
  });

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({
      id: "openrouter-weekly-test",
      choices: [{
        message: {
          content: JSON.stringify({
            status: "open",
            resolution: "The admitted primary evidence leaves the standing proposition open.",
            sources: [primary.url],
          }),
        },
      }],
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, cost: 0.3 },
    }), { status: 200 });
  };
  try {
    await resolveDue("2026-07-24");
    await resolveDue("2026-07-24");
    assert.equal(calls, 1);
    const reconciled = await getQuestion(q.id);
    assert.equal(reconciled?.resolver?.lastAttemptOutcome, "succeeded");
    assert.ok((reconciled?.resolver?.lastFullReconciliationAt ?? 0) > Date.now() - DAY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily council receipts preserve the independent frontier ruling audit", async () => {
  const { scoreboard, dossiers } = await cleanMemory();
  const q = question("GOOGL");
  q.id = "GOOGL:2026-07-24";
  scoreboard.set(q.id, q);
  const first = citation({ id: "googl-10q", date: "2026-07-20" });
  dossiers.set("GOOGL", dossier("GOOGL", "2026-07-20", [first]));

  const {
    getQuestion,
    recordTickerResearchOutcome,
    resolveDue,
  } = await import("../src/lib/scoreboard");
  await resolveDue("2026-07-20");

  const second = citation({ id: "googl-8k", date: "2026-07-22" });
  dossiers.set("GOOGL", dossier("GOOGL", "2026-07-22", [first, second]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "openrouter-frontier-audit-test",
    choices: [{
      message: {
        content: JSON.stringify({
          status: "weakened",
          resolution: "The July 22 primary filing weakened the standing cash-conversion proposition.",
          sources: [second.url],
        }),
      },
    }],
    usage: { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060, cost: 0.36 },
  }), { status: 200 });
  try {
    await resolveDue("2026-07-22");
    const ruled = await getQuestion(q.id);
    assert.equal(
      ruled?.resolver?.lastRulingSummary,
      "The July 22 primary filing weakened the standing cash-conversion proposition.",
    );

    dossiers.set("GOOGL", dossier("GOOGL", "2026-07-24", [first, second]));
    await recordTickerResearchOutcome("GOOGL", "2026-07-24");
    const receipted = await getQuestion(q.id);
    assert.equal(receipted?.resolver?.lastCouncilReceiptDossierDate, "2026-07-24");
    assert.equal(receipted?.resolver?.lastCouncilReceiptAuditId, "audit-GOOGL-2026-07-24");
    assert.equal(
      receipted?.resolver?.lastRulingSummary,
      "The July 22 primary filing weakened the standing cash-conversion proposition.",
    );
    assert.deepEqual(receipted?.resolver?.lastRulingSources, [second.url]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("frontier failure preserves the verified thesis and backs off identical retries", async () => {
  const { scoreboard, dossiers } = await cleanMemory();
  const q = question("NVDA");
  scoreboard.set(q.id, q);
  const first = citation({ id: "nvda-10q", date: "2026-07-20" });
  dossiers.set("NVDA", dossier("NVDA", "2026-07-20", [first]));

  const { getQuestion, resolveDue } = await import("../src/lib/scoreboard");
  await resolveDue("2026-07-20");
  const second = citation({ id: "nvda-8k", date: "2026-07-23" });
  dossiers.set("NVDA", dossier("NVDA", "2026-07-23", [first, second]));

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("upstream unavailable", { status: 503 });
  };
  try {
    await resolveDue("2026-07-23");
    await resolveDue("2026-07-23");
    assert.equal(calls, 1);
    const saved = await getQuestion(q.id);
    assert.equal(saved?.status, "open");
    assert.equal(saved?.thesis, q.thesis);
    assert.equal(saved?.resolution, undefined);
    assert.equal(saved?.resolver?.lastAttemptOutcome, "failed");
    assert.equal(saved?.resolver?.lastErrorCode, "openrouter_http_503");
    assert.ok((saved?.resolver?.nextRetryAt ?? 0) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});
