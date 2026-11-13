"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { paidPlanEntryPath, TIERS } from "@/lib/tiers";
import { captureAnalyticsEvent } from "@/lib/analytics";
import { beginNavigationFeedback } from "@/lib/navigationFeedback";

/** The single public AMM offer: $25/month, with no free entitlement. */
export default function PlanCards({
  checkoutReturnTo,
}: {
  checkoutReturnTo?: "onboarding";
}) {
  const { isSignedIn } = useAuth();
  const clerk = useClerk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setError(null);
    captureAnalyticsEvent("plan_selected", {
      plan: "pro",
      signed_in: Boolean(isSignedIn),
      placement: checkoutReturnTo ? "onboarding" : "pricing",
    });
    if (!isSignedIn) {
      clerk.openSignIn({ forceRedirectUrl: paidPlanEntryPath("pro") });
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "pro", returnTo: "onboarding" }),
      });
      const result = await res.json();
      if (res.ok && result.url) {
        captureAnalyticsEvent("begin_checkout", {
          currency: "USD",
          value: 25,
          plan: "pro",
          placement: checkoutReturnTo ? "onboarding" : "pricing",
        });
        beginNavigationFeedback();
        location.assign(result.url);
        return;
      }
      setError(result.error ?? "Couldn't start checkout — try again");
    } catch {
      setError("Network error — try again");
    }
    setBusy(false);
  }

  return (
    <div>
      <div
        className="pp-card p-6 flex flex-col mt-2 max-w-xl"
        style={{ borderWidth: 2, boxShadow: "5px 5px 0 var(--pr-ink)", background: "var(--pr-card, #FFFDF8)" }}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="pp-mono text-[9px] uppercase tracking-[0.16em] px-2 py-[3px] rounded-full font-bold"
            style={{ background: "var(--pr-ink)", color: "var(--pr-lime)" }}
          >
            {TIERS.pro.label}
          </span>
          <span className="pp-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--pr-orange)" }}>
            one simple plan
          </span>
        </div>
        <p className="mt-4">
          <span className="pp-disp font-extrabold text-[34px] leading-none">$25</span>
          <span className="pp-mono text-[11px] ml-1" style={{ color: "var(--pr-faint)" }}>/month</span>
        </p>
        <p className="mt-2 text-[13.5px] leading-snug font-medium" style={{ color: "var(--pr-dim)" }}>
          Starts immediately. Cancel any time.
        </p>
        <ul className="mt-4 mb-6 space-y-2">
          {[
            "3 company files, research updated daily",
            "30 research questions a month",
            "Morning Note across your book before the open",
          ].map((point) => (
            <li key={point} className="flex gap-2 text-[12.5px]" style={{ color: "var(--pr-dim)" }}>
              <span style={{ color: "var(--pr-up, #0B7A50)" }}>✓</span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <button onClick={subscribe} disabled={busy} className="pp-btn pp-btn-orange w-full py-3 text-[14px]">
          {busy ? "Opening secure checkout…" : "Subscribe for $25 →"}
        </button>
      </div>
      {error && <p className="mt-4 text-sm font-medium" style={{ color: "var(--pr-down)" }}>{error}</p>}
      <p className="mt-5 pp-mono text-[10.5px]" style={{ color: "var(--pr-faint)" }}>
        secure Stripe billing · change or cancel any time from Profile → Billing
      </p>
    </div>
  );
}
