import { describe, expect, it } from "vitest";
import { daysLeftInWeek, parseWeekStartDay, weekBounds } from "../src/week.js";

const TZ = "Europe/Lisbon";
const MO = 1;

const iso = (d: Date): string => d.toISOString();

describe("parseWeekStartDay", () => {
  it("maps weekday codes to indices with Sunday at 0", () => {
    expect(parseWeekStartDay("MO")).toBe(1);
    expect(parseWeekStartDay("SU")).toBe(0);
    expect(parseWeekStartDay("SA")).toBe(6);
    expect(parseWeekStartDay("mo")).toBe(1);
  });

  it("falls back to Monday rather than throwing on junk", () => {
    expect(parseWeekStartDay("nonsense")).toBe(1);
  });
});

describe("weekBounds in Europe/Lisbon", () => {
  it("brackets an ordinary summer week at local midnight (UTC+1)", () => {
    // Thursday 2026-09-10. Week is Mon 09-07 .. Mon 09-14, WEST = UTC+1,
    // so local midnight is 23:00 UTC the previous day.
    const b = weekBounds(new Date("2026-09-10T12:00:00Z"), TZ, MO);
    expect(iso(b.start)).toBe("2026-09-06T23:00:00.000Z");
    expect(iso(b.end)).toBe("2026-09-13T23:00:00.000Z");
    expect(b.startDate).toEqual({ year: 2026, month: 9, day: 7 });
  });

  it("brackets an ordinary winter week at local midnight (UTC+0)", () => {
    // Wednesday 2026-01-14. WET = UTC+0, so local midnight is 00:00 UTC.
    const b = weekBounds(new Date("2026-01-14T12:00:00Z"), TZ, MO);
    expect(iso(b.start)).toBe("2026-01-12T00:00:00.000Z");
    expect(iso(b.end)).toBe("2026-01-19T00:00:00.000Z");
  });

  it("makes the spring-forward week 167 hours, not 168", () => {
    // DST begins Sunday 2026-03-29 at 01:00 UTC (01:00 -> 02:00 local).
    // The containing week starts Mon 03-23 in WET and ends Mon 03-30 in WEST.
    const b = weekBounds(new Date("2026-03-25T12:00:00Z"), TZ, MO);
    expect(iso(b.start)).toBe("2026-03-23T00:00:00.000Z");
    expect(iso(b.end)).toBe("2026-03-29T23:00:00.000Z");
    const hours = (b.end.getTime() - b.start.getTime()) / 3_600_000;
    expect(hours).toBe(167);
  });

  it("makes the fall-back week 169 hours, not 168", () => {
    // DST ends Sunday 2026-10-25 at 01:00 UTC (02:00 -> 01:00 local).
    const b = weekBounds(new Date("2026-10-21T12:00:00Z"), TZ, MO);
    expect(iso(b.start)).toBe("2026-10-18T23:00:00.000Z");
    expect(iso(b.end)).toBe("2026-10-26T00:00:00.000Z");
    const hours = (b.end.getTime() - b.start.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });

  it("leaves no gap or overlap between consecutive weeks across a transition", () => {
    // The week before the spring transition must end exactly where the
    // transition week begins, and so on through it.
    const before = weekBounds(new Date("2026-03-18T12:00:00Z"), TZ, MO);
    const during = weekBounds(new Date("2026-03-25T12:00:00Z"), TZ, MO);
    const after = weekBounds(new Date("2026-04-01T12:00:00Z"), TZ, MO);
    expect(iso(before.end)).toBe(iso(during.start));
    expect(iso(during.end)).toBe(iso(after.start));
  });

  it("is stable anywhere inside the same bucket", () => {
    const a = weekBounds(new Date("2026-09-07T00:00:00Z"), TZ, MO);
    const b = weekBounds(new Date("2026-09-13T22:59:59Z"), TZ, MO);
    expect(iso(a.start)).toBe(iso(b.start));
    expect(iso(a.end)).toBe(iso(b.end));
  });

  it("puts a late Sunday evening session in the week you would expect", () => {
    // The acceptance check from the plan. 23:30 local on Sunday 2026-09-13 is
    // 22:30Z (WEST), which must still fall inside the week that began Mon 09-07.
    const bucket = weekBounds(new Date("2026-09-13T12:00:00Z"), TZ, MO);
    const lateSunday = new Date("2026-09-13T22:30:00Z"); // 23:30 local
    expect(lateSunday.getTime()).toBeGreaterThanOrEqual(bucket.start.getTime());
    expect(lateSunday.getTime()).toBeLessThan(bucket.end.getTime());

    // An hour later is 00:30 local on Monday, i.e. the next bucket.
    const justAfterMidnight = new Date("2026-09-13T23:30:00Z");
    expect(justAfterMidnight.getTime()).toBeGreaterThanOrEqual(bucket.end.getTime());
  });

  it("honours a non-Monday start day", () => {
    // Sunday start: Thursday 2026-09-10 belongs to the week from Sun 09-06.
    const b = weekBounds(new Date("2026-09-10T12:00:00Z"), TZ, 0);
    expect(iso(b.start)).toBe("2026-09-05T23:00:00.000Z");
    expect(iso(b.end)).toBe("2026-09-12T23:00:00.000Z");
  });
});

describe("daysLeftInWeek", () => {
  it("counts today, giving 7 on the first day and 1 on the last", () => {
    // 2026-09-07 is a Monday, 2026-09-13 the Sunday that closes that week.
    expect(daysLeftInWeek(new Date("2026-09-07T09:00:00Z"), TZ, MO)).toBe(7);
    expect(daysLeftInWeek(new Date("2026-09-10T09:00:00Z"), TZ, MO)).toBe(4);
    expect(daysLeftInWeek(new Date("2026-09-13T09:00:00Z"), TZ, MO)).toBe(1);
  });

  it("uses the local date, not the UTC one", () => {
    // 23:30Z on Sunday 2026-09-13 is already Monday 00:30 in Lisbon, so the
    // new week has all 7 days left.
    expect(daysLeftInWeek(new Date("2026-09-13T23:30:00Z"), TZ, MO)).toBe(7);
  });
});
