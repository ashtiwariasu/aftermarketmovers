import assert from "node:assert/strict";
import test from "node:test";
import { isContextSourceKey, normalizeContextExclusions } from "../src/lib/contextSources";

test("fresh HTTPS sources and filed documents are valid context selection keys", () => {
  assert.equal(isContextSourceKey("8ea520a8-5a0c-4f0e-9ad2-f44c890010a0"), true);
  assert.equal(isContextSourceKey("https://www.sec.gov/Archives/edgar/data/1/report.htm"), true);
  assert.equal(isContextSourceKey("https://finance.yahoo.com/quote/MSFT"), true);
  assert.equal(isContextSourceKey("javascript:alert(1)"), false);
  assert.equal(isContextSourceKey("http://example.com/insecure"), false);
});

test("context exclusions keep selected source URLs stable and reject malformed values", () => {
  assert.deepEqual(
    normalizeContextExclusions([
      " https://finance.yahoo.com/quote/MSFT ",
      "https://finance.yahoo.com/quote/MSFT",
      "8ea520a8-5a0c-4f0e-9ad2-f44c890010a0",
      "not-a-source",
      42,
    ]),
    [
      "https://finance.yahoo.com/quote/MSFT",
      "8ea520a8-5a0c-4f0e-9ad2-f44c890010a0",
    ]
  );
});
