import { isUsEquityTradingDay } from "./shortPublishing";

const MARKET_TIME_ZONE = "America/New_York";
const GLOBAL_SEND_MINUTES = 9 * 60;
const MARKET_OPEN_MINUTES = 9 * 60 + 30;

function marketParts(now = new Date()): { hhmm: string; date: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    hhmm: `${hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * One global Morning Note cycle for the US market.
 *
 * Cloud Scheduler invokes the route once at 09:00 ET on weekdays. The bounded
 * window admits provider retries before the opening bell without reintroducing
 * member-specific delivery clocks.
 */
export function globalMorningNoteSlot(
  now = new Date(),
): { date: string; hhmm: string; due: boolean; minutesLate: number } {
  const market = marketParts(now);
  const [currentHour, currentMinute] = market.hhmm.split(":").map(Number);
  const current = currentHour * 60 + currentMinute;
  const minutesLate = current - GLOBAL_SEND_MINUTES;
  return {
    date: market.date,
    hhmm: market.hhmm,
    due: isUsEquityTradingDay(market.date) &&
      current >= GLOBAL_SEND_MINUTES &&
      current < MARKET_OPEN_MINUTES,
    minutesLate,
  };
}

export function morningNoteRunStatus(input: {
  force: string;
  forceMatched: boolean;
  sent: number;
  errors: string[];
}): 200 | 404 | 502 | 503 {
  if (input.force) {
    if (!input.forceMatched) return 404;
    return input.sent === 1 && input.errors.length === 0 ? 200 : 502;
  }
  return input.errors.length > 0 ? 503 : 200;
}
