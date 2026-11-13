const SCREENER_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved";

const SCREENER_IDS = ["day_gainers", "day_losers", "most_actives"] as const;

export interface YahooQuote {
  symbol: string;
  shortName?: string;
  longName?: string;
  quoteType?: string;
  fullExchangeName?: string;
  marketState?: string;
  hasPrePostMarketData?: boolean;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  marketCap?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  postMarketTime?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  preMarketTime?: number;
}

export interface Mover {
  symbol: string;
  name: string;
  exchange: string;
  price: number | null;
  extPrice: number | null;
  extChangePercent: number | null;
  dayChangePercent: number | null;
  volume: number | null;
  marketCap: number | null;
  extTime: number | null;
}

export interface MoversData {
  session: "PRE" | "REGULAR" | "POST" | "CLOSED";
  fetchedAt: number;
  afterHours: { gainers: Mover[]; losers: Mover[] };
  premarket: { gainers: Mover[]; losers: Mover[] };
  regular: { gainers: Mover[]; losers: Mover[] };
}

async function fetchScreener(scrId: string, count = 100): Promise<YahooQuote[]> {
  const url = `${SCREENER_URL}?formatted=false&count=${count}&scrIds=${scrId}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AfterMarketMovers/1.0)" },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.finance?.result?.[0]?.quotes ?? [];
  } catch {
    return [];
  }
}

function toMover(q: YahooQuote, ext: "post" | "pre"): Mover {
  const extPrice = ext === "post" ? q.postMarketPrice : q.preMarketPrice;
  const extChangePercent =
    ext === "post" ? q.postMarketChangePercent : q.preMarketChangePercent;
  const extTime = ext === "post" ? q.postMarketTime : q.preMarketTime;
  return {
    symbol: q.symbol,
    name: q.shortName ?? q.longName ?? q.symbol,
    exchange: q.fullExchangeName ?? "",
    price: q.regularMarketPrice ?? null,
    extPrice: extPrice ?? null,
    extChangePercent: extChangePercent ?? null,
    dayChangePercent: q.regularMarketChangePercent ?? null,
    volume: q.regularMarketVolume ?? null,
    marketCap: q.marketCap ?? null,
    extTime: extTime ?? null,
  };
}

function rank(
  quotes: YahooQuote[],
  ext: "post" | "pre",
  limit = 15
): { gainers: Mover[]; losers: Mover[] } {
  const withExt = quotes.filter((q) => {
    const pct = ext === "post" ? q.postMarketChangePercent : q.preMarketChangePercent;
    const price = q.regularMarketPrice ?? 0;
    const volume = q.regularMarketVolume ?? 0;
    return (
      typeof pct === "number" &&
      Math.abs(pct) >= 0.05 &&
      price >= 0.5 &&
      volume >= 50_000 &&
      (q.quoteType === undefined || q.quoteType === "EQUITY")
    );
  });
  const bySym = new Map(withExt.map((q) => [q.symbol, q]));
  const unique = [...bySym.values()];
  const sorted = [...unique].sort((a, b) => {
    const pa = (ext === "post" ? a.postMarketChangePercent : a.preMarketChangePercent) ?? 0;
    const pb = (ext === "post" ? b.postMarketChangePercent : b.preMarketChangePercent) ?? 0;
    return pb - pa;
  });
  return {
    gainers: sorted
      .filter((q) => ((ext === "post" ? q.postMarketChangePercent : q.preMarketChangePercent) ?? 0) > 0)
      .slice(0, limit)
      .map((q) => toMover(q, ext)),
    losers: sorted
      .filter((q) => ((ext === "post" ? q.postMarketChangePercent : q.preMarketChangePercent) ?? 0) < 0)
      .reverse()
      .slice(0, limit)
      .map((q) => toMover(q, ext)),
  };
}

function rankRegular(quotes: YahooQuote[], limit = 15): { gainers: Mover[]; losers: Mover[] } {
  const bySym = new Map(quotes.map((q) => [q.symbol, q]));
  const unique = [...bySym.values()].filter(
    (q) =>
      typeof q.regularMarketChangePercent === "number" &&
      (q.regularMarketPrice ?? 0) >= 0.5 &&
      (q.regularMarketVolume ?? 0) >= 50_000
  );
  const sorted = [...unique].sort(
    (a, b) => (b.regularMarketChangePercent ?? 0) - (a.regularMarketChangePercent ?? 0)
  );
  return {
    gainers: sorted
      .filter((q) => (q.regularMarketChangePercent ?? 0) > 0)
      .slice(0, limit)
      .map((q) => toMover(q, "post")),
    losers: sorted
      .filter((q) => (q.regularMarketChangePercent ?? 0) < 0)
      .reverse()
      .slice(0, limit)
      .map((q) => toMover(q, "post")),
  };
}

function detectSession(quotes: YahooQuote[]): MoversData["session"] {
  const counts = new Map<string, number>();
  for (const q of quotes) {
    if (q.marketState) counts.set(q.marketState, (counts.get(q.marketState) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "CLOSED";
  if (top.startsWith("PRE")) return "PRE";
  if (top === "REGULAR") return "REGULAR";
  if (top.startsWith("POST")) return "POST";
  return "CLOSED";
}

export async function getMovers(): Promise<MoversData> {
  const results = await Promise.all(SCREENER_IDS.map((id) => fetchScreener(id)));
  const all = results.flat();
  return {
    session: detectSession(all),
    fetchedAt: Date.now(),
    afterHours: rank(all, "post"),
    premarket: rank(all, "pre"),
    regular: rankRegular(all),
  };
}
