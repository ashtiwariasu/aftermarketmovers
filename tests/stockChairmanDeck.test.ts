import assert from "node:assert/strict";
import test from "node:test";
import type { Dossier } from "../src/lib/dossier";
import { buildStockChairmanRun } from "../src/lib/stockChairmanDeck";

test("stock deck presents every chairman field without truncating or rewriting it", () => {
  const dossier = {
    ticker: "MSFT",
    date: "2026-07-18",
    generatedAt: 123,
    headline: "Exact chairman headline",
    story: "Exact long-form story with [1 · 2026-07-18](https://example.com/story).",
    bulls: ["Bull one", "Bull two", "Bull three"],
    bears: ["Bear one", "Bear two", "Bear three"],
    numbersRead: "Exact filed-number analysis.",
    risk: "Exact risk analysis.",
    signalCase: {
      direction: "UP",
      strength: "GENTLE",
      eventType: "macro",
      horizonSessions: { min: 10, max: 15 },
      mechanism: "Exact signal mechanism.",
      invalidation: "Exact evidence that changes the read.",
    },
    emailHook: {
      votesSupport: 3,
      votesOppose: 1,
      votesUncertain: 1,
      confidence: {
        majorityReason: "Exact majority reason.",
        dissentReason: "Exact dissent reason.",
        uncertaintyReason: "Exact uncertainty reason.",
      },
    },
  } as Dossier;

  const run = buildStockChairmanRun(dossier);

  assert.equal(run.cards.length, 6);
  assert.deepEqual(run.cards.map((card) => card.label), [
    "THE STORY", "BULLS / BEARS", "NUMBERS", "RISK", "SIGNAL", "WATCH NEXT",
  ]);
  assert.equal(run.cards[0].title, dossier.headline);
  assert.equal(run.cards[0].markdown, dossier.story);
  assert.match(run.cards[1].markdown, /Bull one/);
  assert.match(run.cards[1].markdown, /Bear three/);
  assert.equal(run.cards[2].markdown, dossier.numbersRead);
  assert.equal(run.cards[3].markdown, dossier.risk);
  assert.equal(
    run.cards[4].markdown,
    [
      dossier.signalCase.mechanism,
      `### Why 3 analysts support it\n${dossier.emailHook.confidence.majorityReason}`,
      `### Why 1 analyst disagrees\n${dossier.emailHook.confidence.dissentReason}`,
      `### Why 1 analyst is uncertain\n${dossier.emailHook.confidence.uncertaintyReason}`,
    ].join("\n\n"),
  );
  assert.equal(run.cards[5].markdown, dossier.signalCase.invalidation);
  assert.deepEqual(run.signal, {
    direction: "UP",
    strength: "GENTLE",
    minSessions: 10,
    maxSessions: 15,
    support: 3,
    oppose: 1,
    uncertain: 1,
  });
});
