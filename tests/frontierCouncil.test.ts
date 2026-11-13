import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_BALLOT_LANES } from "../src/lib/dossier";
import {
  FRONTIER_CONTRACT_POLICY,
  FRONTIER_PUBLIC_RESEARCH_RULES,
  LANES,
  REQUIRED_AUDITOR_ROLES,
  hasRequiredFrontierAuditCoverage,
} from "../src/lib/frontierCouncil";

test("council public research rule is qualitative and forbids forecast advice", () => {
  assert.match(FRONTIER_PUBLIC_RESEARCH_RULES, /UP or DOWN/);
  assert.match(FRONTIER_PUBLIC_RESEARCH_RULES, /10-15 trading sessions/);
  assert.match(FRONTIER_PUBLIC_RESEARCH_RULES, /No buy\/sell\/hold/);
  assert.match(FRONTIER_PUBLIC_RESEARCH_RULES, /percentage forecast/);
});

test("the OpenAI frontier lane uses only the cost-controlled Terra tier", () => {
  assert.ok(LANES.openai.length >= 1);
  assert.ok(LANES.openai.every((model) => model === "openai/gpt-5.6-terra"));
  assert.match(FRONTIER_CONTRACT_POLICY, /cost-controlled/);
  assert.doesNotMatch(FRONTIER_CONTRACT_POLICY, /gpt-5\.6-sol|claude-opus-5|claude-fable-5/);
});

test("exact-thesis ballot lanes preserve five independent provider families", () => {
  const families = EMAIL_BALLOT_LANES.map((lane) => lane.family);
  assert.equal(new Set(families).size, 5);
  for (const lane of EMAIL_BALLOT_LANES) {
    assert.ok(lane.models.every((model) => model.split("/")[0] === (lane.family === "xai" ? "x-ai" : lane.family)));
  }
  assert.ok(EMAIL_BALLOT_LANES[0].models.every((model) => model === "openai/gpt-5.6-terra"));
});

test("frontier council refuses to collapse to a lead without every core auditor", () => {
  assert.deepEqual(REQUIRED_AUDITOR_ROLES, [
    "THE NUMBERS SEAT",
    "THE RISK SEAT",
    "THE EVIDENCE MARSHAL",
  ]);
  assert.equal(hasRequiredFrontierAuditCoverage([
    { role: "THE NUMBERS SEAT" },
    { role: "THE RISK SEAT" },
  ]), false);
  assert.equal(hasRequiredFrontierAuditCoverage([
    { role: "THE NUMBERS SEAT" },
    { role: "THE RISK SEAT" },
    { role: "THE EVIDENCE MARSHAL" },
  ]), true);
});
