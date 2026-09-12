/**
 * D1 access. All aggregation happens here in SQL so that `scoring.ts` stays a
 * pure function over plain data, and so the Worker spends as little CPU as
 * possible (the free plan allows 10 ms per invocation).
 *
 * Design section 3.3: `sessions` is append-only and is the single source of
 * truth. Nothing here stores a derived total — every figure below is computed
 * from the log at read time. The one exception the document allows is a hard
 * delete of a single row, which is what /undo does.
 */

import type { Objective, Snapshot, SubObjective } from "./scoring.js";
import { type WeekBounds, parseWeekStartDay, weekBounds } from "./week.js";

export type Config = {
  weekStartDay: number;
  timezone: string;
  windowDays: number;
};

const DEFAULT_CONFIG: Config = {
  weekStartDay: 1, // Monday
  timezone: "Europe/Lisbon",
  windowDays: 7,
};

export type Loaded = {
  snapshot: Snapshot;
  config: Config;
  bounds: WeekBounds;
};

/**
 * `db.batch()` is typed as a plain array, so a short read would otherwise show
 * up as a confusing `undefined` deep inside a mapper. Fail loudly instead.
 */
function rowsOf(
  result: D1Result<Record<string, unknown>> | undefined,
  what: string,
): Record<string, unknown>[] {
  if (!result) throw new Error(`D1 batch returned no result set for ${what}`);
  return result.results;
}

/**
 * The whole world, in two round-trips.
 *
 * Two rather than one because the weekly window is a parameter of the weekly
 * query, and the window depends on the timezone that lives in `config`. The
 * round-trip is I/O wait, not CPU, so it costs nothing against the 10 ms
 * budget.
 */
export async function load(db: D1Database, now: Date): Promise<Loaded> {
  const [cfgRows, objRows, subRows] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT key, value FROM config"),
    db.prepare("SELECT id, name, weight, active, sort_order FROM objectives ORDER BY sort_order, id"),
    db.prepare(
      "SELECT id, objective_id, name, is_default, active, sort_order FROM sub_objectives ORDER BY sort_order, id",
    ),
  ]);

  const config = readConfig(rowsOf(cfgRows, "config"));
  const bounds = weekBounds(now, config.timezone, config.weekStartDay, config.windowDays);

  const [weeklyRows, allTimeRows] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT sub_objective_id AS id, SUM(points) AS pts
           FROM sessions
          WHERE recorded_at >= ?1 AND recorded_at < ?2
          GROUP BY sub_objective_id`,
      )
      .bind(bounds.start.toISOString(), bounds.end.toISOString()),
    // Totals and last-practiced come out of one scan. `last_practiced_at` is
    // derived here, never stored (design section 3.3).
    db.prepare(
      `SELECT sub_objective_id AS id, SUM(points) AS pts, MAX(recorded_at) AS last
         FROM sessions
        GROUP BY sub_objective_id`,
    ),
  ]);

  const weeklyBySub = new Map<number, number>();
  for (const r of rowsOf(weeklyRows, "weekly points")) weeklyBySub.set(Number(r["id"]), Number(r["pts"]));

  const totalBySub = new Map<number, number>();
  const lastPracticedBySub = new Map<number, string>();
  for (const r of rowsOf(allTimeRows, "all-time totals")) {
    const id = Number(r["id"]);
    totalBySub.set(id, Number(r["pts"]));
    const last = r["last"];
    if (typeof last === "string" && last.length > 0) lastPracticedBySub.set(id, last);
  }

  const snapshot: Snapshot = {
    objectives: rowsOf(objRows, "objectives").map(toObjective),
    subs: rowsOf(subRows, "sub-objectives").map(toSubObjective),
    weeklyBySub,
    totalBySub,
    lastPracticedBySub,
  };

  return { snapshot, config, bounds };
}

function readConfig(rows: Record<string, unknown>[]): Config {
  const map = new Map<string, string>();
  for (const r of rows) map.set(String(r["key"]), String(r["value"]));

  const windowDays = Number(map.get("window_days"));
  return {
    weekStartDay: map.has("week_start_day")
      ? parseWeekStartDay(map.get("week_start_day")!)
      : DEFAULT_CONFIG.weekStartDay,
    timezone: map.get("timezone") ?? DEFAULT_CONFIG.timezone,
    windowDays: Number.isFinite(windowDays) && windowDays > 0 ? windowDays : DEFAULT_CONFIG.windowDays,
  };
}

function toObjective(r: Record<string, unknown>): Objective {
  return {
    id: Number(r["id"]),
    name: String(r["name"]),
    weight: Number(r["weight"]),
    active: Number(r["active"]),
    sort_order: Number(r["sort_order"]),
  };
}

function toSubObjective(r: Record<string, unknown>): SubObjective {
  return {
    id: Number(r["id"]),
    objective_id: Number(r["objective_id"]),
    name: String(r["name"]),
    is_default: Number(r["is_default"]),
    active: Number(r["active"]),
    sort_order: Number(r["sort_order"]),
  };
}

/**
 * Append one session. One session is one point (design section 2.3).
 *
 * The timestamp is generated here rather than by SQLite's DEFAULT so that the
 * format is identical whichever path wrote the row, which is what lets the
 * weekly query compare `recorded_at` lexicographically.
 */
export async function recordSession(
  db: D1Database,
  subObjectiveId: number,
  now: Date,
): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO sessions (sub_objective_id, recorded_at, points) VALUES (?1, ?2, 1.0) RETURNING id",
    )
    .bind(subObjectiveId, now.toISOString())
    .first<{ id: number }>();
  if (!row) throw new Error("insert returned no row");
  return Number(row.id);
}

export type DeletedSession = {
  id: number;
  subName: string;
  objectiveName: string;
  recordedAt: string;
};

/** Look up what a session row represents, for an honest "removed X" message. */
export async function describeSession(
  db: D1Database,
  sessionId: number,
): Promise<DeletedSession | null> {
  const row = await db
    .prepare(
      `SELECT s.id AS id, s.recorded_at AS recorded_at,
              so.name AS sub_name, o.name AS objective_name
         FROM sessions s
         JOIN sub_objectives so ON so.id = s.sub_objective_id
         JOIN objectives o      ON o.id  = so.objective_id
        WHERE s.id = ?1`,
    )
    .bind(sessionId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: Number(row["id"]),
    subName: String(row["sub_name"]),
    objectiveName: String(row["objective_name"]),
    recordedAt: String(row["recorded_at"]),
  };
}

/** The most recent session, or null when the log is empty. */
export async function latestSessionId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM sessions ORDER BY recorded_at DESC, id DESC LIMIT 1")
    .first<{ id: number }>();
  return row ? Number(row.id) : null;
}

/**
 * Hard-delete one specific row — the correction the design document permits
 * alongside negative-point rows (section 3.3). Returns what was removed, or
 * null if that row was already gone.
 */
export async function deleteSession(
  db: D1Database,
  sessionId: number,
): Promise<DeletedSession | null> {
  const described = await describeSession(db, sessionId);
  if (!described) return null;
  const res = await db.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionId).run();
  // `meta.changes` is 0 if something else deleted it between the two calls.
  return res.meta.changes > 0 ? described : null;
}

// -- tree editing (design section 8 step 6) ------------------------------------

/**
 * Create an objective together with its default child (design section 2.2), so
 * points are always recorded against a leaf and every query stays uniform.
 *
 * Both statements go in one `batch`, which D1 runs as a transaction, so
 * `last_insert_rowid()` refers to the objective just inserted and an objective
 * can never exist without a child.
 */
export async function createObjective(
  db: D1Database,
  name: string,
  weight: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO objectives (name, weight, sort_order)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM objectives))`,
      )
      .bind(name, weight),
    db
      .prepare(
        `INSERT INTO sub_objectives (objective_id, name, is_default, sort_order)
         VALUES (last_insert_rowid(), ?1, 1, 0)`,
      )
      .bind(name),
  ]);
}

export async function createSubObjective(
  db: D1Database,
  objectiveId: number,
  name: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sub_objectives (objective_id, name, sort_order)
       VALUES (?1, ?2,
         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sub_objectives WHERE objective_id = ?1))`,
    )
    .bind(objectiveId, name)
    .run();
}

export async function setObjectiveWeight(
  db: D1Database,
  objectiveId: number,
  weight: number,
): Promise<void> {
  await db
    .prepare("UPDATE objectives SET weight = ?2 WHERE id = ?1")
    .bind(objectiveId, weight)
    .run();
}

export async function renameObjective(
  db: D1Database,
  objectiveId: number,
  name: string,
): Promise<void> {
  await db.prepare("UPDATE objectives SET name = ?2 WHERE id = ?1").bind(objectiveId, name).run();
}

export async function renameSubObjective(
  db: D1Database,
  subId: number,
  name: string,
): Promise<void> {
  await db.prepare("UPDATE sub_objectives SET name = ?2 WHERE id = ?1").bind(subId, name).run();
}

export async function setObjectiveActive(
  db: D1Database,
  objectiveId: number,
  active: boolean,
): Promise<void> {
  await db
    .prepare("UPDATE objectives SET active = ?2 WHERE id = ?1")
    .bind(objectiveId, active ? 1 : 0)
    .run();
}

export async function setSubActive(
  db: D1Database,
  subId: number,
  active: boolean,
): Promise<void> {
  await db
    .prepare("UPDATE sub_objectives SET active = ?2 WHERE id = ?1")
    .bind(subId, active ? 1 : 0)
    .run();
}

/**
 * Recorded sessions under an objective, counting rows rather than summing
 * points: a correction row pair can sum to zero while the history is real.
 */
export async function sessionCountForObjective(
  db: D1Database,
  objectiveId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM sessions
        WHERE sub_objective_id IN (SELECT id FROM sub_objectives WHERE objective_id = ?1)`,
    )
    .bind(objectiveId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

export async function sessionCountForSub(db: D1Database, subId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM sessions WHERE sub_objective_id = ?1")
    .bind(subId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/**
 * Delete an objective and its children. Only ever called once the caller has
 * checked there are no sessions underneath: the log is the one thing that
 * cannot be reconstructed (design section 7), so nothing here may destroy it.
 */
export async function deleteObjective(db: D1Database, objectiveId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sub_objectives WHERE objective_id = ?1").bind(objectiveId),
    db.prepare("DELETE FROM objectives WHERE id = ?1").bind(objectiveId),
  ]);
}

export async function deleteSubObjective(db: D1Database, subId: number): Promise<void> {
  await db.prepare("DELETE FROM sub_objectives WHERE id = ?1").bind(subId).run();
}
