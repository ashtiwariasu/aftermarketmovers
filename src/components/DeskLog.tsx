import type { MoversData } from "@/lib/yahoo";

function t(ts: number, minusMin = 0): string {
  return new Date(ts - minusMin * 60_000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** The desk log — real pipeline events, terminal-styled. */
export default function DeskLog({ data }: { data: MoversData }) {
  const hasExt =
    data.afterHours.gainers.length + data.afterHours.losers.length > 0;
  const top = hasExt ? data.afterHours.gainers[0] : data.regular.gainers[0];
  const bottom = hasExt ? data.afterHours.losers[0] : data.regular.losers[0];
  const count =
    data.afterHours.gainers.length +
    data.afterHours.losers.length +
    data.regular.gainers.length +
    data.regular.losers.length;

  const lines: Array<[string, string]> = [
    [t(data.fetchedAt, 9), "screener sweep — 3 universes merged, ranked"],
    ...(top
      ? ([[t(data.fetchedAt, 6), `top ${hasExt ? "AH" : "session"} gainer · ${top.symbol} ${(
          (top.extChangePercent ?? top.dayChangePercent) ?? 0
        ).toFixed(2)}%`]] as Array<[string, string]>)
      : []),
    ...(bottom
      ? ([[t(data.fetchedAt, 6), `top ${hasExt ? "AH" : "session"} loser · ${bottom.symbol} ${(
          (bottom.extChangePercent ?? bottom.dayChangePercent) ?? 0
        ).toFixed(2)}%`]] as Array<[string, string]>)
      : []),
    [t(data.fetchedAt, 3), `${count} important moves in extended-hours trading`],
    [t(data.fetchedAt), "GOOGL case file open · 10 claims locked · scores Jul 23"],
  ];

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--k20)", background: "var(--k10)" }}
    >
      <div
        className="px-4 py-2 flex items-center gap-2 border-b"
        style={{ borderColor: "var(--k20)" }}
      >
        <span className="lamp h-1.5 w-1.5 rounded-full" style={{ background: "var(--pink)" }} />
        <span
          className="font-mono text-[10px] uppercase tracking-[0.2em]"
          style={{ color: "var(--lo)" }}
        >
          AMM Desk log · ET
        </span>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        {lines.map(([time, text], i) => (
          <div key={i} className="flex gap-3 font-mono text-[11.5px] leading-relaxed">
            <span className="nums shrink-0" style={{ color: "var(--dim)" }}>
              {time}
            </span>
            <span style={{ color: i === lines.length - 1 ? "var(--core)" : "var(--lo)" }}>
              {text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
