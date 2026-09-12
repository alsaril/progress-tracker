/**
 * The SVG for the all-time distribution image (design section 6.2).
 *
 * Kept apart from `chart.ts` so this half stays a pure, unit-testable string
 * builder: the rasteriser's .wasm and font imports only resolve inside the
 * Worker bundle, and importing them here would make the geometry untestable.
 *
 * Self-contained: the SVG is built here as a string (a bar chart is arithmetic
 * and <rect> elements, so no charting library) and rasterised in the Worker with
 * @resvg/resvg-wasm. Nothing leaves the account — the alternative the design
 * document offers, a QuickChart URL, would send objective names and point counts
 * to a third party.
 *
 * Design notes, deliberate:
 *
 *  - COLOR JOB IS SEQUENTIAL, NOT CATEGORICAL. Identity already comes from each
 *    row's own label, so giving the four objectives four different hues would be
 *    decoration carrying no information. One hue, stepped, from a validated
 *    ordinal ramp: monotone lightness, adjacent steps far enough apart, and the
 *    lightest step still clears the surface.
 *  - SEGMENTS ARE SEPARATED BY A 2px SURFACE GAP, never by a stroke. A border
 *    around a mark is ink that isn't data.
 *  - ONE COMMITTED SURFACE. A PNG cannot follow the viewer's theme, so rather
 *    than guess, the chart is a light card that reads on its own in either
 *    Telegram theme.
 *  - NO HOVER LAYER, because a photo has none. That raises the bar for direct
 *    labelling: every bar total is labelled at its tip, and /stats also sends
 *    the text breakdown, which is the table view that keeps every
 *    sub-objective's value available even when a segment is too narrow to label.
 */

import { type Snapshot, childrenOf, totalPointsForObjective } from "./scoring.js";

// -- palette (validated ordinal ramp, light surface) ---------------------------

const SURFACE = "#fcfcfb";
const INK = "#0b0b0b";
const INK_SOFT = "#52514e";
/** One hue, dark -> light. Every bar starts at the same step, so no bar implies
 *  a rank the data does not support. */
const RAMP = ["#1c5cab", "#2a78d6", "#5598e7", "#86b6ef"] as const;

/**
 * Text inside a colored fill is the one place text may leave the ink tokens, so
 * it picks whichever of white/ink actually contrasts better against that fill —
 * computed, not tabulated, so it stays correct if the ramp is ever re-stepped.
 * (The middle step of this ramp is a near coin-flip at ~4.4:1 either way, which
 * a hand-written list of "light" steps gets wrong in exactly that case.)
 */
function labelOn(fill: string): string {
  const channel = (i: number): number => {
    const c = Number.parseInt(fill.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  const vsWhite = 1.05 / (lum + 0.05);
  const vsInk = (lum + 0.05) / 0.05;
  return vsWhite >= vsInk ? "#ffffff" : INK;
}

// -- geometry ------------------------------------------------------------------

const W = 680;
const PAD = 20;
const LABEL_W = 124;
const VALUE_W = 96;
const BAR_X = PAD + LABEL_W;
const BAR_MAX = W - PAD - VALUE_W - BAR_X;
const ROW_H = 38;
/** Vertical offset of the bar within its row. */
const BAR_OFFSET = 3;
const BAR_H = 20;
const HEADER_H = 62;
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end

/** Exported so tests assert against the real geometry instead of re-deriving it. */
export const GEOM = {
  W,
  PAD,
  BAR_X,
  BAR_MAX,
  ROW_H,
  BAR_H,
  BAR_OFFSET,
  HEADER_H,
  GAP,
  RADIUS,
} as const;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rough advance width for the subset face at a given size. */
function textWidth(s: string, size: number): number {
  return s.length * size * 0.55;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * A bar segment. Only the data end is rounded, and only on the outermost
 * segment; the baseline end stays square.
 */
function segment(x: number, y: number, w: number, fill: string, roundRight: boolean): string {
  if (w <= 0) return "";
  if (!roundRight || w < RADIUS * 2) {
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${BAR_H}" fill="${fill}"/>`;
  }
  const r = RADIUS;
  const right = x + w;
  const d = [
    `M${x.toFixed(1)},${y}`,
    `H${(right - r).toFixed(1)}`,
    `a${r},${r} 0 0 1 ${r},${r}`,
    `V${y + BAR_H - r}`,
    `a${r},${r} 0 0 1 -${r},${r}`,
    `H${x.toFixed(1)}`,
    "Z",
  ].join(" ");
  return `<path d="${d}" fill="${fill}"/>`;
}

export function buildSvg(s: Snapshot): { svg: string; rows: number } {
  const active = s.objectives.filter((o) => o.active === 1);
  const bars = active
    .map((o) => ({ o, total: totalPointsForObjective(s, o.id) }))
    // Magnitude is the question this view answers ("where has my time gone"),
    // so it is ranked rather than kept in tree order.
    .sort((a, b) => b.total - a.total || a.o.sort_order - b.o.sort_order)
    .filter((x) => x.total > 0);

  const grand = bars.reduce((a, x) => a + x.total, 0);
  const widest = bars.length > 0 ? Math.max(...bars.map((x) => x.total)) : 0;
  // Bottom padding matched to the top rather than left as a whole row's worth
  // of slack below the last bar.
  const H =
    bars.length > 0
      ? HEADER_H + (bars.length - 1) * ROW_H + BAR_OFFSET + BAR_H + PAD
      : HEADER_H + ROW_H;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${SURFACE}"/>`,
    `<text x="${PAD}" y="32" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="${INK}">All time</text>`,
    `<text x="${PAD}" y="52" font-family="DejaVu Sans" font-size="13" fill="${INK_SOFT}">${fmt(grand)} sessions across ${bars.length} ${bars.length === 1 ? "objective" : "objectives"}</text>`,
  ];

  if (bars.length === 0) {
    parts.push(
      `<text x="${PAD}" y="${HEADER_H + 20}" font-family="DejaVu Sans" font-size="14" fill="${INK_SOFT}">No sessions recorded yet.</text>`,
      "</svg>",
    );
    return { svg: parts.join(""), rows: 0 };
  }

  bars.forEach(({ o, total }, i) => {
    const y = HEADER_H + i * ROW_H;
    const barY = y + BAR_OFFSET;
    const fullW = widest > 0 ? (total / widest) * BAR_MAX : 0;

    parts.push(
      `<text x="${PAD}" y="${barY + BAR_H - 5}" font-family="DejaVu Sans" font-size="14" fill="${INK}">${esc(o.name)}</text>`,
    );

    // Segments: one per child that has points. Children with none would be
    // zero-width, so they are simply absent rather than drawn as slivers.
    const kids = childrenOf(s, o.id, false)
      .map((k) => ({ k, pts: s.totalBySub.get(k.id) ?? 0 }))
      .filter((x) => x.pts > 0);

    let x = BAR_X;
    kids.forEach(({ k, pts }, j) => {
      const isLast = j === kids.length - 1;
      const raw = (pts / total) * fullW;
      const w = isLast ? Math.max(0, BAR_X + fullW - x) : Math.max(0, raw - GAP);
      const fill = RAMP[j % RAMP.length]!;
      parts.push(segment(x, barY, w, fill, isLast));

      // A label goes inside a segment only when it fits with padding on both
      // sides; a cropped label is worse than none. The text view carries the
      // rest, so nothing is gated behind this.
      const name = k.name;
      const size = 11;
      if (kids.length > 1 && textWidth(name, size) + 16 < w) {
        parts.push(
          `<text x="${(x + 8).toFixed(1)}" y="${barY + BAR_H - 6}" font-family="DejaVu Sans" font-size="${size}" fill="${labelOn(fill)}">${esc(name)}</text>`,
        );
      }
      x += isLast ? w : raw;
    });

    // Value at the tip.
    parts.push(
      `<text x="${(BAR_X + fullW + 10).toFixed(1)}" y="${barY + BAR_H - 5}" font-family="DejaVu Sans" font-size="13" fill="${INK_SOFT}">${fmt(total)}  ·  ${Math.round((total / grand) * 100)}%</text>`,
    );
  });

  parts.push("</svg>");
  return { svg: parts.join(""), rows: bars.length };
}
