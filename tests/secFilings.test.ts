import assert from "node:assert/strict";
import test from "node:test";
import { retainLatestPeriodicFiling, type SecFiling } from "../src/lib/sec";

function filing(form: string, date: string): SecFiling {
  return {
    form,
    formLabel: form,
    date,
    url: `https://www.sec.gov/Archives/${form}-${date}`,
    title: "filing",
  };
}

test("insider filing volume cannot hide the latest filed-results anchor", () => {
  const recent = Array.from({ length: 40 }, (_, index) =>
    filing("4", `2026-07-${String(24 - (index % 20)).padStart(2, "0")}`),
  );
  const quarterly = filing("10-Q", "2026-04-29");
  const selected = retainLatestPeriodicFiling([...recent, quarterly], 10);

  assert.equal(selected.length, 11);
  assert.equal(selected.at(-1)?.form, "10-Q");
  assert.equal(selected.at(-1)?.date, "2026-04-29");
});

test("an already-recent periodic filing is not duplicated", () => {
  const quarterly = filing("10-Q", "2026-07-24");
  const selected = retainLatestPeriodicFiling(
    [quarterly, filing("8-K", "2026-07-23")],
    10,
  );

  assert.equal(selected.length, 2);
  assert.equal(selected.filter((item) => item.form === "10-Q").length, 1);
});
