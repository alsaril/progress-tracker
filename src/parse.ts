/**
 * Argument parsing for the tree-editing commands (design section 8 step 6).
 *
 * Pure and unit-tested. These commands take text rather than button taps
 * because setting a tree up is bulk typing — `/add Guitar 3` is faster than
 * three taps and a prompt — while the daily path (/next, /log) stays entirely
 * tap-driven.
 *
 * `>` separates a parent from a child, and a rename's old name from its new.
 */

export const MAX_NAME = 64;
/** Guards against a fat-fingered weight that would swamp every other share. */
export const MAX_WEIGHT = 1_000_000;

export type ParseError = { error: string };
export const isError = <T>(x: T | ParseError): x is ParseError =>
  typeof x === "object" && x !== null && "error" in x;

/** Names are stored as typed but compared case-insensitively. */
export function normaliseName(raw: string): string | ParseError {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { error: "That name is empty." };
  if (name.length > MAX_NAME) {
    return { error: `That name is ${name.length} characters; keep it to ${MAX_NAME}.` };
  }
  if (name.includes(">")) {
    return { error: "A name cannot contain “>”, which separates a parent from a child." };
  }
  return name;
}

function parseWeightValue(raw: string): { weight: number; isPercent: boolean } | ParseError {
  const text = raw.trim();
  const isPercent = text.endsWith("%");
  const n = Number(isPercent ? text.slice(0, -1).trim() : text);
  if (!Number.isFinite(n)) return { error: `“${text}” is not a number.` };
  if (n < 0) return { error: "A weight cannot be negative." };
  if (isPercent && n >= 100) {
    return { error: "A share of 100% or more would leave nothing for anything else." };
  }
  if (!isPercent && n > MAX_WEIGHT) return { error: `Keep the weight under ${MAX_WEIGHT}.` };
  return { weight: n, isPercent };
}

// ------------------------------------------------------------------------ /add

export type AddObjective = { kind: "objective"; name: string; weight: number };
export type AddSub = { kind: "sub"; parent: string; name: string };

/**
 * `/add Guitar`        -> objective, default weight 1
 * `/add Guitar 3`      -> objective, weight 3
 * `/add Guitar > Scales` -> sub-objective under Guitar
 *
 * A trailing number is only read as a weight for an objective. Sub-objectives
 * carry no weight of their own (section 2.1), so `/add Guitar > Etude 3` keeps
 * "Etude 3" as the name — which is what someone naming an exercise means.
 */
export function parseAdd(args: string): AddObjective | AddSub | ParseError {
  const text = args.trim();
  if (!text) {
    return {
      error: [
        "<b>/add</b> — build the tree",
        "",
        "<code>/add Guitar</code> — new objective, weight 1",
        "<code>/add Guitar 3</code> — new objective, weight 3",
        "<code>/add Guitar &gt; Scales</code> — sub-objective under Guitar",
        "",
        "Weights are relative: 3 and 1 means three sessions of the first for",
        "every one of the second. They need not add up to anything.",
      ].join("\n"),
    };
  }

  if (text.includes(">")) {
    const parts = text.split(">");
    if (parts.length > 2) return { error: "Only one “>” — the tree is two levels deep." };
    const parent = normaliseName(parts[0]!);
    if (isError(parent)) return parent;
    const name = normaliseName(parts[1]!);
    if (isError(name)) return name;
    return { kind: "sub", parent, name };
  }

  // A trailing token that parses as a number is the weight.
  const tokens = text.split(/\s+/);
  let weight = 1;
  if (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    const asWeight = parseWeightValue(last);
    if (!isError(asWeight) && !asWeight.isPercent) {
      weight = asWeight.weight;
      tokens.pop();
    }
  }
  const name = normaliseName(tokens.join(" "));
  if (isError(name)) return name;
  return { kind: "objective", name, weight };
}

// --------------------------------------------------------------------- /weight

export type SetWeight = { name: string; weight: number; isPercent: boolean };

/** `/weight Guitar 4` or `/weight Guitar 30%` */
export function parseWeight(args: string): SetWeight | ParseError {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return {
      error: [
        "<b>/weight</b> — change an objective's share",
        "",
        "<code>/weight Guitar 4</code> — raw relative weight",
        "<code>/weight Guitar 30%</code> — converted to a raw weight",
        "<code>/weight Guitar 0</code> — keep the history, never recommend it",
      ].join("\n"),
    };
  }
  const value = parseWeightValue(tokens[tokens.length - 1]!);
  if (isError(value)) return value;
  const name = normaliseName(tokens.slice(0, -1).join(" "));
  if (isError(name)) return name;
  return { name, weight: value.weight, isPercent: value.isPercent };
}

// --------------------------------------------------------------------- /rename

export type Rename = { from: string; to: string };

/** `/rename Guitar > Classical guitar` */
export function parseRename(args: string): Rename | ParseError {
  const text = args.trim();
  if (!text.includes(">")) {
    return {
      error: [
        "<b>/rename</b> — rename an objective or sub-objective",
        "",
        "<code>/rename Guitar &gt; Classical guitar</code>",
      ].join("\n"),
    };
  }
  const parts = text.split(">");
  if (parts.length > 2) return { error: "Only one “>”, separating the old name from the new." };
  const from = normaliseName(parts[0]!);
  if (isError(from)) return from;
  const to = normaliseName(parts[1]!);
  if (isError(to)) return to;
  return { from, to };
}

/** A bare name argument, for /pause, /resume and /delete. */
export function parseName(args: string, command: string): string | ParseError {
  const text = args.trim();
  if (!text) return { error: `<code>${command} &lt;name&gt;</code>` };
  return normaliseName(text);
}

/**
 * Convert a requested share into a raw weight, against the sum of the OTHER
 * active weights (design section 2.4: percentages are a display concern, raw
 * weights are what is stored).
 *
 *   share = w / (othersSum + w)   =>   w = share * othersSum / (1 - share)
 *
 * With nothing else active any positive share is satisfied by any positive
 * weight, so 1 is as good an answer as any.
 */
export function weightForShare(share: number, othersSum: number): number {
  if (share <= 0) return 0;
  if (othersSum === 0) return 1;
  const w = (share * othersSum) / (1 - share);
  // Two decimals keeps /tree readable without meaningfully moving the share.
  return Math.round(w * 100) / 100;
}
