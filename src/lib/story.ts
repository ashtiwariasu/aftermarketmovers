import type { TickerSnapshot } from "@/lib/ticker";
import type { getCouncilPage } from "@/lib/council";

function pct(v: number | null): string {
  if (v == null) return "—";
  if (Math.abs(v) < 0.005) return "0.00%";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** AMM Desk's living story paragraph for a company — versioned daily into the file. */
export function storyFor(
  snap: TickerSnapshot,
  page: ReturnType<typeof getCouncilPage>,
  eventDays: number | null,
  flagged: boolean
): string {
  const trading = `How the stock traded: ${pct(snap.dayChangePercent)} on the day, ${
    snap.afterHoursChangePercent != null
      ? `${pct(snap.afterHoursChangePercent)} after hours`
      : "quiet after hours"
  }${flagged ? " — that move is why the flag is up" : ""}.`;
  if (page) {
    const lead =
      eventDays != null && eventDays >= 0
        ? `${eventDays === 0 ? "The next company event is today" : `${eventDays} days to the next company event`}. `
        : "";
    return `${lead}${page.eventNote.whyItMatters} ${trading} Five analysts have ${page.claims.length} claims recorded with ${page.split.vote} agreement — every one gets scored against the actual result, and misses stay on the page.`;
  }
  const next = snap.nextEvent
    ? `Next company event: ${snap.nextEvent}.`
    : "No dated company event is on the calendar — AMM Desk updates when new evidence or meaningful trading clears the bar.";
  return `${snap.name} is being followed in AMM Desk. It checks extended-hours trading and refreshes the company facts each day. ${trading} ${next}`;
}

/** Markdown for the claims-ledger context doc filed into the company folder. */
export function claimsLedgerMd(page: NonNullable<ReturnType<typeof getCouncilPage>>): string {
  return [
    `# Claims ledger — ${page.ticker}`,
    ``,
    `Recorded ${page.asOf} · analyst agreement ${page.split.vote} on: ${page.split.question}`,
    ``,
    ...page.claims.map(
      (c, i) =>
        `- C-${String(i + 1).padStart(2, "0")} · ${c.claim} · ${c.status.replace("resolved_", "")} · resolves by ${c.resolvesBy}`
    ),
    ``,
    `Majority: ${page.split.majority}`,
    ``,
    `Strongest dissent: ${page.split.dissent}`,
    ``,
    `_Timestamped research claims scored against public filings — not ratings or recommendations._`,
  ].join("\n");
}
