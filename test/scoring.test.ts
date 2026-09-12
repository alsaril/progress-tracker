import { describe, expect, it } from "vitest";
import {
  type Objective,
  type Snapshot,
  type SubObjective,
  pickSub,
  rankObjectives,
  recommend,
  shares,
  totalPointsForObjective,
  weeklyPointsForObjective,
} from "../src/scoring.js";

// --------------------------------------------------------------- test helpers

type ObjSpec = { id: number; name: string; weight: number; active?: number; order?: number };
type SubSpec = {
  id: number;
  objective_id: number;
  name: string;
  is_default?: number;
  active?: number;
  order?: number;
};

function obj(s: ObjSpec): Objective {
  return {
    id: s.id,
    name: s.name,
    weight: s.weight,
    active: s.active ?? 1,
    sort_order: s.order ?? s.id,
  };
}

function sub(s: SubSpec): SubObjective {
  return {
    id: s.id,
    objective_id: s.objective_id,
    name: s.name,
    is_default: s.is_default ?? 0,
    active: s.active ?? 1,
    sort_order: s.order ?? s.id,
  };
}

function snapshot(
  objectives: Objective[],
  subs: SubObjective[],
  weekly: Record<number, number> = {},
  last: Record<number, string> = {},
  total: Record<number, number> = {},
): Snapshot {
  return {
    objectives,
    subs,
    weeklyBySub: new Map(Object.entries(weekly).map(([k, v]) => [Number(k), v])),
    totalBySub: new Map(Object.entries(total).map(([k, v]) => [Number(k), v])),
    lastPracticedBySub: new Map(Object.entries(last).map(([k, v]) => [Number(k), v])),
  };
}

/** One objective with only its auto-created default child (section 2.2). */
function flat(id: number, name: string, weight: number, order?: number) {
  return {
    objective: obj({ id, name, weight, order }),
    sub: sub({ id: id * 100, objective_id: id, name, is_default: 1, order: 0 }),
  };
}

/**
 * Record `n` sessions by repeatedly asking for a recommendation and crediting
 * the point, exactly as the bot does. Returns points per objective id.
 */
function simulate(s: Snapshot, n: number, rng: () => number = () => 0): Record<number, number> {
  const perObjective: Record<number, number> = {};
  for (let i = 0; i < n; i++) {
    const r = recommend(s, rng);
    if (!r) break;
    s.weeklyBySub.set(r.sub.id, (s.weeklyBySub.get(r.sub.id) ?? 0) + 1);
    s.lastPracticedBySub.set(r.sub.id, `2026-09-0${(i % 9) + 1}T10:00:00.000Z`);
    perObjective[r.objective.id] = (perObjective[r.objective.id] ?? 0) + 1;
  }
  return perObjective;
}

// ------------------------------------------------------- stage 1, section 4.2

describe("stage 1: choosing the objective", () => {
  it("opens the week in weight order rather than insertion order", () => {
    // Every objective sits at zero points on Monday. The design document needed
    // an explicit "largest weight first" tie-break for this; the divisor form
    // gets it for free. Insertion order here is deliberately the reverse of
    // weight order, so a naive implementation would fail.
    const t = flat(1, "Technique", 3);
    const r = flat(2, "Repertoire", 4);
    const th = flat(3, "Theory", 2);
    const sr = flat(4, "Sight-reading", 1);
    const s = snapshot(
      [sr.objective, th.objective, t.objective, r.objective],
      [sr.sub, th.sub, t.sub, r.sub],
    );

    const ranked = rankObjectives(s);
    expect(ranked.map((o) => o.name)).toEqual([
      "Repertoire",
      "Technique",
      "Theory",
      "Sight-reading",
    ]);
  });

  it("converges exactly on the target shares over a week (3/4/2/1)", () => {
    const t = flat(1, "Technique", 3);
    const r = flat(2, "Repertoire", 4);
    const th = flat(3, "Theory", 2);
    const sr = flat(4, "Sight-reading", 1);
    const s = snapshot(
      [t.objective, r.objective, th.objective, sr.objective],
      [t.sub, r.sub, th.sub, sr.sub],
    );

    // Ten sessions against weights summing to ten: the split should be exact.
    expect(simulate(s, 10)).toEqual({ 1: 3, 2: 4, 3: 2, 4: 1 });
  });

  it("converges on 75/25 for a 3-to-1 weight pair", () => {
    const a = flat(1, "A", 3);
    const b = flat(2, "B", 1);
    const s = snapshot([a.objective, b.objective], [a.sub, b.sub]);
    expect(simulate(s, 8)).toEqual({ 1: 6, 2: 2 });
  });

  it("treats weights as relative, so 30/40/20/10 behaves like 3/4/2/1", () => {
    const t = flat(1, "Technique", 30);
    const r = flat(2, "Repertoire", 40);
    const th = flat(3, "Theory", 20);
    const sr = flat(4, "Sight-reading", 10);
    const s = snapshot(
      [t.objective, r.objective, th.objective, sr.objective],
      [t.sub, r.sub, th.sub, sr.sub],
    );
    expect(simulate(s, 10)).toEqual({ 1: 3, 2: 4, 3: 2, 4: 1 });
  });

  it("self-corrects when the week starts lopsided", () => {
    // Equal weights, but one objective is already four sessions ahead. The
    // recommender must serve the other three before returning to it.
    const a = flat(1, "A", 1);
    const b = flat(2, "B", 1);
    const c = flat(3, "C", 1);
    const s = snapshot(
      [a.objective, b.objective, c.objective],
      [a.sub, b.sub, c.sub],
      { [a.sub.id]: 4 },
    );
    expect(rankObjectives(s).map((o) => o.name)).toEqual(["B", "C", "A"]);
  });

  it("breaks equal-priority ties by sort_order, then id", () => {
    const s = snapshot(
      [
        obj({ id: 7, name: "later", weight: 1, order: 2 }),
        obj({ id: 3, name: "earlier", weight: 1, order: 1 }),
      ],
      [
        sub({ id: 70, objective_id: 7, name: "later", is_default: 1 }),
        sub({ id: 30, objective_id: 3, name: "earlier", is_default: 1 }),
      ],
    );
    expect(rankObjectives(s).map((o) => o.name)).toEqual(["earlier", "later"]);
  });

  it("never recommends a zero-weight objective but keeps its history", () => {
    const paused = flat(1, "Paused", 0);
    const live = flat(2, "Live", 1);
    const s = snapshot(
      [paused.objective, live.objective],
      [paused.sub, live.sub],
      { [paused.sub.id]: 5 },
      {},
      { [paused.sub.id]: 42 },
    );

    expect(rankObjectives(s).map((o) => o.name)).toEqual(["Live"]);
    // Recommended 20 times over, it is still never selected.
    for (let i = 0; i < 20; i++) expect(recommend(s)!.objective.name).toBe("Live");
    // ...and its points are untouched and still readable.
    expect(totalPointsForObjective(s, 1)).toBe(42);
    expect(weeklyPointsForObjective(s, 1)).toBe(5);
  });

  it("excludes inactive objectives", () => {
    const off = flat(1, "Off", 5);
    off.objective.active = 0;
    const on = flat(2, "On", 1);
    const s = snapshot([off.objective, on.objective], [off.sub, on.sub]);
    expect(rankObjectives(s).map((o) => o.name)).toEqual(["On"]);
  });

  it("returns nothing to practice instead of throwing on degenerate input", () => {
    const empty = snapshot([], []);
    expect(recommend(empty)).toBeNull();

    const allZero = flat(1, "Zero", 0);
    expect(recommend(snapshot([allZero.objective], [allZero.sub]))).toBeNull();

    const allPaused = flat(1, "Paused", 1);
    allPaused.objective.active = 0;
    expect(recommend(snapshot([allPaused.objective], [allPaused.sub]))).toBeNull();
  });

  it("skips an objective whose every child has been deactivated", () => {
    const dead = flat(1, "Dead", 10);
    dead.sub.active = 0;
    const live = flat(2, "Live", 1);
    const s = snapshot([dead.objective, live.objective], [dead.sub, live.sub]);
    // "Dead" outranks "Live" on weight but has no child that can be practiced.
    expect(rankObjectives(s)[0]!.name).toBe("Dead");
    expect(recommend(s)!.objective.name).toBe("Live");
  });

  it("counts a deactivated child's points toward its objective's week", () => {
    // The effort really happened, so it still shapes the objective's share;
    // pausing only removes the item from the candidate list.
    const o = obj({ id: 1, name: "O", weight: 1 });
    const kept = sub({ id: 10, objective_id: 1, name: "kept" });
    const retired = sub({ id: 11, objective_id: 1, name: "retired", active: 0 });
    const s = snapshot([o], [kept, retired], { 10: 1, 11: 2 });
    expect(weeklyPointsForObjective(s, 1)).toBe(3);
    expect(pickSub(s, 1)!.name).toBe("kept");
  });
});

// ------------------------------------------------------- stage 2, section 4.3

describe("stage 2: choosing the sub-objective", () => {
  it("records straight to the default child when it is the only one", () => {
    const f = flat(1, "Technique", 1);
    const s = snapshot([f.objective], [f.sub]);
    const r = recommend(s)!;
    expect(r.sub.id).toBe(f.sub.id);
    expect(r.sub.is_default).toBe(1);
  });

  it("prefers the sibling with fewest points this week", () => {
    const o = obj({ id: 1, name: "Theory", weight: 1 });
    const a = sub({ id: 10, objective_id: 1, name: "Intervals" });
    const b = sub({ id: 11, objective_id: 1, name: "Harmony" });
    const s = snapshot([o], [a, b], { 10: 2, 11: 1 }, { 10: "x", 11: "y" });
    expect(pickSub(s, 1)!.name).toBe("Harmony");
  });

  it("carries rotation across the week boundary via last_practiced_at", () => {
    // A fresh week: every child is at zero, so weekly counts give no signal.
    // The one untouched for longest must go first.
    const o = obj({ id: 1, name: "Theory", weight: 1 });
    const a = sub({ id: 10, objective_id: 1, name: "Intervals" });
    const b = sub({ id: 11, objective_id: 1, name: "Harmony" });
    const c = sub({ id: 12, objective_id: 1, name: "Counterpoint" });
    const s = snapshot(
      [o],
      [a, b, c],
      {},
      {
        10: "2026-09-01T10:00:00.000Z",
        11: "2026-09-05T10:00:00.000Z",
        12: "2026-09-03T10:00:00.000Z",
      },
    );
    expect(pickSub(s, 1)!.name).toBe("Intervals");
  });

  it("picks a brand-new sibling once, then sends it to the back of the queue", () => {
    const o = obj({ id: 1, name: "Theory", weight: 1 });
    const a = sub({ id: 10, objective_id: 1, name: "Intervals" });
    const b = sub({ id: 11, objective_id: 1, name: "Harmony" });
    const fresh = sub({ id: 12, objective_id: 1, name: "Brand-new" });
    const s = snapshot(
      [o],
      [a, b, fresh],
      {},
      { 10: "2026-09-01T10:00:00.000Z", 11: "2026-09-02T10:00:00.000Z" },
    );

    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = recommend(s, () => 0)!;
      order.push(r.sub.name);
      s.weeklyBySub.set(r.sub.id, (s.weeklyBySub.get(r.sub.id) ?? 0) + 1);
      s.lastPracticedBySub.set(r.sub.id, `2026-09-1${i}T10:00:00.000Z`);
    }

    // Never practiced, so it goes first — but only because it was owed a turn,
    // not because being new is worth anything afterwards. Once it has had that
    // turn it is just another sibling, and the result is a clean round-robin:
    // it comes back around only after everyone else has had one too.
    expect(order).toEqual([
      "Brand-new",
      "Intervals",
      "Harmony",
      "Brand-new",
      "Intervals",
      "Harmony",
    ]);
  });

  it("uses randomness only among never-practiced siblings", () => {
    const o = obj({ id: 1, name: "O", weight: 1 });
    const a = sub({ id: 10, objective_id: 1, name: "A" });
    const b = sub({ id: 11, objective_id: 1, name: "B" });
    const c = sub({ id: 12, objective_id: 1, name: "C" });
    const s = snapshot([o], [a, b, c]);

    // Injected rng, so the choice is reproducible and explainable.
    expect(pickSub(s, 1, () => 0)!.name).toBe("A");
    expect(pickSub(s, 1, () => 0.5)!.name).toBe("B");
    expect(pickSub(s, 1, () => 0.99)!.name).toBe("C");
  });

  it("never lets rng() === 1 index past the end", () => {
    const o = obj({ id: 1, name: "O", weight: 1 });
    const a = sub({ id: 10, objective_id: 1, name: "A" });
    const b = sub({ id: 11, objective_id: 1, name: "B" });
    const s = snapshot([o], [a, b]);
    expect(pickSub(s, 1, () => 1)!.name).toBe("B");
  });

  it("is deterministic once every sibling has been practiced", () => {
    const o = obj({ id: 1, name: "O", weight: 1 });
    const a = sub({ id: 10, objective_id: 1, name: "A" });
    const b = sub({ id: 11, objective_id: 1, name: "B" });
    const s = snapshot(
      [o],
      [a, b],
      {},
      { 10: "2026-09-01T10:00:00.000Z", 11: "2026-09-02T10:00:00.000Z" },
    );
    // Same answer whatever the rng does: /next can explain itself.
    for (const rng of [() => 0, () => 0.5, () => 0.99, Math.random]) {
      expect(pickSub(s, 1, rng)!.name).toBe("A");
    }
  });

  it("keeps the default child in rotation after real siblings are added", () => {
    // Section 2.2: the default child keeps its history and stays visible.
    const o = obj({ id: 1, name: "Theory", weight: 1 });
    const dflt = sub({ id: 10, objective_id: 1, name: "General", is_default: 1, order: 0 });
    const real = sub({ id: 11, objective_id: 1, name: "Intervals", order: 1 });
    const s = snapshot(
      [o],
      [dflt, real],
      { 10: 1, 11: 2 },
      { 10: "2026-09-01T10:00:00.000Z", 11: "2026-09-02T10:00:00.000Z" },
    );
    expect(pickSub(s, 1)!.name).toBe("General");
  });

  it("returns null for an objective with no children that can be practiced", () => {
    const o = obj({ id: 1, name: "O", weight: 1 });
    const off = sub({ id: 10, objective_id: 1, name: "off", active: 0 });
    expect(pickSub(snapshot([o], [off]), 1)).toBeNull();
  });
});

// ------------------------------------------------------- shares, section 6.1

describe("shares", () => {
  it("derives target shares by renormalising over the active set", () => {
    const t = flat(1, "Technique", 3);
    const r = flat(2, "Repertoire", 4);
    const th = flat(3, "Theory", 2);
    const sr = flat(4, "Sight-reading", 1);
    const s = snapshot(
      [t.objective, r.objective, th.objective, sr.objective],
      [t.sub, r.sub, th.sub, sr.sub],
    );
    const { rows } = shares(s);
    expect(rows.map((x) => x.target)).toEqual([0.3, 0.4, 0.2, 0.1]);
  });

  it("renormalises over a different denominator when one objective is paused", () => {
    // Section 2.4: pausing needs no rebalancing pass.
    const a = flat(1, "A", 1);
    const b = flat(2, "B", 1);
    const c = flat(3, "C", 2);
    c.objective.active = 0;
    const s = snapshot(
      [a.objective, b.objective, c.objective],
      [a.sub, b.sub, c.sub],
    );
    const { rows } = shares(s);
    expect(rows.map((x) => x.objective.name)).toEqual(["A", "B"]);
    expect(rows.map((x) => x.target)).toEqual([0.5, 0.5]);
  });

  it("reports zero, not NaN, for a week with no sessions yet", () => {
    const a = flat(1, "A", 1);
    const s = snapshot([a.objective], [a.sub]);
    const { rows, weeklyTotal } = shares(s);
    expect(weeklyTotal).toBe(0);
    expect(rows[0]!.actual).toBe(0);
  });

  it("computes actual share against the week's own total", () => {
    const a = flat(1, "A", 1);
    const b = flat(2, "B", 1);
    const s = snapshot(
      [a.objective, b.objective],
      [a.sub, b.sub],
      { [a.sub.id]: 3, [b.sub.id]: 1 },
    );
    const { rows, weeklyTotal } = shares(s);
    expect(weeklyTotal).toBe(4);
    expect(rows.map((x) => x.actual)).toEqual([0.75, 0.25]);
  });

  it("survives every active weight being zero", () => {
    const a = flat(1, "A", 0);
    const s = snapshot([a.objective], [a.sub]);
    expect(shares(s).rows[0]!.target).toBe(0);
  });
});
