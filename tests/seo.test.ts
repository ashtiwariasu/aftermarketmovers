import assert from "node:assert/strict";
import test from "node:test";
import type { Dossier } from "../src/lib/dossier";
import {
  conciseResearchText,
  isPublicResearchTicker,
  plainResearchText,
  PUBLIC_RESEARCH_TICKERS,
  stockSeoCopy,
} from "../src/lib/publicResearch";

test("public research universe stays deliberately bounded to fully researched launch tickers", () => {
  assert.deepEqual(PUBLIC_RESEARCH_TICKERS, [
    "AMD", "META", "MSFT", "NVDA", "TSLA",
  ]);
  assert.equal(isPublicResearchTicker("meta"), true);
  assert.equal(isPublicResearchTicker("GOOGL"), false);
});

test("search snippets remove source markup without joining punctuation", () => {
  const source = "The filed quarter held [2 · 2026-03-31](https://www.sec.gov/a). The tape moved [1 · 2026-07-18](https://finance.yahoo.com/b).";
  assert.equal(plainResearchText(source), "The filed quarter held. The tape moved.");
  assert.ok(conciseResearchText(source, 35).length <= 35);
});

test("ticker SEO copy describes only the public evidence file", () => {
  const dossier = {
    date: "2026-07-22",
    emailHook: {
      subjectPunchline: "The selloff lacks a Microsoft-specific cause",
      whatChanged: "Microsoft fell with the broader technology sector [1 · 2026-07-18](https://example.com/source).",
      signal: {
        direction: "UP",
        strength: "GENTLE",
        horizonSessions: { min: 10, max: 15 },
      },
    },
  } as unknown as Dossier;

  const copy = stockSeoCopy("msft", "Microsoft Corporation", dossier);
  assert.equal(copy.title, "MSFT Stock Filings, News & Market Evidence");
  assert.match(copy.description, /market data, SEC filings/);
  assert.match(copy.description, /updated through 2026-07-22/);
  assert.doesNotMatch(copy.description, /upside|downside|signal|selloff|thesis/i);
  assert.doesNotMatch(copy.description, /https?:\/\/|\[1 ·/);
  assert.ok(copy.description.length <= 155);
});

test("ticker pages remain useful when no thesis clears the publication gate", () => {
  const copy = stockSeoCopy("amd", "Advanced Micro Devices, Inc.", null);
  assert.equal(copy.title, "AMD Stock Filings, News & Market Evidence");
  assert.match(copy.description, /company-reported metrics/);
});
