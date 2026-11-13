#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { callModel, dossierReleaseValidationError, type Dossier } from "../../src/lib/dossier";
import {
  buildWeeklyShortEpisodePackage,
  validateWeeklyShortDraft,
  weeklySourceBundle,
  type WeeklyShortDraft,
} from "../../src/lib/weeklyShortEpisode";
import type { WeeklyShortEdition } from "../../src/lib/weeklyShorts";
import { RESEARCH_MODELS } from "../../src/lib/modelPolicy";

const EDITOR_MODEL = process.env.SHORT_COPY_MODEL ?? RESEARCH_MODELS.shortEditor;
const VERIFY_MODEL = process.env.SHORT_VERIFY_MODEL ?? RESEARCH_MODELS.shortVerifier;
const MAX_REPAIR_ATTEMPTS = 2;
const SHORT_EDITOR_MAX_TOKENS = 8_192;
const SHORT_VERIFIER_MAX_TOKENS = 2_048;

function after(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function jsonObject<T>(value: string): T {
  const clean = value.replace(/```(?:json)?|```/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return one JSON object");
  return JSON.parse(clean.slice(start, end + 1)) as T;
}

async function main(): Promise<void> {
  const dossiersPath = after("--dossiers");
  if (!dossiersPath) throw new Error("--dossiers path/to/dossiers.json is required");
  const dossiers = JSON.parse(await readFile(dossiersPath, "utf8")) as Dossier[];
  if (dossiers.length < 5 || dossiers.length > 6) {
    throw new Error("weekly episode requires five or six selected dossiers");
  }
  for (const dossier of dossiers) {
    const releaseError = dossierReleaseValidationError(dossier);
    if (releaseError) throw new Error(`${dossier.ticker} release gate failed: ${releaseError}`);
  }
  const targetDate = after("--target-date") ?? dossiers[0]!.date;
  const publicationDate = after("--publication-date");
  if (!publicationDate) throw new Error("--publication-date YYYY-MM-DD is required");
  const edition = (after("--edition") ?? "weekly-review") as WeeklyShortEdition;
  if (!["weekly-review", "week-ahead"].includes(edition)) {
    throw new Error("--edition must be weekly-review or week-ahead");
  }
  const out = after("--out") ?? path.join("tools", "shorts", "out", publicationDate, edition);
  const nextEventsPath = after("--next-events");
  const nextEventByTicker = nextEventsPath
    ? JSON.parse(await readFile(nextEventsPath, "utf8")) as Record<string, string | null>
    : {};
  await mkdir(out, { recursive: true });
  const sourceBundle = weeklySourceBundle(dossiers);
  const derived = dossiers.map((dossier) => ({
    ticker: dossier.ticker.toUpperCase(),
    activeThesis:
      dossier.thesisLifecycle?.canonicalSubjectPunchline ??
      dossier.emailHook.subjectPunchline,
    observationStatus: dossier.thesisLifecycle?.observationStatus ?? "open",
    signal: dossier.emailHook.signal,
    votes: dossier.emailHook.votes,
    flipCondition: dossier.emailHook.confidence.flipCondition,
  }));
  const countWord = dossiers.length === 5 ? "Five" : "Six";
  const intro = edition === "weekly-review"
    ? `${countWord} big stocks moved most in AMM's research this week. Here is what changed and what could matter next.`
    : `${countWord} big stocks carry the clearest evidence changes into next week. Here is what could matter next.`;
  const close = "Track every thesis and source at aftermarketmovers dot com.";
  const editorSystem = `You are AMM's weekly short-form editor, not a researcher.
Use ONLY SOURCE_BUNDLE and DERIVED_STOCKS. Never add a fact, event, implication,
number, date, cause or company from memory. Return exactly one JSON object:
{
  "schema":"amm-weekly-short-draft-v1",
  "intro":"LOCKED_INTRO",
  "stocks":[
    {"ticker":"EXACT_TICKER","line1":"one sentence","line2":"one sentence","claimIds":["W1","W2"]}
  ],
  "close":"LOCKED_CLOSE",
  "claims":[
    {"id":"W1","ticker":"EXACT_TICKER","statement":"plain claim","support":[
      {"sourceId":"EXACT_TICKER:D1","quote":"exact substring copied from source.text"}
    ]}
  ]
}

Rules:
- Preserve the exact ticker order in DERIVED_STOCKS and include all ${dossiers.length}.
- Exactly two short spoken sentences per stock: line 1 says how the standing
  thesis moved or held; line 2 explains the most useful evidence or next test.
- Give every stock exactly two claimIds in line order. The first claim statement
  must be an exact copy of line1 and the second must be an exact copy of line2.
  Do not add unused claims.
- Total narration, including the locked intro and close, is 150–175 words.
- Write for a smart casual investor. Prefer common words and short sentences.
- Make the first clause of each stock entry distinctive enough to retain attention.
- "Opportunity" may only mean a clearly labelled evidence-backed condition; never
  recommend a trade or imply a guaranteed outcome.
- Every factual statement has a claim, and every claim has a verbatim quote from
  that same ticker's source excerpt. Never cross evidence between companies.
- Preserve direction, strength, lifecycle state and vote count exactly.
- Explain movement across the reporting cycle. Never mention a 10–15-session
  window, expected return, price target, buy, sell, hold or personalised advice.
- No URLs, citation markers, markdown, hype or invented certainty in speech.
- Use LOCKED_INTRO and LOCKED_CLOSE verbatim.`;
  const editorInput = JSON.stringify({
    LOCKED_INTRO: intro,
    LOCKED_CLOSE: close,
    DERIVED_STOCKS: derived,
    SOURCE_BUNDLE: sourceBundle,
  });
  const manualDraft = after("--draft");
  const editorText = manualDraft
    ? await readFile(manualDraft, "utf8")
    : (await callModel(
        EDITOR_MODEL,
        editorSystem,
        editorInput,
        `weekly-short ${edition} ${publicationDate}`,
        { maxTokens: SHORT_EDITOR_MAX_TOKENS },
      ))?.text;
  if (!editorText) throw new Error(`weekly editor ${EDITOR_MODEL} failed`);
  let draft = jsonObject<WeeklyShortDraft>(editorText);
  // Intro/close are immutable product copy, even for a manual draft.
  draft.intro = intro;
  draft.close = close;
  const verifierSystem = `You are an independent evidence-entailment auditor.
Use only the supplied source excerpts, derived states and draft. Check each of
the two sentences for every stock. A sentence passes only if its meaning,
direction, strength, lifecycle movement, dates and numbers are entailed by the
same ticker's cited exact quotes. Reject causal overreach, hidden advice,
headline inflation, unsupported opportunity language and cross-company evidence.
Return exactly {"pass":true,"issues":[]} or {"pass":false,"issues":["specific issue"]}.`;
  const auditAttempts: Array<{
    attempt: number;
    stage: "deterministic" | "independent";
    pass: boolean;
    issues: string[];
  }> = [];
  let verified = false;
  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const deterministicIssues = validateWeeklyShortDraft(dossiers, draft, edition);
    if (deterministicIssues.length) {
      auditAttempts.push({
        attempt: attempt + 1,
        stage: "deterministic",
        pass: false,
        issues: deterministicIssues,
      });
      if (attempt === MAX_REPAIR_ATTEMPTS || manualDraft) {
        throw new Error(
          `weekly draft failed deterministic audit:\n- ${deterministicIssues.join("\n- ")}`,
        );
      }
    } else {
      const verifier = await callModel(
        VERIFY_MODEL,
        verifierSystem,
        JSON.stringify({
          DERIVED_STOCKS: derived,
          SOURCE_BUNDLE: sourceBundle,
          DRAFT: draft,
        }),
        `weekly-short-audit ${edition} ${publicationDate} attempt-${attempt + 1}`,
        { maxTokens: SHORT_VERIFIER_MAX_TOKENS },
      );
      if (!verifier) throw new Error(`weekly verifier ${VERIFY_MODEL} failed`);
      const verdict = jsonObject<{ pass: boolean; issues: string[] }>(verifier.text);
      const issues = verdict.issues ?? [];
      auditAttempts.push({
        attempt: attempt + 1,
        stage: "independent",
        pass: verdict.pass && issues.length === 0,
        issues,
      });
      if (verdict.pass && issues.length === 0) {
        verified = true;
        break;
      }
      if (attempt === MAX_REPAIR_ATTEMPTS || manualDraft) {
        throw new Error(`weekly independent verifier rejected the draft:\n- ${
          (issues.length ? issues : ["unspecified verifier failure"]).join("\n- ")
        }`);
      }
    }

    const failedAudit = auditAttempts.at(-1);
    const repairSystem = `${editorSystem}

This is a repair pass. The previous draft failed an evidence or structure audit.
Return the full corrected JSON object, not a patch. Change only what is needed
to resolve every listed issue. Preserve all claims that were not rejected.
Never weaken a source condition: words such as sustained, with strength, exact
dates, lifecycle state, direction and strength must remain exact when present.`;
    const repaired = await callModel(
      EDITOR_MODEL,
      repairSystem,
      JSON.stringify({
        LOCKED_INTRO: intro,
        LOCKED_CLOSE: close,
        DERIVED_STOCKS: derived,
        SOURCE_BUNDLE: sourceBundle,
        PREVIOUS_DRAFT: draft,
        AUDIT_ISSUES: failedAudit?.issues ?? [],
      }),
      `weekly-short-repair ${edition} ${publicationDate} attempt-${attempt + 1}`,
      { maxTokens: SHORT_EDITOR_MAX_TOKENS },
    );
    if (!repaired) throw new Error(`weekly repair editor ${EDITOR_MODEL} failed`);
    draft = jsonObject<WeeklyShortDraft>(repaired.text);
    draft.intro = intro;
    draft.close = close;
  }
  if (!verified) throw new Error("weekly short did not clear independent verification");
  const episode = buildWeeklyShortEpisodePackage({
    dossiers,
    draft,
    targetDate,
    publicationDate,
    edition,
    nextEventByTicker,
  });
  await Promise.all([
    writeFile(path.join(out, "dossiers.json"), `${JSON.stringify(dossiers, null, 2)}\n`),
    writeFile(path.join(out, "source-bundle.json"), `${JSON.stringify(sourceBundle, null, 2)}\n`),
    writeFile(path.join(out, "episode-package.json"), `${JSON.stringify(episode, null, 2)}\n`),
    writeFile(path.join(out, "verifier-receipt.json"), `${JSON.stringify({
      schema: "amm-weekly-short-verifier-receipt-v1",
      pass: true,
      editorModel: manualDraft ? "manual-reviewed-copy" : EDITOR_MODEL,
      verifierModel: VERIFY_MODEL,
      verifiedAt: Date.now(),
      issues: [],
      attempts: auditAttempts,
    }, null, 2)}\n`),
  ]);
  console.log(JSON.stringify({
    episodeId: episode.episodeId,
    words: episode.editorial.words,
    estimatedSeconds: episode.editorial.estimatedSeconds,
    tickers: episode.stocks.map((stock) => stock.ticker),
    out,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
