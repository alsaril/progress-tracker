# Practice Tracker — Design Document

## 1. Purpose

A single-user Telegram bot for tracking practice sessions against a two-level
tree of objectives. Each completed session is worth one point. The tool must:

- record a point in one or two taps from an iPhone or iPad;
- show how many points each objective and sub-objective has;
- show a distribution graph in two variants (raw all-time, and weight-adjusted
  for the current week);
- answer "what should I practice next?" in a way that drives this week's actual
  distribution toward the target distribution.

Planning is **weekly**: everything is recorded permanently, but the recommender
considers only the current week, so activities can be added, paused, and
reweighted over time without any of it distorting future advice.

Personal tool. Multi-user, sharing, and collaboration are explicit non-goals.

---

## 2. Domain model

### 2.1 Structure

The tree is **at most two levels deep**:

- **Objectives** (root level) — carry a `weight` expressing target share of
  effort.
- **Sub-objectives** (leaf level) — belong to exactly one objective, have no
  weight of their own; siblings are equally important by definition.

No third level. Schema and queries may assume this.

### 2.2 Objectives without sub-objectives

An objective may be practiced directly, with no sub-objectives of its own.

**Implementation: every objective always has at least one sub-objective.** When
an objective is created, a default child is created with it, flagged
`is_default = 1` and named after the parent. Points are therefore *always*
recorded against a leaf, and every query, aggregate, and both stages of the
recommendation stay uniform with no special cases.

Presentation rules:

- An objective whose only child is the default child is shown as a single flat
  item. The bot skips the second keyboard and records straight to the default
  child on one tap.
- Adding a real sub-objective to such an objective: the default child stays,
  keeps its accumulated history, and becomes visible in the list alongside the
  new one. Its name can be edited (e.g. "General", "Unsorted"). It is never
  silently deleted, because its points are real.
- The default child may be deactivated by hand once real children exist and its
  history no longer matters.

### 2.3 Points

- A point is recorded only against a sub-objective.
- An objective's total is the sum of its children's totals — always derived,
  never stored.
- One session = one point. The `points` column is `REAL` so a session can be
  worth more, or be reversed with a negative value, without a schema change.
  The bot records `1`.

### 2.4 Weights

- Weights belong to objectives only.
- **A weight is any nonnegative real number.** Weights are relative and need not
  sum to anything. Shares are derived on read by renormalising over the
  **active** set:

  ```
  effective_weight(o) = o.weight / SUM(weight WHERE active = 1)
  ```

- Weights are mutable at any time. Because points are an append-only log and
  every aggregate is derived, changing a weight retroactively reshapes every
  graph and recommendation with no migration.

Consequences worth relying on:

- Editing one objective's weight requires touching no other row — `3` versus `1`
  is easier to reason about than recomputing four percentages, and there is no
  invariant to repair afterwards.
- Pausing or adding an objective needs no rebalancing pass; the remaining
  weights simply renormalise over a different denominator.
- Percentages are a **display** concern. `/weights` shows each objective's
  derived share alongside its raw weight, and editing accepts either a raw
  number or a `%` value (converted to a raw weight against the current sum).

Two degenerate cases to guard:

- `weight = 0` means "keep the history, never recommend it" — distinct from
  `active = 0`, which also hides it from stats. Stage 1 must treat a zero weight
  as an infinite ratio rather than dividing by zero.
- If every active objective has weight 0 (or none are active), the recommender
  returns "nothing to practise" instead of throwing.

---

## 3. State

### 3.1 Storage

**Cloudflare D1** (SQLite). One database, three tables. Years of use is on the
order of thousands of rows — no partitioning, no archival, no cached aggregates.

### 3.2 Schema

```sql
CREATE TABLE objectives (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  weight      REAL    NOT NULL DEFAULT 1.0   CHECK (weight >= 0),  -- relative, renormalised on read
  active      INTEGER NOT NULL DEFAULT 1,    -- 0 = paused, history retained
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sub_objectives (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  objective_id INTEGER NOT NULL REFERENCES objectives(id),
  name         TEXT    NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0,   -- auto-created stand-in child
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_objective_id INTEGER NOT NULL REFERENCES sub_objectives(id),
  recorded_at      TEXT    NOT NULL DEFAULT (datetime('now')),  -- UTC ISO-8601
  points           REAL    NOT NULL DEFAULT 1.0,
  note             TEXT
);

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: week_start_day ('MO'), timezone (IANA name), window_days ('7')

CREATE INDEX idx_sessions_sub  ON sessions(sub_objective_id);
CREATE INDEX idx_sessions_time ON sessions(recorded_at);
```

There is no per-week table. Every weekly figure is derived from `recorded_at`
at read time.

### 3.3 The one invariant

**`sessions` is append-only and is the single source of truth.** Nothing else
may hold a derived total. Corrections are new rows with negative `points`, or a
hard delete of one specific row — never an adjustment to a running counter.

This is the only expensive-to-reverse decision here. Everything in section 4 is
a pure function of this table plus current weights, changeable at any time with
no data migration.

Timestamps stored in UTC; converted to local time at read time for any
"today" / streak logic.

---

## 4. Recommendation algorithm

Planning runs on a **weekly window**. Everything is recorded forever, but the
recommender only looks at the current week; all-time totals are for statistics,
not for deciding what to do next.

### 4.1 The weekly window

- A week is a fixed, non-overlapping bucket: `[week_start, week_start + 7 days)`
  in **local time**, with a configured start day (default Monday).
- `weekly_points(x)` = sum of `points` for `x` within the current bucket.
- The bucket is a pure function of `recorded_at`. Nothing is stored per-week, no
  rollover job runs, and the window can be changed or removed at any time.

**Fix the week start day and the local timezone once, before any data
accumulates.** Changing either later silently reshuffles every historical
bucket, which is the one thing in this design that quietly rewrites the past.

Properties this gives you:

- A week is interpretable. "You owe three theory sessions before Sunday" is a
  plan.
- Activities can be added, paused, and reweighted freely over time. An item
  created on Wednesday starts the next Monday level with everything else.
- A missed week disappears instead of becoming debt. Intended.

### 4.2 Stage 1 — choose the objective

```
selected = argmin( weekly_points(objective) / effective_weight(objective) )
           over active objectives with weight > 0
tie-break: largest effective_weight first
then:      lowest sort_order, then lowest id
```

Jefferson/D'Hondt divisor method. Repeatedly taking the minimum ratio converges
exactly on the target shares and self-corrects within the week — no schedule, no
quotas, no catch-up bookkeeping.

The tie-break matters more than it looks: at the start of every week each
objective sits at `0 / w`, so **every** objective is tied. Breaking toward the
largest weight makes the opening picks of the week follow the intended
proportions instead of arbitrary insertion order. Getting this wrong means the
big objectives get served last every Monday.

Objectives with `weight = 0` are excluded rather than treated as `0/0`. If no
active objective has a positive weight, the recommender returns "nothing to
practise" instead of throwing.

### 4.3 Stage 2 — choose the sub-objective

```
selected = argmin( weekly_points(sub) )
           over active children of the selected objective
tie-break:  oldest last_practiced_at first, NULLs (never practised) first
then:       random among never-practised items
then:       lowest sort_order, then lowest id
```

Siblings are equally weighted, so this is a plain minimum. For an objective whose
only child is the default one, this stage is a no-op.

Weekly counts alone give no signal on Monday, when every child is at zero. The
**`last_practiced_at` tie-break carries the rotation across the week boundary**:

- On Monday everything is tied at 0 and the pick goes to whichever child has
  gone longest untouched, so rotation continues seamlessly from last week.
- A brand-new child has `last_practiced_at = NULL`, sorts first, is picked
  **once**, then joins the back of the queue like everything else. It cannot
  dominate its siblings.

`last_practiced_at` already comes out of the aggregate query, so this costs
nothing.

Randomness is used only among items that have genuinely never been practised,
where the order is arbitrary and a fixed `id` ordering would be a lie. It is
deliberately **not** the general tie-break: random rotates only in expectation,
so with four tied children there is a 25% chance of repeating the same one
immediately, which produces exactly the clumping the rotation is meant to
prevent. It is also non-reproducible — `/next` would change its answer on every
refresh, could not be unit-tested, and could never explain itself.

### 4.4 Ratios, not targets

Weights express **proportions only**. There is no absolute weekly target and no
"done for the week" state — a 30/40/20/10 split is satisfied equally well by 4
sessions or 40. The system shapes distribution; total volume is the user's
business.

A consequence to accept knowingly: nothing in the tool ever answers "am I
finished this week," and a light week is invisible rather than a shortfall. This
is a deliberate choice, not an oversight. Adding absolute targets later means
changing what a weight *means*, so it is a redesign rather than a config flag.

### 4.5 Deferred on purpose

All one-line changes to a pure function; must not block v1:

- **Cooldown** — suppress an item for N hours after practice.
- **Alternative window lengths** — the window is a parameter, so a fortnight is a
  config change.

Implement scoring as a single pure function (input: sessions + tree + config
containing `week_start_day`, `timezone`, `window`; output: ranked list) so all of
the above stay config rather than surgery.

---

## 5. Interface — Telegram bot

**Telegram is the only client.** No PWA, no public HTTP API, no bearer tokens,
no domain concerns, no offline queue (Telegram handles delivery), and identical
behaviour on iPhone, iPad, and desktop.

The Worker exposes exactly one route: `POST /webhook`. Everything else 404s.

### 5.1 Commands

| Command | Behaviour |
|---|---|
| `/start`, `/log` | Inline keyboard of active objectives. Tapping one either records immediately (if it only has a default child) or opens its sub-objective keyboard. |
| `/next` | Current recommendation for this week, with a one-tap "record it" button. The everyday path. |
| `/stats` | This week's balance view, then the all-time distribution image (section 6). |
| `/undo` | Deletes the most recent session, shows what was removed. |
| `/weights` | Target share vs this week's actual share, raw weights alongside; buttons to adjust. |
| `/add`, `/edit`, `/pause` | Manage objectives and sub-objectives. |
| `/export` | Sends the full session log as a JSON or CSV document. |

### 5.2 Interaction principles

- The recommended item is always pinned at the top of the `/log` keyboard, so
  the common case is one tap.
- Every recorded point is acknowledged with the new total and an inline **Undo**
  button on that same message — no separate command needed for a mis-tap.
- Callback data carries IDs only (`rec:<sub_id>`), never names.
- Answer every `callback_query` promptly, and edit the existing message rather
  than sending a new one, to keep the chat from filling with noise.

---

## 6. Visuals

Two variants, both delivered into the chat.

### 6.1 Balance view — this week, the daily one

A **text chart in a monospace code block**, rendered with Unicode block
characters. Scoped to the **current week**. Diverging bars of
`actual_share − target_share` per objective, zero-centred:

```
Week of 7 Sep  ·  14 sessions  ·  3 days left

                          target  actual
Technique   ████▌            30%    38%   +8
Repertoire      ▐███         40%    33%   -7
Theory          ▐█           20%    17%   -3
Sight-read  ▌                10%    12%   +2

Next: Theory → Intervals
```

Bars to the right are what you owe, to the left are what you have overdone.
Zero dependencies, renders instantly, readable on a phone, and it is the view
that gets used every day. Use a fixed character width and `<pre>` with HTML
parse mode so alignment survives.

Because shares are relative, the header shows the session count but never a
target count or a completion percentage — there is nothing to complete
(section 4.4).

### 6.2 Distribution view — all time, the full picture

A **PNG image** sent with `sendPhoto`, over **all history**, showing points per
objective with sub-objective breakdown — stacked horizontal bars, or a two-ring
sunburst if the hierarchy is worth showing visually. Answers "where has my time
actually gone", which is the question the weekly view deliberately cannot.

Rendering, in order of preference:

1. **Self-contained:** build the SVG as a string in the Worker (it is a bar
   chart — no charting library needed, just arithmetic and `<rect>` elements),
   then rasterise with `@resvg/resvg-wasm`, which runs in Workers. Upload the
   buffer as multipart `sendPhoto`. No third party, no data leaves the account.
2. **Shortcut:** build a QuickChart.io URL and pass it to `sendPhoto` as a URL —
   Telegram fetches and renders it. Roughly zero code. Trade-off: objective
   names and counts pass through a third-party service.

Start with (2) if it gets `/stats` working on day one and swap in (1) later —
keep chart generation behind one function returning a photo payload so the call
site never changes.

### 6.3 Weekly history — optional, later

Sessions per week over the last ~12 weeks as a sparkline or small bar chart, and
per-objective share drift across those weeks. This is where the append-only log
pays off: weekly buckets are a pure function of `recorded_at`, so this view can
be added at any time with no schema change and full retroactive history.

The three views come from the same aggregate function with different date
bounds, so they can never disagree.

---

## 7. Deployment and security

### Deployment

- **Cloudflare Worker** + **D1 binding**, deployed with Wrangler.
- Free `*.workers.dev` subdomain with HTTPS included. No domain purchase, and
  since the URL is only ever a webhook target pasted once into `setWebhook`, its
  appearance is irrelevant.
- Bot token stored as a Worker secret (`wrangler secret put BOT_TOKEN`).

### Security

- Register the webhook with a `secret_token`; reject any request whose
  `X-Telegram-Bot-Api-Secret-Token` header does not match, using a
  constant-time comparison. This is the only thing standing between the Worker
  and the open internet, and it is enough.
- Check `message.from.id` (and `callback_query.from.id`) against a hardcoded
  allowlist of one. Ignore everything else silently — no reply, no error, no
  signal that the bot exists.
- Never echo the bot token, and keep it out of logs and error messages.
- No user-facing auth, no sessions, no tokens to paste anywhere.

### Backup

A scheduled Worker cron that dumps `sessions` to JSON, plus the `/export`
command. The log is the only thing that cannot be reconstructed.

---

## 8. Build order

1. Schema, migrations, and an initial-data script for the objective tree (each
   objective created with its default child and a relative weight).
2. Worker webhook endpoint, secret-token check, user allowlist.
3. Scoring module as a pure, unit-tested function — weekly bucketing, both
   stages, all tie-breaks. Test the Monday all-tied case and the newly-added
   sub-objective case explicitly; they are where this design earns its keep.
4. `/log` and `/next` with inline keyboards and Undo. **Usable daily from here.**
5. `/stats` — text balance view first, then the image.
6. `/add`, `/edit`, `/weights` (raw or `%` input, derived shares on display).
7. `/export` and cron backup.

## 9. Non-goals

Multi-user, sharing, timers or duration tracking, calendar integration, streaks
and gamification, a third tree level, absolute weekly targets or any "done for
the week" state, any client other than Telegram.
