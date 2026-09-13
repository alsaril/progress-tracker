# Working on this repo

Facts live elsewhere: [IMPLEMENTATION.md](IMPLEMENTATION.md) has setup, CI,
dependency policy and every deviation from the design document;
[README.md](README.md) is for whoever uses the bot. This file is the part that
was never written down — the habits and judgements that shaped the code, and the
traps that have already caught someone.

## The bug this repo keeps producing

**One rule implemented twice, then drifting apart.** Every single reuse finding
in two review rounds was this, and it has cost more than anything else here:

- "Is this objective flat?" existed three times — `isFlatObjective`, an inline
  check in the `/log` keyboard, and a third in `/tree` that counted *paused*
  children. So one objective was a one-tap button in `/log` and an itemised
  parent in `/tree`.
- `nextLabel` collapsed a default child into its parent's name using a
  different test than the keyboard, so three entries under one objective all
  rendered identically.
- `/undo` guessed the same collapse with `subName === objectiveName`, which
  named a renamed objective's child by a name the user had never seen.

The tell: if you are about to write `kids.length === 1 && kids[0].is_default`,
or compare two names to decide how to print something — stop, and call the
existing predicate. `isFlatObjective`'s doc comment says the rule "must agree"
with the keyboard; that sentence exists because it did not.

## Verify; don't assert

The user asks for evidence, repeatedly and rightly. Concretely:

- **Reproduce a reported bug before fixing it.** Both review rounds were
  accurate, and both had details slightly off — the prototype-key list was
  shorter than claimed, the column gap was six characters not one. You only
  learn that by running it.
- **Prove a new test actually bites.** After fixing the label collapse I
  reverted the fix, confirmed three tests went red, and restored it. A
  regression test that would have passed against the bug is decoration.
- **Measure instead of estimating.** The `/stats` image is off because a
  benchmark said the render costs ~20 ms CPU against a 10 ms budget — not
  because it felt heavy. Nothing about size, speed or feasibility should be
  claimed here without a number.
- **Never report success from a command whose output you did not read.** A
  `tsc --noEmit | head -5 && echo "clean"` pipeline will happily print "clean"
  while tsc fails, because `head` succeeded. That happened.

## Suspect your measurement before the code

A striking share of alarming results here were the *measurement* being wrong:

| Symptom | Actual cause |
|---|---|
| "Commit count doubled after rewrite" | `--all` includes `refs/original/*` |
| "Rows are different widths" | `awk` counts bytes; block glyphs are 3-byte UTF-8 |
| "Reply routing is broken" | the test helper prepended a blank line |
| "Email is gone from all objects" | `tr` died on binary and truncated the pipe |

When a check looks worse than the code could plausibly be, re-measure — then
verify the re-measurement. But do not stop there and assume: the label-collapse
bug looked like a measurement artifact and was entirely real.

## The pure/impure line

`week.ts`, `scoring.ts`, `format.ts`, `parse.ts`, `keyboard.ts` and
`chart-svg.ts` are pure. `db.ts`, `telegram.ts`, `chart.ts`, `edit.ts`,
`commands.ts` and `index.ts` are not. Decide which side a new module is on
before writing it.

`chart-svg.ts` is split from `chart.ts` for exactly one reason: the `.wasm` and
font imports only resolve inside the Worker bundle, so anything sharing a file
with them cannot be unit-tested. Keep the geometry out of the rasteriser.

Aggregation belongs in SQL, not in the scorer. The scorer takes an already
aggregated snapshot precisely so it can be a pure function of plain data.

## Seams that exist on purpose

Three things look like over-engineering and are not. Removing them breaks the
ability to test without credentials:

- **`TELEGRAM_API_BASE`** — points the bot at a local stub, which is why
  `npm run e2e` needs no Telegram account and can assert on outgoing calls.
- **the injected `rng`** — stage 2's random tie-break among never-practiced
  siblings would otherwise be untestable. The design document itself objects to
  randomness on those grounds; this is the answer to that objection.
- **`now` passed through `Ctx`** — every weekly-bucket test picks its own
  instant, including both DST transitions.

Corollary: no `Date.now()` or `Math.random()` inside pure code.

## Errors are return values

`parse.ts` and `edit.ts` return `{ error: string }` rather than throwing, and
that string **is** the message the user sees — which is why parse failures read
like help text with examples. Keep them written for a person, not a log.

Exceptions are for genuinely exceptional things. A cosmetic call must never gate
a state change: `answerCallbackQuery` is deliberately `.catch(() => {})`,
because it fails routinely for reasons unrelated to the tap and letting it throw
meant the button recorded nothing and said nothing.

## Two invariants worth protecting

**The session log is the only thing that cannot be rebuilt.** `sessions` is
append-only; every total is derived. `/delete` refuses the moment anything is
recorded and points at `/pause`; `/undo` removes exactly one row. If a new
feature could remove sessions, it needs the same care — and back up before any
destructive operation on the remote database.

**Fail closed, and silently.** Unknown sender, wrong chat, bad secret: empty
body, no hint the bot exists. A missing `ALLOWED_USER_ID` rejects *everything*
rather than allowing anything. And always answer Telegram 200 after logging an
internal error, or a bug becomes a retry storm.

## The design document is authority, not scripture

`practice-tracker-design.md` is unusually complete and worth following. But it
does contain a real bug — its `recorded_at` default of `datetime('now')` emits a
space-separated timestamp that cannot sort against the ISO bound its own weekly
query passes in, while the comment beside it claims ISO-8601 — and in places its
stated mechanism fights its stated goal.

When that happens, follow the goal and record the deviation with its reasoning
in IMPLEMENTATION.md. The D'Hondt reformulation is the model: same target
shares, but both of the document's own patches — the Monday all-tied tie-break
and the divide-by-zero guard — simply stop being necessary.

## What to ask about, and what to just decide

Decide: naming, structure, test strategy, which of two equivalent forms to use.
The user does not want to be consulted on those and says so by not answering.

Ask first: anything irreversible or outward-facing. The timezone (it permanently
fixes every historical bucket), repository visibility, a history rewrite, a
force-push, an account-wide subdomain. Also flag — don't silently absorb — a
conflict between two of their own constraints: the wrangler CVE pitted "packages
at least two weeks old" against "no known vulnerabilities", and the resolution
was theirs to make.

When blocked by something you cannot do, say so plainly with the exact commands
they need, rather than working around it.

## Supply chain

Pin exactly, prefer packages at least two weeks old, commit the lockfile,
install with `npm ci`. Before any dependency bump, install it in a scratch
directory and **diff the lockfile package *names***: a bump that only moves
versions of packages already present is a different risk from one that adds new
ones. That check is what justified the wrangler upgrade (91 packages → 91, zero
added).

The repository is public. Personal data belongs in Worker secrets, not
`wrangler.toml` — `ALLOWED_USER_ID` lives as a secret purely for that reason,
and Workers resolves secrets and vars through the same `env`, so it costs
nothing.

## Things that look like bugs and are not

Check here before "fixing" any of these:

- **`Gamma → Gamma`** in a label. Correct once a default child has siblings: it
  is one entry among several and needs naming. The cure is renaming it to
  *General*, which the bot suggests.
- **No "done for the week"**, ever. Weights are proportions, not amounts. Four
  sessions and forty are both perfectly balanced. Adding absolute targets
  changes what a weight *means* — a redesign, not a config flag.
- **A missed week vanishes** rather than becoming debt. Intended.
- **`/add Study 2`** reads `2` as a weight, not part of the name. Documented,
  ambiguous by nature, recoverable with `/rename`.
- **`/add Guitar 30%`** is refused. A share needs something to take a share of,
  which does not exist at creation time.
- **A paused sub-objective's points still count** toward its objective's weekly
  share. The effort happened; pausing only stops it being offered.
- **`load()` makes two round-trips, not one.** The weekly query needs the window
  as a parameter, and the window depends on the timezone stored in `config`, so
  the config read cannot be batched with the query that consumes it. It is I/O
  wait rather than CPU, so it does not threaten the 10 ms budget.

## Not built, deliberately

`/export` and the cron backup (design § 8 step 7). Alternative window lengths —
`weekBounds` anchors buckets to the weekday cycle, so only 7 works, and
`window_days` is clamped to 7 rather than half-honouring anything else; a real
fortnight needs an epoch anchor. A third tree level: the schema and both
recommendation stages assume two.
