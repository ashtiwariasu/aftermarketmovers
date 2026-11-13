"use client";

/**
 * The billing module — llmcouncil's SubscriptionModal, AMM edition.
 * Plan card (tier badge · price · renewal state · change plan · cancel)
 * over the invoice ledger (number · period · amount · paid · view / pdf).
 * Stripe's Portal owns the actual mutations; this modal is the desk-side
 * window onto them.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { TIERS, nextTier, type Tier } from "@/lib/tiers";
import { captureAnalyticsEvent } from "@/lib/analytics";

interface InvoiceRow {
  number: string;
  createdAt: number;
  periodStart: number | null;
  periodEnd: number | null;
  amount: number;
  currency: string;
  status: string | null;
  viewUrl: string | null;
  pdfUrl: string | null;
}

interface Summary {
  tier: Tier;
  label: string;
  price: string;
  blurb: string;
  stripeBacked: boolean;
  renewsAt?: number | null;
  cancelAtPeriodEnd?: boolean;
  invoices: InvoiceRow[];
}

const d = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
const dShort = (ms: number) => new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short" });
const subscribeToHydration = () => () => {};

export default function BillingModal({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useSyncExternalStore(subscribeToHydration, () => true, () => false);

  useEffect(() => {
    fetch("/api/billing/summary")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Couldn't load billing");
        setSummary(j);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function post(path: string, body?: Record<string, unknown>, key = path) {
    if (busy) return;
    setBusy(key);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const j = await res.json();
      if (res.ok && j.url) {
        if (path === "/api/billing/checkout" && typeof body?.tier === "string") {
          const plan = body.tier;
          captureAnalyticsEvent("begin_checkout", {
            currency: "USD",
            value: plan === "ultra" ? 399 : 25,
            plan,
            placement: "billing_modal",
          });
        } else {
          captureAnalyticsEvent("billing_portal_opened", { action: key });
        }
        location.assign(j.url);
        return;
      }
      setError(j.error ?? "Something went wrong");
    } catch {
      setError("Network error — try again");
    }
    setBusy(null);
  }

  const up = summary ? nextTier(summary.tier) : null;
  const down: Tier | null = summary?.tier === "ultra" ? "pro" : null;

  // Portal to <body>: the nav header's backdrop-filter makes it the
  // containing block for fixed descendants, which imprisoned the overlay
  // inside the 90px header strip. Escaping the header fixes it everywhere.
  if (!mounted) return null;
  return createPortal(
    <div
      className="pp fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4"
      style={{ background: "rgba(22,21,15,.45)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] rounded-2xl overflow-hidden"
        style={{ background: "var(--pr-paper, #F4F1EA)", border: "2px solid var(--pr-ink)", boxShadow: "6px 6px 0 var(--pr-ink)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3" style={{ background: "var(--pr-ink)", color: "var(--pr-paper)" }}>
          <span className="pp-mono text-[10px] uppercase tracking-[0.2em]">Billing · AMM Desk</span>
          <button onClick={onClose} className="pp-mono text-[13px] px-1 hover:opacity-70" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <p className="pp-mono text-[11px]" style={{ color: "var(--pr-orange)" }}>
              {error}
            </p>
          )}
          {!summary && !error && (
            <p className="pp-mono text-[11px] animate-pulse" style={{ color: "var(--pr-faint)" }}>
              Opening the ledger…
            </p>
          )}

          {summary && (
            <>
              {/* plan card */}
              <div className="rounded-xl p-4" style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card, #FFFDF8)" }}>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="pp-mono text-[9px] uppercase tracking-[0.16em] px-2 py-[3px] rounded-full font-bold" style={{ background: "var(--pr-ink)", color: "var(--pr-lime)" }}>
                    {summary.label}
                  </span>
                  <span className="pp-disp font-extrabold text-[19px]" style={{ color: "var(--pr-ink, #16150F)" }}>{summary.price}</span>
                </div>
                <p className="mt-1.5 text-[13px]" style={{ color: "var(--pr-dim)" }}>
                  {summary.blurb} · the same five AI analysts at every tier
                </p>
                {summary.stripeBacked && summary.renewsAt && (
                  <p className="mt-2 pp-mono text-[11px]" style={{ color: summary.cancelAtPeriodEnd ? "var(--pr-orange)" : "var(--pr-dim)" }}>
                    {summary.cancelAtPeriodEnd ? `Cancels on ${d(summary.renewsAt)}` : `Renews on ${d(summary.renewsAt)}`}
                  </p>
                )}
                {!summary.stripeBacked && summary.tier !== "free" && (
                  <p className="mt-2 pp-mono text-[10px]" style={{ color: "var(--pr-faint)" }}>
                    legacy desk — Stripe billing not linked
                  </p>
                )}

                <div className="flex items-center gap-2 flex-wrap mt-3.5">
                  {!summary.stripeBacked && summary.tier !== "free" && (
                    <>
                      <button
                        onClick={() => post("/api/billing/checkout", { tier: summary.tier }, "activate")}
                        disabled={!!busy}
                        className="pp-mono text-[10px] uppercase tracking-[0.12em] font-bold px-3 py-2 rounded-lg"
                        style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-lime)", boxShadow: "2px 2px 0 var(--pr-ink)" }}
                      >
                        {busy === "activate" ? "opening…" : `start subscription — ${summary.label} · ${summary.price}`}
                      </button>
                      {summary.tier === "ultra" && (
                        <button
                          onClick={() => post("/api/billing/checkout", { tier: "pro" }, "downshift")}
                          disabled={!!busy}
                          className="pp-mono text-[10px] uppercase tracking-[0.12em] px-3 py-2 rounded-lg"
                          style={{ border: "2px solid var(--pr-ink)", background: "transparent" }}
                        >
                          {busy === "downshift" ? "opening…" : `change plan — ${TIERS.pro.label}`}
                        </button>
                      )}
                    </>
                  )}
                  {up && (
                    <button
                      onClick={() => post("/api/billing/checkout", { tier: up }, "up")}
                      disabled={!!busy}
                      className="pp-mono text-[10px] uppercase tracking-[0.12em] font-bold px-3 py-2 rounded-lg"
                      style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-lime)", boxShadow: "2px 2px 0 var(--pr-ink)" }}
                    >
                      {busy === "up" ? "opening…" : `upgrade — ${TIERS[up].label} · ${TIERS[up].price}`}
                    </button>
                  )}
                  {down && summary.stripeBacked && (
                    <button
                      onClick={() => post("/api/billing/checkout", { tier: down }, "down")}
                      disabled={!!busy}
                      className="pp-mono text-[10px] uppercase tracking-[0.12em] px-3 py-2 rounded-lg"
                      style={{ border: "2px solid var(--pr-ink)", background: "transparent" }}
                    >
                      {busy === "down" ? "opening…" : `change plan — ${TIERS[down].label}`}
                    </button>
                  )}
                  {summary.stripeBacked && summary.tier !== "free" && !summary.cancelAtPeriodEnd && (
                    <button
                      onClick={() => post("/api/billing/portal", { flow: "cancel" }, "cancel")}
                      disabled={!!busy}
                      className="pp-mono text-[10px] uppercase tracking-[0.12em] px-3 py-2 rounded-lg"
                      style={{ border: "1.5px solid var(--pr-ink)", background: "transparent", color: "var(--pr-dim)" }}
                    >
                      {busy === "cancel" ? "opening…" : "cancel subscription"}
                    </button>
                  )}
                  {summary.stripeBacked && (
                    <button
                      onClick={() => post("/api/billing/portal", {}, "portal")}
                      disabled={!!busy}
                      className="pp-mono text-[10px] uppercase tracking-[0.12em] px-3 py-2 rounded-lg"
                      style={{ border: "1.5px solid var(--pr-ink)", background: "transparent", color: "var(--pr-dim)" }}
                    >
                      {busy === "portal" ? "opening…" : "payment method"}
                    </button>
                  )}
                </div>
              </div>

              {/* invoices */}
              <div>
                <p className="pp-mono text-[9px] uppercase tracking-[0.2em] mb-2" style={{ color: "var(--pr-faint)" }}>
                  Invoices
                </p>
                {summary.invoices.length === 0 ? (
                  <p className="pp-mono text-[11px]" style={{ color: "var(--pr-faint)" }}>
                    {summary.stripeBacked ? "No invoices yet." : "Invoices appear once a subscription starts."}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {summary.invoices.map((inv) => (
                      <div key={inv.number} className="flex items-center gap-3 rounded-xl px-3.5 py-2.5" style={{ border: "1.5px solid var(--pr-ink)", background: "var(--pr-card, #FFFDF8)" }}>
                        <div className="min-w-0 flex-1">
                          <p className="pp-mono text-[11.5px] font-bold truncate">{inv.number}</p>
                          <p className="pp-mono text-[10px]" style={{ color: "var(--pr-faint)" }}>
                            {d(inv.createdAt)}
                            {inv.periodStart && inv.periodEnd ? ` · ${dShort(inv.periodStart)}–${dShort(inv.periodEnd)}` : ""}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="pp-mono text-[12.5px] font-bold">
                            ${inv.amount.toFixed(2)}
                          </p>
                          <p className="pp-mono text-[9.5px] uppercase" style={{ color: inv.status === "paid" ? "var(--pr-up, #0B7A50)" : "var(--pr-orange)" }}>
                            {inv.status}
                          </p>
                        </div>
                        <span className="flex gap-2 shrink-0 pp-mono text-[11px]">
                          {inv.viewUrl && (
                            <a href={inv.viewUrl} target="_blank" rel="noreferrer" className="hover:opacity-70" title="View invoice">
                              ↗
                            </a>
                          )}
                          {inv.pdfUrl && (
                            <a href={inv.pdfUrl} className="hover:opacity-70" title="Download PDF">
                              ⬇
                            </a>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <p className="pp-mono text-[9.5px]" style={{ color: "var(--pr-faint)" }}>
                plan changes and cancellation are confirmed on Stripe&apos;s secure page · © Evolo Pty Ltd
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
