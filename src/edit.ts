/**
 * Tree-editing commands (design section 8 step 6): /add, /tree, /weight,
 * /rename, /pause, /resume, /delete.
 *
 * These take typed arguments rather than button taps because building a tree is
 * bulk entry — `/add Guitar 3` beats three taps and a prompt — while the daily
 * path (/next, /log) stays entirely tap-driven.
 *
 * The rule these all obey: nothing here can destroy the session log. /delete
 * refuses as soon as any session exists underneath and points at /pause, which
 * keeps the history and only stops the recommender offering it.
 */

import {
  createObjective,
  createSubObjective,
  deleteObjective,
  deleteSubObjective,
  load,
  renameObjective,
  renameSubObjective,
  sessionCountForObjective,
  sessionCountForSub,
  setObjectiveActive,
  setObjectiveWeight,
  setSubActive,
} from "./db.js";
import { formatTree } from "./format.js";
import {
  type Lookup,
  type Objective,
  type Snapshot,
  type SubObjective,
  childrenOf,
  findObjectiveByName,
  findSubByName,
} from "./scoring.js";
import {
  isError,
  parseAdd,
  parseName,
  parseRename,
  parseWeight,
  weightForShare,
} from "./parse.js";
import { escapeHtml } from "./telegram.js";

/** What a handler wants said back, so the caller owns all the I/O. */
export type Reply = string;

const notFound = (what: string, name: string): Reply =>
  `No ${what} called “${escapeHtml(name)}”. <code>/tree</code> lists them.`;

const ambiguous = (names: string[]): Reply =>
  `That name matches more than one: ${names
    .map((n) => `“${escapeHtml(n)}”`)
    .join(", ")}. Qualify it as <code>Parent &gt; Child</code>.`;

/** Collapse a lookup into either the value or the message explaining why not. */
function resolve<T>(l: Lookup<T>, what: string, name: string): { value: T } | { reply: Reply } {
  if (l.kind === "found") return { value: l.value };
  if (l.kind === "ambiguous") return { reply: ambiguous(l.names) };
  return { reply: notFound(what, name) };
}

// ------------------------------------------------------------------------ /add

export async function handleAdd(db: D1Database, now: Date, args: string): Promise<Reply> {
  const parsed = parseAdd(args);
  if (isError(parsed)) return parsed.error;

  const { snapshot } = await load(db, now);

  if (parsed.kind === "objective") {
    if (findObjectiveByName(snapshot, parsed.name).kind !== "none") {
      return `There is already an objective called “${escapeHtml(parsed.name)}”.`;
    }
    await createObjective(db, parsed.name, parsed.weight);

    // Show the resulting shares, since adding an objective silently
    // renormalises everything else (section 2.4).
    const after = await load(db, now);
    return [
      `Added <b>${escapeHtml(parsed.name)}</b> with weight ${parsed.weight}.`,
      "",
      formatTree(after.snapshot),
    ].join("\n");
  }

  const parent = resolve(
    findObjectiveByName(snapshot, parsed.parent),
    "objective",
    parsed.parent,
  );
  if ("reply" in parent) return parent.reply;

  if (findSubByName(snapshot, parsed.name, parent.value.id).kind !== "none") {
    return `“${escapeHtml(parent.value.name)}” already has a “${escapeHtml(parsed.name)}”.`;
  }

  const hadOnlyDefault =
    childrenOf(snapshot, parent.value.id, false).length === 1;
  await createSubObjective(db, parent.value.id, parsed.name);

  const lines = [
    `Added <b>${escapeHtml(parsed.name)}</b> under <b>${escapeHtml(parent.value.name)}</b>.`,
  ];
  if (hadOnlyDefault) {
    // Section 2.2: the default child keeps its accumulated history and becomes
    // visible rather than being silently deleted.
    lines.push(
      "",
      `“${escapeHtml(parent.value.name)}” now rotates between its new child and` +
        ` its original default entry, which keeps the sessions already logged` +
        ` against it. Rename that with` +
        ` <code>/rename ${escapeHtml(parent.value.name)} &gt; General</code>` +
        ` or retire it with <code>/pause</code>.`,
    );
  }
  return lines.join("\n");
}

// ----------------------------------------------------------------------- /tree

export async function handleTree(db: D1Database, now: Date): Promise<Reply> {
  const { snapshot } = await load(db, now);
  return formatTree(snapshot);
}

// --------------------------------------------------------------------- /weight

export async function handleWeight(db: D1Database, now: Date, args: string): Promise<Reply> {
  const parsed = parseWeight(args);
  if (isError(parsed)) return parsed.error;

  const { snapshot } = await load(db, now);
  const found = resolve(findObjectiveByName(snapshot, parsed.name), "objective", parsed.name);
  if ("reply" in found) return found.reply;
  const objective = found.value;

  let weight = parsed.weight;
  if (parsed.isPercent) {
    // A share is relative to everything else active, so convert against the sum
    // of the OTHER active weights (section 2.4).
    const othersSum = snapshot.objectives
      .filter((o) => o.active === 1 && o.id !== objective.id)
      .reduce((a, o) => a + o.weight, 0);
    weight = weightForShare(parsed.weight / 100, othersSum);
  }

  await setObjectiveWeight(db, objective.id, weight);
  const after = await load(db, now);
  return [
    `<b>${escapeHtml(objective.name)}</b> weight ${objective.weight} → ${weight}` +
      (weight === 0 ? " — its history stays, but it will never be recommended." : "."),
    "",
    formatTree(after.snapshot),
  ].join("\n");
}

// --------------------------------------------------------------------- /rename

export async function handleRename(db: D1Database, now: Date, args: string): Promise<Reply> {
  const parsed = parseRename(args);
  if (isError(parsed)) return parsed.error;

  const { snapshot } = await load(db, now);

  const asObjective = findObjectiveByName(snapshot, parsed.from);
  if (asObjective.kind === "found") {
    if (findObjectiveByName(snapshot, parsed.to).kind !== "none") {
      return `There is already an objective called “${escapeHtml(parsed.to)}”.`;
    }
    await renameObjective(db, asObjective.value.id, parsed.to);
    return `<b>${escapeHtml(parsed.from)}</b> → <b>${escapeHtml(parsed.to)}</b>.`;
  }

  const asSub = findSubByName(snapshot, parsed.from);
  if (asSub.kind === "ambiguous") return ambiguous(asSub.names);
  if (asSub.kind === "found") {
    await renameSubObjective(db, asSub.value.id, parsed.to);
    return `<b>${escapeHtml(parsed.from)}</b> → <b>${escapeHtml(parsed.to)}</b>.`;
  }

  if (asObjective.kind === "ambiguous") return ambiguous(asObjective.names);
  return notFound("objective or sub-objective", parsed.from);
}

// -------------------------------------------------------- /pause and /resume

export async function handleSetActive(
  db: D1Database,
  now: Date,
  args: string,
  active: boolean,
): Promise<Reply> {
  const command = active ? "/resume" : "/pause";
  const parsed = parseName(args, command);
  if (isError(parsed)) return parsed.error;

  const { snapshot } = await load(db, now);

  const asObjective = findObjectiveByName(snapshot, parsed);
  if (asObjective.kind === "found") {
    await setObjectiveActive(db, asObjective.value.id, active);
    const after = await load(db, now);
    return [
      `<b>${escapeHtml(asObjective.value.name)}</b> ${active ? "resumed" : "paused"}.` +
        (active
          ? ""
          : " Its history is kept and the remaining weights renormalise around it."),
      "",
      formatTree(after.snapshot),
    ].join("\n");
  }

  const asSub = findSubByName(snapshot, parsed);
  if (asSub.kind === "ambiguous") return ambiguous(asSub.names);
  if (asSub.kind === "found") {
    await setSubActive(db, asSub.value.id, active);
    return `<b>${escapeHtml(asSub.value.name)}</b> ${active ? "resumed" : "paused"}. Its points still count toward its objective's share.`;
  }

  if (asObjective.kind === "ambiguous") return ambiguous(asObjective.names);
  return notFound("objective or sub-objective", parsed);
}

// --------------------------------------------------------------------- /delete

/**
 * Deletion is only for mistakes — a typo'd name added a minute ago. As soon as
 * anything has been recorded against it, this refuses and points at /pause: the
 * session log is the one thing that cannot be reconstructed.
 */
export async function handleDelete(db: D1Database, now: Date, args: string): Promise<Reply> {
  const parsed = parseName(args, "/delete");
  if (isError(parsed)) return parsed.error;

  const { snapshot } = await load(db, now);

  const asObjective = findObjectiveByName(snapshot, parsed);
  if (asObjective.kind === "found") {
    const o: Objective = asObjective.value;
    const count = await sessionCountForObjective(db, o.id);
    if (count > 0) {
      return (
        `<b>${escapeHtml(o.name)}</b> has ${count} recorded ${count === 1 ? "session" : "sessions"}, ` +
        `so deleting it would destroy history that cannot be rebuilt.\n\n` +
        `<code>/pause ${escapeHtml(o.name)}</code> hides it from the recommender and keeps the record.`
      );
    }
    await deleteObjective(db, o.id);
    return `Deleted <b>${escapeHtml(o.name)}</b> and its children. Nothing had been recorded against it.`;
  }

  const asSub = findSubByName(snapshot, parsed);
  if (asSub.kind === "ambiguous") return ambiguous(asSub.names);
  if (asSub.kind === "found") {
    const sub: SubObjective = asSub.value;
    const count = await sessionCountForSub(db, sub.id);
    if (count > 0) {
      return (
        `<b>${escapeHtml(sub.name)}</b> has ${count} recorded ${count === 1 ? "session" : "sessions"}.\n\n` +
        `<code>/pause ${escapeHtml(sub.name)}</code> keeps the record and stops it being offered.`
      );
    }
    // An objective must always keep at least one child (section 2.2).
    if (remainingChildren(snapshot, sub) === 0) {
      return (
        `That is the only entry under its objective, and an objective always ` +
        `keeps at least one. Delete the objective instead, or add another child first.`
      );
    }
    await deleteSubObjective(db, sub.id);
    return `Deleted <b>${escapeHtml(sub.name)}</b>. Nothing had been recorded against it.`;
  }

  if (asObjective.kind === "ambiguous") return ambiguous(asObjective.names);
  return notFound("objective or sub-objective", parsed);
}

function remainingChildren(s: Snapshot, sub: SubObjective): number {
  return s.subs.filter((x) => x.objective_id === sub.objective_id && x.id !== sub.id).length;
}
