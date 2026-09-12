import { describe, expect, it } from "vitest";
import {
  MAX_NAME,
  isError,
  normaliseName,
  parseAdd,
  parseName,
  parseRename,
  parseWeight,
  weightForShare,
} from "../src/parse.js";
import {
  type Snapshot,
  findObjectiveByName,
  findSubByName,
  hasOnlyDefaultChild,
} from "../src/scoring.js";

const ok = <T>(x: T | { error: string }): T => {
  if (isError(x)) throw new Error(`expected success, got: ${x.error}`);
  return x;
};
const err = <T>(x: T | { error: string }): string => {
  if (!isError(x)) throw new Error("expected an error");
  return x.error;
};

describe("normaliseName", () => {
  it("trims and collapses whitespace", () => {
    expect(ok(normaliseName("  Classical   guitar \n"))).toBe("Classical guitar");
  });

  it("rejects empty, over-long, and separator-bearing names", () => {
    expect(err(normaliseName("   "))).toMatch(/empty/i);
    expect(err(normaliseName("x".repeat(MAX_NAME + 1)))).toMatch(new RegExp(String(MAX_NAME)));
    expect(err(normaliseName("a > b"))).toMatch(/cannot contain/i);
  });
});

describe("parseAdd", () => {
  it("adds an objective with the default weight", () => {
    expect(ok(parseAdd("Guitar"))).toEqual({ kind: "objective", name: "Guitar", weight: 1 });
  });

  it("reads a trailing number as the weight", () => {
    expect(ok(parseAdd("Guitar 3"))).toEqual({ kind: "objective", name: "Guitar", weight: 3 });
    expect(ok(parseAdd("Sight reading 0.5"))).toEqual({
      kind: "objective",
      name: "Sight reading",
      weight: 0.5,
    });
  });

  it("allows weight 0, which keeps history but is never recommended", () => {
    expect(ok(parseAdd("Dormant 0"))).toEqual({ kind: "objective", name: "Dormant", weight: 0 });
  });

  it("keeps a trailing number that is part of a multi-word name intact enough to use", () => {
    // "Study 2" is genuinely ambiguous; the weight reading wins, which is the
    // documented behaviour and recoverable with /rename.
    expect(ok(parseAdd("Study 2"))).toEqual({ kind: "objective", name: "Study", weight: 2 });
  });

  it("adds a sub-objective with >", () => {
    expect(ok(parseAdd("Guitar > Scales"))).toEqual({
      kind: "sub",
      parent: "Guitar",
      name: "Scales",
    });
  });

  it("does not read a trailing number as a weight for a sub-objective", () => {
    // Sub-objectives carry no weight (section 2.1), so this is just a name.
    expect(ok(parseAdd("Piano > Etude 3"))).toEqual({
      kind: "sub",
      parent: "Piano",
      name: "Etude 3",
    });
  });

  it("refuses a third level", () => {
    expect(err(parseAdd("A > B > C"))).toMatch(/two levels/i);
  });

  it("shows usage when given nothing", () => {
    expect(err(parseAdd("  "))).toMatch(/\/add/);
  });

  it("rejects a percentage, which is meaningless when creating", () => {
    // "30%" is not a raw weight, so it stays part of the name and then fails
    // only if the name is unusable; here it becomes the name.
    expect(ok(parseAdd("Guitar 30%"))).toEqual({
      kind: "objective",
      name: "Guitar 30%",
      weight: 1,
    });
  });
});

describe("parseWeight", () => {
  it("reads a raw weight", () => {
    expect(ok(parseWeight("Guitar 4"))).toEqual({
      name: "Guitar",
      weight: 4,
      isPercent: false,
    });
  });

  it("reads a percentage", () => {
    expect(ok(parseWeight("Guitar 30%"))).toEqual({
      name: "Guitar",
      weight: 30,
      isPercent: true,
    });
  });

  it("handles multi-word names", () => {
    expect(ok(parseWeight("Sight reading 2"))).toEqual({
      name: "Sight reading",
      weight: 2,
      isPercent: false,
    });
  });

  it("rejects a negative weight, a non-number, and an impossible share", () => {
    expect(err(parseWeight("Guitar -1"))).toMatch(/negative/i);
    expect(err(parseWeight("Guitar lots"))).toMatch(/not a number/i);
    expect(err(parseWeight("Guitar 100%"))).toMatch(/nothing for anything else/i);
  });

  it("shows usage when given too little", () => {
    expect(err(parseWeight("Guitar"))).toMatch(/\/weight/);
  });
});

describe("weightForShare", () => {
  it("solves for the weight that yields the requested share", () => {
    // Others sum to 7; asking for 30% should give 3, since 3/(7+3) = 0.3.
    expect(weightForShare(0.3, 7)).toBeCloseTo(3, 5);
    // Half of everything means matching the rest exactly.
    expect(weightForShare(0.5, 6)).toBeCloseTo(6, 5);
  });

  it("treats a zero share as weight zero", () => {
    expect(weightForShare(0, 7)).toBe(0);
  });

  it("returns a usable weight when nothing else is active", () => {
    // Any positive weight is 100% of the active set, so 1 is as good as any.
    expect(weightForShare(0.3, 0)).toBe(1);
  });

  it("round-trips through the share it was asked for", () => {
    for (const [share, others] of [
      [0.1, 9],
      [0.25, 12],
      [0.4, 5],
    ] as const) {
      const w = weightForShare(share, others);
      expect(w / (others + w)).toBeCloseTo(share, 2);
    }
  });
});

describe("parseRename and parseName", () => {
  it("splits a rename on >", () => {
    expect(ok(parseRename("Guitar > Classical guitar"))).toEqual({
      from: "Guitar",
      to: "Classical guitar",
    });
  });

  it("requires the separator", () => {
    expect(err(parseRename("Guitar"))).toMatch(/\/rename/);
  });

  it("reads a bare name", () => {
    expect(ok(parseName("  Guitar  ", "/pause"))).toBe("Guitar");
    expect(err(parseName("", "/pause"))).toMatch(/pause/);
  });
});

// ------------------------------------------------------------------ name lookup

function snap(): Snapshot {
  return {
    objectives: [
      { id: 1, name: "Guitar", weight: 3, active: 1, sort_order: 1 },
      { id: 2, name: "Spanish", weight: 4, active: 1, sort_order: 2 },
    ],
    subs: [
      { id: 10, objective_id: 1, name: "Guitar", is_default: 1, active: 1, sort_order: 0 },
      { id: 11, objective_id: 1, name: "Scales", is_default: 0, active: 1, sort_order: 1 },
      { id: 20, objective_id: 2, name: "Spanish", is_default: 1, active: 1, sort_order: 0 },
      { id: 21, objective_id: 2, name: "Vocabulary", is_default: 0, active: 1, sort_order: 1 },
      { id: 22, objective_id: 2, name: "Scales", is_default: 0, active: 1, sort_order: 2 },
    ],
    weeklyBySub: new Map(),
    totalBySub: new Map(),
    lastPracticedBySub: new Map(),
  };
}

describe("findObjectiveByName", () => {
  it("matches case-insensitively", () => {
    const r = findObjectiveByName(snap(), "gUiTaR");
    expect(r.kind === "found" && r.value.id).toBe(1);
  });

  it("reports a miss rather than guessing", () => {
    expect(findObjectiveByName(snap(), "Piano").kind).toBe("none");
  });
});

describe("findSubByName", () => {
  it("finds a unique child", () => {
    const r = findSubByName(snap(), "vocabulary");
    expect(r.kind === "found" && r.value.id).toBe(21);
  });

  it("reports ambiguity with qualified names when a child name repeats", () => {
    const r = findSubByName(snap(), "Scales");
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.names).toEqual(["Guitar > Scales", "Spanish > Scales"]);
  });

  it("resolves the ambiguity when scoped to a parent", () => {
    const r = findSubByName(snap(), "Scales", 2);
    expect(r.kind === "found" && r.value.id).toBe(22);
  });
});

describe("hasOnlyDefaultChild", () => {
  it("is false once a real child exists", () => {
    expect(hasOnlyDefaultChild(snap(), 1)).toBe(false);
  });

  it("is true for a freshly created objective", () => {
    const s = snap();
    s.subs = s.subs.filter((x) => x.id === 10);
    expect(hasOnlyDefaultChild(s, 1)).toBe(true);
  });
});
