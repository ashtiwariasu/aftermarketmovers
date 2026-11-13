/**
 * SEC EDGAR — official filings + XBRL fundamentals for every US-listed company.
 * Free, keyless; requires a User-Agent with contact info and <10 req/s.
 */

// SEC asks every client to name a contact. Set CONTACT_USER_AGENT to yours, e.g. "MyDesk/1.0 (you@example.com)".
const UA = process.env.CONTACT_USER_AGENT || "AMM-self-hosted (set CONTACT_USER_AGENT)";

interface EdgarResult<T> {
  data: T | null;
  error?: string;
}

let edgarQueue: Promise<void> = Promise.resolve();
let lastEdgarRequestAt = 0;

async function waitForEdgarSlot(): Promise<void> {
  const slot = edgarQueue.catch(() => {}).then(async () => {
    // SEC asks automated clients to remain below 10 requests/second.
    const waitMs = Math.max(0, lastEdgarRequestAt + 125 - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastEdgarRequestAt = Date.now();
  });
  edgarQueue = slot;
  await slot;
}

async function edgarResult<T>(url: string, revalidate = 3600): Promise<EdgarResult<T>> {
  let lastError = "SEC request failed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await waitForEdgarSlot();
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        next: { revalidate },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { data: (await res.json()) as T };
      lastError = `SEC HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      if (attempt < 3) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryAfter > 0 ? Math.min(30_000, retryAfter * 1_000) : attempt * 750),
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  return { data: null, error: lastError.slice(0, 240) };
}

async function edgar<T>(url: string, revalidate = 3600): Promise<T | null> {
  return (await edgarResult<T>(url, revalidate)).data;
}

async function cikResult(symbol: string): Promise<{ cik: string | null; error?: string }> {
  const sym = symbol.toUpperCase().trim();
  const result = await edgarResult<Record<string, { cik_str: number; ticker: string }>>(
    "https://www.sec.gov/files/company_tickers.json",
    86_400,
  );
  if (!result.data) return { cik: null, error: result.error ?? "SEC ticker map unavailable" };
  for (const value of Object.values(result.data)) {
    if (value.ticker === sym) return { cik: String(value.cik_str).padStart(10, "0") };
  }
  return { cik: null, error: `${sym} is absent from the SEC ticker map` };
}

/** Ticker → 10-digit CIK, from the SEC's official map (all listed companies). */
export async function cikFor(symbol: string): Promise<string | null> {
  return (await cikResult(symbol)).cik;
}

export interface CompanyHit {
  symbol: string;
  name: string;
}

/**
 * Search every US-listed company (SEC's official map, ~9.3k names) by ticker
 * or company name. Rank: exact ticker → ticker prefix → name starts → name
 * contains. Powers the stock-picker typeahead.
 */
export async function searchCompanies(q: string, limit = 8): Promise<CompanyHit[]> {
  const query = q.toUpperCase().trim();
  if (!query || query.length > 40) return [];
  const map = await edgar<Record<string, { cik_str: number; ticker: string; title: string }>>(
    "https://www.sec.gov/files/company_tickers.json",
    86_400
  );
  if (!map) return [];
  const buckets: CompanyHit[][] = [[], [], [], []];
  for (const v of Object.values(map)) {
    const name = v.title ?? "";
    const upperName = name.toUpperCase();
    let rank = -1;
    if (v.ticker === query) rank = 0;
    else if (v.ticker.startsWith(query)) rank = 1;
    else if (upperName.startsWith(query)) rank = 2;
    else if (query.length >= 3 && upperName.includes(query)) rank = 3;
    if (rank >= 0 && buckets[rank].length < limit) {
      buckets[rank].push({ symbol: v.ticker, name });
    }
  }
  buckets[1].sort((a, b) => a.symbol.length - b.symbol.length);
  return buckets.flat().slice(0, limit);
}

export interface SecFiling {
  form: string; // "10-Q", "8-K", "4", …
  formLabel: string; // "10-Q", "8-K", "Form 4"
  date: string; // YYYY-MM-DD
  filedAt?: number; // exact SEC acceptance time when available
  url: string; // direct document link
  title: string; // report-date / items hint
}

const MAJOR_FORMS = new Set(["10-K", "10-Q", "8-K", "4", "DEF 14A", "SC 13D", "SC 13G", "S-1"]);

function formLabel(form: string): string {
  return form === "4" ? "Form 4" : form;
}

interface Submissions {
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  entityType?: string;
  category?: string;
  stateOfIncorporation?: string;
  stateOfIncorporationDescription?: string;
  sic?: string;
  filings?: {
    recent?: {
      form: string[];
      filingDate: string[];
      acceptanceDateTime?: string[];
      accessionNumber: string[];
      primaryDocument: string[];
      items?: string[];
      reportDate?: string[];
    };
  };
}

export interface SecCompanyIdentity {
  symbol: string;
  cik: string;
  name: string;
  exchange: string;
  entityType: string;
  category: string;
  stateOfIncorporation: string;
  stateOfIncorporationDescription: string;
  sic: string;
  recentForms: string[];
}

export interface SecCompanyIdentityResult {
  identity: SecCompanyIdentity | null;
  ok: boolean;
  error?: string;
}

/**
 * Resolve a ticker to the exact SEC issuer and filing regime. A ticker-shaped
 * string or a live quote is not enough: this identity is the admission anchor
 * used to keep ADRs, funds, stale symbols and ticker reuse out of the research
 * fleet when our evidence adapters cannot fully support them.
 */
export async function getSecCompanyIdentityResult(symbol: string): Promise<SecCompanyIdentityResult> {
  const sym = symbol.toUpperCase().trim();
  const cikLookup = await cikResult(sym);
  if (!cikLookup.cik) {
    const absent = cikLookup.error?.includes("is absent from the SEC ticker map") ?? false;
    return { identity: null, ok: absent, ...(cikLookup.error ? { error: cikLookup.error } : {}) };
  }
  const submission = await edgarResult<Submissions>(
    `https://data.sec.gov/submissions/CIK${cikLookup.cik}.json`,
    21_600,
  );
  if (!submission.data) {
    return { identity: null, ok: false, error: submission.error ?? "SEC issuer record unavailable" };
  }
  const tickerIndex = (submission.data.tickers ?? []).findIndex((ticker) => ticker === sym);
  if (tickerIndex < 0) {
    return { identity: null, ok: true, error: `${sym} is not attached to the resolved SEC issuer` };
  }
  return {
    ok: true,
    identity: {
      symbol: sym,
      cik: cikLookup.cik,
      name: submission.data.name ?? sym,
      exchange: submission.data.exchanges?.[tickerIndex] ?? "",
      entityType: submission.data.entityType ?? "",
      category: submission.data.category ?? "",
      stateOfIncorporation: submission.data.stateOfIncorporation ?? "",
      stateOfIncorporationDescription: submission.data.stateOfIncorporationDescription ?? "",
      sic: submission.data.sic ?? "",
      recentForms: [...new Set(submission.data.filings?.recent?.form ?? [])],
    },
  };
}

export interface SecFilingsResult {
  filings: SecFiling[];
  ok: boolean;
  error?: string;
}

export function retainLatestPeriodicFiling(
  filings: readonly SecFiling[],
  count: number,
): SecFiling[] {
  const selected = filings.slice(0, Math.max(0, count));
  const latestPeriodic = filings.find((item) => item.form === "10-Q" || item.form === "10-K");
  if (latestPeriodic && !selected.some((item) => item.url === latestPeriodic.url)) {
    selected.push(latestPeriodic);
  }
  return selected;
}

/**
 * Recent major filings plus the latest filed-results anchor and an explicit
 * transport status. Insider-heavy issuers can file dozens of Form 4s between
 * quarters, so the latest 10-Q/10-K must not disappear behind a recent limit.
 */
export async function getFilingsResult(symbol: string, count = 8): Promise<SecFilingsResult> {
  const cikLookup = await cikResult(symbol);
  if (!cikLookup.cik) return { filings: [], ok: false, error: cikLookup.error };
  const cik = cikLookup.cik;
  const submission = await edgarResult<Submissions>(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
    1800,
  );
  if (!submission.data) return { filings: [], ok: false, error: submission.error };
  const r = submission.data.filings?.recent;
  if (!r?.form) return { filings: [], ok: true };
  const cikNum = String(parseInt(cik, 10));
  const all: SecFiling[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (!MAJOR_FORMS.has(form)) continue;
    const accession = (r.accessionNumber[i] ?? "").replace(/-/g, "");
    const doc = r.primaryDocument[i] ?? "";
    if (!accession || !doc) continue;
    all.push({
      form,
      formLabel: formLabel(form),
      date: r.filingDate[i],
      ...(r.acceptanceDateTime?.[i] && Number.isFinite(Date.parse(r.acceptanceDateTime[i]))
        ? { filedAt: Date.parse(r.acceptanceDateTime[i]) }
        : {}),
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}/${doc}`,
      title:
        form === "8-K"
          ? (r.items?.[i] ? `items ${r.items[i]}` : "material event")
          : form === "4"
            ? "insider transaction"
            : r.reportDate?.[i]
              ? `period ${r.reportDate[i]}`
              : "filing",
    });
  }
  const filings = retainLatestPeriodicFiling(all, count);
  return { filings, ok: true };
}

/** Recent major filings, newest first. Graceful empty fallback for page reads. */
export async function getFilings(symbol: string, count = 8): Promise<SecFiling[]> {
  return (await getFilingsResult(symbol, count)).filings;
}

// ---- XBRL fundamentals ----

interface FactRow {
  end: string;
  start?: string;
  val: number;
  form?: string;
  fp?: string;
  fy?: number;
  filed?: string;
}

export interface CompanyFacts {
  facts?: { "us-gaap"?: Record<string, { units: Record<string, FactRow[]> }> };
}

function quarterly(rows: FactRow[]): FactRow[] {
  // Quarterly durations only (~60–100 days), deduped by period end, newest last.
  const q = rows.filter((x) => {
    if (!x.start || !x.end) return false;
    const days = (Date.parse(x.end) - Date.parse(x.start)) / 86_400_000;
    return days > 60 && days < 100;
  });
  const byEnd = new Map<string, FactRow>();
  const labelScore = (row: FactRow): number => {
    const endYear = Number(row.end.slice(0, 4));
    return (row.fy === endYear ? 2 : 0) + (/^Q[1-4]$/.test(row.fp ?? "") ? 1 : 0);
  };
  for (const row of q) {
    const existing = byEnd.get(row.end);
    if (!existing || labelScore(row) > labelScore(existing) ||
        (labelScore(row) === labelScore(existing) && String(row.filed ?? "") > String(existing.filed ?? ""))) {
      byEnd.set(row.end, row);
    }
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

function pick(
  gaap: Record<string, { units: Record<string, FactRow[]> }>,
  tags: string[],
  unit: string
): FactRow[] {
  // Companies migrate between equivalent tags over time (e.g. Revenues →
  // RevenueFromContractWithCustomer…). Merge their histories, then reconcile
  // duplicate period ends. Choosing only the newest tag silently discarded the
  // original filing context for older quarters and could inherit a comparative
  // row carrying the current filing's fiscal-year label.
  const merged: FactRow[] = [];
  for (const tag of tags) {
    const rows = gaap[tag]?.units?.[unit];
    if (!rows || rows.length === 0) continue;
    merged.push(...rows);
  }
  return quarterly(merged);
}

export interface Fundamentals {
  /** Refreshes stored snapshots when the filed-metric bridge expands. */
  schemaVersion: number;
  asOf: string; // period end
  fiscal: string; // "Q1 FY2027"
  revenue: number | null;
  revenueYoY: number | null;
  netIncome: number | null;
  netIncomeYoY: number | null;
  eps: number | null;
  epsYoY: number | null;
  quarters: Array<{ fiscal: string; end: string; revenue: number | null }>;
  /** Optional richer filed bridge. Old stored snapshots remain readable. */
  operatingIncome?: FiledMetric | null;
  operatingCashFlow?: FiledMetric | null;
  capitalExpenditures?: FiledMetric | null;
  securitiesGainLoss?: FiledMetric | null;
  incomeTaxExpense?: FiledMetric | null;
  cashAndShortTermInvestments?: FiledMetric | null;
  totalAssets?: FiledMetric | null;
  currentDebt?: FiledMetric | null;
  longTermDebt?: FiledMetric | null;
}

export const FUNDAMENTALS_SCHEMA_VERSION = 2;

export interface FiledMetric {
  value: number;
  start: string | null;
  end: string;
  period: "quarter" | "year-to-date" | "instant";
}

function durationDays(row: FactRow): number | null {
  if (!row.start) return null;
  const days = (Date.parse(row.end) - Date.parse(row.start)) / 86_400_000;
  return Number.isFinite(days) ? days : null;
}

function durationMetric(
  gaap: Record<string, { units: Record<string, FactRow[]> }>,
  tags: string[],
  unit: string,
  end: string,
): FiledMetric | null {
  for (const tag of tags) {
    const candidates = (gaap[tag]?.units?.[unit] ?? [])
      .filter((row) => row.end === end && row.start && Number.isFinite(row.val))
      .map((row, index) => ({ row, index, days: durationDays(row)! }))
      .filter(({ days }) => days > 60 && days < 380)
      // Prefer the shortest complete reported period ending on the anchor date.
      // Cash-flow tags often expose only a six- or nine-month YTD context; income
      // statement tags normally expose the discrete quarter.
      .sort((left, right) => left.days - right.days || right.index - left.index);
    const picked = candidates[0]?.row;
    if (!picked) continue;
    const days = durationDays(picked)!;
    return {
      value: picked.val,
      start: picked.start ?? null,
      end: picked.end,
      period: days <= 100 ? "quarter" : "year-to-date",
    };
  }
  return null;
}

function instantMetric(
  gaap: Record<string, { units: Record<string, FactRow[]> }>,
  tags: string[],
  unit: string,
  end: string,
): FiledMetric | null {
  for (const tag of tags) {
    const rows = gaap[tag]?.units?.[unit] ?? [];
    const candidates = rows.filter((row) => row.end === end && !row.start && Number.isFinite(row.val));
    const picked = candidates.at(-1);
    if (picked) return { value: picked.val, start: null, end: picked.end, period: "instant" };
  }
  return null;
}

function yoy(rows: FactRow[], latest: FactRow): number | null {
  const prior = rows.find((r) => {
    const days = (Date.parse(latest.end) - Date.parse(r.end)) / 86_400_000;
    return days > 330 && days < 400;
  });
  if (!prior || prior.val === 0) return null;
  return ((latest.val - prior.val) / Math.abs(prior.val)) * 100;
}

export function fundamentalsFromCompanyFacts(facts: CompanyFacts | null): Fundamentals | null {
  const gaap = facts?.facts?.["us-gaap"];
  if (!gaap) return null;

  const rev = pick(
    gaap,
    ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"],
    "USD"
  );
  const ni = pick(gaap, ["NetIncomeLoss"], "USD");
  const eps = pick(gaap, ["EarningsPerShareDiluted", "EarningsPerShareBasic"], "USD/shares");
  const anchor = rev[rev.length - 1] ?? ni[ni.length - 1] ?? eps[eps.length - 1];
  if (!anchor) return null;

  const latest = (rows: FactRow[]) => rows.find((r) => r.end === anchor.end) ?? null;
  const lr = latest(rev);
  const ln = latest(ni);
  const le = latest(eps);
  return {
    schemaVersion: FUNDAMENTALS_SCHEMA_VERSION,
    asOf: anchor.end,
    fiscal: anchor.fp && anchor.fy ? `${anchor.fp} FY${anchor.fy}` : anchor.end,
    revenue: lr?.val ?? null,
    revenueYoY: lr ? yoy(rev, lr) : null,
    netIncome: ln?.val ?? null,
    netIncomeYoY: ln ? yoy(ni, ln) : null,
    eps: le?.val ?? null,
    epsYoY: le ? yoy(eps, le) : null,
    quarters: rev.slice(-5).map((r) => ({
      fiscal: r.fp && r.fy ? `${r.fp} FY${r.fy}` : r.end,
      end: r.end,
      revenue: r.val,
    })),
    operatingIncome: durationMetric(gaap, ["OperatingIncomeLoss"], "USD", anchor.end),
    operatingCashFlow: durationMetric(
      gaap,
      ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
      "USD",
      anchor.end,
    ),
    capitalExpenditures: durationMetric(
      gaap,
      ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForAdditionsToPropertyPlantAndEquipment"],
      "USD",
      anchor.end,
    ),
    securitiesGainLoss: durationMetric(
      gaap,
      ["EquitySecuritiesFvNiGainLoss", "DebtAndEquitySecuritiesGainLoss", "DebtSecuritiesGainLoss"],
      "USD",
      anchor.end,
    ),
    incomeTaxExpense: durationMetric(gaap, ["IncomeTaxExpenseBenefit"], "USD", anchor.end),
    cashAndShortTermInvestments: instantMetric(
      gaap,
      ["CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalentsAtCarryingValue"],
      "USD",
      anchor.end,
    ),
    totalAssets: instantMetric(gaap, ["Assets"], "USD", anchor.end),
    currentDebt: instantMetric(
      gaap,
      ["LongTermDebtAndCapitalLeaseObligationsCurrent", "LongTermDebtCurrent", "DebtCurrent"],
      "USD",
      anchor.end,
    ),
    longTermDebt: instantMetric(
      gaap,
      ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligationsNoncurrent"],
      "USD",
      anchor.end,
    ),
  };
}

export async function getFundamentals(symbol: string): Promise<Fundamentals | null> {
  const cik = await cikFor(symbol);
  if (!cik) return null;
  const facts = await edgar<CompanyFacts>(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    21_600
  );
  return fundamentalsFromCompanyFacts(facts);
}

function money(v: number | null): string {
  if (v == null) return "n/a";
  const fixed = (value: number, digits: number): string => {
    const factor = 10 ** digits;
    // Financial display uses conventional half-up rounding; native toFixed can
    // render 36.915 as 36.91 because of the binary floating representation.
    const rounded = Math.round((value + Math.sign(value || 1) * 1e-9) * factor) / factor;
    return rounded.toFixed(digits);
  };
  const a = Math.abs(v);
  if (a >= 1e9) return `$${fixed(v / 1e9, 2)}B`;
  if (a >= 1e6) return `$${fixed(v / 1e6, 1)}M`;
  return `$${v.toFixed(0)}`;
}

function yoyStr(v: number | null): string {
  return v == null ? "" : ` (${v > 0 ? "+" : ""}${v.toFixed(0)}% YoY)`;
}

function metricLine(label: string, metric: FiledMetric | null | undefined): string | null {
  if (!metric) return null;
  const period = metric.period === "instant"
    ? `at ${metric.end}`
    : `${metric.period === "quarter" ? "quarter" : "YTD"} ${metric.start} to ${metric.end}`;
  return `- ${label}: ${money(metric.value)} (${period})`;
}

/** The rolling Numbers note — rewritten whenever a newer quarter files. */
export function fundamentalsMd(symbol: string, f: Fundamentals): string {
  const operatingBridge = [
    metricLine("Operating income", f.operatingIncome),
    metricLine("Equity-securities gain/loss", f.securitiesGainLoss),
    metricLine("Income-tax expense/benefit", f.incomeTaxExpense),
    metricLine("Operating cash flow", f.operatingCashFlow),
    metricLine("Capital expenditures", f.capitalExpenditures),
  ].filter((line): line is string => Boolean(line));
  if (f.operatingCashFlow && f.capitalExpenditures &&
      f.operatingCashFlow.start === f.capitalExpenditures.start &&
      f.operatingCashFlow.end === f.capitalExpenditures.end) {
    operatingBridge.push(
      `- Operating cash flow less capital expenditures: ${money(
        f.operatingCashFlow.value - f.capitalExpenditures.value,
      )} (computed from the two filed lines above)`,
    );
  }
  const balanceSheet = [
    metricLine("Cash and short-term investments", f.cashAndShortTermInvestments),
    metricLine("Total assets", f.totalAssets),
    metricLine("Current debt", f.currentDebt),
    metricLine("Long-term debt", f.longTermDebt),
  ].filter((line): line is string => Boolean(line));
  if (f.currentDebt && f.longTermDebt && f.currentDebt.end === f.longTermDebt.end) {
    balanceSheet.push(
      `- Current plus long-term debt: ${money(f.currentDebt.value + f.longTermDebt.value)} ` +
      `(computed from the two filed lines above at ${f.currentDebt.end})`,
    );
  }

  return [
    `# Fundamentals — ${symbol} (filed numbers, SEC XBRL)`,
    ``,
    `Latest reported quarter: **${f.fiscal}**, period ended ${f.asOf}.`,
    ``,
    `- Revenue: ${money(f.revenue)}${yoyStr(f.revenueYoY)}`,
    `- Net income: ${money(f.netIncome)}${yoyStr(f.netIncomeYoY)}`,
    `- Diluted EPS: ${f.eps != null ? `$${f.eps.toFixed(2)}` : "n/a"}${yoyStr(f.epsYoY)}`,
    ``,
    ...(operatingBridge.length > 0 ? [``, `## Filed operating and cash bridge`, ...operatingBridge] : []),
    ...(balanceSheet.length > 0 ? [``, `## Filed balance sheet`, ...balanceSheet] : []),
    ``,
    `## Latest ${f.quarters.length} reported quarterly revenue observations`,
    `_These observations may be non-consecutive because annual filings do not always expose a discrete fourth quarter._`,
    ...f.quarters.map((q) => `- ${q.fiscal} (${q.end}): ${money(q.revenue)}`),
    ``,
    `_Straight from the company's XBRL filings via SEC EDGAR — no estimates, no model memory._`,
  ].join("\n");
}

/**
 * Fetch a filing document and strip it to readable text. Selection and prompt
 * budgeting happen later on complete filed sections; this boundary must never
 * silently cut an SEC document mid-section.
 */
export async function fetchFilingText(url: string): Promise<string> {
  if (!/^https:\/\/www\.sec\.gov\//.test(url)) return "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  } catch {
    return "";
  }
}
