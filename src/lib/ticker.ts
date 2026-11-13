export interface TickerSnapshot {
  symbol: string;
  name: string;
  exchange: string;
  price: number | null;
  previousClose: number | null;
  dayChangePercent: number | null;
  afterHoursPrice: number | null;
  afterHoursChangePercent: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  volume: number | null;
  marketState: string;
  nextEvent: string | null;
}

// Confirmed report dates for the launch window; everything else shows as monitored.
const NEXT_EVENTS: Record<string, string> = {
  GOOGL: "Q2 2026 earnings — Jul 22 after close",
  GOOG: "Q2 2026 earnings — Jul 22 after close",
  MSFT: "Q4 FY26 earnings — Jul 29 after close",
  AAPL: "Q3 2026 earnings — Jul 30 after close",
  TSLA: "Q2 2026 earnings — Jul 22 after close",
  META: "Q2 2026 earnings — Jul 29 after close",
  AMZN: "Q2 2026 earnings — Jul 30 after close",
  NVDA: "Q2 FY27 earnings — Aug 26 after close",
  AMD: "Q2 2026 earnings — early Aug",
  PLTR: "Q2 2026 earnings — early Aug",
};

interface ChartMeta {
  symbol?: string;
  longName?: string;
  shortName?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;
  regularMarketVolume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  currentTradingPeriod?: {
    post?: { start: number; end: number };
    pre?: { start: number; end: number };
  };
}

export interface DailyBar {
  /** ET calendar date, YYYY-MM-DD. */
  date: string;
  close: number | null;
  /** Split/dividend-adjusted close when the provider supplies it. */
  adjustedClose?: number | null;
  changePct: number | null;
  volume: number | null;
  source?: "tiingo-eod" | "yahoo-chart";
}

interface TiingoDailyRow {
  date?: string;
  close?: number | null;
  adjClose?: number | null;
  volume?: number | null;
  adjVolume?: number | null;
}

interface TiingoDailyMetadataPayload {
  ticker?: string;
  startDate?: string | null;
  endDate?: string | null;
}

export interface TiingoDailyMetadata {
  ticker: string;
  startDate: string;
  endDate: string;
}

export function validIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function marketHistoryStart(years: number): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

/** Official Tiingo coverage bounds used to distinguish IPO history from a partial response. */
export async function getTiingoDailyMetadata(symbol: string): Promise<TiingoDailyMetadata | null> {
  const token = process.env.TIINGO_API_TOKEN;
  const sym = symbol.toUpperCase().trim().replace(/\./g, "-");
  if (!token || !/^[A-Z0-9.\-]{1,12}$/.test(sym)) return null;
  try {
    const res = await fetch(`https://api.tiingo.com/tiingo/daily/${sym}`, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "AfterMarketMovers/2.0",
      },
      next: { revalidate: 20 * 3600 },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const row = (await res.json()) as TiingoDailyMetadataPayload;
    const startDate = String(row?.startDate ?? "").slice(0, 10);
    const endDate = String(row?.endDate ?? "").slice(0, 10);
    if (!validIsoCalendarDate(startDate) || !validIsoCalendarDate(endDate) || startDate > endDate) return null;
    return { ticker: String(row.ticker ?? sym).toUpperCase(), startDate, endDate };
  } catch {
    return null;
  }
}

/** Commercial adjusted EOD history used only by private signal research. */
export async function getTiingoDailyHistory(
  symbol: string,
  options: { years?: number; startDate?: string } = {},
): Promise<DailyBar[]> {
  const token = process.env.TIINGO_API_TOKEN;
  const sym = symbol.toUpperCase().trim().replace(/\./g, "-");
  if (!token || !/^[A-Z0-9.\-]{1,12}$/.test(sym)) return [];
  const startDate = options.startDate ?? marketHistoryStart(options.years ?? 10);
  if (!validIsoCalendarDate(startDate)) return [];
  try {
    const url = new URL(`https://api.tiingo.com/tiingo/daily/${sym}/prices`);
    url.searchParams.set("startDate", startDate);
    const res = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "AfterMarketMovers/2.0",
      },
      next: { revalidate: 20 * 3600 },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as unknown;
    if (!Array.isArray(payload)) return [];
    const rows = payload as TiingoDailyRow[];
    const parsed: Array<{
      date: string;
      close: number | null;
      adjustedClose: number;
      volume: number | null;
    }> = [];
    for (const row of rows) {
      const date = String(row.date ?? "").slice(0, 10);
      if (!validIsoCalendarDate(date)) return [];
      const close = Number.isFinite(row.close) ? Number(row.close) : null;
      // A raw close is not a safe substitute in a long-horizon calibration:
      // one split would create a fabricated return. Reject the complete
      // vendor generation and retain the last atomic adjusted generation.
      if (!Number.isFinite(row.adjClose) || Number(row.adjClose) <= 0) return [];
      parsed.push({
        date,
        close,
        adjustedClose: Number(row.adjClose),
        volume: Number.isFinite(row.adjVolume)
          ? Number(row.adjVolume)
          : Number.isFinite(row.volume)
            ? Number(row.volume)
            : null,
      });
    }
    parsed.sort((left, right) => left.date.localeCompare(right.date));
    if (parsed.some((row, index) => index > 0 && row.date === parsed[index - 1].date)) return [];
    return parsed.map((row, index) => {
      const previous = index > 0 ? parsed[index - 1].adjustedClose : null;
      return {
        ...row,
        changePct: previous == null
          ? null
          : ((row.adjustedClose - previous) / previous) * 100,
        source: "tiingo-eod" as const,
      };
    });
  } catch {
    return [];
  }
}

/** Daily closes/volume for timeline annotations ("$198.40 · −0.6% · 96M vol"). */
export async function getDailyHistory(
  symbol: string,
  range = "3mo",
  options: { requireCompleteAdjusted?: boolean } = {},
): Promise<DailyBar[]> {
  const sym = symbol.toUpperCase().trim();
  if (!/^[A-Z.\-]{1,6}$/.test(sym)) return [];
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=1d`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AfterMarketMovers/1.0)" },
        next: { revalidate: 3600 },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return [];
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const ts: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const adjusted: (number | null)[] = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const closes: (number | null)[] = quote.close ?? [];
    const volumes: (number | null)[] = quote.volume ?? [];
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const bars: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = closes[i] ?? null;
      if (options.requireCompleteAdjusted &&
          (typeof adjusted[i] !== "number" || !Number.isFinite(adjusted[i]) || Number(adjusted[i]) <= 0)) {
        return [];
      }
      const adjustedClose = adjusted[i] ?? close;
      const prev = i > 0 ? (adjusted[i - 1] ?? closes[i - 1] ?? null) : null;
      bars.push({
        date: fmt.format(new Date(ts[i] * 1000)),
        close,
        adjustedClose,
        changePct:
          adjustedClose != null && prev != null && prev !== 0
            ? ((adjustedClose - prev) / prev) * 100
            : null,
        volume: volumes[i] ?? null,
        source: "yahoo-chart",
      });
    }
    return bars;
  } catch {
    return [];
  }
}

export async function getTickerSnapshot(
  symbol: string
): Promise<TickerSnapshot | null> {
  const sym = symbol.toUpperCase().trim();
  if (!/^[A-Z.\-]{1,6}$/.test(sym)) return null;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=5m&includePrePost=true`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AfterMarketMovers/1.0)" },
        next: { revalidate: 300 },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result?.meta?.regularMarketPrice) return null;
    const meta: ChartMeta = result.meta;

    // Post-market price = last trade after the regular session close.
    let afterHoursPrice: number | null = null;
    const regTime = meta.regularMarketTime ?? 0;
    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] =
      result.indicators?.quote?.[0]?.close ?? [];
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (timestamps[i] > regTime && closes[i] != null) {
        afterHoursPrice = closes[i];
        break;
      }
    }
    const price = meta.regularMarketPrice ?? null;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const now = Math.floor(Date.now() / 1000);
    const post = meta.currentTradingPeriod?.post;
    const inOrAfterPost = post ? now >= post.start : false;

    return {
      symbol: sym,
      name: meta.longName ?? meta.shortName ?? sym,
      exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
      price,
      previousClose: prev,
      dayChangePercent:
        price != null && prev != null && prev !== 0
          ? ((price - prev) / prev) * 100
          : null,
      afterHoursPrice,
      afterHoursChangePercent:
        afterHoursPrice != null && price != null && price !== 0 && inOrAfterPost
          ? ((afterHoursPrice - price) / price) * 100
          : null,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      marketState: inOrAfterPost && now <= (post?.end ?? 0) ? "POST" : "CLOSED",
      nextEvent: NEXT_EVENTS[sym] ?? null,
    };
  } catch {
    return null;
  }
}
