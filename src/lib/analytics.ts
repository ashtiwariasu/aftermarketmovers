"use client";

import { sendGAEvent } from "@next/third-parties/google";
import posthog from "posthog-js";
import type { Properties } from "posthog-js";

export type AnalyticsProperties = Properties;

const postHogConfigured = Boolean(
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim()
);
const analyticsEnvironment = process.env.NEXT_PUBLIC_AMM_ENV?.trim() || "production";

/**
 * One product event contract for GA4 and PostHog. Keeping both destinations
 * behind one function prevents the acquisition and product funnels drifting.
 */
export function captureAnalyticsEvent(
  event: string,
  properties: AnalyticsProperties = {}
) {
  const clean = Object.fromEntries(
    Object.entries({ environment: analyticsEnvironment, ...properties }).filter(([, value]) => value !== undefined)
  ) as Properties;

  sendGAEvent("event", event, clean);
  if (postHogConfigured) posthog.capture(event, clean);
}

export function identifyAnalyticsUser(userId: string) {
  if (postHogConfigured) posthog.identify(userId);
}

export function resetAnalyticsUser() {
  if (postHogConfigured) posthog.reset();
}
