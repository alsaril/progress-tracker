/**
 * The recommender (design section 4), as pure functions over an already
 * aggregated snapshot. No D1 access, no clock, no I/O — so every tie-break in
 * the design document is directly testable.
 *
 * Stage 1 is implemented in its D'Hondt divisor form:
 *
 *     priority(o) = weight(o) / (weeklyPoints(o) + 1)      -> take the maximum
 *
 * The design document writes it as argmin(weeklyPoints / effectiveWeight) plus
 * two patches: an explicit "largest weight first" tie-break, because at the
 * start of a week every objective sits at 0/w and is therefore tied, and a
 * special case for weight = 0 to avoid dividing by zero. Both patches vanish
 * here. The denominator never drops below 1, so there is no division by zero,
 * and at zero points the ranking reduces to weight order on its own, which is
 * exactly what the document wanted its tie-break to achieve. Same divisor
 * method, same target shares.
 *
 * Note also that `effective_weight` (the renormalised share from section 2.4)
 * is unnecessary here: the normalising denominator is identical across all
 * candidates, so it cannot change the ordering. Shares stay a display concern.
 */

export type Objective = {
  id: number;
  name: string;
  weight: number;
  active: number;
  sort_order: number;
};

export type SubObjective = {
  id: number;
  objective_id: number;
  name: string;
  is_default: number;
  active: number;
  sort_order: number;
};

export type Snapshot = {
  objectives: Objective[];
  subs: SubObjective[];
  /** Points inside the current weekly bucket, per sub-objective id. */
  weeklyBySub: Map<number, number>;
  /** All-time points, per sub-objective id. */
  totalBySub: Map<number, number>;
  /** All-time MAX(recorded_at) per sub-objective id; absent = never practiced. */
  lastPracticedBySub: Map<number, string>;
};

export type Recommendation = { objective: Objective; sub: SubObjective };

/** Children of an objective, in display order. */
export function childrenOf(s: Snapshot, objectiveId: number, activeOnly = true): SubObjective[] {
  return s.subs
    .filter((x) => x.objective_id === objectiveId && (!activeOnly || x.active === 1))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

/**
 * Weekly points for an objective: the sum over ALL its children, including
 * deactivated ones.
 *
 * Deliberate: a paused sub-objective's points still happened, so the effort
 * still counts toward the objective's share of the week. Pausing hides an item
 * from the *candidate* list (see `pickSub`), it does not rewrite what you did.
 */
export function weeklyPointsForObjective(s: Snapshot, objectiveId: number): number {
  let sum = 0;
  for (const sub of s.subs) {
    if (sub.objective_id === objectiveId) sum += s.weeklyBySub.get(sub.id) ?? 0;
  }
  return sum;
}

/** All-time points for an objective, derived the same way (section 2.3). */
export function totalPointsForObjective(s: Snapshot, objectiveId: number): number {
  let sum = 0;
  for (const sub of s.subs) {
    if (sub.objective_id === objectiveId) sum += s.totalBySub.get(sub.id) ?? 0;
  }
  return sum;
}

/** Objectives eligible to be recommended: active, and carrying a positive weight. */
export function candidateObjectives(s: Snapshot): Objective[] {
  return s.objectives.filter((o) => o.active === 1 && o.weight > 0);
}

/**
 * Stage 1 (section 4.2), as the full ranked list that section 4.5 asks for.
 * Highest divisor priority first; ties broken by sort_order, then id.
 */
export function rankObjectives(s: Snapshot): Objective[] {
  return candidateObjectives(s)
    .map((o) => ({ o, priority: o.weight / (weeklyPointsForObjective(s, o.id) + 1) }))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.o.sort_order - b.o.sort_order ||
        a.o.id - b.o.id,
    )
    .map((x) => x.o);
}

/**
 * Stage 2 (section 4.3): fewest weekly points among active children.
 *
 * Weekly counts give no signal at the start of a week, when every child is at
 * zero, so `lastPracticed` carries the rotation across the week boundary:
 * whichever child has gone longest untouched goes first, and rotation continues
 * seamlessly from last week.
 *
 * Randomness applies ONLY among children that have genuinely never been
 * practiced, where any fixed order would be a lie. It is deliberately not the
 * general tie-break: random rotates only in expectation, so with four tied
 * children it would repeat the same one 25% of the time, producing exactly the
 * clumping the rotation exists to prevent.
 */
export function pickSub(
  s: Snapshot,
  objectiveId: number,
  rng: () => number = Math.random,
): SubObjective | null {
  const candidates = childrenOf(s, objectiveId);
  if (candidates.length === 0) return null;

  const weekly = (x: SubObjective): number => s.weeklyBySub.get(x.id) ?? 0;
  const fewest = Math.min(...candidates.map(weekly));
  const tied = candidates.filter((x) => weekly(x) === fewest);
  if (tied.length === 1) return tied[0]!;

  // Never-practiced items sort ahead of everything else.
  const virgin = tied.filter((x) => !s.lastPracticedBySub.has(x.id));
  if (virgin.length > 0) {
    if (virgin.length === 1) return virgin[0]!;
    const i = Math.floor(rng() * virgin.length);
    return virgin[Math.min(i, virgin.length - 1)]!;
  }

  return tied.sort((a, b) => {
    const la = s.lastPracticedBySub.get(a.id)!;
    const lb = s.lastPracticedBySub.get(b.id)!;
    // ISO-8601 UTC strings, so lexicographic order is chronological order.
    if (la !== lb) return la < lb ? -1 : 1;
    return a.sort_order - b.sort_order || a.id - b.id;
  })[0]!;
}

/**
 * Both stages. Returns null when there is nothing to practice — no active
 * objectives, or every active objective at weight 0 (section 2.4) — rather than
 * throwing.
 */
export function recommend(
  s: Snapshot,
  rng: () => number = Math.random,
): Recommendation | null {
  for (const objective of rankObjectives(s)) {
    const sub = pickSub(s, objective.id, rng);
    // An objective always has at least its default child (section 2.2), but it
    // can have had every child deactivated by hand; skip to the next one.
    if (sub) return { objective, sub };
  }
  return null;
}

/**
 * Target vs actual shares for the balance view (section 6.1).
 *
 * Target share renormalises weight over the active set (section 2.4). Actual
 * share is of the points recorded inside the given bucket. Both are fractions
 * in [0, 1]; a week with no sessions yet has actual = 0 everywhere rather than
 * NaN.
 */
export type ShareRow = {
  objective: Objective;
  target: number;
  actual: number;
  weekly: number;
};

export function shares(s: Snapshot): { rows: ShareRow[]; weeklyTotal: number } {
  const active = s.objectives.filter((o) => o.active === 1);
  const weightSum = active.reduce((a, o) => a + o.weight, 0);
  const weeklyTotal = active.reduce((a, o) => a + weeklyPointsForObjective(s, o.id), 0);

  const rows = active
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((objective) => {
      const weekly = weeklyPointsForObjective(s, objective.id);
      return {
        objective,
        target: weightSum > 0 ? objective.weight / weightSum : 0,
        actual: weeklyTotal > 0 ? weekly / weeklyTotal : 0,
        weekly,
      };
    });

  return { rows, weeklyTotal };
}

// -- name lookup, for the text-driven editing commands -------------------------

export type Lookup<T> =
  | { kind: "found"; value: T }
  | { kind: "none" }
  | { kind: "ambiguous"; names: string[] };

const eq = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Objectives are matched case-insensitively, including paused ones. */
export function findObjectiveByName(s: Snapshot, name: string): Lookup<Objective> {
  const hits = s.objectives.filter((o) => eq(o.name, name));
  if (hits.length === 1) return { kind: "found", value: hits[0]! };
  if (hits.length === 0) return { kind: "none" };
  return { kind: "ambiguous", names: hits.map((o) => o.name) };
}

/**
 * Sub-objectives are matched case-insensitively, optionally within one parent.
 * Unqualified, the same child name under two objectives is ambiguous, and the
 * caller is told to qualify it as `Parent > Child`.
 */
export function findSubByName(
  s: Snapshot,
  name: string,
  objectiveId?: number,
): Lookup<SubObjective> {
  const hits = s.subs.filter(
    (x) => eq(x.name, name) && (objectiveId === undefined || x.objective_id === objectiveId),
  );
  if (hits.length === 1) return { kind: "found", value: hits[0]! };
  if (hits.length === 0) return { kind: "none" };
  const parent = (x: SubObjective): string =>
    s.objectives.find((o) => o.id === x.objective_id)?.name ?? "?";
  return { kind: "ambiguous", names: hits.map((x) => `${parent(x)} > ${x.name}`) };
}

/** True when the objective has never had a real child added (section 2.2). */
export function hasOnlyDefaultChild(s: Snapshot, objectiveId: number): boolean {
  const kids = s.subs.filter((x) => x.objective_id === objectiveId);
  return kids.length === 1 && kids[0]!.is_default === 1;
}
