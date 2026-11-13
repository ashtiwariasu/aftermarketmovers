import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the desk page handles signed-out onboarding while desk APIs stay protected", () => {
  const middleware = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const deskPage = readFileSync(new URL("../src/app/(site)/desk/page.tsx", import.meta.url), "utf8");

  assert.match(middleware, /createRouteMatcher\(\["\/api\/desk\(\.\*\)"\]\)/);
  assert.doesNotMatch(middleware, /createRouteMatcher\(\[[^\]]*"\/desk"/);
  assert.match(deskPage, /if \(!userId\) redirect\("\/desk\/new"\)/);
});
