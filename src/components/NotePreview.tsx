import type { MoversData } from "@/lib/yahoo";

function noteDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The Morning Note, rendered as the paper artifact — built from real prints. */
export default function NotePreview({ data }: { data: MoversData }) {
  const hasExt =
    data.afterHours.gainers.length + data.afterHours.losers.length > 0;
  const pool = hasExt
    ? [...data.afterHours.gainers, ...data.afterHours.losers]
    : [...data.regular.gainers, ...data.regular.losers];
  const items = pool
    .filter((m) => m.extChangePercent != null || m.dayChangePercent != null)
    .sort(
      (a, b) =>
        Math.abs((b.extChangePercent ?? b.dayChangePercent) ?? 0) -
        Math.abs((a.extChangePercent ?? a.dayChangePercent) ?? 0)
    )
    .slice(0, 3);

  return (
    <div
      className="rounded-lg overflow-hidden shadow-2xl"
      style={{ background: "var(--paper)", color: "var(--inkp)" }}
    >
      <div
        className="px-5 py-3 flex items-baseline justify-between border-b"
        style={{ borderColor: "#EAD2DE" }}
      >
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase">
          Morning note
        </span>
        <span className="font-mono text-[10px] nums" style={{ color: "#8A4B66" }}>
          {noteDate(data.fetchedAt)}
        </span>
      </div>
      <div className="px-5 py-4 space-y-3.5">
        {items.map((m) => {
          const chg = m.extChangePercent ?? m.dayChangePercent ?? 0;
          const up = chg >= 0;
          return (
            <div key={m.symbol} className="flex gap-3 items-baseline">
              <span className="font-mono text-[11px] font-semibold nums w-12 shrink-0">
                {m.symbol}
              </span>
              <span
                className="font-mono text-[11px] nums w-16 shrink-0 text-right"
                style={{ color: up ? "#0B7A50" : "#B3273D" }}
              >
                {up ? "+" : ""}
                {chg.toFixed(2)}%
              </span>
              <span className="text-[12.5px] leading-snug" style={{ color: "#5C2240" }}>
                {hasExt ? "moved in extended trading" : "led the last session"} on{" "}
                {m.volume != null && m.volume >= 1e6
                  ? `${(m.volume / 1e6).toFixed(0)}M shares`
                  : "light volume"}{" "}
                — flagged for the open.
              </span>
            </div>
          );
        })}
        {items.length === 0 && (
          <p className="text-[13px]" style={{ color: "#5C2240" }}>
            Nothing needs your attention.
          </p>
        )}
      </div>
      <div
        className="px-5 py-2.5 flex items-center justify-between border-t"
        style={{ borderColor: "#EAD2DE" }}
      >
        <span className="font-mono text-[10.5px]" style={{ color: "#8A4B66" }}>
          handoff · before the open
        </span>
        <span className="font-mono text-[11px] font-semibold">— AMM Desk</span>
      </div>
    </div>
  );
}
