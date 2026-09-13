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

/**
 * A plain decimal, optionally signed. Deliberately stricter than `Number()`,
 * which accepts things nobody types as a weight and would silently mis-read:
 * `Number("")` is 0 (so a stray "%" became "zero percent"), `Number("0x10")`
 * is 16, and `Number(" ")` is 0.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Does this token look like someone intending a weight? */
export function looksLikeWeight(raw: string): boolean {
  const text = raw.trim();
  return DECIMAL.test(text.endsWith("%") ? text.slice(0, -1).trim() : text);
}

function parseWeightValue(raw: string): { weight: number; isPercent: boolean } | ParseError {
  const text = raw.trim();
  const isPercent = text.endsWith("%");
  const digits = isPercent ? text.slice(0, -1).trim() : text;
  if (!DECIMAL.test(digits)) return { error: `“${text}” is not a number.` };
  const n = Number(digits);
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

  // A trailing token that looks like a weight IS the weight — and if it is
  // malformed, say so rather than quietly folding it into the name. Otherwise
  // `/add Guitar -1` creates an objective named "Guitar -1".
  const tokens = text.split(/\s+/);
  let weight = 1;
  if (tokens.length > 1 && looksLikeWeight(tokens[tokens.length - 1]!)) {
    const last = tokens[tokens.length - 1]!;
    const asWeight = parseWeightValue(last);
    if (isError(asWeight)) return asWeight;
    if (asWeight.isPercent) {
      return {
        error: [
          "A share needs something to take a share of, so it cannot be set while creating.",
          "",
          `<code>/add ${tokens.slice(0, -1).join(" ")}</code> first, then`,
          `<code>/weight ${tokens.slice(0, -1).join(" ")} ${last}</code>.`,
        ].join("\n"),
      };
    }
    weight = asWeight.weight;
    tokens.pop();
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

/** `parent` is set only by the three-segment form. */
export type Rename = { parent?: string; from: string; to: string };

/**
 * `/rename Guitar > Classical guitar`        — two segments: old > new
 * `/rename Guitar > Scales > Arpeggios`      — three: parent > old > new
 *
 * The three-segment form disambiguates a child name shared by two parents; it
 * is the counterpart of `Parent > Child` in `parseQualifiedName`.
 */
export function parseRename(args: string): Rename | ParseError {
  const text = args.trim();
  const parts = text.split(">");
  if (!text.includes(">") || parts.length > 3) {
    return {
      error: [
        "<b>/rename</b> — rename an objective or sub-objective",
        "",
        "<code>/rename Guitar &gt; Classical guitar</code>",
        "<code>/rename Guitar &gt; Scales &gt; Arpeggios</code> — when two parents share a child name",
      ].join("\n"),
    };
  }

  const names: string[] = [];
  for (const raw of parts) {
    const n = normaliseName(raw);
    if (isError(n)) return n;
    names.push(n);
  }
  return names.length === 3
    ? { parent: names[0]!, from: names[1]!, to: names[2]! }
    : { from: names[0]!, to: names[1]! };
}

/**
 * A name argument for /pause, /resume and /delete, optionally qualified by its
 * parent as `Parent > Child`.
 *
 * The qualified form exists because two objectives may each have a child of the
 * same name. Without it, `ambiguous()` could tell the user to qualify the name
 * while nothing in the bot accepted one — leaving both children permanently
 * impossible to pause, rename or delete.
 */
export type QualifiedName = { parent?: string; name: string };

export function parseQualifiedName(
  args: string,
  command: string,
): QualifiedName | ParseError {
  const text = args.trim();
  if (!text) {
    return {
      error: [
        `<code>${command} &lt;name&gt;</code>`,
        `<code>${command} Parent &gt; Child</code> — when two parents share a child name`,
      ].join("\n"),
    };
  }

  if (!text.includes(">")) {
    const name = normaliseName(text);
    return isError(name) ? name : { name };
  }

  const parts = text.split(">");
  if (parts.length > 2) {
    return { error: "Only one “>” — the tree is two levels deep." };
  }
  const parent = normaliseName(parts[0]!);
  if (isError(parent)) return parent;
  const name = normaliseName(parts[1]!);
  if (isError(name)) return name;
  return { parent, name };
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
