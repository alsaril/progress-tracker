/**
 * Weekly window arithmetic (design section 4.1).
 *
 * A week is a fixed, non-overlapping bucket `[start, end)` in LOCAL time with a
 * configured start day. The bucket is a pure function of the instant; nothing is
 * stored per-week and no rollover job runs.
 *
 * Europe/Lisbon observes DST, so none of this can be plain offset arithmetic:
 * a week containing a transition is 167 or 169 hours long, not 168. The end of
 * the bucket is therefore computed as local midnight of (start date + 7
 * calendar days) rather than start + 7 * 86400000, which is what keeps
 * consecutive buckets exactly adjacent with no gap and no overlap.
 *
 * No date library: `Intl.DateTimeFormat` with a `timeZone` knows the rules.
 */

export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

const DAY_MS = 86_400_000;

/** 'MO' -> 1. Falls back to Monday for an unrecognised value. */
export function parseWeekStartDay(code: string): number {
  const i = (WEEKDAY_CODES as readonly string[]).indexOf(code.toUpperCase());
  return i === -1 ? 1 : i;
}

type LocalParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    // en-CA with these options yields stable, zero-padded numeric parts.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** Wall-clock reading of an instant in `tz`. */
function localParts(t: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(t));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl did not return a ${type} part for ${tz}`);
    return Number(p.value);
  };
  // h23 can still render midnight as 24 in some engines; normalise it.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Offset of `tz` at instant `t`, in ms, as (wall clock - UTC).
 * Lisbon in summer is +3600000; in winter, 0.
 */
function tzOffsetMs(t: number, tz: string): number {
  const p = localParts(t, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // localParts has second resolution, so compare against a whole second.
  return asIfUtc - Math.floor(t / 1000) * 1000;
}

/**
 * The UTC instant of local midnight on a given calendar date in `tz`.
 *
 * Two passes: guess that the offset at UTC midnight applies, then re-measure at
 * the corrected instant. One correction is enough because an offset change is
 * at most a couple of hours and never lands a shifted instant in a third
 * offset regime.
 */
function localMidnightUtc(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const firstPass = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(firstPass, tz);
}

/** Calendar date, in `tz`, of an instant. */
export function localDate(now: Date, tz: string): { year: number; month: number; day: number } {
  const p = localParts(now.getTime(), tz);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * Day of week (0 = Sunday) of a calendar date. Determined by the date itself,
 * not by any timezone, so plain UTC arithmetic is correct here.
 */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Shift a calendar date by whole days without touching timezones. */
function addDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day) + delta * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export type WeekBounds = {
  /** Inclusive lower bound, as a UTC instant. */
  start: Date;
  /** Exclusive upper bound, as a UTC instant. */
  end: Date;
  /** Local calendar date the week starts on, for labelling. */
  startDate: { year: number; month: number; day: number };
};

/**
 * The bucket containing `now`.
 *
 * `windowDays` comes from config so that section 4.5's "alternative window
 * lengths" stays a parameter rather than surgery. It counts calendar days.
 *
 * Caveat, stated rather than hidden: the bucket is anchored to the weekday
 * cycle, so only `windowDays = 7` yields non-overlapping buckets. A fortnight
 * would need an epoch anchor date to decide *which* Monday starts a bucket.
 * Section 4.5 defers alternative windows, so that anchor is not built yet.
 */
export function weekBounds(
  now: Date,
  tz: string,
  startDay: number,
  windowDays = 7,
): WeekBounds {
  const today = localDate(now, tz);
  const back = (dayOfWeek(today.year, today.month, today.day) - startDay + 7) % 7;
  const startDate = addDays(today.year, today.month, today.day, -back);
  const endDate = addDays(startDate.year, startDate.month, startDate.day, windowDays);
  return {
    start: new Date(localMidnightUtc(startDate.year, startDate.month, startDate.day, tz)),
    end: new Date(localMidnightUtc(endDate.year, endDate.month, endDate.day, tz)),
    startDate,
  };
}

/**
 * Whole local days remaining in the bucket, counting today as one.
 * Monday of a 7-day week gives 7; the last day gives 1.
 */
export function daysLeftInWeek(
  now: Date,
  tz: string,
  startDay: number,
  windowDays = 7,
): number {
  const today = localDate(now, tz);
  const elapsed = (dayOfWeek(today.year, today.month, today.day) - startDay + 7) % 7;
  return windowDays - elapsed;
}
