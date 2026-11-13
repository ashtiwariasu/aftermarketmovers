import assert from "node:assert/strict";
import test from "node:test";
import { shortPublicationIsHandled } from "../src/lib/shortPublication";

test("published and scheduled Shorts are terminally deduplicated", () => {
  assert.equal(shortPublicationIsHandled({ status: "published" }), true);
  assert.equal(shortPublicationIsHandled({ status: "scheduled" }), true);
});

test("an active processing lease deduplicates concurrent work", () => {
  assert.equal(
    shortPublicationIsHandled(
      { status: "processing", leaseExpiresAt: 2_000 },
      1_000,
    ),
    true,
  );
  assert.equal(
    shortPublicationIsHandled(
      { status: "processing", leaseExpiresAt: 1_000 },
      2_000,
    ),
    false,
  );
});

test("failed, rendered, missing and expired records remain retryable", () => {
  assert.equal(shortPublicationIsHandled({ status: "failed" }), false);
  assert.equal(shortPublicationIsHandled({ status: "rendered" }), false);
  assert.equal(shortPublicationIsHandled(undefined), false);
});
