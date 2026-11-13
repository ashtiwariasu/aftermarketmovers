import assert from "node:assert/strict";
import test from "node:test";
import {
  AMM_MONTHLY_PRICE_USD,
  paidPlanEntryPath,
  paidPlanStartsWithTrial,
} from "../src/lib/tiers";

test("public AMM is $25 and paid plans never start with a free trial", () => {
  assert.equal(AMM_MONTHLY_PRICE_USD, 25);
  assert.equal(paidPlanStartsWithTrial("pro"), false);
  assert.equal(paidPlanStartsWithTrial("ultra"), false);
});

test("paid plan links enter explicit Stripe purchase intent", () => {
  assert.equal(paidPlanEntryPath("pro"), "/desk/new?purchase=pro");
  assert.equal(paidPlanEntryPath("ultra"), "/desk/new?purchase=ultra");
});
