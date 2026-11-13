import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  AUXILIARY_MODELS,
  COUNCIL_MODELS,
  DISALLOWED_PREMIUM_DEFAULTS,
  LLMC3_COUNCIL_TIER,
  RESEARCH_MODELS,
  RUNTIME_MODEL_DEPENDENCIES,
  productionModelDefaults,
} from "../src/lib/modelPolicy";
import { callLlmc3Council } from "../src/lib/councilEngine";
import { RESOLVER_ADJUDICATOR_VERSION } from "../src/lib/scoreboard";

test("production routing contains no premium flagship defaults", () => {
  const defaults = new Set(productionModelDefaults());
  for (const model of DISALLOWED_PREMIUM_DEFAULTS) {
    assert.equal(defaults.has(model), false, `${model} must not be a production default`);
  }
});

test("cost control preserves five independent ballot provider families", () => {
  assert.equal(COUNCIL_MODELS.openai.split("/")[0], "openai");
  assert.equal(COUNCIL_MODELS.anthropic.split("/")[0], "anthropic");
  assert.equal(COUNCIL_MODELS.google.split("/")[0], "google");
  assert.equal(COUNCIL_MODELS.xai.split("/")[0], "x-ai");
  assert.equal(COUNCIL_MODELS.deepseek.split("/")[0], "deepseek");
  assert.equal(RESEARCH_MODELS.canonicalChair, "anthropic/claude-sonnet-5");
  assert.equal(RESEARCH_MODELS.dailyChair, "anthropic/claude-sonnet-4.6");
  assert.notEqual(RESEARCH_MODELS.canonicalChair, RESEARCH_MODELS.dailyChair);
  assert.equal(RESEARCH_MODELS.deskChat, "openai/gpt-5.6-terra");
  assert.notEqual(
    RESEARCH_MODELS.shortEditor.split("/")[0],
    RESEARCH_MODELS.shortVerifier.split("/")[0],
  );
});

test("the dependency registry covers every routed runtime model", () => {
  const registered = new Set(RUNTIME_MODEL_DEPENDENCIES.map((dependency) => dependency.model));
  for (const model of [
    ...Object.values(RESEARCH_MODELS),
    ...Object.values(COUNCIL_MODELS),
    ...Object.values(AUXILIARY_MODELS),
  ]) {
    assert.equal(registered.has(model), true, `${model} is missing from release smoke coverage`);
  }
});

test("release smoke covers the exact standard request shape used by every ballot lane", () => {
  for (const model of [
    COUNCIL_MODELS.openai,
    COUNCIL_MODELS.anthropic,
    COUNCIL_MODELS.anthropicFallback,
    COUNCIL_MODELS.google,
    COUNCIL_MODELS.xai,
    COUNCIL_MODELS.deepseek,
  ]) {
    assert.equal(
      RUNTIME_MODEL_DEPENDENCIES.some((dependency) =>
        dependency.model === model && dependency.profile === "standard" && /ballot/i.test(dependency.role)
      ),
      true,
      `${model} is missing request-shape-equivalent ballot smoke coverage`,
    );
  }
});

test("release smoke covers standard extraction and every bounded legacy-council envelope", () => {
  assert.equal(
    RUNTIME_MODEL_DEPENDENCIES.some((dependency) =>
      dependency.model === AUXILIARY_MODELS.evidenceExtractor && dependency.profile === "standard"
    ),
    true,
  );
  for (const model of [
    RESEARCH_MODELS.dailyChair,
    COUNCIL_MODELS.anthropic,
    COUNCIL_MODELS.anthropicFallback,
    COUNCIL_MODELS.google,
    COUNCIL_MODELS.deepseek,
    AUXILIARY_MODELS.legacyIndustrySeat,
  ]) {
    assert.equal(
      RUNTIME_MODEL_DEPENDENCIES.some((dependency) =>
        dependency.model === model && dependency.profile === "bounded"
      ),
      true,
      `${model} is missing bounded legacy-council smoke coverage`,
    );
  }
});

test("paid runtime call sites cannot bypass the central model registry", () => {
  const roots = ["src", "scripts", "tools"];
  const files: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(process.cwd(), relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(child);
    }
  };
  for (const root of roots) visit(root);
  const literal = /["'`](?:anthropic|openai|google|x-ai|moonshotai|deepseek|qwen|z-ai)\/[^"'`\s]+["'`]|["'`]gpt-realtime-[^"'`\s]+["'`]/g;
  const hits = files
    .filter((file) => file !== path.join("src", "lib", "modelPolicy.ts"))
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(literal)].map((match) => `${file}: ${match[0]}`));
  assert.deepEqual(hits, []);
});

test("scoreboard resolver provenance binds the exact model policy", () => {
  assert.match(RESOLVER_ADJUDICATOR_VERSION, /cost-controlled-v1-2026-08-07/);
  assert.match(RESOLVER_ADJUDICATOR_VERSION, /anthropic\/claude-sonnet-5/);
});

test("independent emergency council is explicitly capped below premium", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.LLMC3_COUNCIL_URL;
  const originalToken = process.env.INTERNAL_COUNCIL_TOKEN;
  let requestBody: Record<string, unknown> | undefined;

  process.env.LLMC3_COUNCIL_URL = "https://council.example";
  process.env.INTERNAL_COUNCIL_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      stage1: [
        { model: "model-a", response: "answer a" },
        { model: "model-b", response: "answer b" },
      ],
      aggregate: [],
      consensus: 0.5,
      winner: "model-a",
      models: ["model-a", "model-b"],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    assert.ok(await callLlmc3Council("question", "context"));
    assert.equal(LLMC3_COUNCIL_TIER, "standard");
    assert.equal(requestBody?.tier, "standard");
    assert.equal(requestBody?.max_models, 5);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.LLMC3_COUNCIL_URL;
    else process.env.LLMC3_COUNCIL_URL = originalUrl;
    if (originalToken === undefined) delete process.env.INTERNAL_COUNCIL_TOKEN;
    else process.env.INTERNAL_COUNCIL_TOKEN = originalToken;
  }
});
