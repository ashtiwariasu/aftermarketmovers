import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";

test("an unpaid desk is saved but has no product entitlement", async () => {
  const { createDesk, getDesk, trialStateOf, usageOf, consumeSittings, claimNoteDelivery } = await import("../src/lib/desk");
  const id = "paid_only_entitlement_01";
  const desk = await createDesk("unpaid@example.com", ["MSFT"], [], id);
  const state = trialStateOf(desk);
  const usage = usageOf(desk);

  assert.equal(state.access, "payment_required");
  assert.equal(state.active, false);
  assert.equal(state.daysRemaining, null);
  assert.equal(usage.companiesCap, 0);
  assert.equal(usage.cap, 0);
  assert.equal(usage.allowed, false);
  assert.equal((await consumeSittings(id, 1))?.allowed, false);
  assert.equal(await claimNoteDelivery(id, "2026-08-16", "unpaid_attempt"), false);
  assert.equal((await getDesk(id))?.trialStartedAt, undefined);
});

test("Stripe-backed payment activates service and cancellation locks it again", async () => {
  const { createDesk, getDesk, setDeskBilling, trialStateOf, usageOf, consumeSittings } = await import("../src/lib/desk");
  const id = "paid_only_entitlement_02";
  await createDesk("paid@example.com", ["MSFT"], [], id);

  await setDeskBilling(id, { tier: "pro", stripeSubscriptionId: "sub_test", stripeCustomerId: "cus_test" });
  const paid = (await getDesk(id))!;
  assert.equal(trialStateOf(paid).access, "paid");
  assert.equal(usageOf(paid).companiesCap, 3);
  assert.equal(usageOf(paid).cap, 30);
  assert.equal((await consumeSittings(id, 1))?.allowed, true);

  await setDeskBilling(id, { tier: "free" });
  const cancelled = (await getDesk(id))!;
  assert.equal(trialStateOf(cancelled).access, "payment_required");
  assert.equal(usageOf(cancelled).allowed, false);
});

test("a manually assigned paid tier cannot bypass Stripe validation", async () => {
  const { createDesk, trialStateOf, usageOf } = await import("../src/lib/desk");
  const desk = await createDesk("legacy@example.com", ["NVDA"], [], "paid_only_entitlement_03");
  desk.tier = "ultra";

  assert.equal(trialStateOf(desk).access, "payment_required");
  assert.equal(usageOf(desk).allowed, false);
});
