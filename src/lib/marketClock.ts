// The Shift — the site's governing clock. All times US-Eastern (market floor time).
// Sessions: premarket 04:00–09:30 · regular 09:30–16:00 · after-hours 16:00–20:00
// · overnight 20:00–04:00 · weekend rest (Fri 20:00 → Mon 04:00).

export type ShiftState =
  | "WATCH_AFTER_HOURS"
  | "WATCH_OVERNIGHT"
  | "WATCH_PREMARKET"
  | "DAY"
  | "REST";

export interface ShiftInfo {
  state: ShiftState;
  onWatch: boolean;
  /** Big line for the hero */
  headline: string;
  /** Supporting line */
  subline: string;
  /** Label for the countdown target */
  countdownLabel: string;
  /** ms until the countdown target */
  countdownMs: number;
  /** "4:07 PM ET" style clock */
  etClock: string;
  /** minutes since ET midnight (for the shift bar NOW marker) */
  etMinutes: number;
  /** 0=Sun … 6=Sat in ET */
  etDay: number;
}

function etParts(now: Date): { day: number; minutes: number; clock: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days.indexOf(get("weekday"));
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  const clockFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return {
    day,
    minutes: hour * 60 + minute,
    clock: `${clockFmt.format(now)} ET`,
  };
}

/** minutes-of-week in ET (0 = Sunday 00:00) */
function minutesOfWeek(day: number, minutes: number): number {
  return day * 1440 + minutes;
}

/** ms from now until the next occurrence of (targetDay, targetMinutes) in ET */
function msUntil(now: Date, fromMow: number, targetDay: number, targetMinutes: number): number {
  const target = minutesOfWeek(targetDay, targetMinutes);
  let delta = target - fromMow;
  if (delta <= 0) delta += 7 * 1440;
  return delta * 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
}

const PRE_START = 4 * 60; // 04:00
const OPEN = 9 * 60 + 30; // 09:30
const CLOSE = 16 * 60; // 16:00
const AH_END = 20 * 60; // 20:00

export function getShift(now: Date = new Date()): ShiftInfo {
  const { day, minutes, clock } = etParts(now);
  const mow = minutesOfWeek(day, minutes);
  const isWeekday = day >= 1 && day <= 5;

  const base = { etClock: clock, etMinutes: minutes, etDay: day };

  // Weekend rest: Fri 20:00 → Mon 04:00
  const inWeekend =
    day === 6 ||
    day === 0 ||
    (day === 5 && minutes >= AH_END) ||
    (day === 1 && minutes < PRE_START);
  if (inWeekend) {
    return {
      ...base,
      state: "REST",
      onWatch: false,
      headline: "The desk rests when the market rests.",
      subline: "No sessions, no filings, no noise. The next shift starts with Monday premarket.",
      countdownLabel: "Next shift · Monday 4:00am ET",
      countdownMs: msUntil(now, mow, 1, PRE_START),
    };
  }

  if (minutes >= OPEN && minutes < CLOSE && isWeekday) {
    return {
      ...base,
      state: "DAY",
      onWatch: false,
      headline: "The market's awake. So are you.",
      subline:
        "Regular session — AMM Desk keeps following your companies after the closing bell, when important moves can happen.",
      countdownLabel: "Shift starts · 4:00pm ET",
      countdownMs: msUntil(now, mow, day, CLOSE),
    };
  }

  if (minutes >= CLOSE && minutes < AH_END && isWeekday) {
    return {
      ...base,
      state: "WATCH_AFTER_HOURS",
      onWatch: true,
      headline: "AMM Desk is watching.",
      subline:
        "After-hours session live — earnings landing, stocks gapping in the dark. Findings go in your Morning Note.",
      countdownLabel: "Handoff · 9:30am ET open",
      countdownMs: msUntil(now, mow, day === 5 ? 1 : day + 1, OPEN),
    };
  }

  if (minutes >= PRE_START && minutes < OPEN && isWeekday) {
    return {
      ...base,
      state: "WATCH_PREMARKET",
      onWatch: true,
      headline: "Premarket watch.",
      subline:
        "Final hours of the shift — overnight news pricing in before the bell. Your handoff is being written.",
      countdownLabel: "Handoff · 9:30am ET open",
      countdownMs: msUntil(now, mow, day, OPEN),
    };
  }

  // Overnight (20:00–24:00 weekdays, 00:00–04:00 Tue–Fri)
  const handoffDay = minutes >= AH_END ? (day === 5 ? 1 : day + 1) : day;
  return {
    ...base,
    state: "WATCH_OVERNIGHT",
    onWatch: true,
    headline: "Deep in the night shift.",
    subline:
        "The market is closed. AMM Desk is reading filings and following how your stocks trade so tomorrow's Morning Note is ready.",
    countdownLabel: "Handoff · 9:30am ET open",
    countdownMs: msUntil(now, mow, handoffDay, OPEN),
  };
}
