import Link from "next/link";
import Tri from "@/components/Tri";
import type { Desk } from "@/lib/desk";
import { getTickerSnapshot, type TickerSnapshot } from "@/lib/ticker";

function fmt(v: number | null, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}

function pct(v: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function pctColor(v: number | null): string {
  if (v == null) return "var(--pr-faint)";
  return v >= 0 ? "var(--pr-up)" : "var(--pr-down)";
}

function BaselineCard({ s }: { s: TickerSnapshot }) {
  return (
    <div className="pp-card pp-shadow-sm p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <Link
            href={`/stock/${s.symbol.toLowerCase()}`}
            className="pp-disp font-extrabold text-xl hover:underline"
            style={{ color: "var(--pr-blue)" }}
          >
            {s.symbol}
          </Link>
          <span className="ml-2 text-sm" style={{ color: "var(--pr-dim)" }}>
            {s.name}
          </span>
        </div>
        <span className="pp-mono text-[10.5px]" style={{ color: "var(--pr-faint)" }}>
          {s.exchange}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 text-sm">
        <div>
          <div className="pp-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-faint)" }}>
            Last close
          </div>
          <div className="pp-mono font-semibold">${fmt(s.price)}</div>
        </div>
        <div>
          <div className="pp-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-faint)" }}>
            Day
          </div>
          <div className="pp-mono font-semibold" style={{ color: pctColor(s.dayChangePercent) }}>
            {pct(s.dayChangePercent)}
          </div>
        </div>
        <div>
          <div className="pp-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-faint)" }}>
            After hours
          </div>
          <div className="pp-mono font-semibold" style={{ color: pctColor(s.afterHoursChangePercent) }}>
            {s.afterHoursChangePercent != null
              ? `${pct(s.afterHoursChangePercent)} · $${fmt(s.afterHoursPrice)}`
              : "quiet"}
          </div>
        </div>
        <div>
          <div className="pp-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-faint)" }}>
            52-week range
          </div>
          <div className="pp-mono font-semibold">
            {s.fiftyTwoWeekLow != null && s.fiftyTwoWeekHigh != null
              ? `$${fmt(s.fiftyTwoWeekLow, 0)}–$${fmt(s.fiftyTwoWeekHigh, 0)}`
              : "—"}
          </div>
        </div>
      </div>
      <div
        className="mt-4 pt-3 flex items-center justify-between text-xs"
        style={{ borderTop: "1px solid rgba(22,21,15,.12)" }}
      >
        <span style={{ color: "var(--pr-dim)" }}>
          Next company event:{" "}
          <span className="font-semibold" style={{ color: "var(--pr-ink)" }}>
            {s.nextEvent ?? "monitoring company filings and trading"}
          </span>
        </span>
        <span className="pp-mono inline-flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--pr-orange)" }}>
          <span className="lamp h-1.5 w-1.5 rounded-full" style={{ background: "var(--pr-orange)" }} />
          watching
        </span>
      </div>
    </div>
  );
}

export default async function DeskView({ desk }: { desk: Desk }) {
  const snapshots = (
    await Promise.all(desk.tickers.map((t) => getTickerSnapshot(t)))
  ).filter((s): s is TickerSnapshot => s !== null);

  return (
    <div className="space-y-10 pt-10 max-w-[900px] mx-auto">
      <section>
        <span
          className="pp-mono text-[10.5px] uppercase tracking-[0.2em] inline-flex items-center gap-2"
          style={{ color: "var(--pr-orange)" }}
        >
          <span className="lamp h-2 w-2 rounded-full" style={{ background: "var(--pr-orange)" }} />
          AMM Desk is watching
        </span>
        <h1 className="pp-disp font-extrabold text-4xl sm:text-5xl tracking-tight mt-2">
          Your desk<Tri size="0.34em" />
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pr-dim)" }}>
          Watching {desk.tickers.join(", ")} · Your Morning Note goes to {desk.email}
          <Link href="/desk/new" className="ml-3 underline" style={{ color: "var(--pr-blue)" }}>
            change companies
          </Link>
        </p>
      </section>

      <section className="space-y-4">
        {snapshots.map((s) => (
          <BaselineCard key={s.symbol} s={s} />
        ))}
      </section>

      <section>
        <h2 className="pp-disp font-extrabold text-xl mb-3">AMM Desk log</h2>
        <div
          className="rounded-[14px] p-5 pp-mono text-[12px] space-y-2"
          style={{ background: "var(--pr-ink)", color: "rgba(244,241,234,.8)" }}
        >
          {desk.activity.map((a, i) => (
            <div key={i} className="flex gap-3">
              <span className="shrink-0" style={{ color: "rgba(244,241,234,.4)" }}>
                {new Date(a.at).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span>{a.text}</span>
            </div>
          ))}
          <div className="flex gap-3" style={{ color: "var(--pr-lime)" }}>
            <span className="shrink-0">next</span>
            <span>extended-hours research → your Morning Note</span>
          </div>
        </div>
      </section>

      <section className="pp-card pp-shadow p-6" style={{ transform: "rotate(-0.3deg)" }}>
        <h2 className="pp-disp font-extrabold text-lg">What AMM Desk is doing</h2>
        <ul className="mt-2 text-[14px] space-y-1.5 list-disc pl-5" style={{ color: "var(--pr-dim)" }}>
          <li>Tracks important moves outside regular market hours</li>
          <li>Flags anything that moved more than the market</li>
          <li>Notes upcoming company events such as earnings and filings</li>
          <li>Sends your Morning Note before the next open</li>
        </ul>
        <p className="mt-3 pp-mono text-[11px]" style={{ color: "var(--pr-faint)" }}>
          Five AI analysts review every research answer
        </p>
      </section>
    </div>
  );
}
