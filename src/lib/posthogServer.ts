import { PostHog } from "posthog-node";
import { ammEnvironment } from "@/lib/environment";

type ServerAnalyticsProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

/** Best-effort server analytics. Product behavior must never depend on it. */
export async function captureServerAnalyticsEvent({
  distinctId,
  event,
  properties = {},
}: {
  distinctId: string;
  event: string;
  properties?: ServerAnalyticsProperties;
}) {
  const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  if (!projectToken) return false;

  const client = new PostHog(projectToken, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
  try {
    client.capture({
      distinctId,
      event,
      properties: Object.fromEntries(
        Object.entries({ environment: ammEnvironment(), ...properties }).filter(([, value]) => value !== undefined)
      ),
    });
    await client.shutdown();
    return true;
  } catch (error) {
    console.error(`[posthog] ${event} skipped: ${String(error).slice(0, 160)}`);
    await client.shutdown().catch(() => {});
    return false;
  }
}
