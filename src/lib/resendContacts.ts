import { Resend } from "resend";
import type { OnboardingUser } from "@/lib/onboarding";

type ContactState = "pending" | "completed" | "unsubscribed" | "suppressed" | "deleted";

function client(): Resend | null {
  // Keep the production sender on a send-only key. Contact/audience mutation
  // uses a separately scoped key so a lifecycle integration cannot broaden
  // the blast radius of ordinary Morning Note delivery.
  const key = process.env.RESEND_CONTACTS_API_KEY?.trim() ?? process.env.RESEND_API_KEY?.trim();
  return key ? new Resend(key) : null;
}

function segmentsFor(state: ContactState): string[] {
  const pending = process.env.RESEND_SEGMENT_ONBOARDING?.trim();
  const active = process.env.RESEND_SEGMENT_ACTIVE_DESK?.trim();
  return state === "pending"
    ? pending ? [pending] : []
    : state === "completed"
      ? active ? [active] : []
      : [];
}

function topicsFor(state: ContactState): Array<{ id: string; subscription: "opt_in" | "opt_out" }> {
  const onboarding = process.env.RESEND_TOPIC_ONBOARDING?.trim();
  const morning = process.env.RESEND_TOPIC_MORNING_NOTES?.trim();
  return [
    ...(onboarding ? [{ id: onboarding, subscription: state === "pending" ? "opt_in" as const : "opt_out" as const }] : []),
    ...(morning ? [{ id: morning, subscription: state === "completed" ? "opt_in" as const : "opt_out" as const }] : []),
  ];
}

/**
 * Best-effort Resend mirror. Firestore remains authoritative for eligibility;
 * this mirror powers deliverability history, segments and preference topics.
 */
export async function syncResendOnboardingContact(
  user: Pick<OnboardingUser, "email" | "firstName" | "lastName">,
  state: ContactState,
): Promise<boolean> {
  const resend = client();
  if (!resend || !user.email) return false;
  const segments = segmentsFor(state);
  const topics = topicsFor(state);
  try {
    const created = await resend.contacts.create({
      email: user.email,
      firstName: user.firstName || undefined,
      lastName: user.lastName || undefined,
      unsubscribed: state === "suppressed" || state === "deleted",
      ...(segments.length > 0 ? { segments: segments.map((id) => ({ id })) } : {}),
      ...(topics.length > 0 ? { topics } : {}),
    });
    if (!created.error) return true;

    // Existing contact: never set unsubscribed=false, which could override a
    // recipient's global choice. Only explicit suppression moves it to true.
    const updated = await resend.contacts.update({
      email: user.email,
      firstName: user.firstName || undefined,
      lastName: user.lastName || undefined,
      ...((state === "suppressed" || state === "deleted") ? { unsubscribed: true } : {}),
    });
    if (updated.error) {
      console.warn(`[resend-contact] ${user.email} update failed: ${updated.error.message}`);
      return false;
    }

    if (topics.length > 0) {
      const topicResult = await resend.contacts.topics.update({ email: user.email, topics });
      if (topicResult.error) console.warn(`[resend-contact] topic sync failed: ${topicResult.error.message}`);
    }
    const pending = process.env.RESEND_SEGMENT_ONBOARDING?.trim();
    const active = process.env.RESEND_SEGMENT_ACTIVE_DESK?.trim();
    for (const segmentId of [pending, active].filter((value): value is string => Boolean(value))) {
      const wanted = segments.includes(segmentId);
      const result = wanted
        ? await resend.contacts.segments.add({ email: user.email, segmentId })
        : await resend.contacts.segments.remove({ email: user.email, segmentId });
      // Removing a contact that is already absent is harmless; Resend returns
      // an API error, so keep synchronization best-effort and non-blocking.
      if (result.error && wanted) {
        console.warn(`[resend-contact] segment sync failed: ${result.error.message}`);
      }
    }
    return true;
  } catch (error) {
    console.warn(`[resend-contact] ${user.email} sync failed: ${String(error).slice(0, 180)}`);
    return false;
  }
}
