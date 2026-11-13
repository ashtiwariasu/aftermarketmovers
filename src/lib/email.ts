// Legacy sender signature, now delegating to the gated notifications module —
// one pipe (Resend, AMM's own account), one set of safety gates, one FROM.
import { sendEmail as gatedSend } from "./notifications";

export function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
  headers?: Record<string, string>,
  idempotencyKey?: string,
): Promise<boolean> {
  return gatedSend({
    to,
    subject,
    text,
    html,
    headers,
    kind: "research",
    idempotencyKey,
  });
}
