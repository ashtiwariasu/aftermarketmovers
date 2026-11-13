"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth, useClerk, UserButton } from "@clerk/nextjs";
import type { CSSProperties } from "react";
import { TIERS, nextTier } from "@/lib/tiers";
import { useUsage } from "@/components/UsageMeter";
import BillingModal from "@/components/BillingModal";
import { captureAnalyticsEvent } from "@/lib/analytics";

/**
 * Nav CTA that flips between "Subscribe · $25" and "My desk" + avatar.
 * Billing lives in the profile menu (llmcouncil's pattern): an upgrade
 * action when a higher tier exists, and the billing module (plan,
 * invoices, cancel) — keeping the desk-capacity card purely meters.
 */
export default function NavAuth({
  className,
  style,
  signedOutLabel = "Subscribe · $25",
}: {
  className?: string;
  style?: CSSProperties;
  signedOutLabel?: string;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const usage = useUsage();
  const [billingOpen, setBillingOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  const up = usage ? nextTier(usage.tier) : null;

  // Dunning emails link to /desk?billing=attention — take the member straight
  // to the billing panel so fixing a card is one click from the inbox.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("billing") === "attention") {
      const timer = window.setTimeout(() => setBillingOpen(true), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  async function startUpgrade() {
    if (upgrading || !up) return;
    setUpgrading(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: up }),
      });
      const j = await res.json();
      if (res.ok && j.url) {
        captureAnalyticsEvent("begin_checkout", {
          currency: "USD",
          value: up === "ultra" ? 399 : 25,
          plan: up,
          placement: "navigation_upgrade",
        });
        location.assign(j.url);
        return;
      }
    } catch {
      /* fall through */
    }
    setUpgrading(false);
  }

  if (!isLoaded) {
    return (
      <span className={className} style={{ ...style, visibility: "hidden" }}>
        {signedOutLabel}
      </span>
    );
  }
  if (isSignedIn) {
    return (
      <span className="flex items-center gap-3">
        <Link href="/desk" className={className} style={style}>
          AMM Desk
        </Link>
        <UserButton>
          <UserButton.MenuItems>
            {up && (
              <UserButton.Action
                label={upgrading ? "Opening checkout…" : `Upgrade to ${TIERS[up].label} · ${TIERS[up].price}`}
                labelIcon={<span style={{ color: "#FF4D1F" }}>▲</span>}
                onClick={startUpgrade}
              />
            )}
            <UserButton.Action
              label="Billing & invoices"
              labelIcon={<span>▤</span>}
              onClick={() => setBillingOpen(true)}
            />
          </UserButton.MenuItems>
        </UserButton>
        {billingOpen && <BillingModal onClose={() => setBillingOpen(false)} />}
      </span>
    );
  }
  // Signed out: one click opens the sign-in modal (Google / email code),
  // which lands the member in the funnel at the plan step.
  return (
    <button
      type="button"
      onClick={() => {
        captureAnalyticsEvent(
          signedOutLabel === "Sign in" ? "sign_in_started" : "plan_selected",
          {
          placement: "navigation",
          signed_in: false,
          },
        );
        clerk.openSignIn({ forceRedirectUrl: "/desk/new?purchase=pro" });
      }}
      className={className}
      style={{ cursor: "pointer", ...style }}
    >
      {signedOutLabel}
    </button>
  );
}
