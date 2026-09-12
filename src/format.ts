/**
 * Text rendering (design section 6.1). Pure functions, so they are
 * snapshot-testable and cost almost no CPU.
 *
 * The balance view is a zero-centred diverging chart of
 * (actual_share - target_share) per objective, scoped to the current week.
 * Bars to the RIGHT of the axis are what you owe; bars to the LEFT are what you
 * have overdone. Rendered in a <pre> block with a fixed character width so the
 * alignment survives on a phone.
 *
 * Per section 4.4 the header shows the session count but never a target count
 * or a completion percentage: weights express proportions only, so there is
 * nothing to complete.
 */

import {
  type Recommendation,
  type Snapshot,
  childrenOf,
  shares,
  totalPointsForObjective,
} from "./scoring.js";
import { escapeHtml } from "./telegram.js";
import type { WeekBounds } from "./week.js";

const LABEL_W = 11;
const BAR_HALF = 7;
/** Percentage points represented by a full half-bar. */
const SCALE_PP = 21;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

function truncate(s: string, w: number): string {
  return s.length <= w ? s : `${s.slice(0, w - 1)}…`;
}

/** "7 Sep" */
export function formatWeekLabel(bounds: WeekBounds): string {
  const { day, month } = bounds.startDate;
  return `${day} ${MONTHS[month - 1]}`;
}

/** Whole points render bare; fractional ones keep one decimal. */
function points(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * One diverging bar. `delta` is in percentage points.
 *
 * The axis is always drawn as a half-block leaning in the direction of the bar,
 * so a row at exactly zero still shows where the axis is.
 */
function bar(deltaPP: number): string {
  const cells = Math.min(BAR_HALF, Math.round((Math.abs(deltaPP) * BAR_HALF) / SCALE_PP));
  if (deltaPP > 0) {
    // Overdone: grows leftward, ending at the axis.
    return " ".repeat(BAR_HALF - cells) + "█".repeat(cells) + "▌" + " ".repeat(BAR_HALF);
  }
  if (deltaPP < 0) {
    // Owed: starts at the axis and grows rightward.
    return " ".repeat(BAR_HALF) + "▐" + "█".repeat(cells) + " ".repeat(BAR_HALF - cells);
  }
  return " ".repeat(BAR_HALF) + "│" + " ".repeat(BAR_HALF);
}

/**
 * The daily view. Returns an HTML string containing one <pre> block.
 */
export function formatBalance(
  s: Snapshot,
  bounds: WeekBounds,
  daysLeft: number,
  next: Recommendation | null,
): string {
  const { rows, weeklyTotal } = shares(s);

  const header = [
    `Week of ${formatWeekLabel(bounds)}`,
    `${points(weeklyTotal)} ${weeklyTotal === 1 ? "session" : "sessions"}`,
    `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`,
  ].join("  ·  ");

  const lines: string[] = [header, ""];

  if (rows.length === 0) {
    lines.push("No active objectives.");
    return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
  }

  // Padded by the same rule as the value columns below, so the headings sit
  // exactly over their numbers.
  lines.push(
    " ".repeat(LABEL_W + 1 + BAR_HALF * 2 + 1) + padLeft("target", 7) + padLeft("actual", 7),
  );

  for (const row of rows) {
    const targetPP = row.target * 100;
    const actualPP = row.actual * 100;
    // With no sessions yet there is no actual distribution to compare against,
    // so every row sits on the axis rather than showing a full deficit bar.
    const deltaPP = weeklyTotal > 0 ? actualPP - targetPP : 0;
    const delta = Math.round(deltaPP);

    lines.push(
      [
        pad(truncate(row.objective.name, LABEL_W), LABEL_W),
        " ",
        bar(deltaPP),
        padLeft(`${Math.round(targetPP)}%`, 7),
        padLeft(weeklyTotal > 0 ? `${Math.round(actualPP)}%` : "–", 7),
        padLeft(delta === 0 ? "" : delta > 0 ? `+${delta}` : String(delta), 4),
      ]
        .join("")
        // A row sitting exactly on target has no delta to print; don't leave
        // its padding dangling at the end of the line.
        .trimEnd(),
    );
  }

  if (next) {
    lines.push("", `Next: ${nextLabel(next)}`);
  }

  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/**
 * The all-time picture, as text (design section 6.2 asks for an image; this is
 * what /stats falls back to, and it stays useful even when the image is sent).
 * Stacked as objective totals with their sub-objective breakdown indented.
 */
export function formatAllTime(s: Snapshot): string {
  const active = s.objectives
    .filter((o) => o.active === 1)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  const totals = active.map((o) => ({ o, total: totalPointsForObjective(s, o.id) }));
  const grand = totals.reduce((a, x) => a + x.total, 0);
  if (grand === 0) return `<pre>${escapeHtml("No sessions recorded yet.")}</pre>`;

  const widest = Math.max(...totals.map((x) => x.total));
  const lines: string[] = [`All time  ·  ${points(grand)} sessions`, ""];

  for (const { o, total } of totals) {
    const cells = widest > 0 ? Math.round((total / widest) * 14) : 0;
    lines.push(
      [
        pad(truncate(o.name, LABEL_W), LABEL_W),
        " ",
        pad("█".repeat(cells), 14),
        padLeft(points(total), 5),
        padLeft(`${Math.round((total / grand) * 100)}%`, 5),
      ].join(""),
    );

    // Only worth breaking down when there is more than the default child.
    const kids = childrenOf(s, o.id, false);
    if (kids.length > 1) {
      for (const k of kids) {
        const kt = s.totalBySub.get(k.id) ?? 0;
        if (kt === 0 && k.active === 0) continue;
        lines.push(
          [
            "  ",
            pad(truncate(k.name, LABEL_W + 12), LABEL_W + 12),
            padLeft(points(kt), 5),
            k.active === 0 ? " (paused)" : "",
          ].join(""),
        );
      }
    }
  }

  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/** "Theory → Intervals", collapsing the default child into its parent. */
export function nextLabel(r: Recommendation): string {
  return r.sub.is_default === 1
    ? r.objective.name
    : `${r.objective.name} → ${r.sub.name}`;
}

/** Acknowledgement after recording, with the new totals (design section 5.2). */
export function formatRecorded(
  s: Snapshot,
  subId: number,
  bounds: WeekBounds,
): string {
  const sub = s.subs.find((x) => x.id === subId);
  if (!sub) return "Recorded.";
  const objective = s.objectives.find((o) => o.id === sub.objective_id);
  const label =
    sub.is_default === 1 || !objective
      ? sub.name
      : `${objective.name} → ${sub.name}`;

  const weekly = s.weeklyBySub.get(subId) ?? 0;
  const total = s.totalBySub.get(subId) ?? 0;
  return [
    `✓ <b>${escapeHtml(label)}</b>`,
    `${points(weekly)} this week · ${points(total)} all time`,
    `<i>week of ${escapeHtml(formatWeekLabel(bounds))}</i>`,
  ].join("\n");
}
