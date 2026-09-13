# Practice Tracker

A personal Telegram bot for keeping your practice balanced.

You tell it what you want to work on and roughly how much each thing matters.
Then, whenever you sit down, you ask it **what to practice next** — and it names
whichever thing has fallen furthest behind its share. One tap records the
session.

It answers one question well: *given what I said I wanted, and what I have
actually done this week, what should I do now?*

---

## Getting started

Send **`/start`**. The bot replaces your keyboard with six buttons:

```
[ ▶️ Next ]   [ ✍️ Log    ]
[ 📊 Stats ]  [ 🌳 Tree   ]
[ ↩️ Undo ]   [ ⚙️ Manage ]
```

Nothing has to be typed from memory. Tap **⚙️ Manage → ➕ Objective** and the bot
asks for a name — reply `Guitar 3` and it is created. Every editing action works
that way.

Typing still works, and is quicker when setting up several things at once. Both
forms are shown below.

## Building your tree

Objectives are the things you practice. Each carries a **weight** saying how much
of your time it should get, relative to the others.

| You want | Tap | Or type |
|---|---|---|
| A new objective | ⚙️ Manage → ➕ Objective | `/add Guitar 3` |
| A sub-objective under it | ⚙️ Manage → ➕ Sub-objective | `/add Guitar > Scales` |
| To change a weight | ⚙️ Manage → ⚖️ Weight | `/weight Guitar 4` |
| To rename something | ⚙️ Manage → ✏️ Rename | `/rename Guitar > Classical guitar` |
| To act on a child two parents share | — | `/pause Guitar > Scales` |
| To set something aside | ⚙️ Manage → ⏸ Pause | `/pause Guitar` |
| To bring it back | ⚙️ Manage → ▶️ Resume | `/resume Guitar` |
| To remove a mistake | ⚙️ Manage → 🗑 Delete | `/delete Guitar` |
| To see everything | 🌳 Tree | `/tree` |

**Weights are relative.** `3` and `1` means three sessions of the first for every
one of the second. They do not need to add up to anything, so you can add a new
objective without rebalancing the others — the shares simply redistribute.

If you would rather think in percentages, `/weight Guitar 30%` works too; the bot
converts it into a weight for you.

**Sub-objectives** are for an objective with distinct parts you want to rotate
through — scales, arpeggios, sight-reading. They carry no weights of their own:
siblings count as equally important, and the bot rotates between them, always
offering whichever has gone longest untouched.

## Every day

| You want | Tap | Or type |
|---|---|---|
| What to do now | ▶️ Next | `/next` |
| To record something specific | ✍️ Log | `/log` |
| How the week looks | 📊 Stats | `/stats` |
| To take back a mis-tap | ↩️ Undo | `/undo` |

**▶️ Next** is the everyday path: it names one thing and offers a button to
record it. Two taps from opening the chat to a logged session.

Every recorded session is acknowledged with its running totals and an **Undo**
button on that same message, so a mis-tap costs one tap to fix.

## A worked example

```
/add Guitar 3
/add Spanish 2
/add Reading 1
```

Your **🌳 Tree** now reads:

```
Guitar    w=3  50%  ·  0 all time
Spanish   w=2  33%  ·  0 all time
Reading   w=1  17%  ·  0 all time
```

Ask **▶️ Next** and record whatever it says, six times. You will get **Guitar,
Spanish, Guitar, Guitar, Spanish, Reading** — three, two and one, exactly the
split you asked for. Nothing was scheduled; each pick was just whatever had
fallen furthest behind.

Then **📊 Stats**:

```
Week of 7 Sep  ·  6 sessions  ·  4 days left

                            target actual
Guitar             │           50%    50%
Spanish            │           33%    33%
Reading            │           17%    17%
```

Bars sit on the centre line when you are on target. They grow **right** when you
owe something time and **left** when you have overdone it, so a glance tells you
where you stand.

## Things worth knowing

**A missed week disappears.** Planning is weekly and nothing carries over as
debt. A quiet week is simply a quiet week.

**There is no "done".** Weights describe proportions, not amounts, so the bot
never tells you that you have finished. Four sessions and forty are both
perfectly balanced if they are split the right way. How much you do is your
business.

**Pausing and zero weight differ.** `/pause` hides something completely;
`/weight Guitar 0` keeps it visible in your statistics but never recommends it.
Both keep every session you have recorded.

**Nothing deletes your history.** `/delete` refuses as soon as anything has been
recorded against an objective, and points you at `/pause` instead. It is for
fixing a typo, not for clearing the past.

**Adding a sub-objective keeps what came before.** Sessions logged against the
objective itself stay, as an entry alongside the new ones. The bot will suggest
renaming that entry to something like *General*.

---

Want to know how it works, or run your own?
**[IMPLEMENTATION.md](IMPLEMENTATION.md)** covers setup, deployment, the
recommendation algorithm and the reasoning behind each decision.
**[practice-tracker-design.md](practice-tracker-design.md)** is the original
design document.
