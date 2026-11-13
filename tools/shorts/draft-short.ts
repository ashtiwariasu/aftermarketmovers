#!/usr/bin/env tsx
/**
 * Released dossier → compact script editor → independent entailment audit →
 * immutable episode package. Neither model receives or may use outside context.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildShortEpisodePackage,
  deriveWeekendReportingCycle,
  lockedShortClose,
  lockedShortHook,
  shortSpokenCompanyName,
  shortEpisodeContract,
  shortSourceBundle,
  validateShortDraft,
  type ShortEpisodeBuildOptions,
  type ShortEpisodeFormat,
  type ShortEpisodeDraft,
} from "../../src/lib/shortEpisode";
import { applyEvidenceLockedShortRepair } from "../../src/lib/shortRepair";
import {
  callModel,
  dossierReleaseValidationError,
  type Dossier,
} from "../../src/lib/dossier";
import type { CouncilModelUsage } from "../../src/lib/frontierCouncil";
import { getLatestPublishableDossier } from "../../src/lib/publicResearch";
import { getTickerSnapshot } from "../../src/lib/ticker";
import { RESEARCH_MODELS } from "../../src/lib/modelPolicy";

const EDITOR_MODEL = process.env.SHORT_COPY_MODEL ?? RESEARCH_MODELS.shortEditor;
const VERIFY_MODEL = process.env.SHORT_VERIFY_MODEL ?? RESEARCH_MODELS.shortVerifier;
// The editor returns a small, schema-locked script package. Explicit output
// envelopes prevent providers from reserving a model's huge default context
// while leaving every dossier/council research call unchanged.
const SHORT_EDITOR_MAX_TOKENS = 8_192;
const SHORT_VERIFIER_MAX_TOKENS = 2_048;

function after(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonObject<T>(value: string): T {
  const clean = value.replace(/```(?:json)?|```/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return one JSON object");
  return JSON.parse(clean.slice(start, end + 1)) as T;
}

function cleanCompanyName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (
    name.length < 1 || name.length > 100 ||
    /[\u0000-\u001f\u007f<>]/.test(name) ||
    /https?:\/\//i.test(name)
  ) {
    throw new Error("company name must be 1–100 plain-text characters");
  }
  return name;
}

function applyLockedDerivedBeats(
  source: Dossier,
  draft: ShortEpisodeDraft,
  format: ShortEpisodeFormat,
): ShortEpisodeDraft {
  draft.beats.hook = {
    text: lockedShortHook(source, format),
    claimIds: [],
  };
  draft.beats.close = {
    text: lockedShortClose(format),
    claimIds: [],
  };
  return draft;
}

async function companyIdentity(source: Dossier): Promise<{
  companyName: string;
  source: "explicit" | "market-metadata" | "ticker-only";
}> {
  const explicit = after("--company-name");
  if (explicit) return { companyName: cleanCompanyName(explicit), source: "explicit" };
  const snapshot = await getTickerSnapshot(source.ticker);
  if (
    snapshot?.symbol === source.ticker.toUpperCase() &&
    snapshot.name &&
    snapshot.name.toUpperCase() !== source.ticker.toUpperCase()
  ) {
    return {
      companyName: cleanCompanyName(snapshot.name),
      source: "market-metadata",
    };
  }
  // A missing name must never be replaced with an invented mark or guessed
  // issuer. The ticker is already bound to the released dossier.
  return { companyName: source.ticker.toUpperCase(), source: "ticker-only" };
}

async function dossier(): Promise<Dossier> {
  const file = after("--dossier");
  if (file) return JSON.parse(await readFile(file, "utf8")) as Dossier;
  const ticker = after("--ticker")?.toUpperCase();
  if (!ticker) throw new Error("provide --ticker META or --dossier path/to/dossier.json");
  const value = await getLatestPublishableDossier(ticker);
  if (!value) throw new Error(`no publishable dossier found for ${ticker}`);
  return value;
}

async function main(): Promise<void> {
  const source = await dossier();
  const format = (after("--format") ?? "weekday") as ShortEpisodeFormat;
  if (!["weekday", "weekend-recap"].includes(format)) {
    throw new Error("--format must be weekday or weekend-recap");
  }
  const publicationDate = after("--publication-date") ?? source.date;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(publicationDate)) {
    throw new Error("invalid --publication-date");
  }
  const openedDate = source.thesisLifecycle?.openedDate ?? source.date;
  const snapshot = format === "weekend-recap"
    ? await getTickerSnapshot(source.ticker)
    : null;
  const buildOptions: ShortEpisodeBuildOptions = format === "weekend-recap"
    ? {
        format,
        reportingCycle: deriveWeekendReportingCycle(
          source,
          publicationDate,
          snapshot?.nextEvent,
        ),
      }
    : { format };
  const outputDir = after("--out") ??
    path.join("tools", "shorts", "out", `${source.ticker}-${source.date}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "dossier.json"), `${JSON.stringify(source, null, 2)}\n`);
  const releaseError = dossierReleaseValidationError(source);
  if (releaseError) throw new Error(`released dossier failed validation: ${releaseError}`);
  const identity = await companyIdentity(source);
  const sourceBundle = shortSourceBundle(source);
  await writeFile(path.join(outputDir, "source-bundle.json"), `${JSON.stringify(sourceBundle, null, 2)}\n`);
  const derived = {
    ticker: source.ticker,
    spokenCompanyName: shortSpokenCompanyName(source.ticker),
    date: source.date,
    activeThesis:
      source.thesisLifecycle?.canonicalSubjectPunchline ?? source.emailHook.subjectPunchline,
    openedDate,
    observationIndex: source.thesisLifecycle?.observationIndex ?? 1,
    observationStatus: source.thesisLifecycle?.observationStatus ?? "opened",
    signal: source.emailHook.signal,
    votes: source.emailHook.votes,
    nextTest: source.emailHook.confidence.flipCondition,
    format,
    ...(buildOptions.reportingCycle ? { reportingCycle: buildOptions.reportingCycle } : {}),
  };
  const contract = shortEpisodeContract(format);
  const editorSystem = `You are AMM's short-form script editor. You are not a researcher.
Use ONLY the SOURCE_BUNDLE and DERIVED_VERDICT supplied by the user. Never add a fact,
date, number, company, event, causal claim or implication from memory. Write a compelling
${contract.minSeconds}–${contract.maxSeconds} second spoken script for a busy intelligent investor.

Return exactly one JSON object matching:
{
  "schema":"amm-short-draft-v1",
  "claims":[{"id":"C1","statement":"plain claim","support":[{"sourceId":"D1","quote":"exact substring copied from source.text"}]}],
  "beats":{
    "hook":{"text":"derived by code","claimIds":[]},
    "change":{"text":"...","claimIds":["C2"]},
    "thesis":{"text":"...","claimIds":["C3"]},
    "evidence":{"text":"...","claimIds":["C4"]},
    "council":{"text":"...","claimIds":["C5"]},
    "close":{"text":"derived by code","claimIds":[]}
  }
}

Rules:
- Total narration must validate at ${contract.minWords}–${contract.maxWords} words.
  Aim for ${contract.targetWords.min}–${contract.targetWords.max} words. This range is
  calibrated to Ash's saved voice, not a generic narration estimate.
- One short idea per sentence; every factual beat cites every claim it uses.
- Every support quote is copied verbatim from the referenced source.text.
- Hook is replaced deterministically after editing. Spend no copy budget trying
  to improve it.
- Change says what changed TODAY in one or two short sentences.
- Preserve every source date literally. Never replace a dated event with
  "today", "yesterday", "recently" or "latest".
- Thesis names the ONE active thesis and explains the non-obvious mechanism
  in plain spoken English. It opened on DERIVED_VERDICT.openedDate and is
  being tracked through DERIVED_VERDICT.observationIndex daily observations.
  Never imply that AMM discarded it and opened a fresh thesis today.
- Evidence uses only the one or two facts needed to prove the mechanism.
- Council states support/oppose/uncertain honestly, says whether the active
  thesis opened, strengthened, weakened or remained open today, and names the
  decisive reservation.
- Lifecycle states describe what the evidence did to the thesis. Never invent
  a reason for strengthening, weakening or remaining open unless that reason
  is stated verbatim in SOURCE_BUNDLE.
- Prefer common words. Translate accounting terms on first use. Avoid desk jargon
  such as tape, print, read-through, cohort, capex, filed, catalyst and rerating
  unless the sentence immediately explains the term in everyday language.
- Use exact dossier numbers; never invent, combine or round a number.
- Treat a headline deal, initiative or partnership value as economically
  ambiguous unless SOURCE_BUNDLE states what the number measures. Never imply
  that it is one party's investment, spending, contracted revenue or booked
  demand. If the bundle does not define the scope, omit the amount or call it
  an unscoped reported value.
- Qualitative direction only; no percentage forecast. The reporting-cycle
  movement and review date are displayed visually, so do not turn the script
  into a second overlapping countdown.
- No buy, sell, hold, target, fair value or personalised advice.
- Do not say a rumor is false merely because a filing reports a different accounting category.
- No source URLs in speech. No markdown. No promotional claim except the fixed closing line.`;
  const formatRules = format === "weekend-recap"
    ? `
WEEKEND RECAP MODE:
- Summarise the most decision-relevant verified change from the most recent
  completed trading session and how it affected the standing thesis.
- Say "weekend recap" only in the locked hook. Do not pretend a new event
  happened on the publication date.
- The visual runs from the last results to the next results. Do not mention a
  10–15-session window, expected impact window, target return or countdown.
- The reporting-cycle start and the thesis-open date are separate facts. Never
  say the thesis opened, began or started "with the results" unless those two
  supplied dates are identical.
- Keep the thesis continuous: explain what strengthened, weakened or left it
  open across the completed week, then name the next company result that tests it.
`
    : "";
  const editorInput = JSON.stringify({ DERIVED_VERDICT: derived, SOURCE_BUNDLE: sourceBundle });
  const suppliedDraftPath = after("--draft");
  const editorModel = suppliedDraftPath ? "manual-reviewed-copy" : EDITOR_MODEL;
  let editorText: string;
  let editorUsage: CouncilModelUsage | undefined;
  if (suppliedDraftPath) {
    editorText = await readFile(suppliedDraftPath, "utf8");
    editorUsage = undefined;
  } else {
    const editor = await callModel(
      EDITOR_MODEL,
      `${editorSystem}${formatRules}`,
      editorInput,
      `short-copy ${source.ticker} ${source.date}`,
      { maxTokens: SHORT_EDITOR_MAX_TOKENS },
    );
    if (!editor) throw new Error(`short editor ${EDITOR_MODEL} failed`);
    editorText = editor.text;
    editorUsage = editor.usage;
  }
  let draft = applyLockedDerivedBeats(source, jsonObject<ShortEpisodeDraft>(editorText), format);
  let deterministicIssues = validateShortDraft(source, draft, buildOptions);
  const pacingOnlyFailure = (issues: string[]): boolean =>
    issues.length > 0 && issues.every((issue) =>
      issue.startsWith("narration is ") ||
      issue.startsWith("estimated duration is ") ||
      /^[a-z]+ estimated to end at /.test(issue) ||
      /^[a-z]+ contains \d+ numeric facts; locked weekday maximum is /.test(issue) ||
      /^[a-z]+ beat is \d+ words; locked weekday range is /.test(issue));
  const lengthRepairs: Array<{
    attempt: number;
    responseSha256?: string;
    usage?: CouncilModelUsage;
    error?: string;
    issues: string[];
  }> = [];
  const maxLengthRepairs = suppliedDraftPath ? 0 : 3;
  for (
    let attempt = 1;
    attempt <= maxLengthRepairs && pacingOnlyFailure(deterministicIssues);
    attempt += 1
  ) {
    const repairSystem = `You are AMM's final spoken-copy length editor.
The supplied draft already passed every deterministic check except its spoken length.
Use ONLY its existing claims, supports and DERIVED_VERDICT. Return exactly one JSON
object matching the same amm-short-draft-v1 schema.

Rules:
- Make the combined six beat texts ${contract.targetWords.min}–${contract.targetWords.max}
  words. Count carefully.
- Resolve every supplied pacing issue, including beat word ranges, numeric
  density and estimated beat-end timing.
- Preserve claims, support quotes and every beat's claimIds exactly.
- Change only beat text. Do not add a fact, number, date, company, event, causal
  claim, certainty, recommendation or source.
- Preserve exact dates and temporal wording. Never replace a date with
  "today", "yesterday", "recently" or "latest".
- Treat opened/strengthened/weakened/remained-open as state labels only. Do not
  invent why the state changed.
- Keep the fixed close unchanged.
- When a beat carries too many numbers, omit the least decision-relevant
  spoken numbers while preserving its bound claim and exact support.
- Prefer one short clarifying sentence over repetition or filler.`;
    const repairInput = JSON.stringify({
      DERIVED_VERDICT: derived,
      ISSUES: deterministicIssues,
      DRAFT: draft,
    });
    const repair = await callModel(
      EDITOR_MODEL,
      repairSystem,
      repairInput,
      `short-copy-length-repair-${attempt} ${source.ticker} ${source.date}`,
      { maxTokens: SHORT_EDITOR_MAX_TOKENS },
    );
    const repairRecord: (typeof lengthRepairs)[number] = {
      attempt,
      issues: deterministicIssues,
    };
    if (!repair) {
      repairRecord.error = `repair editor ${EDITOR_MODEL} failed`;
      lengthRepairs.push(repairRecord);
      continue;
    }
    repairRecord.responseSha256 = hash(repair.text);
    repairRecord.usage = repair.usage;
    try {
      const repaired = jsonObject<ShortEpisodeDraft>(repair.text);
      // The repair lane is prose-only. Claims and bindings remain byte-for-byte
      // from the first editor output; the independent verifier still audits text.
      repaired.claims = draft.claims;
      for (const beatName of [
        "hook",
        "change",
        "thesis",
        "evidence",
        "council",
        "close",
      ] as const) {
        repaired.beats[beatName].claimIds = draft.beats[beatName].claimIds;
      }
      draft = applyLockedDerivedBeats(source, repaired, format);
      deterministicIssues = validateShortDraft(source, draft, buildOptions);
      repairRecord.issues = deterministicIssues;
    } catch (error) {
      repairRecord.error = error instanceof Error ? error.message : String(error);
    }
    lengthRepairs.push(repairRecord);
  }
  if (deterministicIssues.length) {
    await writeFile(path.join(outputDir, "blocked-copy-attempt.json"), `${JSON.stringify({
      schema: "amm-short-blocked-copy-v1",
      dossier: { ticker: source.ticker, date: source.date },
      model: editorModel,
      inputSha256: hash(editorInput),
      responseSha256: hash(editorText),
      usage: editorUsage ?? null,
      repairs: lengthRepairs,
      issues: deterministicIssues,
      draft,
    }, null, 2)}\n`);
    throw new Error(`short editor output failed deterministic gate:\n- ${deterministicIssues.join("\n- ")}`);
  }

  const verifierSystem = `You are an entailment auditor, not an editor.
You receive a closed SOURCE_BUNDLE and one draft. Treat all outside knowledge as unavailable.
For every draft claim, decide whether its statement and every sentence that cites it are
fully supported by the exact quoted source. A merely plausible inference is unsupported.
DERIVED_VERDICT is authoritative only for ticker, spoken company name, date, active-thesis identity,
opened date, observation index/status, signal, horizon, vote counts and the next
test. The deterministic hook's ticker, qualitative label and "N of 5 council votes"
wording are approved derived product state, not an external research claim. The fixed
close is approved product routing, not an external research claim.
Also fail category substitutions (for example debt versus obligations), stronger certainty,
wrong causality, changed dates, rounded figures, or a horizon not present in DERIVED_VERDICT.
For any amount attached to a deal, initiative or partnership, require the draft to
preserve what the exact source says the number measures. If the bundle does not
identify whether it is investment, spending, contracted revenue, purchases, total
business volume or merely an announced value, fail wording that lets the audience
infer one of those meanings; the safe repair is to omit the amount or explicitly
call the reported value unscoped.
Return JSON only:
{"status":"PASS"|"FAIL","unsupportedClaimIds":[],"notes":["brief reason"]}.
Do not rewrite the draft and do not introduce any new fact.`;
  type EntailmentVerdict = {
    status: "PASS" | "FAIL";
    unsupportedClaimIds: string[];
    notes: string[];
  };
  type EntailmentAudit = {
    input: string;
    responseText: string;
    usage: CouncilModelUsage | undefined;
    verdict: EntailmentVerdict;
  };
  const auditDraft = async (
    candidate: ShortEpisodeDraft,
    label: string,
  ): Promise<EntailmentAudit> => {
    const input = JSON.stringify({
      DERIVED_VERDICT: derived,
      SOURCE_BUNDLE: sourceBundle,
      DRAFT: candidate,
    });
    const response = await callModel(
      VERIFY_MODEL,
      verifierSystem,
      input,
      label,
      { maxTokens: SHORT_VERIFIER_MAX_TOKENS },
    );
    if (!response) throw new Error(`short entailment auditor ${VERIFY_MODEL} failed`);
    return {
      input,
      responseText: response.text,
      usage: response.usage,
      verdict: jsonObject<EntailmentVerdict>(response.text),
    };
  };

  const entailmentAudits: EntailmentAudit[] = [
    await auditDraft(draft, `short-entailment ${source.ticker} ${source.date}`),
  ];
  const entailmentRepairs: Array<{
    attempt: number;
    inputSha256: string;
    responseSha256?: string;
    usage?: CouncilModelUsage;
    lockError?: string;
    deterministicIssues?: string[];
  }> = [];
  let finalAudit = entailmentAudits[0];
  const maxEntailmentRepairs = suppliedDraftPath ? 0 : 2;
  for (
    let attempt = 1;
    attempt <= maxEntailmentRepairs &&
      (finalAudit.verdict.status !== "PASS" ||
        finalAudit.verdict.unsupportedClaimIds?.length > 0);
    attempt += 1
  ) {
    const rejectedIds = [...new Set(finalAudit.verdict.unsupportedClaimIds ?? [])]
      .filter((claimId) => draft.claims.some((claim) => claim.id === claimId));
    if (!rejectedIds.length) break;
    const repairSystem = `You are AMM's evidence-locked short-copy repair editor.
An independent auditor rejected specific claims or sentences for saying more than
their exact dossier support. Repair ONLY those rejected claim statements and ONLY
the beat text that cites them. Return exactly one amm-short-draft-v1 JSON object.

Hard rules:
- Use only SOURCE_BUNDLE, the rejected claims' existing exact support quotes and
  DERIVED_VERDICT. Treat all outside knowledge as unavailable.
- Preserve schema, claim count/order/ids, every support sourceId/quote, every
  beat claimIds array, the hook, close, accepted claim statements and accepted
  beat text exactly. Code rejects any other change.
- Prefer the dossier's literal accounting/category words. Do not translate a
  technical term into a claimed economic equivalent unless the support says so.
- Remove unsupported causality, equivalence, certainty or interpretation. A
  shorter literal sentence is better than a clever inference.
- Preserve exact source dates. Never replace a date with "today", "yesterday",
  "recently" or "latest".
- Lifecycle states are labels, not causes. State that the thesis strengthened,
  weakened or remained open without inventing why it changed.
- Keep total six-beat narration at ${contract.minWords}–${contract.maxWords} words.
${format === "weekday"
  ? `- Keep weekday beats inside their locked ranges: change 9–12 words,
  thesis 8–10, evidence 8–11, and council 11–14.
- Keep change and evidence to at most three spoken numeric facts each.`
  : ""}
- No new fact, number, date, company, event, implication or recommendation.
- The repaired result will face the same deterministic gate and a fresh,
  independent entailment audit.`;
    const repairInput = JSON.stringify({
      DERIVED_VERDICT: derived,
      SOURCE_BUNDLE: sourceBundle,
      REJECTED_CLAIM_IDS: rejectedIds,
      AUDITOR_NOTES: finalAudit.verdict.notes,
      DRAFT: draft,
    });
    const repairRecord: (typeof entailmentRepairs)[number] = {
      attempt,
      inputSha256: hash(repairInput),
    };
    const response = await callModel(
      EDITOR_MODEL,
      repairSystem,
      repairInput,
      `short-entailment-repair-${attempt} ${source.ticker} ${source.date}`,
      { maxTokens: SHORT_EDITOR_MAX_TOKENS },
    );
    if (!response) {
      repairRecord.lockError = `repair editor ${EDITOR_MODEL} failed`;
      entailmentRepairs.push(repairRecord);
      continue;
    }
    repairRecord.responseSha256 = hash(response.text);
    repairRecord.usage = response.usage;
    try {
      const proposed = jsonObject<ShortEpisodeDraft>(response.text);
      const repaired = applyEvidenceLockedShortRepair(draft, proposed, rejectedIds);
      const locked = applyLockedDerivedBeats(source, repaired, format);
      const issues = validateShortDraft(source, locked, buildOptions);
      if (issues.length) {
        repairRecord.deterministicIssues = issues;
        entailmentRepairs.push(repairRecord);
        continue;
      }
      draft = locked;
      entailmentRepairs.push(repairRecord);
      finalAudit = await auditDraft(
        draft,
        `short-entailment-after-repair-${attempt} ${source.ticker} ${source.date}`,
      );
      entailmentAudits.push(finalAudit);
    } catch (error) {
      repairRecord.lockError = error instanceof Error ? error.message : String(error);
      entailmentRepairs.push(repairRecord);
    }
  }
  const verdict = finalAudit.verdict;
  if (verdict.status !== "PASS" || verdict.unsupportedClaimIds?.length) {
    await writeFile(path.join(outputDir, "blocked-entailment-attempt.json"), `${JSON.stringify({
      schema: "amm-short-blocked-entailment-v1",
      dossier: { ticker: source.ticker, date: source.date },
      editorModel,
      verifierModel: VERIFY_MODEL,
      editorUsage: editorUsage ?? null,
      verifierUsage: finalAudit.usage ?? null,
      verdict,
      entailmentRepairs,
      entailmentAudits: entailmentAudits.map((audit, index) => ({
        attempt: index,
        inputSha256: hash(audit.input),
        responseSha256: hash(audit.responseText),
        usage: audit.usage ?? null,
        verdict: audit.verdict,
      })),
      draft,
    }, null, 2)}\n`);
    throw new Error(
      `short entailment audit failed: ${verdict.unsupportedClaimIds?.join(", ") || "unspecified"} ` +
      `${verdict.notes?.join("; ") || ""}`.trim(),
    );
  }

  const episode = buildShortEpisodePackage(
    source,
    draft,
    Date.now(),
    identity,
    buildOptions,
  );
  const files = {
    draft: path.join(outputDir, "draft.json"),
    package: path.join(outputDir, "episode-package.json"),
    dossier: path.join(outputDir, "dossier.json"),
    audit: path.join(outputDir, "copy-audit.json"),
    description: path.join(outputDir, "source-description.txt"),
  };
  await Promise.all([
    writeFile(files.draft, `${JSON.stringify(draft, null, 2)}\n`),
    writeFile(files.package, `${JSON.stringify(episode, null, 2)}\n`),
    writeFile(files.dossier, `${JSON.stringify(source, null, 2)}\n`),
    writeFile(
      files.description,
      `${episode.publication.sourceDescription}\n\nTrace: ${episode.publication.traceUrl}\n`,
    ),
    writeFile(files.audit, `${JSON.stringify({
      schema: "amm-short-copy-audit-v1",
      episodeId: episode.episodeId,
      identity,
      dossierSha256: episode.dossier.sha256,
      sourceBundleSha256: episode.provenance.sourceBundleSha256,
      editor: {
        model: editorModel,
        inputSha256: hash(editorInput),
        responseSha256: hash(editorText),
        usage: editorUsage ?? null,
        repairs: lengthRepairs,
      },
      verifier: {
        model: VERIFY_MODEL,
        inputSha256: hash(finalAudit.input),
        responseSha256: hash(finalAudit.responseText),
        verdict,
        usage: finalAudit.usage ?? null,
        attempts: entailmentAudits.map((audit, index) => ({
          attempt: index,
          inputSha256: hash(audit.input),
          responseSha256: hash(audit.responseText),
          verdict: audit.verdict,
          usage: audit.usage ?? null,
        })),
        repairs: entailmentRepairs,
      },
    }, null, 2)}\n`),
  ]);
  console.log(JSON.stringify({
    releaseReadyForRender: true,
    package: files.package,
    episodeId: episode.episodeId,
    words: episode.editorial.words,
    estimatedSeconds: episode.editorial.estimatedSeconds,
    companyName: identity.companyName,
    identitySource: identity.source,
    editorCostUsd: editorUsage?.costUsd ?? null,
    verifierCostUsd: entailmentAudits.reduce(
      (sum, audit) => sum + (audit.usage?.costUsd ?? 0),
      0,
    ),
    entailmentRepairCostUsd: entailmentRepairs.reduce(
      (sum, repair) => sum + (repair.usage?.costUsd ?? 0),
      0,
    ),
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
