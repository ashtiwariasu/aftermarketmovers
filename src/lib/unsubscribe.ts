import { createHash, createHmac, timingSafeEqual } from "crypto";

function legacyToken(deskId: string): string {
  return createHash("sha256")
    .update(`${process.env.CRON_TOKEN ?? ""}:${deskId}`)
    .digest("hex")
    .slice(0, 32);
}

/** New links use a dedicated stable secret; CRON_TOKEN is the migration fallback. */
export function unsubscribeToken(deskId: string): string {
  const secret = process.env.UNSUBSCRIBE_SECRET?.trim();
  if (!secret) return legacyToken(deskId);
  return createHmac("sha256", secret).update(deskId).digest("hex").slice(0, 32);
}

/** Validate both new and legacy tokens without a value-dependent early return. */
export function validUnsubscribeToken(deskId: string, token: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(token)) return false;
  const provided = Buffer.from(token, "hex");
  const candidates = new Set([unsubscribeToken(deskId)]);
  if (process.env.CRON_TOKEN?.trim()) candidates.add(legacyToken(deskId));
  let valid = 0;
  for (const candidate of candidates) {
    const expected = Buffer.from(candidate, "hex");
    valid |= Number(expected.length === provided.length && timingSafeEqual(expected, provided));
  }
  return valid === 1;
}
