"use client";

import { useEffect, useState } from "react";
import { getShift, type ShiftInfo } from "@/lib/marketClock";

function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function useShift(intervalMs: number): ShiftInfo | null {
  const [shift, setShift] = useState<ShiftInfo | null>(null);
  useEffect(() => {
    const tick = () => setShift(getShift());
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return shift;
}

/** Nav badge — lamp + state + ET clock (Paper Round skin). */
export function SessionBadge() {
  const shift = useShift(30_000);
  if (!shift) return <span className="hidden sm:block w-28" />;
  return (
    <span className="hidden sm:flex items-center gap-2 pp-mono text-[10.5px] tracking-widest uppercase">
      <span
        className={`h-2 w-2 rounded-full ${shift.onWatch ? "lamp" : ""}`}
        style={{
          background: shift.onWatch ? "var(--pr-orange)" : "rgba(22,21,15,.25)",
        }}
      />
      <span style={{ color: shift.onWatch ? "var(--pr-orange)" : "var(--pr-dim)" }}>
        {shift.onWatch ? "On watch" : shift.state === "DAY" ? "Off shift" : "Rest"}
      </span>
      <span style={{ color: "var(--pr-faint)" }}>·</span>
      <span style={{ color: "var(--pr-dim)" }}>{shift.etClock}</span>
    </span>
  );
}

/** One-line session eyebrow for the hero. */
export function ShiftEyebrow() {
  const shift = useShift(1000);
  const s = shift;
  return (
    <p
      className="font-mono text-[11px] tracking-[0.2em] uppercase flex items-center gap-2"
      style={{ color: "var(--pink)" }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s?.onWatch ? "lamp" : ""}`}
        style={{ background: s?.onWatch ? "var(--pink)" : "var(--k30)" }}
      />
      {s ? s.countdownLabel : "AMM"}
      {s && (
        <span className="nums" style={{ color: "var(--core)" }}>
          {fmtCountdown(s.countdownMs)}
        </span>
      )}
    </p>
  );
}

/** Hero copy block — left-aligned, session-aware, no poster. */
export function ShiftHeadline() {
  const shift = useShift(1000);
  const s = shift;
  return (
    <div>
      <p
        className="font-mono text-[11px] tracking-[0.2em] uppercase flex items-center gap-2"
        style={{ color: "var(--pink)" }}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${s?.onWatch ? "lamp" : ""}`}
          style={{ background: s?.onWatch ? "var(--pink)" : "var(--k30)" }}
        />
        {s ? s.countdownLabel : "The shift"}
        {s && (
          <span className="nums" style={{ color: "var(--core)" }}>
            {fmtCountdown(s.countdownMs)}
          </span>
        )}
      </p>
      <h1 className="font-disp font-black text-3xl sm:text-[42px] leading-[1.08] mt-4">
        {s ? s.headline : "AMM"}
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed max-w-md" style={{ color: "var(--lo)" }}>
        {s
          ? s.subline
          : "Five analysts. Every filing, every call, every after-hours session."}
      </p>
    </div>
  );
}

/** 24h ET shift bar with NOW marker — self-updating. */
export function ShiftBar() {
  const shift = useShift(30_000);
  const etMinutes = shift?.etMinutes ?? 0;
  const seg = (from: number, to: number) => `${((to - from) / 1440) * 100}%`;
  const nowPct = `${(etMinutes / 1440) * 100}%`;
  return (
    <div>
      <div
        className="relative h-1.5 rounded-full overflow-hidden flex"
        style={{ background: "var(--k10)" }}
      >
        <div style={{ width: seg(0, 240), background: "var(--k20)" }} />
        <div style={{ width: seg(240, 570), background: "var(--dim)" }} />
        <div style={{ width: seg(570, 960), background: "var(--k30)" }} />
        <div style={{ width: seg(960, 1200), background: "var(--pink)" }} />
        <div style={{ width: seg(1200, 1440), background: "var(--k20)" }} />
        {shift && (
          <div
            className="absolute top-[-3px] h-[12px] w-[2px]"
            style={{ left: nowPct, background: "var(--core)" }}
          />
        )}
      </div>
      <div
        className="mt-2 flex justify-between font-mono text-[9.5px] uppercase tracking-[0.14em]"
        style={{ color: "var(--dim)" }}
      >
        <span>00:00</span>
        <span>04:00 pre</span>
        <span>09:30 open</span>
        <span style={{ color: "var(--pink)" }}>16:00 shift</span>
        <span>20:00</span>
      </div>
    </div>
  );
}
