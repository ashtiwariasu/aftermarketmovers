import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";

test("Morning Note claims are leased, retryable and committed with a dossier watermark", async () => {
  const {
    claimNoteDelivery,
    completeNoteDelivery,
    createDesk,
    failNoteDelivery,
    getDesk,
    setDeskBilling,
  } = await import("../src/lib/desk");
  const id = "desk_delivery_0001";
  await createDesk("reader@example.com", ["GOOGL"], [], id);
  await setDeskBilling(id, { tier: "pro", stripeSubscriptionId: "sub_delivery_1" });

  assert.equal(await claimNoteDelivery(id, "2026-07-17", "attempt_one", 1_000), true);
  assert.equal(
    await claimNoteDelivery(id, "2026-07-17", "attempt_two", 1_001),
    false,
    "a live lease blocks concurrent delivery",
  );
  assert.equal(
    await failNoteDelivery(id, "2026-07-17", "wrong_attempt", "wrong", 1_002),
    false,
  );
  assert.equal(
    await failNoteDelivery(id, "2026-07-17", "attempt_one", "temporary provider error", 1_003),
    true,
  );
  assert.equal(
    await claimNoteDelivery(id, "2026-07-17", "attempt_two", 1_004),
    true,
    "failed deliveries retry in the same slot",
  );
  assert.equal(
    await completeNoteDelivery(
      id,
      "2026-07-17",
      "attempt_two",
      "dossier-v5:GOOGL:2026-07-17:123",
      "dossier-v5:GOOGL:2026-07-17:123",
      1_005,
    ),
    true,
  );
  const desk = await getDesk(id);
  assert.equal(desk?.lastNoteDate, "2026-07-17");
  assert.equal(desk?.lastNoteArtifactKey, "dossier-v5:GOOGL:2026-07-17:123");
  assert.equal(desk?.noteDelivery?.status, "sent");
  assert.equal(
    await claimNoteDelivery(id, "2026-07-17", "attempt_three", 2_000),
    false,
    "a committed slot never sends twice",
  );
});

test("a stale claim can be recovered after the lease and fallbacks preserve the dossier watermark", async () => {
  const {
    claimNoteDelivery,
    completeNoteDelivery,
    createDesk,
    getDesk,
    setDeskBilling,
  } = await import("../src/lib/desk");
  const id = "desk_delivery_0002";
  await createDesk("reader@example.com", ["MSFT"], [], id);
  await setDeskBilling(id, { tier: "pro", stripeSubscriptionId: "sub_delivery_2" });
  assert.equal(await claimNoteDelivery(id, "2026-07-17", "stale_one", 1_000), true);
  assert.equal(
    await claimNoteDelivery(id, "2026-07-17", "stale_two", 1_000 + 21 * 60_000),
    true,
  );
  assert.equal(
    await completeNoteDelivery(
      id,
      "2026-07-17",
      "stale_two",
      "no-thesis:desk_delivery_0002:2026-07-17",
      null,
      1_000 + 21 * 60_000 + 1,
    ),
    true,
  );
  assert.equal((await getDesk(id))?.lastNoteArtifactKey, undefined);
});

test("listAllDesks is exhaustive beyond the legacy 500-row cap", async () => {
  const { createDesk, listAllDesks, listDesks } = await import("../src/lib/desk");
  for (let index = 0; index < 505; index++) {
    const id = `bulk_desk_${String(index).padStart(4, "0")}`;
    await createDesk(`${index}@example.com`, ["AAPL"], [], id);
  }
  const legacyPage = await listDesks(500);
  const all = await listAllDesks(73);
  assert.equal(legacyPage.length, 500);
  assert.ok(all.length >= 507);
  assert.equal(all.filter((desk) => desk.id.startsWith("bulk_desk_")).length, 505);
});
