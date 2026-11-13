import { unsubscribeToken } from "@/lib/unsubscribe";
import { sendEmailWithReceipt, type EmailSendReceipt } from "@/lib/notifications";
import type { ClaimedOnboardingNudge, OnboardingNudgeStage } from "@/lib/onboarding";
import { siteUrl } from "@/lib/environment";

const SITE = siteUrl();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function copy(stage: OnboardingNudgeStage, firstName: string): {
  subject: string;
  eyebrow: string;
  headline: string;
  body: string;
  cta: string;
} {
  const greeting = firstName ? `${firstName}, ` : "";
  if (stage === 0) {
    return {
      subject: "Your AMM Desk needs one stock",
      eyebrow: "YOUR ANALYSTS ARE READY",
      headline: `${greeting}choose the first stock for AMM Desk.`,
      body: "Subscribe for $25/month, then choose one stock in under a minute. AMM starts researching as soon as your desk is active.",
      cta: "Activate AMM Desk",
    };
  }
  if (stage === 1) {
    return {
      subject: "Choose one stock tonight. Wake up to the thesis.",
      eyebrow: "BEFORE TOMORROW'S NOTE",
      headline: "One stock tonight. One stress-tested thesis by morning.",
      body: "Five frontier AI analysts will read the filings, news, trading activity and social chatter for up to three stocks. AMM Desk is $25/month and starts immediately.",
      cta: "Subscribe and choose a stock",
    };
  }
  return {
    subject: "Still want AMM to research your stocks?",
    eyebrow: "FINAL SETUP NOTE",
    headline: "Your AMM Desk is still waiting.",
    body: "Subscribe for $25/month and add one stock to begin the first research. If now is not the right time, this is the last setup reminder.",
    cta: "Activate AMM Desk",
  };
}

export function onboardingEmailForClaim(claim: ClaimedOnboardingNudge): {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  ctaUrl: string;
  unsubscribeUrl: string;
} {
  const item = copy(claim.stage, claim.user.firstName);
  const token = unsubscribeToken(claim.user.id);
  const unsubscribeUrl = `${SITE}/api/onboarding/unsubscribe?d=${encodeURIComponent(claim.user.id)}&t=${token}`;
  const ctaUrl = `${SITE}/desk/new?purchase=pro&utm_source=lifecycle&utm_medium=email&utm_campaign=onboarding_recovery&utm_content=stage_${claim.stage + 1}`;
  const address = process.env.COMPANY_POSTAL_ADDRESS?.trim() ?? "";
  const legalLine = `Evolo Pty Ltd · ${address}`;
  const text = [
    "AMM▲",
    "",
    item.eyebrow,
    item.headline,
    "",
    item.body,
    "",
    "$25/month · 3 stocks · cancel any time",
    "",
    `${item.cta}: ${ctaUrl}`,
    "",
    `Turn off setup reminders: ${unsubscribeUrl}`,
    legalLine,
  ].join("\n");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#F0ECE3;color:#16150F;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F0ECE3;"><tr><td align="center" style="padding:28px 14px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#FFFDF8;border:2px solid #16150F;border-radius:14px;overflow:hidden;">
      <tr><td style="background:#16150F;padding:18px 22px;color:#FFFDF8;font-weight:900;font-size:21px;letter-spacing:-.02em;">AMM<span style="color:#FF4D1F;font-size:13px;vertical-align:middle;">▲</span></td></tr>
      <tr><td style="padding:30px 28px 12px;">
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.16em;color:#FF4D1F;font-weight:800;">${escapeHtml(item.eyebrow)}</div>
        <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.04;letter-spacing:-.025em;margin:13px 0 18px;">${escapeHtml(item.headline)}</h1>
        <p style="font-size:16px;line-height:1.55;margin:0;color:#39372F;">${escapeHtml(item.body)}</p>
        <div style="margin:24px 0 0;padding:13px 15px;border-left:4px solid #2F50FF;background:#F7F4ED;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:800;letter-spacing:.08em;">$25/MONTH&nbsp;&nbsp;·&nbsp;&nbsp;3 STOCKS&nbsp;&nbsp;·&nbsp;&nbsp;CANCEL ANY TIME</div>
      </td></tr>
      <tr><td style="padding:18px 28px 30px;">
        <a href="${ctaUrl}" style="display:block;background:#FF4D1F;color:#FFFDF8;text-decoration:none;text-align:center;font-weight:850;font-size:16px;padding:15px 18px;border:2px solid #16150F;border-radius:9px;box-shadow:3px 3px 0 #16150F;">${escapeHtml(item.cta)} →</a>
      </td></tr>
      <tr><td style="border-top:1px solid #C9C4B8;padding:17px 24px 20px;text-align:center;font-size:10px;line-height:1.55;color:#77736A;">
        ${escapeHtml(legalLine)}<br>
        You created an AMM account but have not created AMM Desk. <a href="${unsubscribeUrl}" style="color:#77736A;">Unsubscribe from setup reminders</a>.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return {
    subject: item.subject,
    text,
    html,
    ctaUrl,
    unsubscribeUrl,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export async function sendOnboardingNudge(
  claim: ClaimedOnboardingNudge,
): Promise<EmailSendReceipt> {
  const email = onboardingEmailForClaim(claim);
  return sendEmailWithReceipt({
    to: claim.user.email,
    subject: email.subject,
    text: email.text,
    html: email.html,
    headers: email.headers,
    kind: "lifecycle",
    idempotencyKey: claim.idempotencyKey,
    tags: [
      { name: "category", value: "onboarding" },
      { name: "user_id", value: claim.user.id },
      { name: "stage", value: String(claim.stage) },
    ],
  });
}
