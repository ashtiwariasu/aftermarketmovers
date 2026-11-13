import assert from "node:assert/strict";
import test from "node:test";
import { citedTextHtml } from "../src/lib/morningNote";

test("morning-note citations are clickable and surrounding model text is escaped", () => {
  const html = citedTextHtml(
    `Revenue rose <script>alert(1)</script>. [1 · 2026-07-16](https://www.sec.gov/filing "SEC filing")`,
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="https:\/\/www\.sec\.gov\/filing"/);
  assert.match(html, />1 · 2026-07-16<\/a>/);
});

test("adjacent citation links retain a readable space in Gmail", () => {
  const html = citedTextHtml(
    `[1 · 2026-07-16](https://www.sec.gov/one "First")` +
    `[2 · 2026-07-17](https://www.sec.gov/two "Second")`,
  );
  assert.match(html, /<\/a> <a href=/);
});
