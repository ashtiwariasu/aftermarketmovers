"use client";

import { useEffect } from "react";
import { captureAnalyticsEvent } from "@/lib/analytics";

export default function ResearchAnalytics({
  ticker,
  hasPublishedThesis,
  pageVariant = "member",
  hasDailyShort = false,
}: {
  ticker: string;
  hasPublishedThesis: boolean;
  pageVariant?: "member" | "public_evidence" | "subscription_gate";
  hasDailyShort?: boolean;
}) {
  useEffect(() => {
    captureAnalyticsEvent("research_viewed", {
      ticker,
      published_thesis: hasPublishedThesis,
      page_variant: pageVariant,
      has_daily_short: hasDailyShort,
    });
  }, [ticker, hasPublishedThesis, pageVariant, hasDailyShort]);

  return null;
}
