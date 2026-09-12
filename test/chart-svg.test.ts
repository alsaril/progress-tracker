import { describe, expect, it } from "vitest";
import { GEOM, buildSvg } from "../src/chart-svg.js";
import type { Snapshot } from "../src/scoring.js";

function snap(
  objectives: Snapshot["objectives"],
  subs: Snapshot["subs"],
  total: Record<number, number>,
): Snapshot {
  return {
    objectives,
    subs,
    weeklyBySub: new Map(),
    totalBySub: new Map(Object.entries(total).map(([k, v]) => [Number(k), v])),
    lastPracticedBySub: new Map(),
  };
}

const example = (): Snapshot =>
  snap(
    [
      { id: 1, name: "Technique", weight: 3, active: 1, sort_order: 1 },
      { id: 2, name: "Repertoire", weight: 4, active: 1, sort_order: 2 },
      { id: 3, name: "Theory", weight: 2, active: 1, sort_order: 3 },
    ],
    [
      { id: 10, objective_id: 1, name: "Technique", is_default: 1, active: 1, sort_order: 0 },
      { id: 20, objective_id: 2, name: "Repertoire", is_default: 1, active: 1, sort_order: 0 },
      { id: 30, objective_id: 3, name: "Theory", is_default: 1, active: 1, sort_order: 0 },
      { id: 31, objective_id: 3, name: "Intervals", is_default: 0, active: 1, sort_order: 1 },
      { id: 32, objective_id: 3, name: "Harmony", is_default: 0, active: 1, sort_order: 2 },
    ],
    { 10: 30, 20: 40, 30: 0, 31: 12, 32: 8 },
  );

describe("buildSvg", () => {
  it("ranks bars by magnitude, since that is the question it answers", () => {
    const { svg } = buildSvg(example());
    const order = [...svg.matchAll(/>([A-Z][a-z-]+)<\/text>/g)].map((m) => m[1]);
    expect(order.slice(0, 3)).toEqual(["Repertoire", "Technique", "Theory"]);
  });

  it("scales the longest bar to the full plot width", () => {
    const { svg } = buildSvg(example());
    // The widest bar's data end is a rounded path, so read the right edge from
    // the path's horizontal run (which stops one radius short of the corner).
    const rightEdges = [
      ...svg.matchAll(new RegExp(`<path d="M${GEOM.BAR_X}\\.0,\\d+ H([\\d.]+) a4,4`, "g")),
    ].map((m) => Number(m[1]) + GEOM.RADIUS);
    // Repertoire (40 of a 40 max) spans the whole plot area.
    expect(Math.max(...rightEdges)).toBeCloseTo(GEOM.BAR_X + GEOM.BAR_MAX, 0);
  });

  it("scales shorter bars proportionally, not to their own maximum", () => {
    const { svg } = buildSvg(example());
    // Technique is 30 of a 40 max, so three quarters of the plot width.
    const tip = GEOM.BAR_X + (30 / 40) * GEOM.BAR_MAX + 10;
    expect(svg).toContain(`<text x="${tip.toFixed(1)}"`);
  });

  it("omits children with no points instead of drawing zero-width slivers", () => {
    // Theory's default child has 0 points, so only Intervals and Harmony draw.
    const { svg } = buildSvg(example());
    expect(svg).toContain(">Intervals</text>");
    expect(svg).toContain(">Harmony</text>");
    expect(svg).not.toMatch(/width="0\.0"/);
  });

  it("separates stacked segments with a surface gap, never a stroke", () => {
    const { svg } = buildSvg(example());
    expect(svg).not.toContain("stroke");
  });

  it("rounds only the data end of a bar", () => {
    const { svg } = buildSvg(example());
    // The outermost segment is a path with two arcs; interior ones are rects.
    const paths = [...svg.matchAll(/<path d="[^"]*a4,4[^"]*"/g)];
    expect(paths.length).toBe(3); // one per bar
  });

  it("skips an in-segment label that would not fit, rather than cropping it", () => {
    const s = snap(
      [{ id: 1, name: "Theory", weight: 1, active: 1, sort_order: 1 }],
      [
        { id: 10, objective_id: 1, name: "A very long sub-objective name", is_default: 0, active: 1, sort_order: 1 },
        { id: 11, objective_id: 1, name: "Rest", is_default: 0, active: 1, sort_order: 2 },
      ],
      { 10: 1, 11: 99 },
    );
    const { svg } = buildSvg(s);
    // The 1-point segment is far too narrow for a 29-character label.
    expect(svg).not.toContain("A very long sub-objective name");
    // The wide one still gets its label.
    expect(svg).toContain(">Rest</text>");
  });

  it("labels every bar total, since a PNG has no tooltip to fall back on", () => {
    const { svg } = buildSvg(example());
    expect(svg).toContain("40  ·  44%");
    expect(svg).toContain("30  ·  33%");
    expect(svg).toContain("20  ·  22%");
  });

  it("uses one hue, never a categorical palette", () => {
    const { svg } = buildSvg(example());
    const fills = new Set([...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]));
    // Surface, two ink tokens, white, and steps of the single blue ramp.
    for (const f of fills) {
      expect(["#fcfcfb", "#0b0b0b", "#52514e", "#ffffff", "#1c5cab", "#2a78d6", "#5598e7", "#86b6ef"]).toContain(f);
    }
  });

  it("picks the in-segment label colour that actually contrasts better", () => {
    const { svg } = buildSvg(example());
    // Intervals sits on the darkest step -> white; Harmony on the middle step,
    // where ink wins the coin-flip (4.46:1 vs 4.42:1).
    expect(svg).toMatch(/fill="#ffffff">Intervals</);
    expect(svg).toMatch(/fill="#0b0b0b">Harmony</);
  });

  it("excludes inactive objectives and reports the row count", () => {
    const s = example();
    s.objectives[0]!.active = 0;
    const { svg, rows } = buildSvg(s);
    expect(rows).toBe(2);
    expect(svg).not.toContain(">Technique</text>");
  });

  it("signals nothing to draw for an empty log", () => {
    const s = example();
    s.totalBySub = new Map();
    const { rows, svg } = buildSvg(s);
    expect(rows).toBe(0);
    expect(svg).toContain("No sessions recorded yet.");
  });

  it("escapes objective names into the SVG", () => {
    const s = example();
    s.objectives[0]!.name = 'Rock & <Roll> "x"';
    const { svg } = buildSvg(s);
    expect(svg).toContain("Rock &amp; &lt;Roll&gt; &quot;x&quot;");
    expect(svg).not.toContain("<Roll>");
  });

  it("grows in height with the number of bars and stays a fixed width", () => {
    const one = buildSvg(
      snap(
        [{ id: 1, name: "Solo", weight: 1, active: 1, sort_order: 1 }],
        [{ id: 10, objective_id: 1, name: "Solo", is_default: 1, active: 1, sort_order: 0 }],
        { 10: 5 },
      ),
    ).svg;
    const three = buildSvg(example()).svg;
    const h = (svg: string): number => Number(/height="(\d+)"/.exec(svg)![1]);
    expect(h(three)).toBeGreaterThan(h(one));
    expect(three).toContain('width="680"');
    expect(one).toContain('width="680"');
  });
});
