"use client";

import { useRouter } from "next/navigation";
import { useAuth, useClerk } from "@clerk/nextjs";
import type { CSSProperties, ReactNode } from "react";
import { captureAnalyticsEvent } from "@/lib/analytics";
import { beginNavigationFeedback } from "@/lib/navigationFeedback";
import { paidPlanEntryPath } from "@/lib/tiers";

/**
 * Every public CTA leads to the $25/month subscription before desk setup.
 */
export default function GetStartedCta({
  plan,
  ticker,
  authMode = "sign-in",
  analyticsPlacement,
  className,
  style,
  children,
}: {
  plan?: "free" | "pro" | "ultra";
  ticker?: string;
  authMode?: "sign-in" | "sign-up";
  analyticsPlacement?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { isSignedIn } = useAuth();
  const clerk = useClerk();
  const router = useRouter();
  const query = new URLSearchParams();
  const paidPlan = plan === "ultra" ? "ultra" : "pro";
  if (plan !== "free") {
    const entry = new URL(paidPlanEntryPath(paidPlan), "https://aftermarketmovers.com");
    entry.searchParams.forEach((value, key) => query.set(key, value));
  } else if (plan) {
    query.set("plan", plan);
  }
  if (ticker) query.set("add", ticker.toUpperCase());
  const target = `/desk/new${query.size ? `?${query.toString()}` : ""}`;

  return (
    <button
      type="button"
      onClick={() => {
        captureAnalyticsEvent(ticker ? "track_stock_intent" : "plan_selected", {
          ...(ticker ? { ticker: ticker.toUpperCase() } : {}),
          plan: paidPlan,
          ...(analyticsPlacement ? { placement: analyticsPlacement } : {}),
          signed_in: Boolean(isSignedIn),
        });
        if (isSignedIn) {
          beginNavigationFeedback();
          router.push(target);
        }
        else if (authMode === "sign-up") {
          clerk.openSignUp({ forceRedirectUrl: target });
        } else {
          clerk.openSignIn({ forceRedirectUrl: target });
        }
      }}
      className={className}
      style={{ cursor: "pointer", border: "none", font: "inherit", ...style }}
    >
      {children}
    </button>
  );
}
