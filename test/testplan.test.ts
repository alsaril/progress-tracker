/**
 * Pins TESTPLAN.md's stated expectations to the code.
 *
 * That document tells you exactly what the bot will answer, six taps in a row.
 * If the recommender ever changes, these fail — so the walkthrough cannot
 * quietly become wrong while still reading as authoritative.
 */

import { expect, it } from "vitest";
import { type Snapshot, recommend, shares } from "../src/scoring.js";
import { weightForShare } from "../src/parse.js";

it("TESTPLAN scenario 4: six sessions give Alpha,Beta,Alpha,Alpha,Beta,Gamma", () => {
  const s: Snapshot = {
    objectives: [
      { id: 1, name: "Alpha", weight: 3, active: 1, sort_order: 1 },
      { id: 2, name: "Beta", weight: 2, active: 1, sort_order: 2 },
      { id: 3, name: "Gamma", weight: 1, active: 1, sort_order: 3 },
    ],
    subs: [
      { id: 10, objective_id: 1, name: "Alpha", is_default: 1, active: 1, sort_order: 0 },
      { id: 20, objective_id: 2, name: "Beta", is_default: 1, active: 1, sort_order: 0 },
      { id: 30, objective_id: 3, name: "Gamma", is_default: 1, active: 1, sort_order: 0 },
    ],
    weeklyBySub: new Map(), totalBySub: new Map(), lastPracticedBySub: new Map(),
  };
  const order: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = recommend(s, () => 0)!;
    order.push(r.objective.name);
    s.weeklyBySub.set(r.sub.id, (s.weeklyBySub.get(r.sub.id) ?? 0) + 1);
    s.totalBySub.set(r.sub.id, (s.totalBySub.get(r.sub.id) ?? 0) + 1);
    s.lastPracticedBySub.set(r.sub.id, `2026-09-0${i + 1}T10:00:00.000Z`);
  }
  expect(order).toEqual(["Alpha", "Beta", "Alpha", "Alpha", "Beta", "Gamma"]);

  const { rows } = shares(s);
  expect(rows.map((r) => [r.objective.name, r.weekly])).toEqual([
    ["Alpha", 3], ["Beta", 2], ["Gamma", 1],
  ]);
  // Scenario 4: every bar on the axis, target === actual exactly.
  for (const r of rows) expect(r.actual).toBeCloseTo(r.target, 10);
});

it("TESTPLAN scenario 2: shares as objectives are added", () => {
  const mk = (ws: [string, number][]): Snapshot => ({
    objectives: ws.map(([name, weight], i) => ({ id: i + 1, name, weight, active: 1, sort_order: i + 1 })),
    subs: ws.map((_, i) => ({ id: (i + 1) * 10, objective_id: i + 1, name: "x", is_default: 1, active: 1, sort_order: 0 })),
    weeklyBySub: new Map(), totalBySub: new Map(), lastPracticedBySub: new Map(),
  });
  const pct = (s: Snapshot) => shares(s).rows.map((r) => Math.round(r.target * 100));
  expect(pct(mk([["Alpha", 3]]))).toEqual([100]);
  expect(pct(mk([["Alpha", 3], ["Beta", 2]]))).toEqual([60, 40]);
  expect(pct(mk([["Alpha", 3], ["Beta", 2], ["Gamma", 1]]))).toEqual([50, 33, 17]);
});

it("TESTPLAN scenario 8: percentage conversions", () => {
  expect(weightForShare(0.5, 3)).toBe(3);     // 50% against others=3  -> 3
  expect(weightForShare(0.6, 3)).toBe(4.5);   // 60% against others=3  -> 4.5
});
