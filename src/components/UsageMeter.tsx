"use client";

/**
 * UsageMeter — the desk's fuel gauges. Sittings render as a segmented battery
 * (lime → orange when low → drained ink when empty); companies render as file
 * slots (squares when the cap is small, a compact bar at Ultra scale).
 * Self-fetching from /api/desk/usage; refreshes when anything dispatches a
 * "desk-usage-changed" window event (CouncilRoom does after each sitting).
 */

import { useCallback, useEffect, useState } from "react";

export interface Usage {
  tier: "free" | "pro" | "ultra";
  label: string;
  companies: { used: number; cap: number };
  sittings: { used: number; cap: number };
  maxCost: number;
  trial: {
    access: "payment_required" | "paid";
    active: boolean;
    startedAt: number | null;
    endsAt: number | null;
    daysRemaining: number | null;
  };
}

export function useUsage(): Usage | null {
  const [usage, setUsage] = useState<Usage | null>(null);
  const load = useCallback(() => {
    fetch("/api/desk/usage", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => u && setUsage(u))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("desk-usage-changed", load);
    return () => window.removeEventListener("desk-usage-changed", load);
  }, [load]);
  return usage;
}

function Battery({ used, cap, compact }: { used: number; cap: number; compact?: boolean }) {
  const left = Math.max(0, cap - used);
  const frac = cap > 0 ? left / cap : 0;
  const cells = Math.min(cap, 10);
  const litCells = Math.ceil(frac * cells);
  const color = frac <= 0 ? "var(--pr-faint)" : frac <= 0.2 ? "var(--pr-orange)" : "var(--pr-lime)";
  const h = compact ? 10 : 14;
  return (
    <span className="inline-flex items-center gap-[3px]" title={`${left} of ${cap} research questions left this month`}>
      <span
        className="inline-flex items-center gap-[2px] px-[3px] py-[2px] rounded-[3px]"
        style={{ border: "1.5px solid var(--pr-ink)", background: "var(--pr-card)" }}
      >
        {Array.from({ length: cells }, (_, i) => (
          <span
            key={i}
            style={{
              width: compact ? 4 : 6,
              height: h,
              borderRadius: 1,
              background: i < litCells ? color : "transparent",
              border: i < litCells ? "none" : "1px dashed var(--pr-faint)",
            }}
          />
        ))}
      </span>
      {/* battery tip */}
      <span style={{ width: 3, height: h - 4, background: "var(--pr-ink)", borderRadius: 1 }} />
    </span>
  );
}

function FileSlots({ used, cap }: { used: number; cap: number }) {
  if (cap > 6) {
    // Ultra scale — a compact fill bar beats 50 squares.
    const frac = Math.min(1, used / cap);
    return (
      <span
        className="inline-block align-middle rounded-[3px] overflow-hidden"
        style={{ border: "1.5px solid var(--pr-ink)", width: 72, height: 12, background: "var(--pr-card)" }}
        title={`${used} of ${cap} files open`}
      >
        <span className="block h-full" style={{ width: `${frac * 100}%`, background: "var(--pr-blue)" }} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-[3px]" title={`${used} of ${cap} files open`}>
      {Array.from({ length: cap }, (_, i) => (
        <span
          key={i}
          style={{
            width: 11,
            height: 13,
            borderRadius: 2,
            background: i < used ? "var(--pr-blue)" : "transparent",
            border: i < used ? "1.5px solid var(--pr-ink)" : "1.5px dashed var(--pr-faint)",
          }}
        />
      ))}
    </span>
  );
}

export function TierChip({ label }: { label: string }) {
  return (
    <span
      className="pp-mono text-[9px] uppercase tracking-[0.16em] px-2 py-[3px] rounded-full font-bold"
      style={{ background: "var(--pr-ink)", color: "var(--pr-lime)" }}
    >
      {label}
    </span>
  );
}

/**
 * variant="rail": full card for the /desk rail.
 * variant="compact": one-line strip for the workbench header / composer.
 */
export default function UsageMeter({ variant = "rail" }: { variant?: "rail" | "compact" }) {
  const usage = useUsage();
  if (!usage) return null;
  const { sittings, companies } = usage;
  const left = Math.max(0, sittings.cap - sittings.used);
  const trial = usage.trial;

  if (variant === "compact") {
    return (
      <span className="inline-flex items-center gap-2 pp-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-dim)" }}>
        <Battery used={sittings.used} cap={sittings.cap} compact />
        <span>
          {left}/{sittings.cap} question{sittings.cap === 1 ? "" : "s"}
        </span>
        <TierChip label={usage.label} />
        {trial.access === "payment_required" && <span>subscription required</span>}
      </span>
    );
  }

  return (
    <div className="pp-card pp-shadow-sm p-5">
      <div className="flex items-center justify-between">
        <p className="pp-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--pr-faint)" }}>
          AMM Desk
        </p>
        <TierChip label={usage.label} />
      </div>
      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="pp-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-dim)" }}>
            Files open
          </span>
          <span className="inline-flex items-center gap-2">
            <FileSlots used={companies.used} cap={companies.cap} />
            <span className="pp-mono text-[11px] font-bold">
              {companies.used}/{companies.cap}
            </span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="pp-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-dim)" }}>
            Questions left
          </span>
          <span className="inline-flex items-center gap-2">
            <Battery used={sittings.used} cap={sittings.cap} />
            <span className="pp-mono text-[11px] font-bold">
              {left}/{sittings.cap}
            </span>
          </span>
        </div>
      </div>
      <p className="mt-3 pp-mono text-[10px]" style={{ color: "var(--pr-faint)" }}>
        {trial.access === "payment_required"
          ? "subscription required · your existing research is saved"
          : "resets monthly · every question uses one credit · reviewed by five AI analysts"}
      </p>
      {trial.access === "payment_required" && (
        <a href="/pricing" className="pp-btn pp-btn-orange mt-4 block text-center py-2.5 text-[13px]">
          Subscribe for $25 →
        </a>
      )}
    </div>
  );
}
