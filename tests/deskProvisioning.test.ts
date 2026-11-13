import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desk creation provisions only server-confirmed additions", () => {
  const source = readFileSync(new URL("../src/app/(site)/desk/new/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Promise\.allSettled\(additions\.map\(provision\)\)/);
  assert.doesNotMatch(source, /data\.snapshots\.map\([^)]*provision/);
});

