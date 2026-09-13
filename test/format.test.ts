import { describe, expect, it } from "vitest";
import {
  formatAllTime,
  formatBalance,
  formatRecorded,
  formatWeekLabel,
  nextLabel,
} from "../src/format.js";
import { type Snapshot, recommend } from "../src/scoring.js";
import { weekBounds } from "../src/week.js";

const TZ = "Europe/Lisbon";
const MO = 1;
const BOUNDS = weekBounds(new Date("2026-09-10T12:00:00Z"), TZ, MO);

/** Strip the <pre> wrapper so tests read the chart the way the user sees it. */
const plain = (html: string): string => html.replace(/<\/?pre>/g, "");

/** The design document's own example tree: 3/4/2/1 over four objectives. */
function exampleSnapshot(weekly: Record<number, number>): Snapshot {
  return {
    objectives: [
      { id: 1, name: "Technique", weight: 3, active: 1, sort_order: 1 },
      { id: 2, name: "Repertoire", weight: 4, active: 1, sort_order: 2 },
      { id: 3, name: "Theory", weight: 2, active: 1, sort_order: 3 },
      { id: 4, name: "Sight-reading", weight: 1, active: 1, sort_order: 4 },
    ],
    subs: [
      { id: 10, objective_id: 1, name: "Technique", is_default: 1, active: 1, sort_order: 0 },
      { id: 20, objective_id: 2, name: "Repertoire", is_default: 1, active: 1, sort_order: 0 },
      { id: 30, objective_id: 3, name: "Theory", is_default: 1, active: 1, sort_order: 0 },
      { id: 31, objective_id: 3, name: "Intervals", is_default: 0, active: 1, sort_order: 1 },
      { id: 40, objective_id: 4, name: "Sight-reading", is_default: 1, active: 1, sort_order: 0 },
    ],
    weeklyBySub: new Map(Object.entries(weekly).map(([k, v]) => [Number(k), v])),
    totalBySub: new Map([
      [10, 120],
      [20, 160],
      [30, 30],
      [31, 44],
      [40, 39],
    ]),
    lastPracticedBySub: new Map([
      [10, "2026-09-10T10:00:00.000Z"],
      [31, "2026-09-09T10:00:00.000Z"],
    ]),
  };
}

describe("formatWeekLabel", () => {
  it("names the local date the week started on", () => {
    expect(formatWeekLabel(BOUNDS)).toBe("7 Sep");
  });
});

describe("formatBalance", () => {
  const s = exampleSnapshot({ 10: 5, 20: 5, 30: 1, 31: 1, 40: 2 });

  it("renders the week's balance as an aligned diverging chart", () => {
    expect(plain(formatBalance(s, BOUNDS, 4, recommend(s, () => 0))))
      .toMatchInlineSnapshot(`
      "Week of 7 Sep  ·  14 sessions  ·  4 days left

                                  target actual
      Technique        ██▌           30%    36%  +6
      Repertoire         ▐█          40%    36%  -4
      Theory             ▐██         20%    14%  -6
      Sight-read…       █▌           10%    14%  +4

      Next: Repertoire"
    `);
  });

  it("keeps every data row exactly the same width", () => {
    // Fixed character width is what makes <pre> alignment survive on a phone.
    const rows = plain(formatBalance(s, BOUNDS, 4, null)).split("\n").slice(3, 7);
    expect(new Set(rows.map((r) => r.length))).toEqual(new Set([45]));
  });

  it("puts the column headings exactly over their numbers", () => {
    const lines = plain(formatBalance(s, BOUNDS, 4, null)).split("\n");
    const header = lines[2]!;
    const firstRow = lines[3]!;
    expect(header.indexOf("target") + 6).toBe(firstRow.indexOf("30%") + 3);
    expect(header.indexOf("actual") + 6).toBe(firstRow.indexOf("36%") + 3);
  });

  it("draws overdone objectives left of the axis and owed ones right", () => {
    const lines = plain(formatBalance(s, BOUNDS, 4, null)).split("\n");
    // Technique is over its share (+6): blocks end at the axis marker '▌'.
    expect(lines[3]).toContain("██▌");
    // Repertoire is behind (-4): the axis marker '▐' is followed by blocks.
    expect(lines[4]).toContain("▐█");
  });

  it("shows the session count but never a target count or completion", () => {
    // Section 4.4: weights are proportions, so there is nothing to complete.
    const out = plain(formatBalance(s, BOUNDS, 4, null));
    expect(out).toContain("14 sessions");
    // No "3 of 10", no "5/12", no goal or completion language anywhere.
    expect(out).not.toMatch(/complete|goal|target count|\d+\s*\/\s*\d+|\d+ of \d+/i);
  });

  it("singularises one session and one day", () => {
    const one = exampleSnapshot({ 10: 1 });
    const out = plain(formatBalance(one, BOUNDS, 1, null));
    expect(out).toContain("1 session  ·  1 day left");
  });

  it("sits every row on the axis for a week with no sessions yet", () => {
    // No actual distribution exists yet, so showing full deficit bars would be
    // an invention. Actual reads '–' rather than 0%.
    const empty = exampleSnapshot({});
    const out = plain(formatBalance(empty, BOUNDS, 7, null));
    expect(out).toContain("0 sessions");
    expect(out).toContain("│");
    expect(out).not.toContain("█");
    expect(out).toContain("–");
  });

  it("says so plainly when there are no active objectives", () => {
    const none: Snapshot = {
      objectives: [],
      subs: [],
      weeklyBySub: new Map(),
      totalBySub: new Map(),
      lastPracticedBySub: new Map(),
    };
    expect(plain(formatBalance(none, BOUNDS, 7, null))).toContain("No active objectives.");
  });
});

describe("formatAllTime", () => {
  it("renders objective totals with a sub-objective breakdown", () => {
    const s = exampleSnapshot({ 10: 5, 20: 5, 30: 1, 31: 1, 40: 2 });
    expect(plain(formatAllTime(s))).toMatchInlineSnapshot(`
      "All time  ·  393 sessions

      Technique   ███████████     120  31%
      Repertoire  ██████████████  160  41%
      Theory      ██████           74  19%
        Theory                    30
        Intervals                 44
      Sight-read… ███              39  10%"
    `);
  });

  it("breaks down only objectives that have more than a default child", () => {
    const s = exampleSnapshot({});
    const out = plain(formatAllTime(s));
    // Theory has two children, so it is itemised; Technique has one, so it is
    // shown flat (section 2.2).
    expect(out).toContain("  Intervals");
    expect(out.match(/^ {2}Technique/m)).toBeNull();
  });

  it("says so plainly before anything has been recorded", () => {
    const s = exampleSnapshot({});
    s.totalBySub = new Map();
    expect(plain(formatAllTime(s))).toContain("No sessions recorded yet.");
  });
});

describe("nextLabel", () => {
  it("collapses a flat objective into its own name", () => {
    // Technique has only its auto-created default child.
    const s = exampleSnapshot({});
    const rec = { objective: s.objectives[0]!, sub: s.subs[0]! };
    expect(nextLabel(s, rec)).toBe("Technique");
  });

  it("shows parent and child for a real sub-objective", () => {
    const s = exampleSnapshot({});
    const rec = { objective: s.objectives[2]!, sub: s.subs[3]! };
    expect(nextLabel(s, rec)).toBe("Theory → Intervals");
  });

  it("stops collapsing the default child once siblings are added", () => {
    // The reported bug: an objective that was flat gains real children, and
    // every entry under it still printed as just the parent's name — so three
    // different things were indistinguishable in /next and in the keyboard.
    const s = exampleSnapshot({});
    const theoryDefault = s.subs[2]!; // named "Theory", is_default
    const rec = { objective: s.objectives[2]!, sub: theoryDefault };
    expect(theoryDefault.is_default).toBe(1);
    expect(nextLabel(s, rec)).toBe("Theory → Theory");
  });

  it("collapses again if the siblings are paused away", () => {
    // Back to one practicable child, so the flat form is correct once more —
    // and this matches what the /log keyboard does with the same objective.
    const s = exampleSnapshot({});
    s.subs[3]!.active = 0; // Intervals
    const rec = { objective: s.objectives[2]!, sub: s.subs[2]! };
    expect(nextLabel(s, rec)).toBe("Theory");
  });

  it("distinguishes every child of a non-flat objective", () => {
    const s = exampleSnapshot({});
    const labels = s.subs
      .filter((x) => x.objective_id === 3)
      .map((sub) => nextLabel(s, { objective: s.objectives[2]!, sub }));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["Theory → Theory", "Theory → Intervals"]);
  });
});

describe("formatRecorded", () => {
  it("names the default child explicitly when it has siblings", () => {
    // Same bug as nextLabel: the acknowledgement said only "Theory".
    const s = exampleSnapshot({ 30: 1 });
    expect(formatRecorded(s, 30, BOUNDS)).toContain("Theory → Theory");
  });

  it("uses the bare objective name for a flat objective", () => {
    const s = exampleSnapshot({ 10: 1 });
    const out = formatRecorded(s, 10, BOUNDS);
    expect(out).toContain("Technique");
    expect(out).not.toContain("→");
  });

  it("acknowledges with this week's and the all-time total", () => {
    const s = exampleSnapshot({ 31: 2 });
    const out = formatRecorded(s, 31, BOUNDS);
    expect(out).toContain("Theory → Intervals");
    expect(out).toContain("2 this week · 44 all time");
    expect(out).toContain("week of 7 Sep");
  });

  it("escapes HTML in objective names", () => {
    const s = exampleSnapshot({});
    s.objectives[0]!.name = "Rock & <Roll>";
    s.subs[0]!.is_default = 0;
    s.subs[0]!.name = "a<b";
    const out = formatRecorded(s, 10, BOUNDS);
    expect(out).toContain("Rock &amp; &lt;Roll&gt; → a&lt;b");
    expect(out).not.toContain("<Roll>");
  });
});
