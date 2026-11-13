import assert from "node:assert/strict";
import test from "node:test";
import { cardPreviewHook, cardPreviewText } from "../src/lib/cardPreview";

test("collapsed desk cards remove citation payloads and stay bounded", () => {
  const thesis = [
    "The March-quarter results are more likely to support the shares over the next 10–15 sessions.",
    "[2 · 2026-03-31](https://data.sec.gov/api/xbrl/companyfacts/CIK0000789019.json \"MSFT SEC XBRL company facts\")",
    "The litigation notice carries no filed damages.",
    "[17 · 2026-07-20](https://example.com/a-very-long-source-path)",
  ].join(" ");

  const preview = cardPreviewText(thesis, 140);
  assert.ok(preview.length <= 140);
  assert.doesNotMatch(preview, /https?:\/\/|\[[^\]]+\]\(/);
  assert.match(preview, /^The March-quarter results/);
});

test("collapsed desk cards preserve useful link labels", () => {
  assert.equal(
    cardPreviewText("Read the [earnings release](https://example.com/report) before the call."),
    "Read the earnings release before the call.",
  );
});

test("desk hooks lead with the mechanism and stay within sixteen words", () => {
  const thesis = "This recovery is more likely to support the shares over the next 10–15 sessions because the filed quarter shows operating cash covering heavy capital spending, with cash well above debt. [2 · 2026-03-31](https://example.com/filing) The risk is a renewed sector sell-off.";
  const hook = cardPreviewHook(thesis);

  assert.equal(hook, "The filed quarter shows operating cash covering heavy capital spending, with cash well above debt.");
  assert.ok(hook.split(/\s+/).length <= 16);
  assert.doesNotMatch(hook, /https?:\/\/|\[[^\]]+\]\(/);
});

test("event-led hooks close before a speculative consequence", () => {
  assert.equal(
    cardPreviewHook("The scheduled Advancing AI event lands inside the window, so a named customer commitment is more likely to support the shares over 10–15 sessions."),
    "The scheduled Advancing AI event lands inside the window",
  );
});
