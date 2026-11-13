import assert from "node:assert/strict";
import test from "node:test";
import { formatIntentEvidence, selectIntentEvidence } from "../src/lib/intentContext";
import {
  evidenceBoundAnswerIssues,
  runSittingRoom,
  SITTING_MODEL,
} from "../src/lib/sittingRoom";

test("all checked sources stay eligible while the question retrieves only relevant evidence", () => {
  const sources = [
    {
      id: "cash-filing",
      name: "MSFT Q3 SEC XBRL cash-flow note",
      content:
        "Operating cash flow was $46.68 billion. Capital expenditure was $30.88 billion, leaving positive cash coverage for the infrastructure build.",
    },
    {
      id: "cloud-note",
      name: "Cloud capacity thesis",
      content:
        "Cloud demand grew while management expanded data-center capacity. The open question is whether monetisation outruns depreciation.",
    },
    {
      id: "unrelated",
      name: "Office design history",
      content: "A retrospective on typography, icon spacing, and the visual identity of a discontinued office product.",
    },
  ];

  const selection = selectIntentEvidence(
    "Does cash flow cover the higher cloud capex, and what is the earnings risk?",
    sources
  );

  assert.equal(selection.eligibleSourceCount, 3);
  assert.ok(selection.matchedSourceIds.includes("cash-filing"));
  assert.ok(selection.matchedSourceIds.includes("cloud-note"));
  assert.ok(!selection.matchedSourceIds.includes("unrelated"));
  assert.equal(selection.omittedSourceCount, 1);
  assert.match(selection.label, /earnings and financial performance/);
});

test("intent evidence preserves complete coherent passages and source boundaries", () => {
  const paragraph =
    "The filing reports revenue growth of 18%. Operating cash flow covers capital expenditure, while the next filing must show whether returns keep pace with capacity.";
  const selection = selectIntentEvidence("What does the filing say about revenue and cash flow?", [
    { id: "filing-1", name: "Filed quarter", content: paragraph },
  ]);
  const formatted = formatIntentEvidence(selection);

  assert.equal(selection.passages.length, 1);
  assert.equal(selection.passages[0].text, paragraph);
  assert.match(formatted, /FILE SOURCE — Filed quarter \[document filing-1\]/);
  assert.match(formatted, /next filing must show whether returns keep pace with capacity\./);
});

test("interactive chat uses one cost-controlled model over the prepared company-file context", () => {
  assert.equal(SITTING_MODEL, "openai/gpt-5.6-terra");
});

test("interactive chat makes exactly one grounded model request", async () => {
  const originalFetch = globalThis.fetch;
  const originalAmmKey = process.env.OPENROUTER_API_KEY_AMM;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const requests: Array<{ body: Record<string, unknown>; title: string | null }> = [];
  const streamedAnswers: string[] = [];
  const streamedNotes: string[] = [];

  process.env.OPENROUTER_API_KEY_AMM = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  globalThis.fetch = async (_input, init) => {
    requests.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      title: new Headers(init?.headers).get("X-Title"),
    });
    const stream =
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Operating cash exceeded capex in the admitted filing. " } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "[Q1 10-Q · 2026-03-31](https://www.sec.gov/example)" } }] })}\n\n` +
      "data: [DONE]\n\n";
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  try {
    const result = await runSittingRoom(
      "Does operating cash cover capex?",
      "FILE SOURCE — Q1 10-Q [document filing-1]: filed 2026-03-31. Operating cash was $10B and capex was $7B. Original source: https://www.sec.gov/example",
      {
        line: () => {},
        notes: (delta) => streamedNotes.push(delta),
        answer: (delta) => streamedAnswers.push(delta),
      }
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, SITTING_MODEL);
    assert.equal(requests[0].title, "AMM Desk Chat");
    assert.match(JSON.stringify(requests[0].body.messages), /Q1 10-Q/);
    assert.deepEqual(streamedNotes, []);
    assert.equal(
      streamedAnswers.join(""),
      "Operating cash exceeded capex in the admitted filing. [Q1 10-Q · 2026-03-31](https://www.sec.gov/example)"
    );
    assert.equal(
      result?.answer,
      "Operating cash exceeded capex in the admitted filing. [Q1 10-Q · 2026-03-31](https://www.sec.gov/example)"
    );
    assert.deepEqual(result?.transcript.audits, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAmmKey === undefined) delete process.env.OPENROUTER_API_KEY_AMM;
    else process.env.OPENROUTER_API_KEY_AMM = originalAmmKey;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("release gate rejects assent, invented sources, and missing dates", () => {
  const context =
    "FILE SOURCE — Q1 10-Q [document filing-1]: filed 2026-03-31. Original source: https://www.sec.gov/example";
  const issues = evidenceBoundAnswerIssues(
    "You're right. Revenue rose in the quarter. [Article](https://outside.example/story)",
    context
  );

  assert.ok(issues.some((issue) => issue.includes("conversational assent")));
  assert.ok(issues.some((issue) => issue.includes("outside admitted context")));
  assert.ok(issues.some((issue) => issue.includes("source date missing")));
});

test("release gate permits exact closed-file boundary answers", () => {
  const issues = evidenceBoundAnswerIssues(
    "**Not established in the current AMM file.** The selected sources do not contain a dated company disclosure answering that question. Evidence cutoff: 2026-07-25.",
    "COMPANY FILE FRESHNESS: market snapshot captured 2026-07-25."
  );
  assert.deepEqual(issues, []);
});

test("freshness-sensitive questions require an explicit evidence cutoff", () => {
  const context =
    "Dated source: Company update. Published: 2026-07-24. Original source: https://example.com/update";
  const issues = evidenceBoundAnswerIssues(
    "The admitted update is dated 2026-07-24. [Company update · 2026-07-24](https://example.com/update)",
    context,
    "What is the latest news?"
  );
  assert.ok(issues.some((issue) => issue.includes("evidence cutoff")));
});

test("a false-premise correction must cite the admitted dated source", () => {
  const issues = evidenceBoundAnswerIssues(
    "**The AMM file does not support that premise.** The evidence cutoff is 2026-07-25.",
    "COMPANY FILE FRESHNESS: market snapshot captured 2026-07-25."
  );
  assert.ok(issues.some((issue) => issue.includes("premise correction")));
});

test("invalid first draft is repaired by the same model before anything is released", async () => {
  const originalFetch = globalThis.fetch;
  const originalAmmKey = process.env.OPENROUTER_API_KEY_AMM;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const requests: Array<{ body: Record<string, unknown>; title: string | null }> = [];
  const emitted: string[] = [];
  const answers = [
    "You're right. Cash covers capex.",
    "Operating cash exceeded capex in the admitted filing. [Q1 10-Q · 2026-03-31](https://www.sec.gov/example)",
  ];

  process.env.OPENROUTER_API_KEY_AMM = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  globalThis.fetch = async (_input, init) => {
    const index = requests.length;
    requests.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      title: new Headers(init?.headers).get("X-Title"),
    });
    const stream =
      `data: ${JSON.stringify({ choices: [{ delta: { content: answers[index] } }] })}\n\n` +
      "data: [DONE]\n\n";
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  try {
    const result = await runSittingRoom(
      "Does operating cash cover capex?",
      "FILE SOURCE — Q1 10-Q [document filing-1]: filed 2026-03-31. Operating cash was $10B and capex was $7B. Original source: https://www.sec.gov/example",
      {
        line: () => {},
        notes: () => {},
        answer: (text) => emitted.push(text),
      }
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.model, SITTING_MODEL);
    assert.equal(requests[1].body.model, SITTING_MODEL);
    assert.equal(requests[0].title, "AMM Desk Chat");
    assert.equal(requests[1].title, "AMM Desk Chat · Source Repair");
    assert.deepEqual(emitted, [answers[1]]);
    assert.equal(result?.answer, answers[1]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAmmKey === undefined) delete process.env.OPENROUTER_API_KEY_AMM;
    else process.env.OPENROUTER_API_KEY_AMM = originalAmmKey;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});
