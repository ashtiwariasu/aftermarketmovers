import posthog from "posthog-js";

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
const analyticsEnvironment = process.env.NEXT_PUBLIC_AMM_ENV?.trim() || "production";

if (projectToken) {
  posthog.init(projectToken, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
    defaults: "2026-05-30",
    capture_pageview: "history_change",
    capture_pageleave: true,
    person_profiles: "identified_only",
    autocapture: false,
    disable_session_recording: true,
  });
  posthog.register({ environment: analyticsEnvironment });
}
