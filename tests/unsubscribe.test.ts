import assert from "node:assert/strict";
import test from "node:test";

process.env.DESK_STORE = "memory";
process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";

test("GET confirms without mutation; POST performs the signed unsubscribe", async () => {
  const { createDesk, getDesk } = await import("../src/lib/desk");
  const { unsubToken } = await import("../src/lib/doorbell");
  const { GET, POST } = await import("../src/app/api/email/unsub/route");
  const { NextRequest } = await import("next/server");
  const id = "desk_unsubscribe_01";
  await createDesk("reader@example.com", ["GOOGL"], [], id);
  const token = unsubToken(id);
  const url = `https://aftermarketmovers.com/api/email/unsub?d=${id}&t=${token}`;

  const confirmation = await GET(new NextRequest(url));
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /Turn off Morning Notes\?/);
  assert.equal((await getDesk(id))?.emailOptOut, undefined, "GET must not change delivery state");

  const mutation = await POST(new NextRequest(url, { method: "POST" }));
  assert.equal(mutation.status, 200);
  assert.match(await mutation.text(), /Morning Notes are off/);
  assert.equal((await getDesk(id))?.emailOptOut, true);
});

test("unsubscribe rejects a tampered token without changing the desk", async () => {
  const { createDesk, getDesk } = await import("../src/lib/desk");
  const { POST } = await import("../src/app/api/email/unsub/route");
  const { NextRequest } = await import("next/server");
  const id = "desk_unsubscribe_02";
  await createDesk("reader@example.com", ["MSFT"], [], id);
  const request = new NextRequest(
    `https://aftermarketmovers.com/api/email/unsub?d=${id}&t=${"0".repeat(32)}`,
    { method: "POST" },
  );
  assert.equal((await POST(request)).status, 400);
  assert.equal((await getDesk(id))?.emailOptOut, undefined);
});
