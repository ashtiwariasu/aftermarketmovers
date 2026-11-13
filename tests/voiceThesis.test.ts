import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";

import type { Desk } from "../src/lib/desk";
import { dayKey, TIERS } from "../src/lib/tiers";
import { realtimeSessionConfig, REALTIME_MODEL, VOICE_TOOL_NAME } from "../src/lib/realtimeVoice";
import { citationsFromAnswer, spokenAnswerFromMarkdown } from "../src/lib/voiceAnswer";

function desk(id: string, tier: "pro" | "ultra" = "pro"): Desk {
  return {
    id,
    email: `${id}@example.com`,
    tickers: ["AMZN"],
    createdAt: Date.parse("2026-07-01T00:00:00Z"),
    activity: [],
    tier,
    stripeSubscriptionId: `sub_${id}`,
    tz: "Australia/Brisbane",
  };
}

const sourceSummary = {
  sources: ["SEC filing"],
  stats: ["Q2 filing loaded"],
  retrieval: {
    intent: "thesis",
    eligibleSources: 1,
    readableSources: 1,
    matchedSources: 1,
    matchedPassages: 2,
  },
};

test("paid voice allowances are explicit and reset on a local-day key", () => {
  assert.equal(TIERS.free.voiceSecondsPerDay, 0);
  assert.equal(TIERS.pro.voiceSecondsPerDay, 900);
  assert.equal(TIERS.ultra.voiceSecondsPerDay, 3600);
  assert.equal(
    dayKey("Australia/Brisbane", new Date("2026-07-24T15:30:00Z")),
    "2026-07-25",
  );
});

test("voice metering permits one active session and charges server elapsed time", async () => {
  const { beginVoiceSession, heartbeatVoiceSession } = await import("../src/lib/voiceStore");
  const owner = desk("voice-meter-pro");
  const startedAt = Date.parse("2026-07-25T00:00:00Z");
  const first = await beginVoiceSession(owner, "AMZN", "pro", "dated context", sourceSummary, startedAt);
  assert.equal(first.allowed, true);
  assert.equal(first.remainingSeconds, 900);
  assert.ok(first.sessionId);

  const duplicate = await beginVoiceSession(owner, "AMZN", "pro", "dated context", sourceSummary, startedAt + 1_000);
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, "already_active");

  const heartbeat = await heartbeatVoiceSession(owner.id, first.sessionId!, false, startedAt + 10_000);
  assert.equal(heartbeat?.remainingSeconds, 890);
  const finished = await heartbeatVoiceSession(owner.id, first.sessionId!, true, startedAt + 20_000);
  assert.equal(finished?.remainingSeconds, 880);

  const next = await beginVoiceSession(owner, "AMZN", "pro", "dated context", sourceSummary, startedAt + 21_000);
  assert.equal(next.allowed, true);
  assert.equal(next.remainingSeconds, 880);
});

test("Realtime session is tool-bound to the company file", () => {
  const config = realtimeSessionConfig("AMZN");
  assert.equal(config.model, REALTIME_MODEL);
  assert.equal(config.tools[0].name, VOICE_TOOL_NAME);
  assert.match(config.instructions, /only source of truth/i);
  assert.match(config.instructions, /outside this company’s AMM file/i);
  assert.equal(config.audio.output.voice, "marin");
});

test("spoken answers preserve source labels but do not read URLs", () => {
  const answer =
    "**The filing shows cash coverage.** [SEC 10-Q · 2026-07-23](https://www.sec.gov/example) " +
    "The risk remains an inference [S4].";
  assert.deepEqual(citationsFromAnswer(answer), [
    { label: "SEC 10-Q · 2026-07-23", href: "https://www.sec.gov/example" },
    { label: "S4" },
  ]);
  const spoken = spokenAnswerFromMarkdown(answer);
  assert.match(spoken, /SEC 10-Q · 2026-07-23/);
  assert.doesNotMatch(spoken, /https?:/);
  assert.match(spoken, /S4/);
});
