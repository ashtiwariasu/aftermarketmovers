import type { Desk } from "./desk";

export interface DossierBackfillPlan {
  tickers: string[];
  invalidTickers: string[];
  deskCount: number;
}

export function dossierBackfillFailed(input: {
  mode: "dry-run" | "verify" | "execute";
  needsBackfill: string[];
  generated: string[];
  failed: Array<{ ticker: string; error: string }>;
  invalidTickers?: string[];
  outboxNeedsBackfill?: string[];
  outboxCreated?: string[];
  outboxFailed?: Array<{ key: string; error: string }>;
  invalidPublishedV5?: string[];
}): boolean {
  const outboxMissing = input.outboxNeedsBackfill ?? [];
  const outboxCreated = new Set(input.outboxCreated ?? []);
  const outboxFailed = input.outboxFailed?.length ?? 0;
  const invalidPublishedV5 = input.invalidPublishedV5?.length ?? 0;
  if (input.mode === "verify") {
    return input.needsBackfill.length > 0 || outboxMissing.length > 0 || outboxFailed > 0 ||
      invalidPublishedV5 > 0 || (input.invalidTickers?.length ?? 0) > 0;
  }
  if (input.mode !== "execute") return false;
  const generated = new Set(input.generated);
  return (input.invalidTickers?.length ?? 0) > 0 || input.failed.length > 0 ||
    outboxFailed > 0 || invalidPublishedV5 > 0 ||
    input.needsBackfill.some((ticker) => !generated.has(ticker)) ||
    outboxMissing.some((key) => !outboxCreated.has(key));
}

/**
 * Pure migration planner: include every actively watched, supported ticker.
 * Manual migrations follow the same lifecycle contract as scheduled research
 * and must not accidentally revive a zero-watcher or coverage-paused company.
 */
export function planWatchedTickerBackfill(
  desks: Pick<Desk, "tickers" | "researchActive" | "supportPaused" | "tier" | "stripeSubscriptionId">[],
): DossierBackfillPlan {
  const valid = new Set<string>();
  const invalid = new Set<string>();
  for (const desk of desks) {
    if (
      desk.researchActive === false ||
      (desk.tier !== "pro" && desk.tier !== "ultra") ||
      !desk.stripeSubscriptionId
    ) continue;
    for (const raw of desk.tickers) {
      const ticker = raw.trim().toUpperCase();
      if (desk.supportPaused?.[ticker]) continue;
      if (/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) valid.add(ticker);
      else if (raw.trim()) invalid.add(raw.trim());
    }
  }
  return {
    tickers: [...valid].sort(),
    invalidTickers: [...invalid].sort(),
    deskCount: desks.length,
  };
}
