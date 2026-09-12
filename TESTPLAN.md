# Production smoke test, on dummy data

A walkthrough for the live bot, using throwaway objectives named `Alpha`,
`Beta`, `Gamma` so nothing here touches a real tree. Every expectation is exact:
the recommender is deterministic except for one documented case, so if a
sequence below differs, something is genuinely wrong rather than just surprising.

Work through it in Telegram. Roughly ten minutes.

Deployed at **https://practice-tracker.alsaril.workers.dev**, with the webhook
registered and verified: `pending_update_count: 0`, no `last_error_message`, and
`allowed_updates` narrowed to `message` and `callback_query`.

If you ever need to re-register it (a changed subdomain, or a rotated secret):

```bash
BOT_TOKEN=... WEBHOOK_SECRET=... ./scripts/set-webhook.sh \
  https://practice-tracker.alsaril.workers.dev/webhook
```

A `last_error_message` mentioning 403 means the `WEBHOOK_SECRET` on the Worker
and the one passed here disagree.

The public surface was checked from outside, and is a closed door: `GET /` and
`GET /webhook` both 404, `POST /webhook` without a valid secret token 403, and
every rejected request returns an **empty body** — no version banner, no error
detail, nothing confirming a bot lives there.

---

## 1 · Silence for strangers, and an empty start

| Do | Expect |
|---|---|
| Send `/next` | A reply. If you get **nothing at all**, `ALLOWED_USER_ID` does not match your account — the bot ignores unknown senders without a word, by design. |
| Send `/tree` | **"No objectives yet."** plus `/add` usage. |
| Send `/next` | **"Nothing to practise"** — not an error, not a crash. |
| Send `/stats` | A week header reading `0 sessions`, then "No sessions recorded yet." |

The point of the last two: the degenerate empty state is a normal answer.

## 2 · Build a throwaway tree

| Do | Expect |
|---|---|
| `/add Alpha 3` | "Added **Alpha** with weight 3", then the tree. |
| `/add Beta 2` | Tree now shows `Alpha w=3 50%` and `Beta w=2 33%`… |
| `/add Gamma 1` | …and finally **Alpha 50% · Beta 33% · Gamma 17%**. |

**Watch the shares move as you add.** Alpha reads 100% alone, then 60%, then
50%. Nothing rewrote Alpha's weight — shares are derived over the active set on
every read, which is what makes adding and pausing free of any rebalancing pass.

| Do | Expect |
|---|---|
| `/add Alpha 3` again | "There is already an objective called Alpha." |
| `/add A > B > C` | "Only one '>' — the tree is two levels deep." |
| `/weight Alpha -1` | "A weight cannot be negative." |
| `/weight Nope 3` | "No objective called 'Nope'." |

## 3 · The opening of a week follows weight order

This is the case the design document needed a special tie-break for: on Monday
every objective sits at zero, so naively they are all tied and insertion order
decides. It should not.

| Do | Expect |
|---|---|
| `/next` | **Alpha** — the largest weight, not the first created and not the last. |

Its subtitle names the runner-up: *"furthest behind its share; next would be
Beta"*.

## 4 · Six sessions land exactly on target

Tap **✓ Record** on whatever `/next` offers, then send `/next` again, six times.
The recommendation is fully deterministic here, so the sequence is predictable:

| # | Expect |
|---|---|
| 1 | Alpha |
| 2 | Beta |
| 3 | Alpha |
| 4 | Alpha |
| 5 | Beta |
| 6 | Gamma |

Totals now **Alpha 3 · Beta 2 · Gamma 1** — exactly the 3 : 2 : 1 you asked
for, with no schedule and no quotas, just "whoever is furthest behind, next".

| Do | Expect |
|---|---|
| `/stats` | Every bar sits on the axis (`│`), target and actual both 50/33/17, and no `+`/`-` deltas. |

A chart with nothing to show is the correct output when the week is perfectly
balanced. Each acknowledgement along the way also showed a running
`N this week · N all time`.

## 5 · Undo, twice

| Do | Expect |
|---|---|
| Tap **↩ Undo** on the last acknowledgement | "Removed **Gamma**", message edited in place rather than a new one. |
| Tap the same **↩ Undo** again | "That session is already gone." — not a second deletion, not an error. |
| `/next` | **Gamma** again, since it is now owed that session back. |

Record it again to get back to 3 : 2 : 1.

## 6 · Sub-objectives rotate, and a new one waits its turn

| Do | Expect |
|---|---|
| `/add Gamma > One` | "Added **One** under **Gamma**", plus a note that Gamma now also keeps its original default entry — **with the session already logged against it** — and can be renamed or paused. |
| `/add Gamma > Two` | Added. |
| `/log` | Gamma is now `Gamma ›` (a drill-down) instead of a one-tap button; Alpha and Beta are still one tap. |
| Tap `Gamma ›` | Three children: `Gamma`, `One`, `Two`, plus `‹ Back`. |

That default child is section 2.2 of the design doing its job: it is never
silently deleted, because its point is real.

Now force Gamma to the front and watch stage 2 rotate. Record Gamma four times
in a row (via `/log` → `Gamma ›`, or by repeatedly recording whatever `/next`
says until Gamma comes round):

| Expect |
|---|
| `One` and `Two` are offered **before** `Gamma` comes round again — they have never been practised, so they are owed a turn first. |
| Between `One` and `Two`, either may go first. **This is the one non-deterministic choice in the whole system**, and only ever among never-practised siblings, where any fixed order would be a fiction. |
| After all three have one session each, the rotation becomes strict round-robin: longest-untouched first, forever. |

## 7 · Zero weight and pause differ

| Do | Expect |
|---|---|
| `/weight Beta 0` | "weight 2 → 0 — its history stays, but it will never be recommended." Tree still lists Beta, with `(never recommended)`. |
| `/next` repeatedly | Beta never appears. |
| `/stats` | Beta is **still there**, with its 2 sessions and a 0% target. |
| `/weight Beta 2` | Back to normal. |
| `/pause Gamma` | "paused… the remaining weights renormalise around it." Alpha and Beta shares jump to 60/40. |
| `/next` | Never Gamma. |
| `/log` | Gamma is absent from the keyboard entirely. |
| `/resume Gamma` | Shares back to 50/33/17. |

The distinction, worth confirming with your own eyes: **weight 0** keeps an
objective visible in statistics but never recommends it; **paused** removes it
from the picture altogether. Both keep every recorded session.

## 8 · Percentages convert to raw weights

| Do | Expect |
|---|---|
| `/weight Alpha 50%` | "weight 3 → 3". Alpha's share reads 50%. |
| `/weight Alpha 60%` | "weight 3 → 4.5", share 60%. |
| `/weight Alpha 100%` | Refused: "A share of 100% or more would leave nothing for anything else." |
| `/weight Alpha 3` | Back to where you started. |

You typed a share; what got stored was a weight. `3 → 4.5` is the arithmetic
`w / (others + w) = 0.6` with `others = 3`. Percentages are a display and input
convenience only.

## 9 · Deletion cannot destroy history

| Do | Expect |
|---|---|
| `/delete Alpha` | **Refused**: "Alpha has 3 recorded sessions, so deleting it would destroy history that cannot be rebuilt", and it suggests `/pause Alpha`. |
| `/add Typo 1` then `/delete Typo` | Deleted, "Nothing had been recorded against it." |

Deletion is for fixing a typo you made a minute ago, nothing more. The session
log is the only thing in the system that cannot be reconstructed.

## 10 · The week boundary

The one thing worth checking against a real clock, because it is the piece most
likely to be quietly wrong — Lisbon is `UTC+1` in summer, so "today" in the bot
and "today" in UTC are not the same day late at night.

| Do | Expect |
|---|---|
| Record something before midnight Lisbon time on a Sunday | `/stats` still counts it in the week that began that Monday. |
| Record something just after midnight | `/stats` shows `7 days left` and a reset weekly count, while **all-time totals carry on unchanged**. |

If you would rather not stay up: this is covered by unit tests, including both
DST-transition weeks (167 and 169 hours long), and verified against the real
query at both sides of the boundary.

---

## Cleaning up

`/undo` removes the most recent session each time, so send it repeatedly until
the log is empty, then delete the dummy objectives:

```
/undo   (× however many you recorded)
/delete Alpha
/delete Beta
/delete Gamma
/tree     ->  "No objectives yet."
```

Or wipe it in one go and re-apply nothing (the schema and config survive):

```bash
npx wrangler d1 execute practice-tracker --remote \
  --command "DELETE FROM sessions; DELETE FROM sub_objectives; DELETE FROM objectives;"
```

Then build your real tree with `/add`.

## If something misbehaves

```bash
npx wrangler tail                 # live logs from the deployed Worker
npx wrangler d1 execute practice-tracker --remote \
  --command "SELECT * FROM sessions ORDER BY id DESC LIMIT 10"
```

`wrangler tail` is also how to confirm the CPU figures in README.md on a real
invocation, if you ever move to a paid plan and want to switch the `/stats`
image on.
