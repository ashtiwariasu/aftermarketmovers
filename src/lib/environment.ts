export type AmmEnvironment = "local" | "development" | "production" | "test";

/** The Google Cloud project that holds production data, from the environment (never written into the code). */
function productionProjectId(): string {
  return process.env.AMM_PRODUCTION_PROJECT_ID?.trim() ?? "";
}
const PRODUCTION_SITE_URL = "https://aftermarketmovers.com";

function normalizedEnvironment(value: string | undefined): AmmEnvironment | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "development" || normalized === "production" || normalized === "test") {
    return normalized;
  }
  return null;
}

/**
 * AMM_ENV is deliberately separate from NODE_ENV. A Cloud Run development
 * service still runs an optimized Next.js production build, but it must never
 * inherit production side-effect permissions.
 */
export function ammEnvironment(): AmmEnvironment {
  const explicit = normalizedEnvironment(process.env.AMM_ENV);
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "test") return "test";
  if (process.env.NODE_ENV === "development") return "local";
  return "production";
}

export function isProductionEnvironment(): boolean {
  return ammEnvironment() === "production";
}

/**
 * NEXT_PUBLIC_AMM_ENV is frozen into the client bundle and any statically
 * generated metadata. Keep crawl policy tied to that build marker rather than
 * a runtime-only Cloud Run variable.
 */
export function isPublicProductionBuild(): boolean {
  return process.env.NEXT_PUBLIC_AMM_ENV !== "development";
}

export function siteUrl(): string {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/$/, "");
  return configured || PRODUCTION_SITE_URL;
}

export interface EnvironmentSafetyReport {
  environment: AmmEnvironment;
  projectId: string;
  siteUrl: string;
  dataMode: "primary" | "shared" | "memory";
  billingMode: "disabled" | "test" | "live";
  emailMode: "disabled" | "sink" | "live";
  issues: string[];
}

function inferredDataMode(): EnvironmentSafetyReport["dataMode"] {
  if (process.env.DESK_STORE === "memory") return "memory";
  return process.env.AMM_DATA_MODE === "shared" ? "shared" : "primary";
}

function inferredBillingMode(): EnvironmentSafetyReport["billingMode"] {
  const explicit = process.env.AMM_BILLING_MODE?.trim().toLowerCase();
  if (explicit === "test" || explicit === "live") return explicit;
  // Preserve the existing production contract while making every explicit
  // non-production environment opt in to test billing.
  if (ammEnvironment() === "production" && process.env.STRIPE_SECRET_KEY?.trim()) return "live";
  return "disabled";
}

function inferredEmailMode(): EnvironmentSafetyReport["emailMode"] {
  if (process.env.AMM_EMAILS_ENABLED !== "true") return "disabled";
  return process.env.EMAIL_SINK_OVERRIDE?.trim() ? "sink" : "live";
}

/**
 * Fail-closed runtime contract for non-production services. It prevents the
 * most damaging class of configuration error: deploying a development build
 * that targets an unintended project, bills live cards, emails members, or
 * mutates production messaging audiences.
 */
export function environmentSafetyReport(): EnvironmentSafetyReport {
  const environment = ammEnvironment();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GCLOUD_PROJECT?.trim() || "";
  const baseUrl = siteUrl();
  const dataMode = inferredDataMode();
  const billingMode = inferredBillingMode();
  const emailMode = inferredEmailMode();
  const issues: string[] = [];

  if (environment !== "production" && environment !== "test") {
    if (process.env.DESK_STORE !== "memory" && !projectId) {
      issues.push("non-production Firestore requires an explicit GOOGLE_CLOUD_PROJECT");
    }
    if (baseUrl === PRODUCTION_SITE_URL) {
      issues.push("non-production APP_BASE_URL must not be the production site");
    }
    if (dataMode !== "shared" && process.env.DESK_STORE !== "memory") {
      issues.push("non-production AMM_DATA_MODE must be shared");
    }
    if (dataMode === "shared" && projectId !== productionProjectId()) {
      issues.push("shared data mode must explicitly target the production data project");
    }
    if (emailMode === "live") {
      issues.push("non-production email must be disabled or redirected with EMAIL_SINK_OVERRIDE");
    }
    if (process.env.RESEND_CONTACTS_API_KEY?.trim() || process.env.RESEND_SEGMENT_ACTIVE_DESK?.trim() || process.env.RESEND_SEGMENT_ONBOARDING?.trim()) {
      issues.push("non-production must not mutate Resend contacts or production segments");
    }
    if (billingMode === "live" || process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
      issues.push("non-production billing must be disabled or use Stripe test mode");
    }
    // Clerk identities and analytics are intentionally common across AMM
    // environments. Mutation guards and the `environment` event property keep
    // test activity distinguishable without creating a second user universe.
  }

  return { environment, projectId, siteUrl: baseUrl, dataMode, billingMode, emailMode, issues };
}

export function assertEnvironmentSafety(): EnvironmentSafetyReport {
  const report = environmentSafetyReport();
  if (report.issues.length > 0) {
    throw new Error(`unsafe AMM ${report.environment} environment: ${report.issues.join("; ")}`);
  }
  return report;
}

export function billingMode(): EnvironmentSafetyReport["billingMode"] {
  return inferredBillingMode();
}
