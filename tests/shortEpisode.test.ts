import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildShortEpisodePackage,
  deriveWeekendReportingCycle,
  shortEpisodeUsedCitationIds,
  shortEpisodeUsedCitations,
  shortPackageValidationError,
  validateShortDraft,
  type ShortEpisodeDraft,
} from "../src/lib/shortEpisode";
import { applyEvidenceLockedShortRepair } from "../src/lib/shortRepair";
import {
  calculateDossierCitationCoverage,
  type Dossier,
} from "../src/lib/dossier";

const citationUrl = "https://www.sec.gov/filing";
const cited =
  `Cloud operating income accelerated 34% while capital spending rose. [1 · 2026-07-16]` +
  `(${citationUrl} "SEC filing — 2026-07-16")`;

function citedClaim(text: string): string {
  return `${text} [1 · 2026-07-16](${citationUrl} "SEC filing — 2026-07-16")`;
}

function dossier(): Dossier {
  const value = {
    ticker: "GOOGL",
    date: "2026-07-17",
    generatedAt: Date.parse("2026-07-17T00:00:00Z"),
    artifactVersion: 5,
    headline: cited,
    story: Array.from({ length: 24 }, (_, index) => citedClaim(
      `The core synthesis connects cloud demand with the heavier capacity commitment in observation ${index + 1}.`,
    )).join(" "),
    bulls: [
      citedClaim("Enterprise contract growth supports the constructive demand case."),
      citedClaim("Customer expansion adds an independent sign of product adoption."),
      citedClaim("Operating leverage gives the business room to absorb deployment costs."),
    ],
    bears: [
      citedClaim("Long construction lead times leave near-term returns exposed to execution."),
      citedClaim("Capacity arriving before demand would weaken asset productivity."),
      citedClaim("A slower workload mix could defer the expected margin conversion."),
    ],
    risk: Array.from({ length: 14 }, (_, index) => citedClaim(
      `The failure case turns on utilisation, delivery timing and contract durability in risk test ${index + 1}.`,
    )).join(" "),
    numbersRead: Array.from({ length: 14 }, (_, index) => citedClaim(
      `The filed arithmetic separates operating profit, cash generation and investment intensity in bridge ${index + 1}.`,
    )).join(" "),
    signalCase: {
      eventType: "earnings",
      direction: "UP",
      strength: "GENTLE",
      horizonSessions: { min: 10, max: 15 },
      mechanism: cited,
      invalidation: cited,
    },
    sources: "SEC",
    emailHook: {
      subjectPunchline: "Cloud acceleration now carries a much heavier bill",
      priorUpdate: null,
      whatChanged: cited,
      thesis: cited,
      question: "Is it true that cloud acceleration now carries a much heavier bill?",
      primaryEvidence: cited,
      secondaryEvidence: [cited, cited],
      signal: {
        eventType: "earnings",
        direction: "UP",
        strength: "GENTLE",
        horizonSessions: { min: 10, max: 15 },
      },
      votesSupport: 3,
      votesOppose: 1,
      votesUncertain: 1,
      votesTotal: 5,
      votes: { support: 3, oppose: 1, uncertain: 1 },
      confidence: {
        majorityReason: cited,
        dissentReason: cited,
        uncertaintyReason: cited,
        flipCondition: cited,
      },
      oracle: { type: "filing", trigger: cited, dueBy: "2026-11-14" },
      editorialStrength: { novelty: 4, materiality: 4, evidence: 4, asymmetry: 3, score: 76 },
    },
    citations: [{
      id: "S1",
      title: "SEC filing",
      url: citationUrl,
      publisher: "SEC",
      authority: "primary",
      publishedAt: Date.parse("2026-07-16T20:00:00Z"),
      publishedDate: "2026-07-16",
      retrievedAt: Date.parse("2026-07-16T20:05:00Z"),
      sourceDocumentId: "sec-googl-filing",
    }],
    citationCoverage: { claims: 0, cited: 0, primarySources: 0 },
    briefAuditId: "brief-audit-test",
    councilRunId: "council-run-test",
    seats: 5,
  } as Dossier;
  value.thesisLifecycle = {
    schemaVersion: 1,
    id: "f".repeat(48),
    openedDate: "2026-07-14",
    openedAt: Date.parse("2026-07-14T00:00:00Z"),
    observationDate: value.date,
    observationIndex: 4,
    observationStatus: "strengthened",
    canonicalSubjectPunchline: value.emailHook.subjectPunchline,
    canonicalThesis: value.emailHook.thesis,
    canonicalQuestion: value.emailHook.question,
    canonicalSignal: value.emailHook.signal,
    canonicalOracle: value.emailHook.oracle,
    canonicalVotes: {
      support: value.emailHook.votesSupport,
      oppose: value.emailHook.votesOppose,
      uncertain: value.emailHook.votesUncertain,
      total: 5,
    },
    latestSignal: value.emailHook.signal,
  };
  value.citationCoverage = calculateDossierCitationCoverage(value);
  return value;
}

function draft(): ShortEpisodeDraft {
  const quote = "Cloud operating income accelerated 34% while capital spending rose.";
  const claim = (id: string, statement: string) => ({
    id,
    statement,
    support: [{ sourceId: "D1", quote }],
  });
  return {
    schema: "amm-short-draft-v1",
    claims: [
      claim("C1", "The filed quarter shows cloud growth alongside rising investment"),
      claim("C2", "The same filing is the basis for the directional thesis"),
      claim("C3", "The council majority relies on the admitted filing"),
    ],
    beats: {
      hook: {
        text: "Google. AMM thesis: gentle upside.",
        claimIds: [],
      },
      change: {
        text: "Cloud income rose 34 percent while capital spending increased in parallel today.",
        claimIds: ["C1"],
      },
      thesis: {
        text: "AMM sees gentle upside because operations can support rising investment.",
        claimIds: ["C2"],
      },
      evidence: {
        text: "The filing pairs stronger cloud income with heavier capital spending directly.",
        claimIds: ["C1"],
      },
      council: {
        text: "Three support, one opposes, and one remains uncertain pending the next company filing.",
        claimIds: ["C3"],
      },
      close: {
        text: "For daily thesis updates and evidence, visit aftermarketmovers dot com.",
        claimIds: [],
      },
    },
  };
}

function weekendDraft(): ShortEpisodeDraft {
  const value = draft();
  value.beats.hook.text =
    "GOOGL. Weekend recap. Current read: gentle upside. 3 of 5 council votes support the active thesis.";
  value.beats.change.text =
    "Cloud operating income accelerated 34% while capital spending rose, putting operating progress and the heavier capacity commitment into the same frame.";
  value.beats.thesis.text =
    "AMM reads that tension as gentle upside because current operating progress gives the company room to carry the investment while demand is still expanding.";
  value.beats.evidence.text =
    "The decisive evidence is the filed operating result, not outside commentary, and the open risk is whether later demand continues to justify the larger spending base over the coming reporting cycle. That distinction keeps the argument tied to evidence the released record actually contains, rather than a more exciting but unsupported outside narrative. It also prevents unsupported outside facts.";
  value.beats.council.text =
    "Three of five analysts support the read, one opposes it and one remains uncertain, with the next filing set as the test that can strengthen or retire the thesis.";
  value.beats.close.text =
    "See the full dossier and every source at aftermarketmovers dot com.";
  return value;
}

test("builds a locked 36–46 second weekday episode and trace receipt", () => {
  const result = buildShortEpisodePackage(dossier(), draft(), 123, {
    companyName: "Alphabet Inc.",
    source: "market-metadata",
  });
  assert.equal(result.editorial.templateVersion, "amm-weekday-locked-v3");
  assert.equal(result.editorial.words >= 61, true);
  assert.equal(result.editorial.words <= 63, true);
  assert.equal(result.editorial.estimatedSeconds >= 36, true);
  assert.equal(result.editorial.estimatedSeconds <= 46, true);
  assert.equal(result.provenance.citations[0].url, citationUrl);
  assert.match(result.publication.sourceDescription, /brief-audit-test/);
  assert.match(result.publication.sourceDescription, /Sources used in this episode/);
  assert.match(result.publication.sourceDescription, /S1\. SEC/);
  assert.deepEqual(result.identity, {
    companyName: "Alphabet Inc.",
    source: "market-metadata",
  });
  assert.deepEqual(result.lifecycle, {
    id: "f".repeat(48),
    openedDate: "2026-07-14",
    observationDate: "2026-07-17",
    observationIndex: 4,
    status: "strengthened",
    canonicalSubjectPunchline: "Cloud acceleration now carries a much heavier bill",
    canonicalLabel: "GENTLE UPSIDE",
    currentLabel: "GENTLE UPSIDE",
    reviewDueBy: "2026-11-14",
  });
  assert.equal(shortPackageValidationError(dossier(), result), null);
});

test("blocks weekday hook or CTA drift before any render is purchased", () => {
  const hookDrift = draft();
  hookDrift.beats.hook.text = "Here is today's GOOGL stock forecast.";
  assert.match(
    validateShortDraft(dossier(), hookDrift).join("\n"),
    /deterministic current-read opener/,
  );

  const ctaDrift = draft();
  ctaDrift.beats.close.text = "Subscribe now for more stock picks.";
  assert.match(
    validateShortDraft(dossier(), ctaDrift).join("\n"),
    /locked AMM routing line/,
  );
});

test("blocks weekday scene-length drift before any render is purchased", () => {
  const value = draft();
  value.beats.evidence.text = "The filing supports the thesis.";
  assert.match(
    validateShortDraft(dossier(), value).join("\n"),
    /evidence beat is .*locked weekday range/,
  );
});

test("blocks the prior production evidence pacing drift before any render is purchased", () => {
  const value = draft();
  value.beats.evidence.text =
    "The filing shows 34 percent cloud growth, 12 billion dollars of spending, " +
    "7 billion dollars of operating income, and 9 percent margins in the quarter.";
  const issues = validateShortDraft(dossier(), value).join("\n");
  assert.match(issues, /evidence beat is .*locked weekday range/);
  assert.match(issues, /evidence contains .*numeric facts/);
  assert.match(issues, /evidence estimated to end at .*locked weekday maximum/);
});

test("blocks a 59-word fast-delivery script before any render is purchased", () => {
  const value = draft();
  value.beats.change.text =
    "Revenue grew today while the latest filing showed no company-specific adverse event.";
  value.beats.evidence.text =
    "Operating cash flow still covered the disclosed capital spending program.";
  value.beats.thesis.text =
    "AMM sees gentle upside because operating progress still funds investment.";
  value.beats.council.text =
    "Three support, none oppose, and two remain uncertain pending fresh primary evidence.";
  const issues = validateShortDraft(dossier(), value).join("\n");
  assert.match(issues, /narration is 59 words; expected 60–63/);
});

test("builds a source-bound weekend recap with a quarter-to-quarter reporting cycle", () => {
  const source = dossier();
  const value = weekendDraft();
  const result = buildShortEpisodePackage(source, value, 123, undefined, {
    format: "weekend-recap",
    reportingCycle: {
      publicationDate: "2026-07-18",
      sourceDate: source.date,
      startDate: "2026-04-25",
      startLabel: "LAST RESULTS · APR 25",
      endDate: "2026-11-14",
      endLabel: "NEXT RESULTS · NOV 14",
    },
  });
  assert.equal(result.format, "weekend-recap");
  assert.deepEqual(result.reportingCycle, {
    publicationDate: "2026-07-18",
    sourceDate: "2026-07-17",
    startDate: "2026-04-25",
    startLabel: "LAST RESULTS · APR 25",
    endDate: "2026-11-14",
    endLabel: "NEXT RESULTS · NOV 14",
  });
  assert.doesNotMatch(result.editorial.script, /10[–-]15|expected impact/i);
  assert.equal(shortPackageValidationError(source, result), null);
});

test("anchors a weekend recap to admitted results, not the later thesis-open date", () => {
  const source = dossier();
  source.date = "2026-07-25";
  source.thesisLifecycle!.openedDate = "2026-07-25";
  source.citations = [
    {
      ...source.citations![0],
      id: "S10Q",
      title: "GOOGL 10-Q — period 2026-06-30",
      url: "https://www.sec.gov/Archives/10q.htm",
      publishedDate: "2026-07-23",
      publishedAt: Date.parse("2026-07-23T20:00:00Z"),
    },
    {
      ...source.citations![0],
      id: "S8K",
      title: "GOOGL 8-K — items 2.02,9.01",
      url: "https://www.sec.gov/Archives/8k.htm",
      publishedDate: "2026-07-22",
      publishedAt: Date.parse("2026-07-22T20:00:00Z"),
    },
  ];
  assert.deepEqual(
    deriveWeekendReportingCycle(source, "2026-07-26", "Q2 earnings — Jul 22 after close"),
    {
      publicationDate: "2026-07-26",
      sourceDate: "2026-07-25",
      startDate: "2026-07-22",
      startLabel: "LAST RESULTS · JUL 22",
      endDate: "2026-11-14",
      endLabel: "NEXT RESULTS · DATE PENDING",
    },
  );
});

test("uses a future known earnings date for the weekend cycle endpoint", () => {
  const source = dossier();
  source.citations![0] = {
    ...source.citations![0],
    title: "GOOGL 10-Q — period 2026-06-30",
  };
  assert.equal(
    deriveWeekendReportingCycle(source, "2026-07-18", "Q2 earnings — Jul 22 after close").endLabel,
    "NEXT RESULTS · JUL 22",
  );
});

test("blocks weekend copy that conflates a later thesis opening with results", () => {
  const source = dossier();
  const value = weekendDraft();
  value.beats.thesis.text =
    "The thesis opened with these results, and AMM reads the operating progress as gentle upside.";
  const options = {
    format: "weekend-recap" as const,
    reportingCycle: {
      publicationDate: "2026-07-18",
      sourceDate: source.date,
      startDate: "2026-07-12",
      startLabel: "LAST RESULTS · JUL 12",
      endDate: "2026-11-14",
      endLabel: "NEXT RESULTS · DATE PENDING",
    },
  };
  assert.match(
    validateShortDraft(source, value, options).join("\n"),
    /must not conflate the results date with the later thesis-open date/,
  );
});

test("exposes only the citations actually used by the finished short", () => {
  const result = buildShortEpisodePackage(dossier(), draft(), 123);
  result.provenance.citations.push({
    id: "S99",
    title: "Unused source",
    url: "https://example.com/unused",
    publisher: "Example",
    authority: "independent",
    publishedDate: "2026-07-16",
    sourceDocumentId: "unused-source",
  });
  assert.deepEqual(shortEpisodeUsedCitationIds(result), ["S1"]);
  assert.deepEqual(
    shortEpisodeUsedCitations(result).map((citation) => citation.id),
    ["S1"],
  );
});

test("blocks an external numeric claim that is absent from cited dossier support", () => {
  const value = draft();
  value.beats.evidence.text =
    "The decisive evidence is a new 81% increase that does not appear anywhere in the admitted dossier.";
  assert.match(validateShortDraft(dossier(), value).join("\n"), /unsupported numeric fact: 81%/);
});

test("treats sentence-final punctuation as presentation, not a new numeric fact", () => {
  const value = draft();
  value.beats.change.text =
    "Cloud operating income accelerated 34% while capital spending rose in observation 1.";
  assert.doesNotMatch(
    validateShortDraft(dossier(), value).join("\n"),
    /unsupported numeric fact: 1\./,
  );
});

test("blocks support quotes that are not verbatim dossier text", () => {
  const value = draft();
  value.claims[0].support[0].quote = "A fabricated support sentence that is not in the dossier.";
  assert.match(validateShortDraft(dossier(), value).join("\n"), /quote is not verbatim dossier text/);
});

test("accepts an evidence-locked repair of only rejected claim prose", () => {
  const before = draft();
  const proposed = structuredClone(before);
  proposed.claims[1].statement =
    "The same filing is the stated basis for the directional thesis";
  proposed.beats.thesis.text =
    "AMM keeps the thesis tied to the same filed operating result and does not add a broader causal explanation.";
  const repaired = applyEvidenceLockedShortRepair(before, proposed, ["C2"]);
  assert.equal(repaired.claims[1].statement, proposed.claims[1].statement);
  assert.equal(repaired.beats.thesis.text, proposed.beats.thesis.text);
  assert.deepEqual(repaired.claims[1].support, before.claims[1].support);
  assert.equal(repaired.beats.evidence.text, before.beats.evidence.text);
});

test("rejects any entailment repair that alters locked evidence or accepted copy", () => {
  const before = draft();
  const supportTamper = structuredClone(before);
  supportTamper.claims[1].support[0].quote = "Changed support";
  assert.throws(
    () => applyEvidenceLockedShortRepair(before, supportTamper, ["C2"]),
    /changed locked support/,
  );

  const acceptedCopyTamper = structuredClone(before);
  acceptedCopyTamper.beats.change.text = "Changed accepted copy";
  assert.throws(
    () => applyEvidenceLockedShortRepair(before, acceptedCopyTamper, ["C2"]),
    /changed locked change copy/,
  );
});

test("detects mutation after the immutable package is built", () => {
  const source = dossier();
  const episode = buildShortEpisodePackage(source, draft(), 123);
  episode.editorial.beats.thesis.text += " Mutated.";
  assert.match(shortPackageValidationError(source, episode) ?? "", /blocked|does not match dossier/);
});

test("binds the reliable text identity into the immutable episode", () => {
  const source = dossier();
  const episode = buildShortEpisodePackage(source, draft(), 123, {
    companyName: "Alphabet Inc.",
    source: "explicit",
  });
  episode.identity!.companyName = "Another Company";
  assert.match(shortPackageValidationError(source, episode) ?? "", /does not match dossier/);
});

test("binds the continuous-thesis lifecycle into the immutable episode", () => {
  const source = dossier();
  const episode = buildShortEpisodePackage(source, draft(), 123);
  episode.lifecycle.observationIndex += 1;
  assert.match(shortPackageValidationError(source, episode) ?? "", /does not match dossier/);
});

test("renders every lifecycle-aware visual without unresolved template tokens", {
  skip: process.env.AMM_RENDER_SHORT_CARDS_TEST !== "1",
}, () => {
  const source = dossier();
  const episode = buildShortEpisodePackage(source, draft(), 123, {
    companyName: "Alphabet Inc.",
    source: "explicit",
  });
  const requestedDirectory = process.env.AMM_RENDER_SHORT_CARDS_DIR?.trim();
  const directory = requestedDirectory ||
    mkdtempSync(join(tmpdir(), "amm-short-cards-"));
  mkdirSync(directory, { recursive: true });
  const packagePath = join(directory, "episode-package.json");
  writeFileSync(packagePath, JSON.stringify(episode));
  writeFileSync(join(directory, "dossier.json"), JSON.stringify(source));
  try {
    execFileSync("python3", [
      resolve("tools/shorts/make_cards.py"),
      packagePath,
      directory,
    ], { stdio: "pipe" });
    const required = [
      "s-hook.png",
      "s-frame.png",
      "split-frame.png",
      "split-hook.png",
      "s-meter.png",
      "split-meter.png",
      "s-vote.png",
      "split-vote.png",
      "s-end.png",
      "split-end.png",
      "split-cap1.png",
      "caption-weights.json",
      "weekday-01-hook.png",
      "weekday-02-change.png",
      "weekday-03-evidence.png",
      "weekday-04-thesis.png",
      "weekday-05-council.png",
      "weekday-06-close.png",
      "weekday-visual-plan.json",
    ];
    for (const name of required) {
      assert.equal(existsSync(join(directory, name)), true, `${name} was not rendered`);
    }
    const pngs = readdirSync(directory).filter((name) => name.endsWith(".png"));
    assert.equal(pngs.length >= 18, true);
    const dimensions = execFileSync("python3", [
      "-c",
      [
        "from PIL import Image",
        "import os,sys",
        "root=sys.argv[1]",
        "files=[f for f in os.listdir(root) if f.endswith('.png')]",
        "assert files",
        "assert all(Image.open(os.path.join(root,f)).size==(1080,1920) for f in files)",
      ].join(";"),
      directory,
    ], { encoding: "utf8" });
    assert.equal(dimensions, "");
  } finally {
    if (!requestedDirectory) rmSync(directory, { recursive: true, force: true });
  }
});

test("the Cloud Run card renderer uses container-safe Chromium flags", () => {
  const output = execFileSync("python3", [
    "-c",
    [
      "import importlib.util,json,os,subprocess,sys,tempfile",
      "spec=importlib.util.spec_from_file_location('cards',sys.argv[1])",
      "cards=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(cards)",
      "calls=[]",
      "cards.chrome_bin=lambda:'/usr/bin/chromium'",
      "cards.os.geteuid=lambda:0",
      "def fake_run(cmd,**kwargs):",
      "  calls.append(cmd)",
      "  shot=next((v.split('=',1)[1] for v in cmd if v.startswith('--screenshot=')),None)",
      "  if shot: open(shot,'wb').write(b'png')",
      "  return subprocess.CompletedProcess(cmd,0,'','')",
      "cards.subprocess.run=fake_run",
      "out=tempfile.mktemp(suffix='.png')",
      "cards.render('<html></html>',out)",
      "print(json.dumps(calls[0]))",
    ].join("\n"),
    resolve("tools/shorts/make_cards.py"),
  ], { encoding: "utf8" });
  const args = JSON.parse(output) as string[];
  assert.equal(args.includes("--no-sandbox"), true);
  assert.equal(args.includes("--disable-dev-shm-usage"), true);
});

test("short caption wrapping keeps financial amounts attached to their units", () => {
  const output = execFileSync("python3", [
    "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('cards',sys.argv[1])",
      "cards=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(cards)",
      "value='Half-year operating cash flow was $84.86 billion against $80.60 billion of capital expenditures, leaving a $4.26 billion residual.'",
      "print(json.dumps(cards.sentence_chunks(value)))",
    ].join(";"),
    resolve("tools/shorts/make_cards.py"),
  ], { encoding: "utf8" });
  const chunks = JSON.parse(output) as string[];
  assert.deepEqual(chunks, [
    "Half-year operating cash flow was $84.86 billion against $80.60 billion of capital expenditures, leaving a $4.26 billion residual.",
  ]);
});

test("weekday evidence graphics preserve percentages and financial units", () => {
  const output = execFileSync("python3", [
    "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('cards',sys.argv[1])",
      "cards=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(cards)",
      "value='Revenue grew 34 percent, margin was 1.4%, operating income reached $28.24 billion and cash was $398 million.'",
      "print(json.dumps(cards.evidence_numbers(value)))",
    ].join(";"),
    resolve("tools/shorts/make_cards.py"),
  ], { encoding: "utf8" });
  const values = JSON.parse(output) as string[];
  assert.deepEqual(values, ["34%", "1.4%", "$28.24B"]);
});

test("weekday comparison graphics bind each figure to its preceding financial line", () => {
  const output = execFileSync("python3", [
    "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('cards',sys.argv[1])",
      "cards=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(cards)",
      "growth=cards.growth_metrics('Revenue rose 24% while net income jumped 298%.')",
      "comparison=cards.evidence_metrics('The securities line was $99.03B versus operating income of $40.77B.')",
      "trailing=cards.evidence_metrics('Half-year capex was $80.60B against $84.86B operating cash flow.')",
      "print(json.dumps({'growth':growth,'comparison':comparison,'trailing':trailing}))",
    ].join(";"),
    resolve("tools/shorts/make_cards.py"),
  ], { encoding: "utf8" });
  const values = JSON.parse(output) as {
    growth: Array<{ label: string; value: string }>;
    comparison: Array<{ label: string; value: string }>;
    trailing: Array<{ label: string; value: string }>;
  };
  assert.deepEqual(
    values.growth.map(({ label, value }) => ({ label, value })),
    [
      { label: "REVENUE", value: "24%" },
      { label: "NET INCOME", value: "298%" },
    ],
  );
  assert.deepEqual(
    values.comparison.map(({ label, value }) => ({ label, value })),
    [
      { label: "SECURITIES LINE", value: "$99.03B" },
      { label: "OPERATING INCOME", value: "$40.77B" },
    ],
  );
  assert.deepEqual(
    values.trailing.map(({ label, value }) => ({ label, value })),
    [
      { label: "CAPEX", value: "$80.60B" },
      { label: "OPERATING CASH FLOW", value: "$84.86B" },
    ],
  );
});

test("weekday market-move evidence is never presented as a filed operating metric", () => {
  const output = execFileSync("python3", [
    "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('cards',sys.argv[1])",
      "cards=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(cards)",
      "value='AMD dropped roughly 7.1% and then 4% on the two reported days.'",
      "metrics=cards.evidence_metrics(value)",
      "print(json.dumps({'metrics':metrics,'headline':cards.evidence_headline(value,metrics)}))",
    ].join(";"),
    resolve("tools/shorts/make_cards.py"),
  ], { encoding: "utf8" });
  const result = JSON.parse(output) as {
    metrics: Array<{ label: string; value: string }>;
    headline: string;
  };
  assert.deepEqual(
    result.metrics.map(({ label, value }) => ({ label, value })),
    [
      { label: "REPORTED MOVE 1", value: "7.1%" },
      { label: "REPORTED MOVE 2", value: "4%" },
    ],
  );
  assert.equal(result.headline, "The reported share-price moves");
});

test("builds one portrait Avatar V payload with the locked copy and exact identities", () => {
  const source = dossier();
  const episode = buildShortEpisodePackage(source, draft(), 123);
  const directory = mkdtempSync(join(tmpdir(), "amm-short-payload-"));
  const packagePath = join(directory, "episode.json");
  const payloadPath = join(directory, "payload.json");
  writeFileSync(packagePath, JSON.stringify(episode));
  try {
    execFileSync("python3", [
      resolve("tools/shorts/heygen_payload.py"),
      packagePath,
      payloadPath,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    assert.equal(payload.type, "avatar");
    assert.equal(payload.avatar_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(payload.voice_id, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.deepEqual(payload.engine, { type: "avatar_v" });
    assert.equal(payload.aspect_ratio, "9:16");
    assert.equal(payload.resolution, "1080p");
    assert.equal(payload.motion_prompt, undefined);
    const expectedScript = [
      "hook", "change", "evidence", "thesis", "council", "close",
    ].map((name) => episode.editorial.beats[
      name as keyof typeof episode.editorial.beats
    ].text).join("\n\n");
    assert.equal(payload.script, expectedScript);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("weekday rendering cannot be redirected to another presenter by environment", () => {
  const renderer = readFileSync(resolve("tools/shorts/make-episode.sh"), "utf8");
  const weeklyRenderer = readFileSync(
    resolve("tools/shorts/make-weekly-episode.sh"),
    "utf8",
  );
  const qc = readFileSync(resolve("tools/shorts/qc.py"), "utf8");
  assert.match(renderer, /AVATAR="\$\{HEYGEN_AVATAR_ID:\?/);
  assert.match(renderer, /EXPECTED_AVATAR_GROUP="\$\{HEYGEN_AVATAR_GROUP:\?/);
  assert.match(renderer, /VOICE="\$\{HEYGEN_VOICE_ID:\?/);
  assert.doesNotMatch(renderer, /HEYGEN_AVATAR_ID:-/);
  assert.doesNotMatch(renderer, /HEYGEN_VOICE_ID:-/);
  assert.match(qc, /LOCKED_AVATAR_NAME = os\.environ\.get\("HEYGEN_PRESENTER_NAME"/);
  assert.match(qc, /LOCKED_VOICE_NAME = os\.environ\.get\("HEYGEN_VOICE_NAME"/);
  for (const script of [renderer, weeklyRenderer]) {
    assert.match(script, /command -v sha256sum/);
    assert.match(script, /command -v shasum/);
    assert.match(script, /command -v openssl/);
    assert.match(script, /\| sha256_stdin \| cut -c1-40/);
  }
});

test("aligns returned HeyGen subtitles to every audited beat without guessing", () => {
  const source = dossier();
  const episode = buildShortEpisodePackage(source, draft(), 123);
  const directory = mkdtempSync(join(tmpdir(), "amm-short-timing-"));
  const packagePath = join(directory, "episode.json");
  const subtitlePath = join(directory, "episode.srt");
  writeFileSync(packagePath, JSON.stringify(episode));
  const names = ["hook", "change", "evidence", "thesis", "council", "close"] as const;
  const srt = names.map((name, index) => {
    const start = index * 10;
    const end = start + 9;
    const stamp = (seconds: number) =>
      `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
      `${String(seconds % 60).padStart(2, "0")},000`;
    return `${index + 1}\n${stamp(start)} --> ${stamp(end)}\n` +
      `${episode.editorial.beats[name].text}\n`;
  }).join("\n");
  writeFileSync(subtitlePath, srt);
  try {
    const script = [
      "import importlib.util,json,sys",
      `spec=importlib.util.spec_from_file_location('finish',${JSON.stringify(resolve("tools/shorts/finish.py"))})`,
      "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
      `package=json.load(open(${JSON.stringify(packagePath)}))`,
      `cues=module.parse_srt(${JSON.stringify(subtitlePath)})`,
      "timings,ratio=module.derive_beat_timings(package,cues)",
      "print(json.dumps({'timings':timings,'ratio':ratio}))",
    ].join(";");
    const result = JSON.parse(execFileSync("python3", ["-c", script], {
      encoding: "utf8",
    }));
    assert.equal(result.ratio, 1);
    assert.equal(result.timings.hook.start, 0);
    assert.equal(result.timings.change.start, 10);
    assert.equal(result.timings.close.end, 59);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("holds each research visual until the next beat begins", () => {
  const script = [
    "import importlib.util,json",
    `spec=importlib.util.spec_from_file_location('finish',${JSON.stringify(resolve("tools/shorts/finish.py"))})`,
    "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
    "timings={'hook':{'start':0.34,'end':6.68},'change':{'start':7.5,'end':18.92},'thesis':{'start':19.8,'end':33.48},'evidence':{'start':34.38,'end':48.34},'council':{'start':49.04,'end':62.84},'close':{'start':63.52,'end':66.82}}",
    "print(json.dumps(module.derive_display_timings(timings,67.24)))",
  ].join(";");
  const result = JSON.parse(execFileSync("python3", ["-c", script], {
    encoding: "utf8",
  }));
  assert.deepEqual(result, {
    hook: { start: 0, end: 7.5 },
    change: { start: 7.5, end: 19.8 },
    thesis: { start: 19.8, end: 34.38 },
    evidence: { start: 34.38, end: 49.04 },
    council: { start: 49.04, end: 63.52 },
    close: { start: 63.52, end: 67.44 },
  });
});
