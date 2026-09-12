# Practice Tracker

A single-user Telegram bot that records practice sessions against a two-level
objective tree and tells you what to practise next, steering the current week's
distribution toward your target weights.

Implements steps 1–5 of `practice-tracker-design.md` § 8. TypeScript on
Cloudflare Workers with D1.

| Command | What it does |
|---|---|
| `/next` | The recommendation, one tap to record it. The everyday path. |
| `/log`, `/start` | The whole tree, with the recommendation pinned at the top. |
| `/stats` | This week's balance chart, then the all-time breakdown. |
| `/undo` | Removes the most recent session. |

Not built yet (design § 8 steps 6–7): `/add`, `/edit`, `/weights`, `/export`,
and the cron backup. Until they exist, edit the tree in `scripts/seed.sql` and
re-run the seed, or use `wrangler d1 execute` directly.

## Setup

```bash
npm ci            # never `npm install` — see Dependencies
npm test          # 67 unit tests, no network or account needed
npm run typecheck
```

Then, once per deployment. **Run every `wrangler` command from the project
directory** — it finds `wrangler.toml` by walking up from the working
directory, and outside the project it fails with "Required Worker name
missing".

1. **Create the bot** with [@BotFather](https://t.me/BotFather) and keep the token.
2. **Find your numeric user id** with [@userinfobot](https://t.me/userinfobot).
3. **Edit `scripts/seed.sql`** with your real objectives and weights.
5. **Create the database** and put the id it prints into `wrangler.toml`:
   ```bash
   npx wrangler login
   npx wrangler d1 create practice-tracker
   npm run db:remote && npm run seed:remote
   ```
6. **Set the secrets** — a bot token, and any random string as the webhook secret:
   ```bash
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put ALLOWED_USER_ID   # your numeric Telegram user id
   ```
   On the first of these, wrangler will offer to create a Worker called
   `practice-tracker` because none exists yet. Say yes.
7. **Deploy and register the webhook:**
   ```bash
   npm run deploy
   BOT_TOKEN=... WEBHOOK_SECRET=... ./scripts/set-webhook.sh \
     https://practice-tracker.<you>.workers.dev/webhook
   ```

## Running locally

No Telegram account or Cloudflare login needed. `.dev.vars` holds the local
values, and `TELEGRAM_API_BASE` points the bot at a stub instead of the real API.

```bash
npm run db:local && npm run seed:local
npm run dev
```

With the dev server up, run the end-to-end harness in another shell:

```bash
npm run e2e     # 27 checks, ~10s
```

It stands up a stub Bot API that `TELEGRAM_API_BASE` points at, replays
`test/fixtures/` through `POST /webhook`, and asserts on the calls the Worker
makes back out — including that a wrong secret, an unknown sender, and a
non-webhook route are all turned away **without making any Bot API call**.

Or drive it by hand:

```bash
curl -X POST http://127.0.0.1:8787/webhook \
  -H 'content-type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: local-dev-secret' \
  -d '{"update_id":1,"message":{"message_id":5,"chat":{"id":42},
       "from":{"id":42},"text":"/next"}}'
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. `npm ci --ignore-scripts` against the committed lockfile
2. `npm audit --audit-level=high` — **fails the build on any high advisory**,
   including ones that appear upstream later
3. `npm run typecheck`
4. `npm test` (67 unit tests)
5. `npm run e2e` (27 checks against a real `wrangler dev` with a seeded local D1)

Then, only on `main` and only if all of that passed, it deploys with
`npx wrangler deploy`.

Two deliberate choices:

- **Actions are pinned to commit SHAs, not tags.** A tag can be re-pointed at
  new code; a SHA cannot. Only first-party `actions/*` are used — no
  third-party action runs in the job that holds the Cloudflare token.
- **CI never migrates the database.** Deploy pushes the Worker only. An
  automatic schema change against the append-only log is not something a push
  to `main` should be able to do — run `npm run db:remote` by hand.

### Repository secrets the deploy needs

Settings → Secrets and variables → Actions:

| Secret | Where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template. Scope it to your account, and add **D1 → Edit** if you later let CI migrate. |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages → Account details, or `npx wrangler whoami` |

Use the *Edit Cloudflare Workers* template rather than a Global API Key: the
template is scoped to Workers, and a Global Key would let CI do anything to your
whole Cloudflare account.

`BOT_TOKEN`, `WEBHOOK_SECRET` and `ALLOWED_USER_ID` are **not** repository secrets — they live on
the Worker (`wrangler secret put`) and persist across deploys, so CI never needs
to see them.

### If `--file` fails against `--remote`

`wrangler d1 execute --remote --file=...` uploads the file through a separate
endpoint, which some sandboxed or proxied networks block ("fetch failed" with a
connectivity warning, while `--command` against the same database works fine).
If you hit that, apply the statements inline instead:

```bash
python3 - <<'EOF'
import subprocess
sql = open("migrations/0001_init.sql").read()
body = "\n".join(l for l in sql.splitlines() if not l.strip().startswith("--"))
for s in (x.strip() for x in body.split(";")):
    if s:
        subprocess.run(["npx","wrangler","d1","execute","practice-tracker",
                        "--remote","--command",s+";","-y"], check=True)
EOF
```

## The weekly window is not reconfigurable

`timezone` is **Europe/Lisbon** and `week_start_day` is **Monday**, in the
`config` table. Design § 4.1: changing either after data accumulates silently
reshuffles every historical bucket. Lisbon observes DST, so `src/week.ts`
resolves local midnight properly rather than doing offset arithmetic — the weeks
containing a transition are 167 and 169 hours long, and there are tests for
both.

## The all-time image is off by default

Design § 6.2 asks for a PNG of the all-time distribution. It is built
(`src/chart-svg.ts` + `src/chart.ts`, rasterised in-Worker with
`@resvg/resvg-wasm`, no third-party service) but **disabled**, because it does
not fit the free plan's CPU budget. Measured on this machine:

| | CPU |
|---|---|
| `buildSvg` (SVG string) | 0.013 ms |
| `initWasm` (once per isolate) | 23.4 ms |
| `Resvg.render` @1x | 17.2 ms |
| `Resvg.render` @2x | 20.6 ms |

Workers allow **10 ms CPU per invocation on the free plan** (paid defaults to
30 s). The render is roughly twice the free budget, and the first `/stats` in an
isolate also pays `initWasm`. Every text path, by contrast, runs in about 4–5 ms
wall time including D1.

So `CHART_IMAGE = "off"` in `wrangler.toml`. On a paid plan, set it to `"on"`.
`/stats` sends its text views either way, and the text breakdown lists every
sub-objective's total — which is also what keeps the chart's lightest, lowest
contrast segment accessible when it is too narrow to label.

These figures are from Node with the same wasm, not from a deployed Worker.
Confirm with `npx wrangler tail` before trusting them on a paid plan.

## Dependencies

Four dev dependencies, one runtime dependency, all **pinned exactly**:

| package | pin | published |
|---|---|---|
| `wrangler` | 4.131.1 | 2026-09-11 |
| `@cloudflare/workers-types` | 5.20260911.1 | 2026-09-11 |
| `typescript` | 7.0.2 | 2026-07-08 |
| `vitest` | 4.1.11 | 2026-08-18 |
| `@resvg/resvg-wasm` | 2.6.2 | 2024-03-26 |

`npm audit` reports **0 vulnerabilities**.

**Policy.** Pin exactly, and prefer packages at least two weeks old so a freshly
published version cannot be a supply-chain surprise. `wrangler` and
`workers-types` are a deliberate, reasoned exception: the two-week-old wrangler
(4.127.1) carried three high advisories via `sharp` → `miniflare`, and the
vulnerable range covered *every* version old enough to pass the rule, so the
choice was a known CVE or a fresh publish. Upgrading was allowed only on the
condition that it introduce no new dependencies, which was checked rather than
assumed:

- The wrangler tree went **91 packages → 91 packages, zero added, zero
  removed**. All 35 changes were version bumps of packages already present —
  `sharp` 0.35.2 → 0.35.4 (the version the advisory names as fixed), plus
  `workerd`/`miniflare` on the same Cloudflare release train.
- `@cloudflare/workers-types` had to move with it (wrangler 4.131.1 peer-requires
  `^5.20260911.1`). It has **zero dependencies** and ships a single
  `index.d.ts` — compile-time only, never in the Worker bundle.

Re-check with `npm audit` and, before any future bump,
`npm install wrangler@<new>` in a scratch directory and diff the lockfile
package *names*. A bump that only moves versions of packages already in the tree
is a different risk from one that adds new ones.

Other choices that keep the tree small:

- `package-lock.json` is committed; install with `npm ci` so transitive versions
  are frozen too. `--ignore-scripts` works (`workerd` ships as a
  platform-specific optional dependency, not a postinstall download).
- No Telegram library: the five Bot API calls used are a ~110-line `fetch`
  wrapper in `src/telegram.ts`. No web framework — there is one route. No date
  library — `Intl` knows Lisbon's DST rules. No charting library — a bar chart
  is arithmetic and `<rect>` elements.
- The font is **vendored, not installed** (`vendor/`, with `PROVENANCE.txt`
  recording the upstream release, both checksums, and the subsetting command).
  resvg cannot draw text without font data; a 22 KB subset of DejaVu Sans is a
  smaller trust surface than a font package.

## Layout

```
src/week.ts        weekly bucket arithmetic, DST-aware      pure
src/scoring.ts     both recommendation stages, all tie-breaks pure
src/format.ts      the § 6.1 balance chart and messages     pure
src/chart-svg.ts   the § 6.2 SVG                            pure
src/chart.ts       resvg rasterisation                      Worker-only
src/db.ts          D1 → Snapshot, and the two writes
src/telegram.ts    Bot API client
src/commands.ts    commands and callbacks
src/index.ts       route, secret check, allowlist, dispatch
```

Everything marked pure is unit-tested. Aggregation happens in SQL so the
recommender is a function of plain data, and so the Worker spends as little CPU
as possible. `chart-svg.ts` is split from `chart.ts` only so the geometry is
testable — the `.wasm` and font imports resolve in the Worker bundle but not in
vitest.

## Where this deviates from the design document

1. **Stage 1 uses the D'Hondt divisor form** `argmax(weight / (points + 1))`
   rather than § 4.2's `argmin(points / weight)`. Same method, same target
   shares, but both of the document's patches disappear: Monday's universal
   `0/w` tie becomes a plain ranking by weight, and there is no division by zero
   to special-case. Tested to reproduce 3/4/2/1 exactly.
2. **`recorded_at` defaults to `strftime('%Y-%m-%dT%H:%M:%fZ','now')`**, not
   `datetime('now')`. The latter emits `2026-09-12 17:04:00` — space-separated —
   which does not sort lexicographically against the `T`-separated ISO bound the
   weekly query passes in. This was a real bug in the schema as written.
3. **`last_practiced_at` is derived** as `MAX(recorded_at)`, never a column, per
   the § 3.3 invariant that only `sessions` holds state.
4. **The secret token comparison hashes both sides** before
   `crypto.subtle.timingSafeEqual`, so the buffers are always 32 bytes: no throw
   on length mismatch, and no length leak.
5. **The scorer takes an `rng` parameter**, so § 4.3's random tie-break among
   never-practised siblings is reproducible under test — the document's own
   objection to randomness, answered rather than dodged.
6. **`ALLOWED_USER_ID` is a Wrangler var**, not a literal in source.
7. **§ 6.2's QuickChart shortcut is rejected**, and the image is gated (above).
   QuickChart would send objective names and point counts to a third party.
8. **The § 6.2 chart uses one stepped hue, not four colours.** Identity already
   comes from each row's label, so per-objective hues would be decoration.
9. **`/stats` also sends an all-time text breakdown**, which § 6.2 leaves to the
   image. It is what makes the view useful with the image off.
