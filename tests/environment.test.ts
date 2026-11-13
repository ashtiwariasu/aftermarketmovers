import assert from "node:assert/strict";
import test from "node:test";
import { environmentSafetyReport } from "../src/lib/environment";

const KEYS = [
  "AMM_ENV", "APP_BASE_URL", "AMM_DATA_MODE", "DESK_STORE", "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT", "AMM_EMAILS_ENABLED", "EMAIL_SINK_OVERRIDE", "RESEND_CONTACTS_API_KEY",
  "RESEND_SEGMENT_ACTIVE_DESK", "RESEND_SEGMENT_ONBOARDING", "AMM_BILLING_MODE",
  "STRIPE_SECRET_KEY", "CLERK_SECRET_KEY", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "AMM_PRODUCTION_PROJECT_ID",
] as const;

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const prior = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    run();
  } finally {
    for (const key of KEYS) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("shared-data development runtime accepts common users and analytics with side effects locked", () => {
  withEnvironment({
    AMM_ENV: "development",
    APP_BASE_URL: "https://amm-dev.example.test",
    AMM_DATA_MODE: "shared",
    DESK_STORE: "firestore",
    GOOGLE_CLOUD_PROJECT: "example-prod-project",
    AMM_PRODUCTION_PROJECT_ID: "example-prod-project",
    AMM_EMAILS_ENABLED: "true",
    EMAIL_SINK_OVERRIDE: "sink@example.test",
    AMM_BILLING_MODE: "disabled",
    CLERK_SECRET_KEY: "sk_live_shared_identity",
    NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-EXAMPLE123",
  }, () => {
    assert.deepEqual(environmentSafetyReport().issues, []);
  });
});

test("development runtime rejects unsunk email, live billing and contact mutation", () => {
  withEnvironment({
    AMM_ENV: "development",
    APP_BASE_URL: "https://amm-dev.example.test",
    AMM_DATA_MODE: "shared",
    DESK_STORE: "firestore",
    GOOGLE_CLOUD_PROJECT: "example-prod-project",
    AMM_PRODUCTION_PROJECT_ID: "example-prod-project",
    AMM_EMAILS_ENABLED: "true",
    AMM_BILLING_MODE: "live",
    STRIPE_SECRET_KEY: "sk_live_unsafe",
    RESEND_CONTACTS_API_KEY: "contacts_unsafe",
  }, () => {
    const issues = environmentSafetyReport().issues.join(" | ");
    assert.match(issues, /EMAIL_SINK_OVERRIDE/);
    assert.match(issues, /Resend contacts/);
    assert.match(issues, /billing/);
  });
});

test("development runtime rejects a production hostname", () => {
  withEnvironment({
    AMM_ENV: "development",
    APP_BASE_URL: "https://aftermarketmovers.com",
    AMM_DATA_MODE: "shared",
    DESK_STORE: "firestore",
    GOOGLE_CLOUD_PROJECT: "example-prod-project",
    AMM_PRODUCTION_PROJECT_ID: "example-prod-project",
  }, () => {
    assert.match(environmentSafetyReport().issues.join(" | "), /APP_BASE_URL/);
  });
});
