import assert from "node:assert/strict";
import test from "node:test";
import type { Desk } from "../src/lib/desk";

process.env.DESK_STORE = "memory";

function desk(
  id: string,
  tickers: string[],
  overrides: Partial<Desk> = {},
): Desk {
  return {
    id,
    email: `${id}@example.com`,
    tickers,
    createdAt: 1,
    activity: [],
    tier: "pro",
    stripeSubscriptionId: `sub_${id}`,
    ...overrides,
  };
}

test("fleet snapshot is exhaustive, shared and governed only by active membership", async () => {
  const { companyFleetSnapshot } = await import("../src/lib/companyFleet");
  const snapshot = companyFleetSnapshot([
    desk("desk_watcher_0001", ["aapl", "MSFT"]),
    desk("desk_watcher_0002", ["AAPL"]),
    desk("desk_watcher_0003", ["NVDA"], { researchActive: false }),
    desk("desk_watcher_0004", ["TSLA"], {
      supportPaused: {
        TSLA: {
          code: "not_supported",
          message: "Coverage is paused.",
          policyVersion: "us-v1",
          pausedAt: 2,
        },
      },
    }),
    desk("desk_watcher_0005", ["AMD"], { tier: "free" }),
  ]);

  assert.deepEqual(snapshot.tickers, ["AAPL", "MSFT"]);
  assert.deepEqual([...snapshot.watchersByTicker.get("AAPL") ?? []], [
    "desk_watcher_0001",
    "desk_watcher_0002",
  ]);
  assert.equal(snapshot.watchersByTicker.get("MSFT")?.size, 1);
});

test("shared membership is idempotent, pauses on last removal and reactivates without deleting history", async () => {
  const {
    getCompanyFleetRecord,
    resetCompanyFleetMemoryForTests,
    syncDeskFleetMembership,
  } = await import("../src/lib/companyFleet");
  resetCompanyFleetMemoryForTests();

  await syncDeskFleetMembership("desk_watcher_1001", [], ["AMZN"], 100);
  await syncDeskFleetMembership("desk_watcher_1001", ["AMZN"], ["AMZN"], 101);
  assert.deepEqual(await getCompanyFleetRecord("AMZN"), {
    symbol: "AMZN",
    schema: "company-fleet-v1",
    active: true,
    watcherCount: 1,
    createdAt: 100,
    activatedAt: 100,
    updatedAt: 101,
  });

  await syncDeskFleetMembership("desk_watcher_1002", [], ["AMZN"], 102);
  assert.equal((await getCompanyFleetRecord("AMZN"))?.watcherCount, 2);

  await syncDeskFleetMembership("desk_watcher_1001", ["AMZN"], [], 103);
  assert.deepEqual(
    {
      active: (await getCompanyFleetRecord("AMZN"))?.active,
      watcherCount: (await getCompanyFleetRecord("AMZN"))?.watcherCount,
    },
    { active: true, watcherCount: 1 },
  );

  await syncDeskFleetMembership("desk_watcher_1002", ["AMZN"], [], 104);
  const paused = await getCompanyFleetRecord("AMZN");
  assert.equal(paused?.active, false);
  assert.equal(paused?.watcherCount, 0);
  assert.equal(paused?.pausedAt, 104);
  assert.equal(paused?.createdAt, 100);

  await syncDeskFleetMembership("desk_watcher_1003", [], ["AMZN"], 200);
  const reactivated = await getCompanyFleetRecord("AMZN");
  assert.equal(reactivated?.active, true);
  assert.equal(reactivated?.watcherCount, 1);
  assert.equal(reactivated?.createdAt, 100, "company history survives a zero-watcher pause");
  assert.equal(reactivated?.activatedAt, 200);
  assert.equal(reactivated?.pausedAt, undefined);
});

test("reconciliation repairs stale fleet membership from the authoritative desk set", async () => {
  const {
    getCompanyFleetRecord,
    reconcileCompanyFleetFromDesks,
    resetCompanyFleetMemoryForTests,
    syncDeskFleetMembership,
  } = await import("../src/lib/companyFleet");
  resetCompanyFleetMemoryForTests();

  await syncDeskFleetMembership("desk_stale_00001", [], ["AAPL"], 10);
  const result = await reconcileCompanyFleetFromDesks([
    desk("desk_live_000001", ["MSFT"]),
    desk("desk_live_000002", ["MSFT"]),
  ], 20);

  assert.deepEqual(result.active, ["MSFT"]);
  assert.deepEqual(result.paused, ["AAPL"]);
  assert.equal(result.membershipsAdded, 2);
  assert.equal(result.membershipsRemoved, 1);
  assert.equal((await getCompanyFleetRecord("AAPL"))?.active, false);
  assert.equal((await getCompanyFleetRecord("MSFT"))?.watcherCount, 2);
});

test("saving a desk cannot reactivate a coverage-paused legacy selection", async () => {
  const { createDesk } = await import("../src/lib/desk");
  const { companyFleetSnapshot } = await import("../src/lib/companyFleet");
  const id = "desk_paused_00001";
  const original = await createDesk("paused@example.com", ["TSLA", "MSFT"], [], id);
  original.tier = "pro";
  original.stripeSubscriptionId = "sub_paused";
  original.supportPaused = {
    TSLA: {
      code: "not_supported",
      message: "Coverage is paused.",
      policyVersion: "us-v1",
      pausedAt: 10,
    },
  };

  const retained = await createDesk("paused@example.com", ["TSLA", "MSFT"], [], id);
  assert.deepEqual(Object.keys(retained.supportPaused ?? {}), ["TSLA"]);
  assert.deepEqual(companyFleetSnapshot([retained]).tickers, ["MSFT"]);

  const removed = await createDesk("paused@example.com", ["MSFT"], [], id);
  assert.deepEqual(removed.supportPaused, {});
});
