import { Resend, type WebhookEvent } from "resend";

const apiKey = process.env.RESEND_CONTACTS_API_KEY?.trim() ?? process.env.RESEND_API_KEY?.trim();
const baseUrl = (process.env.BASE_URL ?? "https://aftermarketmovers.com").replace(/\/$/, "");
if (!apiKey) throw new Error("RESEND_CONTACTS_API_KEY (or a full-access RESEND_API_KEY) is required");
const resend = new Resend(apiKey);

async function segment(name: string): Promise<string> {
  const listed = await resend.segments.list();
  if (listed.error) throw new Error(`Unable to list Resend segments: ${listed.error.message}`);
  const found = listed.data?.data.find((item) => item.name === name);
  if (found) return found.id;
  const created = await resend.segments.create({ name });
  if (created.error || !created.data?.id) {
    throw new Error(`Unable to create Resend segment ${name}: ${created.error?.message ?? "missing id"}`);
  }
  return created.data.id;
}

async function topic(name: string, description: string): Promise<string> {
  const listed = await resend.topics.list();
  if (listed.error) throw new Error(`Unable to list Resend topics: ${listed.error.message}`);
  const found = listed.data?.data.find((item) => item.name === name);
  if (found) return found.id;
  const created = await resend.topics.create({
    name,
    description,
    defaultSubscription: "opt_in",
  });
  if (created.error || !created.data?.id) {
    throw new Error(`Unable to create Resend topic ${name}: ${created.error?.message ?? "missing id"}`);
  }
  return created.data.id;
}

async function webhook(): Promise<{ id: string; signingSecret: string }> {
  const endpoint = `${baseUrl}/api/webhooks/resend`;
  const events: WebhookEvent[] = [
    "email.delivered",
    "email.clicked",
    "email.bounced",
    "email.complained",
    "email.suppressed",
  ];
  const listed = await resend.webhooks.list();
  if (listed.error) throw new Error(`Unable to list Resend webhooks: ${listed.error.message}`);
  const found = listed.data?.data.find((item) => item.endpoint === endpoint);
  if (found) {
    const current = await resend.webhooks.get(found.id);
    if (current.error || !current.data?.signing_secret) {
      throw new Error(`Unable to inspect Resend webhook: ${current.error?.message ?? "missing signing secret"}`);
    }
    await resend.webhooks.update(found.id, { endpoint, events, status: "enabled" });
    return { id: found.id, signingSecret: current.data.signing_secret };
  }
  const created = await resend.webhooks.create({ endpoint, events });
  if (created.error || !created.data?.id || !created.data.signing_secret) {
    throw new Error(`Unable to create Resend webhook: ${created.error?.message ?? "missing webhook fields"}`);
  }
  return { id: created.data.id, signingSecret: created.data.signing_secret };
}

async function main() {
  const [onboardingSegment, activeDeskSegment, onboardingTopic, morningNotesTopic, hook] = await Promise.all([
    segment("AMM · Onboarding incomplete"),
    segment("AMM · Active desks"),
    // Topics are not enabled on every Resend workspace. They improve the
    // preference-center mirror but are not an eligibility control; signed
    // one-click unsubscribe + Firestore suppression remain authoritative.
    topic("AMM setup reminders", "Reminders to finish creating an AMM desk.").catch(() => null),
    topic("AMM Morning Notes", "The daily research note for an active AMM desk.").catch(() => null),
    webhook(),
  ]);

  // This output contains the signing secret. Capture it directly into Secret
  // Manager; never paste it into source or CI logs.
  process.stdout.write(JSON.stringify({
    onboardingSegment,
    activeDeskSegment,
    onboardingTopic,
    morningNotesTopic,
    webhookId: hook.id,
    webhookSigningSecret: hook.signingSecret,
  }));
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
