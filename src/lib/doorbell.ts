import type { Desk } from "./desk";
import { getDossierHistory, getPeriodicFilingsSnapshot } from "./companyStore";
import { getDailyHistory, getTickerSnapshot, type TickerSnapshot } from "./ticker";
import {
  dossierReleaseValidationError,
  getCachedDossier,
  getRejectedDossierFactualUpdate,
  type Dossier,
  type RejectedDossierFactualUpdate,
} from "./dossier";
import { citedTextHtml, type ComposedNote } from "./morningNote";
import { publicResearchContentIssues } from "./notifications";
import {
  getThesisMovementObservations,
  type ActiveQuestion,
} from "./scoreboard";
import {
  buildThesisMovementView,
  mergeThesisMovementObservations,
  signalScore,
  thesisMovementWindow,
  type ThesisMovementObservation,
  type ThesisMovementView,
} from "./thesisMovement";
import { unsubscribeToken, validUnsubscribeToken } from "./unsubscribe";
import { siteUrl } from "./environment";
import { getDailyThesisCoverage } from "./dailyThesisCheck";
import {
  isUsEquityTradingDay,
  previousUsEquityTradingDay,
} from "./shortPublishing";

/**
 * The Morning Note doorbell — the locked fox/triangle/skeleton design.
 *
 * A full dossier is compressed into four familiar beats. The renderer never
 * creates a forecast: it will only publish a structured hook which five
 * independent seats have already voted on. If no hook clears 3/5, the same
 * template says that plainly and carries the latest valid thesis forward.
 */

const SITE = siteUrl();
const INK = "#16150F";
const PAPER = "#F4F1EA";
const CARD = "#FFFDF8";
const BLUE = "#2B4BF2";
const ORANGE = "#FF4D1F";
const LIME = "#D9F45B";
const DIM = "#57544A";
const FAINT = "#7A766C";
const GREEN = "#0B7A50";
const RED = "#B3273D";

type PriorStatus = "strengthened" | "weakened" | "resolved" | "invalidated" | "replaced" | "open";
type SignalDirection = "UP" | "DOWN";
type SignalStrength = "GENTLE" | "MODERATE" | "STRONG";

interface NormalizedHook {
  subjectPunchline: string;
  priorUpdate: { status: PriorStatus; text: string } | null;
  whatChanged: string;
  thesis: string;
  primaryEvidence: string;
  secondaryEvidence: string[];
  signal: {
    direction: SignalDirection;
    strength: SignalStrength;
    horizonSessions: { min: number; max: number };
  };
  votesSupport: number;
  votesOppose: number;
  votesUncertain: number;
  votesTotal: number;
  confidence: {
    majorityReason: string;
    dissentReason: string | null;
    uncertaintyReason: string | null;
    flipCondition: string;
  };
  editorialStrength: number;
}

export interface PriorThesis {
  ticker: string;
  date: string;
  thesis: string;
  votesSupport: number | null;
  votesTotal: number | null;
  lifecycle: "open" | "resolved" | "expired" | "unknown";
  sessionsElapsed: number | null;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value == null ? null : requiredString(value) ?? undefined;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Runtime adapter for the v5 hook. Keeping this defensive makes the reader
 * migration-safe while Firestore contains mixed artifact versions.
 */
function structuredHook(dossier: Dossier): NormalizedHook | null {
  if (dossierReleaseValidationError(dossier) !== null) return null;
  const hook = asRecord((dossier as unknown as Record<string, unknown>).emailHook);
  if (!hook) return null;
  const priorRaw = hook.priorUpdate;
  let priorUpdate: NormalizedHook["priorUpdate"] = null;
  if (priorRaw != null) {
    const prior = asRecord(priorRaw);
    const status = prior?.status;
    const text = requiredString(prior?.text);
    if (
      !prior ||
      !text ||
      /\bconfirm(?:ed|s|ation)?\b/i.test(text) ||
      !["strengthened", "weakened", "resolved", "invalidated", "replaced", "open"].includes(String(status))
    ) {
      return null;
    }
    priorUpdate = { status: status as PriorStatus, text };
  }

  const signal = asRecord(hook.signal);
  const horizon = asRecord(signal?.horizonSessions);
  const confidence = asRecord(hook.confidence);
  const direction = signal?.direction;
  const strength = signal?.strength;
  const min = integer(horizon?.min);
  const max = integer(horizon?.max);
  const votesSupport = integer(hook.votesSupport);
  const votesOppose = integer(hook.votesOppose);
  const votesUncertain = integer(hook.votesUncertain);
  const votesTotal = integer(hook.votesTotal);
  const subjectPunchline = requiredString(hook.subjectPunchline);
  const whatChanged = requiredString(hook.whatChanged);
  const thesis = requiredString(hook.thesis);
  const primaryEvidence = requiredString(hook.primaryEvidence);
  const majorityReason = requiredString(confidence?.majorityReason);
  const flipCondition = requiredString(confidence?.flipCondition);
  const dissentReason = nullableString(confidence?.dissentReason);
  const uncertaintyReason = nullableString(confidence?.uncertaintyReason);
  const secondaryEvidence = Array.isArray(hook.secondaryEvidence)
    ? hook.secondaryEvidence.map(requiredString).filter((v): v is string => Boolean(v))
    : [];

  if (
    !subjectPunchline ||
    !whatChanged ||
    !thesis ||
    !primaryEvidence ||
    secondaryEvidence.length < 2 ||
    secondaryEvidence.length > 3 ||
    !majorityReason ||
    !flipCondition ||
    dissentReason === undefined ||
    uncertaintyReason === undefined ||
    !["UP", "DOWN"].includes(String(direction)) ||
    !["GENTLE", "MODERATE", "STRONG"].includes(String(strength)) ||
    min !== 10 ||
    max !== 15 ||
    votesTotal !== 5 ||
    votesSupport == null ||
    votesOppose == null ||
    votesUncertain == null ||
    votesSupport < 0 ||
    votesOppose < 0 ||
    votesUncertain < 0 ||
    votesSupport + votesOppose + votesUncertain !== votesTotal ||
    (votesOppose > 0 && !dissentReason) ||
    (votesUncertain > 0 && !uncertaintyReason)
  ) {
    return null;
  }

  return {
    subjectPunchline,
    priorUpdate,
    whatChanged,
    thesis,
    primaryEvidence,
    secondaryEvidence,
    signal: {
      direction: direction as SignalDirection,
      strength: strength as SignalStrength,
      horizonSessions: { min, max },
    },
    votesSupport,
    votesOppose,
    votesUncertain,
    votesTotal,
    confidence: {
      majorityReason,
      dissentReason,
      uncertaintyReason,
      flipCondition,
    },
    editorialStrength: (() => {
      if (typeof hook.editorialStrength === "number" && Number.isFinite(hook.editorialStrength)) {
        return hook.editorialStrength;
      }
      const editorial = asRecord(hook.editorialStrength);
      return typeof editorial?.score === "number" && Number.isFinite(editorial.score)
        ? editorial.score
        : 0;
    })(),
  };
}

/** Only a fully valid v5 thesis can appear in the carry-forward block. */
function priorThesis(dossier: Dossier): PriorThesis | null {
  const current = structuredHook(dossier);
  if (current && current.votesSupport >= 3) {
    if (publicResearchContentIssues({ subject: "", text: current.thesis }).length > 0) return null;
    return {
      ticker: dossier.ticker,
      date: dossier.date,
      thesis: current.thesis,
      votesSupport: current.votesSupport,
      votesTotal: current.votesTotal,
      lifecycle: "unknown",
      sessionsElapsed: null,
    };
  }
  return null;
}

function pct(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function change(snapshot: TickerSnapshot): number {
  return (snapshot.afterHoursChangePercent ?? snapshot.dayChangePercent) ?? 0;
}

/**
 * Strip dossier citations for the email surface.
 *
 * The full dossier remains fully traceable. The Morning Note is the concise
 * doorbell, so neither citation chips nor raw source URLs belong in its prose.
 * Stored dossiers span a few historical Markdown variants, including links
 * split across whitespace, so this deliberately accepts more than the current
 * canonical citation formatter.
 */
function plain(value: string): string {
  return value
    .replace(
      /\[(?:\d+|S\d+)\s*[·.]\s*\d{4}-\d{2}-\d{2}\]\s*\(\s*https?:\/\/[^)]*\)/gi,
      "",
    )
    .replace(/\[(?:\d+|S\d+)\s*[·.]\s*\d{4}-\d{2}-\d{2}\]/gi, "")
    .replace(/\[S\d+\]/gi, "")
    .replace(/\[([^\]]+)\]\s*\(\s*https?:\/\/[^)]*\)/gi, "$1")
    .replace(/https?:\/\/[^\s<>"']+/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s+([.,;:?])/g, "$1")
    .replace(/([.!?])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function traceablePlain(value: string): string {
  return value
    .replace(
      /\[(\d+ · \d{4}-\d{2}-\d{2})\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g,
      "$1 $2",
    )
    .replace(/\s+([.,;:?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Use a complete opening sentence for the email; the dossier keeps the rest. */
function openingSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const boundary = normalized.match(/^([\s\S]*?[.!?])\s+(?=[A-Z0-9“"'])/);
  return (boundary?.[1] ?? normalized).trim();
}

/** Protect current stored hooks while the stricter prompt governs new runs. */
function plainEmailLanguage(value: string): string {
  return value
    .replace(/\btech-slump markdown\b/gi, "tech selloff")
    .replace(/\bsector-generic repricing\b/gi, "broad-sector move")
    .replace(/\bcompany-specific break\b/gi, "company-specific problem")
    .replace(/\bmarks-driven remeasurement\b/gi, "market-value gains")
    .replace(/\bprinted negative\b/gi, "observed downside")
    .replace(/\bunvalidated positive\b/gi, "unproven catalyst")
    .replace(/\bre-anchoring\b/gi, "reassessment")
    .replace(/\bretire the read\b/gi, "invalidate the thesis");
}

function emailLine(value: string): string {
  // Remove complete citation blocks before finding the first sentence.
  // Source titles inside a Markdown citation can contain full stops; sentence
  // splitting first would leave a dangling half-link in the email.
  return plainEmailLanguage(openingSentence(plain(value)));
}

function emailThesis(value: string): string {
  return emailLine(value).replace(/^The claim:\s*/i, "");
}

function overnightDates(now = new Date()): Set<string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return new Set([
    fmt.format(now),
    fmt.format(new Date(now.getTime() - 86_400_000)),
  ]);
}

export function expectedDailyTrackingDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const today = `${value("year")}-${value("month")}-${value("day")}`;

  // The overnight dossier cycle is keyed to the upcoming New York trading
  // date. At the 09:00 ET send, every desk therefore reads that same current
  // date rather than yesterday's close-date bucket.
  if (isUsEquityTradingDay(today)) return today;
  return previousUsEquityTradingDay(today);
}

export function dossierArtifactKey(dossier: Dossier): string {
  return `dossier-v${dossier.artifactVersion}:${dossier.ticker}:${dossier.date}:${dossier.generatedAt}`;
}

function rawPriorStatus(dossier: Dossier): PriorStatus | null {
  if (dossierReleaseValidationError(dossier) !== null) return null;
  const hook = asRecord((dossier as unknown as Record<string, unknown>).emailHook);
  const prior = asRecord(hook?.priorUpdate);
  const status = prior?.status;
  return ["strengthened", "weakened", "resolved", "invalidated", "replaced", "open"].includes(String(status))
    ? (status as PriorStatus)
    : null;
}

/** Resolve a fixed 10–15-session thesis against observed exchange sessions. */
export function lifecycleFromSessionDates(
  issuedOn: string,
  sessionDates: string[],
  resolvedByLaterArtifact = false,
): Pick<PriorThesis, "lifecycle" | "sessionsElapsed"> {
  if (resolvedByLaterArtifact) return { lifecycle: "resolved", sessionsElapsed: null };
  const clean = [...new Set(sessionDates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  // A real bar on/before issue proves that this is a usable market-session
  // series. Without it we refuse to call the proposition open or expired.
  if (!clean.some((date) => date <= issuedOn)) {
    return { lifecycle: "unknown", sessionsElapsed: null };
  }
  const sessionsElapsed = clean.filter((date) => date > issuedOn).length;
  return {
    lifecycle: sessionsElapsed >= 15 ? "expired" : "open",
    sessionsElapsed,
  };
}

async function resolvePriorLifecycle(
  prior: PriorThesis,
  dossiers: Dossier[],
): Promise<PriorThesis> {
  const firstLater = dossiers
    .filter(
      (dossier) =>
        dossierReleaseValidationError(dossier) === null &&
        dossier.ticker === prior.ticker &&
        dossier.date > prior.date &&
        structuredHook(dossier) !== null,
    )
    .sort((left, right) => left.date.localeCompare(right.date))[0];
  const laterStatus = firstLater ? rawPriorStatus(firstLater) : null;
  const resolvedByLaterArtifact = laterStatus != null &&
    ["resolved", "invalidated", "replaced"].includes(laterStatus);
  if (resolvedByLaterArtifact) {
    return { ...prior, lifecycle: "resolved", sessionsElapsed: null };
  }
  const bars = await getDailyHistory(prior.ticker, "3mo").catch(() => []);
  return {
    ...prior,
    ...lifecycleFromSessionDates(prior.date, bars.map((bar) => bar.date), false),
  };
}

export function unsubToken(deskId: string): string {
  return unsubscribeToken(deskId);
}

export function validUnsubToken(deskId: string, token: string): boolean {
  return validUnsubscribeToken(deskId, token);
}

function postalAddress(): string {
  return process.env.COMPANY_POSTAL_ADDRESS?.trim() || "COMPANY_POSTAL_ADDRESS REQUIRED — DELIVERY DISABLED";
}

function dateAndTime(_desk: Desk, now: Date): { dateLabel: string; timeLabel: string } {
  return {
    dateLabel: now
      .toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
      })
      .toUpperCase(),
    timeLabel: "PRE-OPEN ET",
  };
}

export interface ResearchIncompleteStatus {
  /** New York trading date whose overnight research was expected. */
  trackingDate: string;
  tickers: string[];
}

function normalizedIncompleteStatus(
  status: ResearchIncompleteStatus | null | undefined,
): ResearchIncompleteStatus | null {
  if (!status || !/^20\d{2}-\d{2}-\d{2}$/.test(status.trackingDate)) return null;
  const tickers = [...new Set(status.tickers.map((ticker) => ticker.trim().toUpperCase()))]
    .filter((ticker) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker))
    .sort((left, right) => left.localeCompare(right));
  return tickers.length > 0 ? { trackingDate: status.trackingDate, tickers } : null;
}

function researchIncompleteCopy(status: ResearchIncompleteStatus): string {
  const names = status.tickers.join(", ");
  const companies = status.tickers.length === 1 ? "this company" : "these companies";
  return `${names}: the ${status.trackingDate} evidence-and-council review did not complete for ${companies}. ` +
    "Where available, the last valid thesis for each affected company is carried forward as prior research only; no current-day ruling was produced.";
}

function researchIncompleteHtml(status: ResearchIncompleteStatus): string {
  return `<div style="margin:16px 24px 0;border:2px solid ${ORANGE};background:#FFF4EC;border-radius:10px;padding:13px 15px;">
    <p style="margin:0;font-family:monospace;font-size:10px;letter-spacing:1.7px;color:${ORANGE};font-weight:700;">RESEARCH INCOMPLETE · ${esc(status.tickers.join(" · "))}</p>
    <p style="margin:7px 0 0;font-size:13px;line-height:1.5;color:${INK};">${esc(researchIncompleteCopy(status))}</p>
  </div>`;
}

function footer(desk: Desk): { html: string; text: string; unsubUrl: string; headers: Record<string, string> } {
  const unsubUrl = `${SITE}/api/email/unsub?d=${encodeURIComponent(desk.id)}&t=${unsubToken(desk.id)}`;
  const disclaimer = "Independent factual market research. Not financial, investment, tax or legal advice. Personal circumstances are not considered.";
  const address = postalAddress();
  return {
    unsubUrl,
    html: `<div style="margin:18px 24px 0;border-top:1px solid #CFC9BC;padding:15px 0 18px;text-align:left;">
      <p style="margin:0;font-family:monospace;font-size:9px;line-height:1.45;color:${FAINT};">${esc(disclaimer)}</p>
      <p style="margin:4px 0 0;font-family:monospace;font-size:9px;line-height:1.45;color:${FAINT};">Evolo Pty Ltd · ${esc(address)} · <a href="${unsubUrl}" style="color:${FAINT};">unsubscribe</a></p>
    </div>`,
    text: `${disclaimer}\nEvolo Pty Ltd · ${address}\nUnsubscribe: ${unsubUrl}`,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

function voteMarks(hook: NormalizedHook): string {
  const support = Array.from(
    { length: hook.votesSupport },
    () => `<img src="${SITE}/tri-brand-flat.png?v=2" width="16" height="15" alt="" title="SUPPORT" style="display:inline-block;vertical-align:middle;margin-right:7px;">`,
  ).join("");
  const oppose = Array.from(
    { length: hook.votesOppose },
    () => `<span aria-hidden="true" title="OPPOSE" style="display:inline-block;vertical-align:middle;margin-right:7px;font-family:Arial,sans-serif;font-size:15px;line-height:15px;color:${RED};">▼</span>`,
  ).join("");
  const uncertain = Array.from(
    { length: hook.votesUncertain },
    () => `<span aria-hidden="true" title="UNCERTAIN" style="display:inline-block;vertical-align:middle;margin-right:7px;font-family:Arial,sans-serif;font-size:17px;line-height:15px;color:#9B978E;">△</span>`,
  ).join("");
  return `${support}${oppose}${uncertain}`;
}

function signalLabel(hook: NormalizedHook): string {
  const direction = hook.signal.direction === "UP" ? "UPSIDE" : "DOWNSIDE";
  const strength = hook.signal.strength === "STRONG" ? "STRONG" : "GENTLE";
  const minWeeks = Math.ceil(hook.signal.horizonSessions.min / 5);
  const maxWeeks = Math.ceil(hook.signal.horizonSessions.max / 5);
  return `${strength} ${direction} · ${minWeeks}–${maxWeeks} WEEKS`;
}

export interface PriorPublishedSignal {
  date: string;
  direction: SignalDirection;
  strength: SignalStrength;
}

function shortDossierDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${month[Number(match[2]) - 1] ?? match[2]} ${Number(match[3])}`;
}

/** The previous marker is derived only from an earlier, published public dossier. */
export function previousPublishedSignal(
  current: Dossier,
  history: Dossier[],
): PriorPublishedSignal | null {
  const previous = history
    .filter(
      (candidate) =>
        candidate.ticker === current.ticker &&
        candidate.generatedAt < current.generatedAt &&
        dossierReleaseValidationError(candidate) === null,
    )
    .map((candidate) => ({ candidate, hook: structuredHook(candidate) }))
    .filter(
      (item): item is { candidate: Dossier; hook: NormalizedHook } =>
        Boolean(item.hook && item.hook.votesSupport >= 3),
    )
    .sort((left, right) => right.candidate.generatedAt - left.candidate.generatedAt)[0];
  if (!previous) return null;
  return {
    date: previous.candidate.date,
    direction: previous.hook.signal.direction,
    strength: previous.hook.signal.strength,
  };
}

function directionalSignal(hook: NormalizedHook): string {
  const railIndex = (signal: Pick<NormalizedHook["signal"], "direction" | "strength">): number =>
    signal.direction === "DOWN"
      ? signal.strength === "STRONG" ? 0 : 1
      : signal.strength === "STRONG" ? 4 : 3;
  const currentIndex = railIndex(hook.signal);
  const signalColor = hook.signal.direction === "UP" ? BLUE : ORANGE;
  const anchors = new Map<number, { top: string; bottom: string; size: number; color: string }>([
    [0, { top: "STRONG", bottom: "DOWNSIDE", size: 26, color: ORANGE }],
    [1, { top: "GENTLE", bottom: "DOWNSIDE", size: 20, color: ORANGE }],
    [2, { top: "NEUTRAL", bottom: "", size: 17, color: INK }],
    [3, { top: "GENTLE", bottom: "UPSIDE", size: 20, color: BLUE }],
    [4, { top: "STRONG", bottom: "UPSIDE", size: 26, color: BLUE }],
  ]);
  const positions = Array.from({ length: 5 }, (_, index) => {
    const active = index === currentIndex;
    const anchor = anchors.get(index)!;
    const marker = active
      ? `<span style="display:inline-block;box-sizing:border-box;width:34px;height:34px;padding:4px;background:${CARD};border:2px solid ${signalColor};border-radius:50%;"><span style="display:inline-block;box-sizing:border-box;width:22px;height:22px;line-height:18px;text-align:center;background:${CARD};border:2px solid ${signalColor};border-radius:50%;"><img src="${SITE}/tri-brand-flat.png?v=2" width="11" height="10" alt="" style="display:inline-block;vertical-align:middle;"></span></span>`
      : `<span style="display:inline-block;box-sizing:border-box;width:${anchor.size}px;height:${anchor.size}px;background:${CARD};border:2px solid ${anchor.color};border-radius:50%;"></span>`;
    const leftLine = index === 0 ? "transparent" : index <= 2 ? ORANGE : BLUE;
    const rightLine = index === 4 ? "transparent" : index < 2 ? ORANGE : BLUE;
    return `<td width="20%" align="center" valign="top" style="padding:0;">
      <table role="presentation" width="100%" height="46" cellpadding="0" cellspacing="0"><tr>
        <td width="50%" height="46" valign="middle" style="font-size:0;line-height:0;"><span style="display:block;height:2px;background:${leftLine};"></span></td>
        <td width="38" height="46" align="center" valign="middle" style="font-size:0;line-height:0;">${marker}</td>
        <td width="50%" height="46" valign="middle" style="font-size:0;line-height:0;"><span style="display:block;height:2px;background:${rightLine};"></span></td>
      </tr></table>
      <div style="min-height:25px;margin-top:5px;font-family:monospace;font-size:8px;line-height:1.35;font-weight:700;letter-spacing:.55px;color:${active ? signalColor : anchor.color};">${anchor.top}${anchor.bottom ? `<br>${anchor.bottom}` : ""}</div>
    </td>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:monospace;font-size:9px;letter-spacing:1.7px;font-weight:700;color:${INK};">CURRENT DIRECTIONAL READ</td>
      <td align="right" style="font-family:monospace;font-size:9px;letter-spacing:1px;font-weight:700;color:${signalColor};">${hook.votesSupport}/${hook.votesTotal} AGREE</td>
    </tr></table>
    <p style="margin:8px 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:.96;font-weight:700;letter-spacing:-1.2px;text-transform:uppercase;color:${signalColor};">${esc(signalLabel(hook).split(" · ")[0])}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${positions}</tr></table>`;
}

function dossierMovementObservation(dossier: Dossier): ThesisMovementObservation {
  const lifecycle = dossier.thesisLifecycle;
  const votes = dossier.emailHook.votes;
  return {
    schemaVersion: 1,
    date: dossier.date,
    observedAt: dossier.generatedAt,
    index: lifecycle?.observationIndex ?? 1,
    status: lifecycle?.observationStatus ?? "opened",
    score: signalScore(lifecycle?.latestSignal ?? dossier.emailHook.signal),
    support: votes.support,
    oppose: votes.oppose,
    uncertain: votes.uncertain,
    unavailable: Math.max(0, 5 - votes.support - votes.oppose - votes.uncertain),
    ...(dossier.briefAuditId ? { auditId: dossier.briefAuditId } : {}),
  };
}

async function movementForDoorbell(
  hero: Dossier,
  history: Dossier[],
  nextEvent: string | null,
): Promise<ThesisMovementView | null> {
  const lifecycle = hero.thesisLifecycle;
  const [filings, stored] = await Promise.all([
    getPeriodicFilingsSnapshot(hero.ticker, 4).catch(() => []),
    lifecycle
      ? getThesisMovementObservations({
          ticker: hero.ticker,
          lifecycleId: lifecycle.id,
          openedDate: lifecycle.openedDate,
          limit: 130,
        }).catch(() => [] as ThesisMovementObservation[])
      : Promise.resolve([] as ThesisMovementObservation[]),
  ]);
  const fromDossiers = (lifecycle ? [hero, ...history] : [hero])
    .filter((item) => {
      if (item.ticker !== hero.ticker || dossierReleaseValidationError(item) !== null) return false;
      if (!lifecycle) return item.generatedAt === hero.generatedAt;
      return item.thesisLifecycle?.id === lifecycle.id ||
        (!item.thesisLifecycle && item.date === lifecycle.openedDate);
    })
    .map(dossierMovementObservation);
  const observations = mergeThesisMovementObservations(fromDossiers, stored);
  return buildThesisMovementView({
    observations,
    fallbackSignal: lifecycle?.latestSignal ?? hero.emailHook.signal,
    fallbackVotes: {
      ...hero.emailHook.votes,
      unavailable: Math.max(
        0,
        5 -
          hero.emailHook.votes.support -
          hero.emailHook.votes.oppose -
          hero.emailHook.votes.uncertain,
      ),
    },
    window: thesisMovementWindow({
      openedDate: lifecycle?.openedDate ?? hero.date,
      filings,
      nextEvent,
    }),
  });
}

function lifecycleStatusLabel(dossier: Dossier): string {
  const lifecycle = dossier.thesisLifecycle;
  const status = lifecycle?.observationStatus ?? dossier.emailHook.priorUpdate?.status;
  if (status === "strengthened") return "STRENGTHENED TODAY";
  if (status === "weakened") return "WEAKENED TODAY";
  if (status === "open") return "UNCHANGED TODAY";
  if (!lifecycle || lifecycle.observationIndex <= 1 || status === "opened") {
    return "OPENED TODAY";
  }
  return "UNCHANGED TODAY";
}

function agreementSummary(hook: NormalizedHook): string {
  const majority = plain(emailLine(hook.confidence.majorityReason));
  const notSupporting = Math.max(0, hook.votesTotal - hook.votesSupport);
  const lead = hook.votesSupport === 5
    ? `All five analysts support the standing thesis: ${majority}`
    : `${hook.votesSupport} of five analysts support the standing thesis: ${majority}`;
  if (notSupporting === 0) return lead;
  return `${lead} ${notSupporting === 1 ? "One analyst wants" : `${notSupporting} analysts want`} more evidence before changing the standing thesis.`;
}

export interface HeroRankInput {
  /** Research date. Freshness is the first publication requirement. */
  date?: string;
  votesSupport: number;
  votesOppose: number;
  editorialStrength: number;
  absoluteMove: number;
}

/**
 * A Morning Note is a freshness product: never promote yesterday's stronger
 * ballot above today's cleared research. Within the newest research date,
 * agreement and contradiction risk outrank punchiness; movement breaks ties.
 */
export function compareHeroRank(left: HeroRankInput, right: HeroRankInput): number {
  const freshness = (right.date ?? "").localeCompare(left.date ?? "");
  if (freshness !== 0) return freshness;
  const support = right.votesSupport - left.votesSupport;
  if (support !== 0) return support;
  const opposition = left.votesOppose - right.votesOppose;
  if (opposition !== 0) return opposition;
  const editorial = right.editorialStrength - left.editorialStrength;
  if (editorial !== 0) return editorial;
  return right.absoluteMove - left.absoluteMove;
}

function assertRenderIsSafe(result: Pick<ComposedNote, "subject" | "html" | "text">): void {
  const issues = publicResearchContentIssues(result);
  if (issues.length > 0) throw new Error(`Research email blocked: ${issues.join(", ")}`);
}

export interface DoorbellResult extends ComposedNote {
  headers: Record<string, string>;
  /** Stable source/day identifier used for delivery idempotency and watermarks. */
  artifactKey: string;
  /** Set only when this email presents a dossier as a new thesis. */
  publishedDossierKey: string | null;
}

export interface DoorbellRenderInput {
  desk: Desk;
  hero: Dossier;
  heroSnapshot?: TickerSnapshot;
  priorSignal?: PriorPublishedSignal | null;
  thesisMovement?: ThesisMovementView | null;
  priorResolution?: ActiveQuestion;
  updates: number;
  others: string[];
  researchIncomplete?: ResearchIncompleteStatus | null;
  now?: Date;
}

/** Pure renderer used by production and regression tests. */
export function renderDoorbell({
  desk,
  hero,
  heroSnapshot,
  thesisMovement = null,
  updates,
  others,
  researchIncomplete,
  now = new Date(),
}: DoorbellRenderInput): DoorbellResult {
  const hook = structuredHook(hero);
  if (!hook || hook.votesSupport < 3) {
    throw new Error("A new Morning Note thesis must use the v5 hook and clear 3/5");
  }
  const heroChange = heroSnapshot ? change(heroSnapshot) : null;
  const heroSession = heroSnapshot?.afterHoursChangePercent != null ? "after hours" : "on the day";
  const { dateLabel, timeLabel } = dateAndTime(desk, now);
  const compliance = footer(desk);
  const researchUrl = `${SITE}/stock/${hero.ticker.toLowerCase()}?utm_source=morning_note&utm_medium=email&utm_campaign=doorbell`;
  const whatChanged = emailLine(hook.whatChanged);
  const activeThesis = hero.thesisLifecycle?.canonicalSubjectPunchline || hook.subjectPunchline;
  const thesis = emailThesis(activeThesis);
  const subject = `🦊 ${hero.ticker}: ${plain(plainEmailLanguage(hook.subjectPunchline))}`;
  // The email is the doorbell, not the dossier: one direct proof and the
  // strongest corroborating fact are enough to earn the click.
  const evidence = [hook.primaryEvidence, hook.secondaryEvidence[0]].map(emailLine);
  const whatChangedCopy = plain(whatChanged);
  const plainThesis = plain(thesis);
  const thesisCopy = plainThesis.charAt(0).toUpperCase() + plainThesis.slice(1);
  const evidenceCopy = evidence.map(plain);
  const confidenceCopy = agreementSummary(hook);
  const openedDate = thesisMovement?.window.startDate ??
    hero.thesisLifecycle?.openedDate ??
    hero.date;
  const thesisStatus = lifecycleStatusLabel(hero);
  const incomplete = normalizedIncompleteStatus(researchIncomplete);
  const completedStocks = Math.max(0, desk.tickers.length - (incomplete?.tickers.length ?? 0));
  const coverageLine = incomplete
    ? `<b style="color:${INK};">${completedStocks}/${desk.tickers.length} stocks</b> completed · <b style="color:${INK};">${updates} update${updates === 1 ? "" : "s"}</b> · <b style="color:${ORANGE};">1 Signal</b>`
    : `<b style="color:${INK};">${desk.tickers.length} stock${desk.tickers.length === 1 ? "" : "s"}</b> scanned · <b style="color:${INK};">${updates} update${updates === 1 ? "" : "s"}</b> · <b style="color:${ORANGE};">1 Signal</b>`;
  const skeleton = (width: number) =>
    `<div style="height:11px;border-radius:5px;background:#DDD8CB;margin:0 0 7px;width:${width}%;"></div>`;

  const html = `
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(thesisCopy)}</div>
<div style="background:#EDE9DF;padding:30px 12px;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:${INK};">
  <div style="max-width:620px;margin:0 auto;background:${PAPER};border:2px solid ${INK};border-radius:16px;overflow:hidden;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
      <tr>
        <td style="padding:14px 24px;"><img src="${SITE}/fox-note.png" width="31" height="40" alt="" style="display:inline-block;vertical-align:middle;margin-right:9px;"><span style="font-weight:800;font-size:24px;color:${PAPER};vertical-align:middle;">AMM</span><img src="${SITE}/tri-on.png" width="10" height="9" alt="▲" style="display:inline-block;vertical-align:baseline;margin-left:2px;"></td>
        <td align="right" style="padding:14px 24px;font-family:monospace;font-size:12px;letter-spacing:2px;color:${LIME};">${dateLabel} · ${timeLabel}</td>
      </tr>
    </table>

    <p style="margin:24px 24px 0;font-family:monospace;font-size:13px;color:${DIM};">${coverageLine}</p>
    ${incomplete ? researchIncompleteHtml(incomplete) : ""}

    <div style="margin:20px 24px 0;background:${CARD};border:2px solid ${INK};border-radius:14px;padding:22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="top"><span style="font-family:Arial,sans-serif;font-weight:500;font-size:28px;line-height:1;color:${BLUE};">${esc(hero.ticker)}</span><br><span style="display:inline-block;margin-top:8px;font-family:monospace;font-size:14px;font-weight:700;color:${heroChange != null && heroChange < 0 ? RED : GREEN};">${heroChange != null ? `${pct(heroChange)} ${heroSession === "after hours" ? "AH" : "today"}` : "on watch"}</span></td>
        <td align="right" valign="top" style="font-family:monospace;font-size:10px;font-weight:700;letter-spacing:1px;color:${FAINT};text-transform:uppercase;">${esc(shortDossierDate(hero.date))}</td>
      </tr></table>

      <div style="margin-top:24px;">
        <p style="margin:0;font-family:monospace;font-size:11px;letter-spacing:2px;color:${ORANGE};font-weight:700;">WHAT CHANGED TODAY</p>
        <p style="margin:10px 0 0;font-size:15px;line-height:1.58;color:${INK};">${esc(whatChangedCopy)}</p>
      </div>

      <div style="margin:22px 0 0;border-left:4px solid ${ORANGE};background:#FBF8F1;border-radius:0 10px 10px 0;padding:16px 18px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-family:monospace;font-size:9px;letter-spacing:1.5px;color:${INK};font-weight:700;">ACTIVE THESIS · OPENED ${esc(shortDossierDate(openedDate).toUpperCase())}</td>
          <td align="right" style="font-family:monospace;font-size:8px;letter-spacing:1px;color:${ORANGE};font-weight:700;">${esc(thesisStatus)}</td>
        </tr></table>
        <p style="margin:12px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.06;font-weight:700;letter-spacing:-.6px;color:${INK};">${esc(thesisCopy)}</p>
      </div>

      <div style="margin-top:18px;padding:15px 13px 14px;border-top:1.5px solid ${INK};border-bottom:1.5px solid ${INK};border-left:4px solid ${BLUE};">
        ${directionalSignal(hook)}
      </div>

      <div style="margin-top:22px;">
        <p style="margin:0;font-family:monospace;font-size:11px;letter-spacing:2px;color:${ORANGE};font-weight:700;">NEW EVIDENCE</p>
        ${evidenceCopy.map((item, index) => `<p style="margin:${index === 0 ? 10 : 10}px 0 0;font-size:14px;line-height:1.55;color:${INK};"><b>${index + 1}.</b> ${esc(item)}</p>`).join("")}
      </div>

      <div style="margin-top:20px;padding-top:15px;border-top:1px solid #9B978E;">
        <p style="margin:0;font-family:monospace;font-size:10px;letter-spacing:2px;color:${ORANGE};font-weight:700;">ANALYST AGREEMENT</p>
        <p style="margin:8px 0 0;">${voteMarks(hook)}<span style="font-family:monospace;font-size:11px;font-weight:700;color:${INK};margin-left:5px;vertical-align:middle;">${hook.votesSupport}/${hook.votesTotal} AGREE</span></p>
        <p style="margin:11px 0 0;font-size:12px;line-height:1.5;color:${INK};">${esc(confidenceCopy)}</p>
      </div>

      <div style="margin-top:15px;border-top:1px solid #D8D2C6;padding-top:12px;">
        ${skeleton(92)}${skeleton(78)}${skeleton(61)}
        <a href="${researchUrl}" style="display:block;text-align:center;background:${ORANGE};color:#FFFFFF;font-weight:800;font-size:18px;text-decoration:none;padding:17px 20px;border-radius:9px;border:2px solid ${INK};margin-top:12px;">View Full Research in AMM Desk&nbsp; →</a>
      </div>
    </div>

    ${others.length > 0 ? `<p style="margin:16px 24px 0;font-family:monospace;font-size:10px;color:${DIM};">Also moved: <b style="color:${INK};">${others.map(esc).join(" · ")}</b></p>` : ""}
    ${compliance.html}
  </div>
</div>`;

  const text = [
    `AMM MORNING NOTE · ${dateLabel}`,
    incomplete
      ? `${completedStocks}/${desk.tickers.length} stocks completed · ${updates} updates · 1 Signal`
      : `${desk.tickers.length} stocks scanned · ${updates} updates · 1 Signal`,
    ...(incomplete ? ["", "RESEARCH INCOMPLETE", researchIncompleteCopy(incomplete)] : []),
    "",
    `${hero.ticker} · ${shortDossierDate(hero.date)} · ${heroChange != null ? pct(heroChange) : ""} ${heroSession}`,
    `WHAT CHANGED TODAY: ${whatChangedCopy}`,
    "",
    `ACTIVE THESIS · OPENED ${shortDossierDate(openedDate).toUpperCase()} · ${thesisStatus}: ${thesisCopy}`,
    "",
    `CURRENT DIRECTIONAL READ: ${signalLabel(hook).split(" · ")[0]} · ${hook.votesSupport}/${hook.votesTotal} AGREE`,
    "",
    "NEW EVIDENCE:",
    ...evidenceCopy.map((item, index) => `${index + 1}. ${item}`),
    "",
    `ANALYST AGREEMENT: ${hook.votesSupport}/${hook.votesTotal} AGREE. ${confidenceCopy}`,
    "",
    `View full research in AMM Desk: ${researchUrl}`,
    others.length > 0 ? `Also moved: ${others.join(", ")}` : "",
    "",
    compliance.text,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const artifactKey = dossierArtifactKey(hero);
  const result: DoorbellResult = {
    subject,
    html,
    text,
    headers: compliance.headers,
    artifactKey,
    publishedDossierKey: artifactKey,
  };
  assertRenderIsSafe(result);
  return result;
}

export interface NoThesisRenderInput {
  desk: Desk;
  snapshots: TickerSnapshot[];
  factualUpdates?: RejectedDossierFactualUpdate[];
  latestValid: PriorThesis | null;
  updates: number;
  researchIncomplete?: ResearchIncompleteStatus | null;
  reason?:
    | "insufficient-support"
    | "publication-gate"
    | "already-delivered"
    | "no-new-v5"
    | "research-incomplete"
    | "forced-verification";
  now?: Date;
}

/** Honest, fixed-format morning when no new proposition earns publication. */
export function renderNoThesisDoorbell({
  desk,
  snapshots,
  factualUpdates = [],
  latestValid,
  updates,
  researchIncomplete,
  reason = "no-new-v5",
  now = new Date(),
}: NoThesisRenderInput): DoorbellResult {
  const { dateLabel, timeLabel } = dateAndTime(desk, now);
  const compliance = footer(desk);
  const ranked = [...snapshots].sort((a, b) => Math.abs(change(b)) - Math.abs(change(a))).slice(0, 3);
  const rejectedChanges = [...factualUpdates]
    .sort((left, right) => right.generatedAt - left.generatedAt)
    .slice(0, 3)
    .map((update) => update.whatChanged);
  const latestRejectedObservation = [...factualUpdates]
    .sort((left, right) => right.generatedAt - left.generatedAt)
    .find((update) => update.thesisObservation)?.thesisObservation ?? null;
  const tapeChanges = ranked.map((snapshot) => {
    const afterHours = snapshot.afterHoursChangePercent == null
      ? ""
      : `; ${pct(snapshot.afterHoursChangePercent)} after hours`;
    const close = snapshot.price == null ? "" : ` closed at $${snapshot.price.toFixed(2)},`;
    return `${snapshot.symbol}${close} ${pct(snapshot.dayChangePercent)} on the day${afterHours}.`;
  });
  const factualChanges = rejectedChanges.length > 0
    ? [...rejectedChanges, ...tapeChanges].slice(0, 4)
    : tapeChanges.length > 0
      ? tapeChanges
      : ["No verified trading snapshot was available when the Morning Note was prepared."];
  const ticker = latestValid?.ticker ?? desk.tickers[0];
  const researchUrl = `${SITE}/stock/${ticker.toLowerCase()}?utm_source=morning_note&utm_medium=email&utm_campaign=no_new_thesis`;
  // A sub-3/5 proposition can contribute a cited factual update, but its
  // chair-authored priorUpdate is not a council-admitted lifecycle ruling.
  const lifecycle = latestValid?.lifecycle ?? "unknown";
  const lifecycleLabel = lifecycle === "unknown"
    ? "STATUS UNAVAILABLE"
    : lifecycle.toUpperCase();
  const latestLine = latestValid
    ? `${latestValid.ticker} · ${latestValid.date}${latestValid.votesSupport != null ? ` · ${latestValid.votesSupport}/${latestValid.votesTotal} SUPPORT` : ""}${latestValid.sessionsElapsed != null ? ` · ${latestValid.sessionsElapsed} SESSIONS ELAPSED` : ""}`
    : "NO PRIOR THESIS ON FILE";
  const latestText = latestValid?.thesis ?? "No earlier thesis is being carried as current.";
  const skeleton = (width: number) =>
    `<div style="height:11px;border-radius:5px;background:#DDD8CB;margin:0 0 7px;width:${width}%;"></div>`;
  const incomplete = normalizedIncompleteStatus(researchIncomplete);
  const completedStocks = Math.max(0, desk.tickers.length - (incomplete?.tickers.length ?? 0));
  const coverageLine = incomplete
    ? `<b style="color:${INK};">${completedStocks}/${desk.tickers.length} stocks</b> completed · <b style="color:${INK};">${updates} update${updates === 1 ? "" : "s"}</b>`
    : `Your <b style="color:${INK};">${desk.tickers.length} stock${desk.tickers.length === 1 ? "" : "s"}</b>, scanned overnight · <b style="color:${INK};">${updates} update${updates === 1 ? "" : "s"}</b>`;
  const fallback = {
    "insufficient-support": {
      title: "NO NEW THESIS CLEARED 3/5",
      explanation: "Fewer than three analysts supported the same conclusion, so no new signal is being published.",
    },
    "publication-gate": {
      title: "NO NEW THESIS CLEARED 3/5",
      explanation: "A possible signal did not pass the evidence checks, so no new signal is being published.",
    },
    "already-delivered": {
      title: "NO NEW THESIS CLEARED 3/5",
      explanation: "No new thesis has arrived since the previous Morning Note.",
    },
    "no-new-v5": {
      title: "NO NEW THESIS CLEARED 3/5",
      explanation: "No new thesis was ready for publication this morning.",
    },
    "research-incomplete": {
      title: `RESEARCH INCOMPLETE${incomplete ? ` · ${incomplete.tickers.join(" · ")}` : ""}`,
      explanation: incomplete
        ? researchIncompleteCopy(incomplete)
        : "The daily evidence-and-council review did not complete. The last valid thesis is prior research only; no current-day ruling was produced.",
    },
    "forced-verification": {
      title: "NO NEW THESIS CLEARED 3/5",
      explanation: "This forced release-check email exercises the no-thesis path. It is a delivery test, not a market conclusion.",
    },
  }[reason];
  const activeCarry = ["open", "strengthened", "weakened"].includes(lifecycle);
  const carryNotice = latestValid
    ? activeCarry
      ? latestRejectedObservation
        ? "Today's council did not admit a new directional state. The prior valid thesis remains on file as prior research, not a current-day ruling."
        : "This remains inside its measured 10–15-session window."
      : lifecycle === "expired"
        ? "Its 15-session window has ended; it is shown as history, not as a current signal."
        : lifecycle === "resolved"
          ? "A later v5 artifact marked it resolved; it is shown as history, not as a current signal."
          : "Its market-session state could not be verified, so it is not being carried as current."
    : "No earlier thesis is being carried as current.";
  const subject = reason === "research-incomplete"
    ? `🦊 AMM: research incomplete${incomplete ? ` for ${incomplete.tickers.join(", ")}` : ""}; prior thesis carried forward`
    : latestRejectedObservation
      ? "🦊 AMM: no new directional read; prior thesis remains on file"
      : "🦊 AMM: no new thesis cleared 3/5";
  const preheader = reason === "research-incomplete"
    ? "A daily review did not finish; prior research is carried forward without a current-day ruling."
    : "No new signal met the publication bar this morning.";
  const html = `
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
<div style="background:#EDE9DF;padding:26px 12px;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:${INK};">
  <div style="max-width:560px;margin:0 auto;background:${PAPER};border:2px solid ${INK};border-radius:14px;overflow:hidden;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};"><tr>
      <td style="padding:12px 20px;"><img src="${SITE}/fox-note.png" width="26" alt="" style="display:inline-block;vertical-align:middle;margin-right:9px;"><span style="font-weight:800;font-size:19px;color:${PAPER};vertical-align:middle;">AMM</span><img src="${SITE}/tri-on.png" width="10" height="9" alt="▲" style="display:inline-block;vertical-align:baseline;margin-left:2px;"></td>
      <td align="right" style="padding:12px 20px;font-family:monospace;font-size:10px;letter-spacing:2px;color:${LIME};">${dateLabel} · ${timeLabel}</td>
    </tr></table>
    <p style="margin:14px 20px 0;font-family:monospace;font-size:11.5px;color:${DIM};">${coverageLine}</p>
    <div style="margin:16px;background:${CARD};border:2px solid ${INK};border-radius:12px;padding:18px;">
      <div style="background:${INK};border-radius:8px;padding:11px 12px;font-family:monospace;font-size:11px;letter-spacing:1.5px;font-weight:700;color:${LIME};">${fallback.title}</div>
      <div style="margin-top:15px;"><p style="margin:0;font-family:monospace;font-size:10px;letter-spacing:2px;color:${ORANGE};font-weight:700;">WHAT CHANGED</p>${factualChanges.map((line) => `<p style="margin:7px 0 0;font-size:14px;line-height:1.5;color:${INK};">${citedTextHtml(line)}</p>`).join("")}</div>
      <div style="margin:15px 0 0;border-left:4px solid ${ORANGE};background:#FBF8F1;border-radius:0 8px 8px 0;padding:13px 14px;">
        <p style="margin:0;font-family:monospace;font-size:9.5px;letter-spacing:1.7px;color:${INK};font-weight:700;">LATEST VALID THESIS · ${lifecycleLabel}</p>
        <p style="margin:5px 0 0;font-family:monospace;font-size:9.5px;color:${FAINT};">${esc(latestLine)}</p>
        <p style="margin:8px 0 0;font-size:14px;line-height:1.5;color:${INK};">${citedTextHtml(latestText)}</p>
        <p style="margin:8px 0 0;font-size:12.5px;line-height:1.45;color:${DIM};">${esc(carryNotice)}</p>
      </div>
      <div style="margin-top:15px;"><p style="margin:0;font-family:monospace;font-size:10px;letter-spacing:2px;color:${ORANGE};font-weight:700;">PUBLICATION STATUS</p><p style="margin:6px 0 0;font-size:13.5px;line-height:1.5;color:${INK};">${esc(fallback.explanation)}</p></div>
      <div style="margin-top:15px;border-top:1px solid #D8D2C6;padding-top:12px;">${skeleton(92)}${skeleton(78)}${skeleton(61)}<a href="${researchUrl}" style="display:block;text-align:center;background:${ORANGE};color:${PAPER};font-weight:800;font-size:17px;text-decoration:none;padding:16px 20px;border-radius:11px;border:2px solid ${INK};margin-top:12px;">View Latest Research in AMM Desk&nbsp; →</a></div>
    </div>
    ${compliance.html}
  </div>
</div>`;
  const text = [
    `AMM MORNING NOTE · ${dateLabel}`,
    fallback.title,
    incomplete
      ? `${completedStocks}/${desk.tickers.length} stocks completed · ${updates} updates`
      : `${desk.tickers.length} stocks scanned overnight · ${updates} updates`,
    "",
    "WHAT CHANGED",
    ...factualChanges.map(traceablePlain),
    "",
    `LATEST VALID THESIS · ${lifecycleLabel} · ${latestLine}`,
    traceablePlain(latestText),
    carryNotice,
    "",
    `PUBLICATION STATUS: ${fallback.explanation}`,
    `Latest research in AMM Desk: ${researchUrl}`,
    "",
    compliance.text,
  ].join("\n");
  const dateKey = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const result: DoorbellResult = {
    subject,
    html,
    text,
    headers: compliance.headers,
    artifactKey: `no-thesis:${desk.id}:${dateKey}`,
    publishedDossierKey: null,
  };
  assertRenderIsSafe(result);
  return result;
}

export async function composeDoorbell(
  desk: Desk,
  options: {
    forceOutcome?: "no-thesis";
    repeatPublished?: boolean;
    /** One market-wide research date captured by the global pre-open run. */
    trackingDate?: string;
    /** Shared capture time so every desk renders the same market-wide edition. */
    now?: Date;
    /** Market-wide tape capture, loaded once before any desk email is composed. */
    snapshots?: readonly TickerSnapshot[];
  } = {},
): Promise<DoorbellResult | null> {
  if (desk.tickers.length === 0) return null;
  const now = options.now ?? new Date();
  let fresh = overnightDates(now);
  let completedTickers: Set<string> | null = null;
  let researchIncomplete: ResearchIncompleteStatus | null = null;
  if (options.trackingDate) {
    const trackingDate = /^20\d{2}-\d{2}-\d{2}$/.test(options.trackingDate)
      ? options.trackingDate
      : expectedDailyTrackingDate(now);
    const coverage = await getDailyThesisCoverage(desk.tickers, trackingDate);
    completedTickers = new Set(coverage.checks.map((check) => check.ticker));
    researchIncomplete = normalizedIncompleteStatus({
      trackingDate,
      tickers: coverage.missingTickers,
    });
    fresh = new Set([trackingDate]);
  }
  const researchTickers = completedTickers
    ? desk.tickers.filter((ticker) => completedTickers!.has(ticker.trim().toUpperCase()))
    : desk.tickers;
  const [snapshots, dossierList, rejectedUpdateList] = await Promise.all([
    options.snapshots
      ? Promise.resolve(options.snapshots.filter((snapshot) =>
          desk.tickers.includes(snapshot.symbol.toUpperCase())))
      : Promise.all(desk.tickers.map((ticker) => getTickerSnapshot(ticker).catch(() => null))).then((results) =>
          results.filter((snapshot): snapshot is TickerSnapshot => snapshot !== null),
        ),
    // One damaged/unavailable company record must not suppress the entire
    // morning ritual. The remaining tickers can still produce a thesis; if
    // none can, the fixed no-thesis note remains deliverable.
    Promise.all(desk.tickers.map((ticker) => getCachedDossier(ticker).catch(() => null))),
    Promise.all(researchTickers.flatMap((ticker) => [...fresh].map((date) =>
      getRejectedDossierFactualUpdate(ticker, date).catch(() => null)
    ))),
  ]);
  const rejectedUpdates = rejectedUpdateList.filter(
    (update): update is RejectedDossierFactualUpdate => update !== null,
  );
  const currentDossiers = dossierList.filter((dossier): dossier is Dossier => dossier !== null);
  const historyCache = new Map<string, Promise<Dossier[]>>();
  const historyForTicker = (ticker: string): Promise<Dossier[]> => {
    const symbol = ticker.toUpperCase();
    const cached = historyCache.get(symbol);
    if (cached) return cached;
    const requested = getDossierHistory<Dossier>(symbol, 130).catch(() => [] as Dossier[]);
    historyCache.set(symbol, requested);
    return requested;
  };
  const snapshotByTicker = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  const freshStored = currentDossiers.filter((dossier) =>
    fresh.has(dossier.date) &&
    (!completedTickers || completedTickers.has(dossier.ticker.trim().toUpperCase()))
  );
  const freshV5 = freshStored.filter((dossier) => dossierReleaseValidationError(dossier) === null);
  const cleared = freshV5
    .map((dossier) => ({ dossier, hook: structuredHook(dossier), key: dossierArtifactKey(dossier) }))
    .filter(
      (item): item is { dossier: Dossier; hook: NormalizedHook; key: string } =>
        Boolean(item.hook && item.hook.votesSupport >= 3 && fresh.has(item.dossier.date)),
    );
  const repeatedArtifact = !options.repeatPublished &&
    cleared.some((item) => item.key === desk.lastNoteArtifactKey);
  const candidates = cleared
    .filter((item) => options.repeatPublished || item.key !== desk.lastNoteArtifactKey)
    .sort((left, right) => compareHeroRank(
      {
        date: left.dossier.date,
        votesSupport: left.hook.votesSupport,
        votesOppose: left.hook.votesOppose,
        editorialStrength: left.hook.editorialStrength,
        absoluteMove: Math.abs(change(snapshotByTicker.get(left.dossier.ticker) ?? ({} as TickerSnapshot))),
      },
      {
        date: right.dossier.date,
        votesSupport: right.hook.votesSupport,
        votesOppose: right.hook.votesOppose,
        editorialStrength: right.hook.editorialStrength,
        absoluteMove: Math.abs(change(snapshotByTicker.get(right.dossier.ticker) ?? ({} as TickerSnapshot))),
      },
    ));

  const rejectedKeys = new Set<string>();
  let rejectedByPublicationGate = freshStored.length > freshV5.length ||
    freshV5.some((dossier) => structuredHook(dossier) === null);
  for (const candidate of options.forceOutcome === "no-thesis" ? [] : candidates) {
    const hero = candidate.dossier;
    const history = await historyForTicker(hero.ticker);
    const priorSignal = previousPublishedSignal(hero, history);
    const thesisMovement = await movementForDoorbell(
      hero,
      history,
      snapshotByTicker.get(hero.ticker)?.nextEvent ?? null,
    );
    const others = snapshots
      .filter((snapshot) => snapshot.symbol !== hero.ticker && Math.abs(change(snapshot)) >= 0.5)
      .sort((left, right) => Math.abs(change(right)) - Math.abs(change(left)))
      .slice(0, 3)
      .map((snapshot) => snapshot.symbol);
    try {
      return renderDoorbell({
        desk,
        hero,
        heroSnapshot: snapshotByTicker.get(hero.ticker),
        priorSignal,
        thesisMovement,
        updates: freshV5.length,
        others,
        researchIncomplete,
        now,
      });
    } catch {
      rejectedByPublicationGate = true;
      rejectedKeys.add(candidate.key);
      // A public-copy violation disqualifies this candidate. Try the next
      // cleared thesis, then fall back to the explicit no-new-thesis note.
    }
  }

  // A rejected or quiet run must not overwrite yesterday's still-valid read.
  const histories = await Promise.all(
    desk.tickers.map(historyForTicker),
  );
  const allDossiers = [...currentDossiers, ...histories.flat()]
    .filter((dossier) => dossierReleaseValidationError(dossier) === null);
  const unresolvedPrior = allDossiers
    .filter((dossier) => !rejectedKeys.has(dossierArtifactKey(dossier)))
    .map(priorThesis)
    .filter((item): item is PriorThesis => item !== null)
    .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
  const prior = unresolvedPrior
    ? await resolvePriorLifecycle(unresolvedPrior, allDossiers)
    : null;
  const hasInsufficientSupport = rejectedUpdates.some((update) => update.reason === "minority-support") ||
    freshV5.some((dossier) => {
      const hook = structuredHook(dossier);
      return hook !== null && hook.votesSupport < 3;
    });
  const reason: NonNullable<NoThesisRenderInput["reason"]> =
    options.forceOutcome === "no-thesis"
      ? "forced-verification"
      : researchIncomplete
        ? "research-incomplete"
      : rejectedByPublicationGate
        ? "publication-gate"
        : repeatedArtifact
          ? "already-delivered"
          : hasInsufficientSupport
            ? "insufficient-support"
            : "no-new-v5";

  return renderNoThesisDoorbell({
    desk,
    snapshots,
    factualUpdates: rejectedUpdates,
    latestValid: prior,
    updates: freshV5.length + rejectedUpdates.length,
    reason,
    researchIncomplete,
    now,
  });
}
