import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";
process.env.UNSUBSCRIBE_SECRET = "test-onboarding-unsubscribe-secret";
process.env.COMPANY_POSTAL_ADDRESS = "21 Pullen Rd, Everton Park QLD 4053, Australia";

test("onboarding recovery follows inactivity, local-time and hard desk suppression", async () => {
  const {
    acceptOnboardingNudge,
    claimDueOnboardingNudges,
    completeOnboardingUser,
    getOnboardingUser,
    recordOnboardingProgress,
    resetOnboardingMemoryStore,
    upsertOnboardingUser,
  } = await import("../src/lib/onboarding");
  resetOnboardingMemoryStore();
  const start = Date.parse("2026-07-20T00:00:00Z");
  const id = "user_recovery_0001";
  await upsertOnboardingUser({ id, email: "reader@example.com", firstName: "Rae" }, start);
  await recordOnboardingProgress(id, {
    timezone: "Australia/Brisbane",
    intendedTickers: ["msft", "MSFT", "bad ticker"],
  }, start + 10 * 60_000);
  assert.equal((await claimDueOnboardingNudges(start + 35 * 60_000)).length, 0);
  const [first] = await claimDueOnboardingNudges(start + 41 * 60_000);
  assert.ok(first);
  assert.equal(first.stage, 0);
  assert.equal(first.user.intendedTickers[0], "MSFT");
  assert.equal(await acceptOnboardingNudge(first, "email_first", start + 41 * 60_000), true);
  const scheduled = (await getOnboardingUser(id))?.nextNudgeAt;
  assert.ok(scheduled && scheduled > start);

  await completeOnboardingUser(id, start + 45 * 60_000);
  assert.equal((await getOnboardingUser(id))?.status, "completed");
  assert.equal((await claimDueOnboardingNudges(Number.MAX_SAFE_INTEGER)).length, 0);
});

test("unsubscribe and Resend suppression stop every later nudge idempotently", async () => {
  const {
    claimDueOnboardingNudges,
    getOnboardingUser,
    recordResendOnboardingEvent,
    resetOnboardingMemoryStore,
    setOnboardingEmailOptOut,
    upsertOnboardingUser,
  } = await import("../src/lib/onboarding");
  resetOnboardingMemoryStore();
  const start = Date.parse("2026-07-20T00:00:00Z");
  const firstId = "user_recovery_0002";
  await upsertOnboardingUser({ id: firstId, email: "stop@example.com" }, start);
  assert.equal(await setOnboardingEmailOptOut(firstId, start + 1), true);
  assert.equal((await claimDueOnboardingNudges(Number.MAX_SAFE_INTEGER)).length, 0);

  const secondId = "user_recovery_0003";
  await upsertOnboardingUser({ id: secondId, email: "bounce@example.com" }, start);
  const result = await recordResendOnboardingEvent({
    eventId: "webhook_event_001",
    eventType: "email.bounced",
    eventAt: start + 2,
    emailId: "email_bounced_001",
    userId: secondId,
    stage: 0,
  });
  assert.deepEqual(result, { processed: true, suppressed: true });
  assert.deepEqual(await recordResendOnboardingEvent({
    eventId: "webhook_event_001",
    eventType: "email.bounced",
    eventAt: start + 2,
    emailId: "email_bounced_001",
    userId: secondId,
    stage: 0,
  }), { processed: false, suppressed: false });
  assert.equal((await getOnboardingUser(secondId))?.status, "suppressed");
});

test("every onboarding email carries the $25 offer and one-click opt-out", async () => {
  const { onboardingEmailForClaim } = await import("../src/lib/onboardingEmail");
  const now = Date.now();
  const email = onboardingEmailForClaim({
    stage: 0,
    leaseToken: "lease",
    idempotencyKey: "onboarding/user/stage-0",
    user: {
      id: "user_recovery_0004",
      email: "reader@example.com",
      firstName: "Rae",
      lastName: "",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      status: "pending",
      timezone: "Australia/Brisbane",
      intendedTickers: [],
      nudgeStage: 0,
      deliveries: {},
    },
  });
  assert.match(email.text, /\$25\/month · 3 stocks · cancel any time/i);
  assert.match(email.ctaUrl, /purchase=pro/);
  assert.match(email.html, /21 Pullen Rd/);
  assert.match(email.ctaUrl, /utm_campaign=onboarding_recovery/);
  assert.equal(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});
