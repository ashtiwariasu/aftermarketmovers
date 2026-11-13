/**
 * The social-evidence watchlist — SEED LIST, edit freely (Ash owns this file).
 * Handles are pulled in batched from: queries; unknown/renamed handles are
 * skipped by the API and logged, so a wrong entry costs nothing.
 */
export const WATCHLIST: { handle: string; why: string }[] = [
  // Earnings & filings discourse
  { handle: "TheTranscript_", why: "earnings-call quotes — closest cousin to our receipts" },
  { handle: "BrianFeroldi", why: "financial-education fintwit, quality tone" },
  { handle: "borrowed_ideas", why: "deep-dive threads on companies we cover" },
  { handle: "SecCrawler", why: "filings flow" },
  // Fast tape / market chatter (signal for what retail is reacting to)
  { handle: "DeItaone", why: "fastest headline wire on X" },
  { handle: "unusual_whales", why: "retail chatter bellwether — hype-adjacent, weigh accordingly" },
  { handle: "Stocktwits", why: "retail sentiment aggregate" },
  // AI × finance / competitors
  { handle: "AnthropicAI", why: "our chairman's vendor" },
  { handle: "OpenAI", why: "model news that moves our costs and seats" },
  { handle: "perplexity_ai", why: "competitor — watch finance moves" },
  { handle: "fiscal_ai", why: "competitor-adjacent research data tool" },
  { handle: "AlphaSenseInc", why: "incumbent research platform" },
  { handle: "SimplyWallSt", why: "nearest occupant of 'my stocks, explained'" },
  // Creator pipeline (sponsorship targets — know what they post)
  { handle: "ChitChatStocks", why: "sponsorship target" },
  { handle: "FundamentalEdge", why: "sponsorship target — Invest with AI" },
];

/** Brand + concept queries — mentions we should never miss. */
export const BRAND_QUERIES = [
  '"aftermarketmovers" OR "after market movers" OR aftermarketmovers.com',
  '"LLM council" OR "AI research desk"',
];

/** Ticker chatter pilot — the three most-watched names on member desks. */
export const TICKER_QUERIES = [
  { ticker: "GOOGL", query: '(GOOGL OR Alphabet) (stock OR earnings OR shares) -is:retweet -is:reply lang:en' },
  { ticker: "NVDA", query: '(NVDA OR Nvidia) (stock OR earnings OR shares) -is:retweet -is:reply lang:en' },
  { ticker: "TSLA", query: '(TSLA OR Tesla) (stock OR earnings OR shares) -is:retweet -is:reply lang:en' },
];

/** Query template for any fleet ticker — replies and retweets excluded. */
export function tickerQuery(sym: string): string {
  const safe = sym.toUpperCase().trim();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(safe)) return '"__invalid_amm_ticker__"';
  return `($${safe} OR ${safe}) (stock OR earnings OR shares) -is:retweet -is:reply lang:en`;
}
