export interface NewsItem {
  title: string;
  publisher: string;
  link: string;
  at: number; // ms epoch
}

interface YahooNews {
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: number;
}

/** Recent headlines for a ticker via Yahoo's keyless search endpoint.
 *  nameHint (e.g. "Alphabet Inc.") tightens relevance: only titles naming the
 *  ticker or the company survive; falls back to the raw feed if that empties it. */
export async function getTickerNews(
  symbol: string,
  count = 4,
  nameHint?: string
): Promise<NewsItem[]> {
  const sym = symbol.toUpperCase().trim();
  if (!/^[A-Z.\-]{1,6}$/.test(sym)) return [];
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${sym}&quotesCount=0&newsCount=${count + 8}&enableFuzzyQuery=false`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AfterMarketMovers/1.0)" },
        next: { revalidate: 600 },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return [];
    const json = await res.json();
    const items: YahooNews[] = json?.news ?? [];
    const clean = items
      .filter((n) => n.title && n.providerPublishTime)
      .sort((a, b) => (b.providerPublishTime ?? 0) - (a.providerPublishTime ?? 0));
    const tokens = [sym.toLowerCase()];
    const firstWord = nameHint?.split(/[\s,]+/)[0];
    if (firstWord && firstWord.length >= 3) tokens.push(firstWord.toLowerCase());
    const relevant = clean.filter((n) =>
      tokens.some((t) => n.title!.toLowerCase().includes(t))
    );
    return (relevant.length > 0 ? relevant : clean).slice(0, count).map((n) => ({
      title: n.title!,
      publisher: n.publisher ?? "wire",
      link: n.link ?? "",
      at: n.providerPublishTime! * 1000,
    }));
  } catch {
    return [];
  }
}

/** "4:52 PM ET" when within ~20h, otherwise "JUL 11". */
export function newsStamp(atMs: number): string {
  const ageH = (Date.now() - atMs) / 3_600_000;
  if (ageH < 20) {
    return (
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(atMs)) + " ET"
    );
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  })
    .format(new Date(atMs))
    .toUpperCase();
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Days until the month-day named in an event string, or null. */
export function daysToEvent(event: string | null): number | null {
  if (!event) return null;
  const m = event.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})/
  );
  if (!m) return null;
  const now = new Date();
  let target = Date.UTC(now.getUTCFullYear(), MONTHS[m[1]], parseInt(m[2], 10));
  let diff = Math.ceil((target - Date.now()) / 86_400_000);
  if (diff < -300) {
    target = Date.UTC(now.getUTCFullYear() + 1, MONTHS[m[1]], parseInt(m[2], 10));
    diff = Math.ceil((target - Date.now()) / 86_400_000);
  }
  return diff;
}
