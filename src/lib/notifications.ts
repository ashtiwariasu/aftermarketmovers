/**
 * Transactional email notifications (Resend HTTP API) — llmcouncil's
 * notifications module, AMM edition. Deliberately minimal: one POST, no SDK,
 * and three safety gates so a misconfigured environment can never spam real
 * members:
 *
 * - `AMM_EMAILS_ENABLED` must be "true" (off everywhere by default),
 * - `RESEND_API_KEY` must be present (bound from Secret Manager when set),
 * - `EMAIL_SINK_OVERRIDE` redirects every message to one inbox — set it
 *   anywhere that shares real member data so tests never reach users.
 *
 * First consumers: churn-save flows (payment-failed recovery, renewal value
 * summary), fired best-effort from Stripe webhooks. Auth emails (sign-in
 * codes) are Clerk's job, not this module's.
 */

import { isProductionEnvironment, siteUrl } from "@/lib/environment";

const RESEND_URL = "https://api.resend.com/emails";
const SITE = siteUrl();

function visibleHtml(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:lt|#60);/gi, "<")
    .replace(/&(?:gt|#62);/gi, ">")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function scanText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Final public-copy gate. Historical and same-session percentages remain
 * factual evidence; percentages presented as future outcomes are blocked.
 */
export function publicResearchContentIssues({
  subject,
  html,
  text,
}: {
  subject: string;
  html?: string;
  text: string;
}): string[] {
  const copy = scanText(`${subject}\n${text}\n${html ? visibleHtml(html) : ""}`);
  const issues = new Set<string>();
  // A cited third-party rating is evidence about what that analyst published,
  // not AMM issuing the rating. Remove only clearly attributed rating clauses
  // before scanning for AMM-authored recommendations; un-attributed
  // "outperform"/"underperform" language remains blocked below.
  const adviceCopy = copy.replace(
    /\b[A-Z][A-Za-z&.-]+(?:\s+[A-Z][A-Za-z&.-]+){0,2}\s+(?:reported|said|wrote|called|rates?|rated|reiterate(?:d|s)?|maintain(?:ed|s)?|assign(?:ed|s)?)\b[^.!?\n]{0,55}\b(?:outperform|underperform|overweight|underweight|market[- ]perform|sector[- ]perform|buy|sell|hold)\b/g,
    " [ATTRIBUTED ANALYST RATING] ",
  );
  // Fail closed on trade instructions and rating vocabulary, including the
  // common inflections that a one-word `buy|sell` check misses. This is
  // intentionally stricter than the generation prompt: model copy must be
  // rewritten when factual prose happens to use one of these public-action
  // terms.
  const recommendationLanguage = [
    // Advice constructions, not vocabulary: "insider selling", "sell-off",
    // "the company bought back stock" are facts the product must report.
    /\b(?:buy|sell)\s+(?:the\s+(?:stock|shares?|dip|name)|this\s+(?:stock|name|dip)|it\b)/i,
    /\b(?:[Bb]uy|[Ss]ell)\s+[A-Z][A-Z0-9.-]{0,9}\b/,
    /\b(?:buy|sell)\s+(?:now|today|immediately|aggressively)\b/i,
    /\b(?:investors?|readers?|you|we|one|traders?)\b[^.!?\n]{0,45}\b(?:should|would|could|can|might|must|may|consider|ought\s+to|want\s+to)\b[^.!?\n]{0,35}\b(?:buy|sell|buying|selling|accumulat\w*|add|adding|exit|exiting|trim\w*)\b/i,
    /\b(?:should|worth)\s+(?:be\s+)?(?:buy|sell|bought|sold|buying|selling)\b/i,
    /\bwould\s+be\s+(?:bought|sold)\b/i,
    /\b(?:is|remains|looks\s+like|becomes|stays)\s+a\s+(?:buy|sell|hold)\b/i,
    /\b(?:time|opportunity|chance)\s+to\s+(?:buy|sell)\b/i,
    /\baccumulat(?:e|es|ed|ing)\s+(?:the\s+)?(?:stock|shares?|position)\b/i,
    /\b(?:overweight|underweight|market[- ]perform|sector[- ]perform|strong[- ]buy|strong[- ]sell)\b/i,
    /\b(?:outperform|underperform)(?![a-z])/i,
    /\b(?:go|going|stay|remain)\s+(?:long|short)\b/i,
    /\b(?:long|short)\s+(?:the|this|these|a)\s+(?:stock|shares?|securit(?:y|ies)|position)\b/i,
    /\b(?:recommend|recommends|recommended|recommending|rate|rates|rated|rating)\b[^.!?\n]{0,50}\b(?:hold|accumulate|reduce|avoid|exit|long|short)\b/i,
    /\b(?:should|must|could|consider|investors?|readers?|you|we)\b[^.!?\n]{0,45}\b(?:hold|add\s+to|reduce|exit|avoid)\b/i,
    /\b(?:hold|reduce|avoid|exit)\s+(?:the|this|these|a|your)\s+(?:stock|shares?|securit(?:y|ies)|position)\b/i,
    /\bhold\s+(?:rating|recommendation)\b/i,
    /\b(?:rating|recommendation)\s+(?:(?:is|of|at|remains?)\s+)?hold\b/i,
    /\b(?:maintain|maintains|maintained|reiterate|reiterates|reiterated|assign|assigns|assigned|issue|issues|issued)\b[^.!?\n]{0,30}\bhold\b/i,
    /\b(?:[Aa]void|[Ee]xit)\s+[A-Z][A-Z0-9.-]{0,9}\b/,
    /\b(?:reduce|trim)\s+(?:[A-Z][A-Z0-9.-]{0,9}\s+)?(?:exposure|position|holding|stake|allocation)\b/i,
    /\b(?:[Ll]ong|[Ss]hort)\s+[A-Z][A-Z0-9.-]{0,9}\b/,
    /\b(?:high|strong|full|core|conviction)\s+(?:long|short)\b/i,
  ];
  for (const pattern of recommendationLanguage) {
    const m = adviceCopy.match(pattern);
    if (m) { issues.add(`recommendation language: "${m[0].slice(0, 100)}"`); break; }
  }
  if (
    /\b(?:price\s+(?:targets?|objectives?)|target\s+prices?|fair\s+values?|target(?:ed|ing|s)?\s+(?:a\s+)?(?:price\s+of\s+)?[$€£]\s*\d|worth\s+[$€£]\s*\d|(?:should|could|may|likely\s+to|expected\s+to)\s+(?:reach|trade\s+at|hit)\s+[$€£]\s*\d)/i.test(copy) ||
    /\bvaluation\b[^.!?\n]{0,45}[$€£]\s*\d+(?:\.\d+)?\s*(?:\/\s*share|per[-\s]+share)\b/i.test(copy) ||
    /[$€£]\s*\d+(?:\.\d+)?\s*(?:\/\s*share|per[-\s]+share)\b[^.!?\n]{0,45}\bvaluation\b/i.test(copy)
  ) {
    issues.add("price target");
  }
  const numberWord = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)`;
  const numberToken = String.raw`(?:[+\-−]?\d+(?:\.\d+)?|${numberWord}(?:[-\s]+${numberWord})*)`;
  const percentUnit = String.raw`(?:%|pct\.?|percent(?:age\s+points?)?|per\s+cent)`;
  const percent = String.raw`${numberToken}\s*${percentUnit}`;
  const percentBand = String.raw`${numberToken}\s*(?:${percentUnit})?\s*(?:-|–|—|to|through|and)\s*${numberToken}\s*${percentUnit}`;
  // A cue is predictive only when it is connected to a measured move. For
  // example, "set to launch July 28, with shares up 9% today" contains a
  // future event and a historical percentage in one sentence; it is not a 9%
  // forecast.
  // WEAK cues (modals, implies, estimate, model) appear constantly in historical
  // analysis ("the 81% growth implies a prior margin near 38%") and only count
  // when a move verb sits between cue and percentage. (False-positive family
  // fixed 2026-07-18 after quoted-validator rollout; fixtures below.)
  const strongCue = String.raw`(?:expect(?:ed|s|ing)?|forecast(?:ed|s|ing)?|project(?:ed|s|ing)?|target(?:ed|s|ing)?|anticipate(?:d|s|ing)?|predict(?:ed|s|ing)?|will|set\s+to|on\s+track\s+to|poised\s+to)`;
  const weakCue = String.raw`(?:model(?:led|ed|s|ing)?|estimate(?:d|s|ing)?|likely|may|might|can|could|should|would|potential(?:ly)?|implies?|points?\s+to|possible|probable|plausible)`;
  const moveVerb = String.raw`(?:rise|fall|gain|decline|drop|rally|climb|slide|advance|retreat|appreciate|depreciate|move|swing|jump|surge|plunge|correct)`;
  const moveCue = String.raw`(?:upside|downside|return|price\s+move|share\s+move|price\s+(?:up|down)|shares?\s+(?:up|down)|rise|fall|gain|decline|drop|rally|climb|slide|advance|retreat|appreciate|depreciate|move\s+(?:up|down))`;
  // A percentage is a FORECAST only when its clause carries an explicit
  // future cue or a forward-pointing horizon ("next/coming N weeks").
  // Historical facts — "rose 81% in the quarter", "-5.03% over 21 sessions" —
  // are the product's substance and must pass. (Fleet-blocking false
  // positive fixed 2026-07-18; fixtures in tests/notifications.test.ts.)
  const futureHorizon = String.raw`(?:(?:within|by)\s+(?:the\s+)?(?:next\s+|coming\s+)?(?:\d+[\s-]*|(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)[\s-]+)*(?:trading\s+|market\s+)?(?:sessions?|days?|weeks?|months?|quarters?)|(?:within|over|in|during|by|for)\s+(?:the\s+)?(?:next|coming|upcoming)\s+[^.!?\n]{0,24}(?:sessions?|days?|weeks?|months?|quarters?)|(?:next|coming|upcoming)\s+(?:\d+[\s-]*(?:-|–|—|to)?\s*\d*\s+)?(?:trading\s+|market\s+)?(?:sessions?|days?|weeks?|months?|quarters?))`;
  const futurePercent = [
    // upside/downside are forward-looking by definition — no cue needed.
    new RegExp(String.raw`(?:${percentBand}|${percent})[^.!?\n]{0,30}\b(?:upside|downside)\b`, "i"),
    new RegExp(String.raw`\b(?:upside|downside)\b[^.!?\n]{0,30}(?:${percentBand}|${percent})`, "i"),
    new RegExp(String.raw`\b${strongCue}\b[^.!?;,\n]{0,70}\b(?:${moveCue}|${moveVerb}|grow|contract|expand|increase|decrease)\b[^.!?\n]{0,40}(?:${percentBand}|${percent})`, "i"),
    new RegExp(String.raw`\b(?:modelled|modeled|forecast(?:ed)?|projected|expected)\b[^.!?\n]{0,25}(?:${percentBand}|${percent})[^.!?\n]{0,55}\b${futureHorizon}\b`, "i"),
    new RegExp(String.raw`(?:${percentBand}|${percent})[^.!?\n]{0,35}\b(?:${moveCue}|${moveVerb}|growth|contraction|expansion|increase|decrease)\b[^.!?\n]{0,35}\b${strongCue}\b`, "i"),
    new RegExp(String.raw`\b${weakCue}\b[^.!?\n]{0,60}\b(?:${moveCue}|${moveVerb})\b[^.!?\n]{0,40}(?:${percentBand}|${percent})`, "i"),
    // Reverse order only when the modal is predicative about the move itself
    // ("a 4% move is possible"), not epistemic hedging about a past figure
    // ("the 81% surge cannot be judged repeatable").
    new RegExp(String.raw`(?:${percentBand}|${percent})[^.!?\n]{0,20}\b(?:${moveCue}|${moveVerb})\b\s+(?:is|are|looks?|seems?|appears?|remains?)\s+(?:possible|likely|probable|plausible)`, "i"),
    new RegExp(String.raw`(?:${percentBand}|${percent})[^.!?\n]{0,20}\b(?:${moveCue}|${moveVerb})\b\s+(?:could|may|might)\s+(?:occur|materialize|follow|come|repeat|extend|continue)`, "i"),
    new RegExp(String.raw`(?:${percentBand}|${percent})[^.!?\n]{0,35}\b(?:${moveCue}|${moveVerb}|return|growth|contraction)\b[^.!?\n]{0,45}\b${futureHorizon}\b`, "i"),
    new RegExp(String.raw`\b${futureHorizon}\b[^.!?\n]{0,45}\b(?:${moveCue}|${moveVerb}|return|growth|contraction)\b[^.!?\n]{0,35}(?:${percentBand}|${percent})`, "i"),
    new RegExp(String.raw`\b${moveCue}\b[^.!?\n]{0,45}(?:${percentBand}|${percent})[^.!?\n]{0,80}\b${futureHorizon}\b`, "i"),
  ];
  const forecastHits = new Set<string>();
  for (const pattern of futurePercent) {
    const m = copy.match(pattern);
    if (m) forecastHits.add(`"${m[0].slice(0, 100)}"`);
    if (forecastHits.size >= 3) break;
  }
  if (forecastHits.size) issues.add(`percentage forecast: ${[...forecastHits].join("; ")}`);
  return [...issues];
}

export function researchDeliveryIssues({
  subject,
  html,
  text,
  headers,
}: {
  subject: string;
  html?: string;
  text: string;
  headers?: Record<string, string>;
}): string[] {
  const issues = new Set(publicResearchContentIssues({ subject, html, text }));
  const address = process.env.COMPANY_POSTAL_ADDRESS?.trim();
  const all = `${text}\n${html ? visibleHtml(html) : ""}`;
  if (!address) issues.add("COMPANY_POSTAL_ADDRESS missing");
  else if (!all.includes(address)) issues.add("physical postal address absent");
  if (!/Evolo Pty Ltd/i.test(all)) issues.add("legal entity absent");
  if (!/Independent factual market research/i.test(all)) issues.add("research disclaimer absent");
  if (!/unsubscribe/i.test(all)) issues.add("unsubscribe absent");
  if (!(process.env.UNSUBSCRIBE_SECRET?.trim() || process.env.CRON_TOKEN?.trim())) {
    issues.add("unsubscribe signing secret missing");
  }
  if (!headers?.["List-Unsubscribe"] || headers["List-Unsubscribe-Post"] !== "List-Unsubscribe=One-Click") {
    issues.add("one-click unsubscribe headers absent");
  }
  return [...issues];
}

export type EmailKind = "transactional" | "research" | "lifecycle";

export interface EmailSendReceipt {
  accepted: boolean;
  providerEmailId?: string;
  reason: "accepted" | "disabled" | "misconfigured" | "blocked" | "rejected" | "network";
  retryable: boolean;
  detail?: string;
}

function lifecycleDeliveryIssues({
  html,
  text,
  headers,
}: {
  html?: string;
  text: string;
  headers?: Record<string, string>;
}): string[] {
  const address = process.env.COMPANY_POSTAL_ADDRESS?.trim();
  const all = `${text}\n${html ? visibleHtml(html) : ""}`;
  const issues: string[] = [];
  if (!address) issues.push("COMPANY_POSTAL_ADDRESS missing");
  else if (!all.includes(address)) issues.push("physical postal address absent");
  if (!/Evolo Pty Ltd/i.test(all)) issues.push("legal entity absent");
  if (!/unsubscribe/i.test(all)) issues.push("unsubscribe absent");
  if (!headers?.["List-Unsubscribe"] || headers["List-Unsubscribe-Post"] !== "List-Unsubscribe=One-Click") {
    issues.push("one-click unsubscribe headers absent");
  }
  return issues;
}

/** Send one email and retain Resend's provider id for delivery receipts. Never throws. */
export async function sendEmailWithReceipt({
  to,
  subject,
  text,
  html,
  headers,
  kind = "research",
  idempotencyKey,
  tags,
}: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  kind?: EmailKind;
  /** Stable key for retry-safe provider acceptance (Resend keeps it 24h). */
  idempotencyKey?: string;
  tags?: Array<{ name: string; value: string }>;
}): Promise<EmailSendReceipt> {
  if (process.env.AMM_EMAILS_ENABLED !== "true") {
    return { accepted: false, reason: "disabled", retryable: false };
  }
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) {
    return { accepted: false, reason: "misconfigured", retryable: false, detail: "missing key or recipient" };
  }
  const address = process.env.COMPANY_POSTAL_ADDRESS?.trim();
  if (!address) {
    console.warn("[email] send blocked: COMPANY_POSTAL_ADDRESS missing");
    return { accepted: false, reason: "misconfigured", retryable: false, detail: "postal address missing" };
  }
  const legalLine = `Evolo Pty Ltd · ${address}`;
  const outboundText = text.includes(address) && /Evolo Pty Ltd/i.test(text)
    ? text
    : `${text.trimEnd()}\n\n${legalLine}`;
  const outboundHtml = html && visibleHtml(html).includes(address) && /Evolo Pty Ltd/i.test(visibleHtml(html))
    ? html
    : html
      ? `${html}<div style="margin-top:18px;font-size:11px;color:#777;text-align:center;">${escapeHtml(legalLine)}</div>`
      : undefined;
  if (kind === "research") {
    const issues = researchDeliveryIssues({ subject, html: outboundHtml, text: outboundText, headers });
    if (issues.length > 0) {
      console.warn(`[email] research send blocked: ${issues.join(", ")}`);
      return { accepted: false, reason: "blocked", retryable: false, detail: issues.join(", ") };
    }
  } else if (kind === "lifecycle") {
    const issues = lifecycleDeliveryIssues({ html: outboundHtml, text: outboundText, headers });
    if (issues.length > 0) {
      console.warn(`[email] lifecycle send blocked: ${issues.join(", ")}`);
      return { accepted: false, reason: "blocked", retryable: false, detail: issues.join(", ") };
    }
  }
  const sink = process.env.EMAIL_SINK_OVERRIDE?.trim();
  if (!isProductionEnvironment() && !sink) {
    console.warn("[email] non-production send blocked: EMAIL_SINK_OVERRIDE missing");
    return {
      accepted: false,
      reason: "blocked",
      retryable: false,
      detail: "non-production requires EMAIL_SINK_OVERRIDE",
    };
  }
  const from = process.env.EMAIL_FROM || process.env.NOTE_FROM || "AMM <desk@aftermarketmovers.com>";
  try {
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [sink || to],
        subject: sink ? `[sink:${to}] ${subject}` : subject,
        text: outboundText,
        ...(outboundHtml ? { html: outboundHtml } : {}),
        ...(headers ? { headers } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
      }),
    });
    const responseText = await r.text();
    if (r.ok) {
      let providerEmailId = "";
      try {
        providerEmailId = String((JSON.parse(responseText) as { id?: string }).id ?? "");
      } catch {}
      return {
        accepted: true,
        providerEmailId: providerEmailId || undefined,
        reason: "accepted",
        retryable: false,
      };
    }
    console.warn(`[email] send rejected (${r.status}): ${responseText.slice(0, 200)}`);
    return {
      accepted: false,
      reason: "rejected",
      retryable: r.status === 408 || r.status === 409 || r.status === 429 || r.status >= 500,
      detail: `${r.status}: ${responseText.slice(0, 180)}`,
    };
  } catch (e) {
    console.error(`[email] send failed for ${sink || to}: ${String(e).slice(0, 200)}`);
    return { accepted: false, reason: "network", retryable: true, detail: String(e).slice(0, 180) };
  }
}

/** Backwards-compatible boolean sender for existing billing and research flows. */
export async function sendEmail(
  input: Parameters<typeof sendEmailWithReceipt>[0],
): Promise<boolean> {
  return (await sendEmailWithReceipt(input)).accepted;
}

/** Card-recovery nudge on invoice.payment_failed (best-effort). */
export function sendPaymentFailedEmail(email: string): Promise<boolean> {
  const fixUrl = `${SITE}/desk?billing=attention`;
  return sendEmail({
    to: email,
    subject: "Your AMM payment didn't go through",
    text:
      "Hi,\n\n" +
      "A payment for your AMM desk didn't go through — this is usually an\n" +
      "expired or replaced card. Your desk is unchanged for now.\n\n" +
      `Update your card in about a minute here: ${fixUrl}\n` +
      "(Opens your billing panel — payment updates happen on secure Stripe.)\n\n" +
      "If you meant to let the subscription lapse, ignore this and it will end\n" +
      "on its own. Reply to this email if something looks wrong and a human\n" +
      "will sort it out.\n\n" +
      "— AMM · aftermarketmovers.com",
    kind: "transactional",
  });
}

/** Pre-renewal value summary (invoice.upcoming). */
export function sendRenewalSummaryEmail(
  email: string,
  { sittings, companies, renewsAt }: { sittings: number; companies: number; renewsAt: string }
): Promise<boolean> {
  // Deliberately do not mix product promotion into an account/renewal notice.
  // Keeping this relationship message transactional also means a research
  // opt-out cannot accidentally suppress necessary billing communication.
  void sittings;
  void companies;
  return sendEmail({
    to: email,
    subject: "Your month at the AMM desk",
    text: [
      "Hi,",
      "",
      `Your AMM desk renews on ${renewsAt}.`,
      "",
      `Back to AMM Desk: ${SITE}/desk`,
      "Manage or change your plan any time from Profile → Billing & invoices.",
      "",
      "— AMM · aftermarketmovers.com",
    ].join("\n"),
    kind: "transactional",
  });
}
