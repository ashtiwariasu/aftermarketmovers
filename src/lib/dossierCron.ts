/**
 * Retry only when the durable drain stopped before starting every ticker.
 * A completed-but-rejected ticker is an observed research outcome, not a
 * transport failure; automatically replaying it multiplies model spend while
 * preserving the same evidence and contract.
 */
export function dossierCronStatus(unfinished: readonly string[]): number {
  return unfinished.length > 0 ? 503 : 200;
}

export function dossierCronAuthorized(
  expectedRaw: string | undefined,
  receivedRaw: string | null,
): boolean {
  const expected = expectedRaw?.trim() ?? "";
  const received = receivedRaw?.trim() ?? "";
  return expected.length > 0 && received === expected;
}

/**
 * FNV-1a keeps a ticker on the same shard when another desk adds or removes a
 * different ticker. That stability matters during Scheduler retries: a
 * shifting index-based partition can both repeat completed work and strand a
 * symbol between attempts.
 */
export function dossierTickerShard(ticker: string, shardCount: number): number {
  let hash = 0x811c9dc5;
  for (const char of ticker.trim().toUpperCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

export function selectDossierShard(
  tickers: readonly string[],
  shard: number,
  shardCount: number,
): string[] {
  return [...tickers]
    .sort((a, b) => a.localeCompare(b))
    .filter((ticker) => dossierTickerShard(ticker, shardCount) === shard);
}

/**
 * Narrow the active fleet before any provider-backed support checks. The
 * scheduler used to verify the complete fleet inside every shard, multiplying
 * SEC and market-data work by the shard count before research even began.
 */
export function selectDossierCandidates(input: {
  activeTickers: readonly string[];
  requestedTicker?: string | null;
  shard?: number | null;
  shardCount?: number | null;
}): string[] {
  const active = [...new Set(input.activeTickers.map((ticker) => ticker.trim().toUpperCase()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (input.requestedTicker) {
    const requested = input.requestedTicker.trim().toUpperCase();
    return active.includes(requested) ? [requested] : [];
  }
  if (input.shard !== null && input.shard !== undefined &&
      input.shardCount !== null && input.shardCount !== undefined) {
    return selectDossierShard(active, input.shard, input.shardCount);
  }
  return active;
}

export function dailyResearchLeaseId(ticker: string, date: string): string {
  return `daily-research:${ticker.trim().toUpperCase()}:${date}`;
}
