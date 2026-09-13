/**
 * Command and callback handling (design section 5).
 *
 * Interaction rules from section 5.2, applied throughout:
 *  - the recommended item is pinned at the top of the /log keyboard, so the
 *    common case is one tap;
 *  - every recorded point is acknowledged with the new total and an inline Undo
 *    on that same message;
 *  - callback data carries ids only, never names;
 *  - callback queries are answered promptly and messages are edited in place
 *    rather than appended, to keep the chat quiet.
 */

import { renderDistribution } from "./chart.js";
import {
  handleAdd,
  handleDelete,
  handleRename,
  handleSetActive,
  handleTree,
  handleWeight,
} from "./edit.js";
import {
  deleteSession,
  latestSessionId,
  load,
  recordSession,
} from "./db.js";
import { formatAllTime, formatBalance, formatRecorded, nextLabel } from "./format.js";
import {
  BOT_COMMANDS,
  MANAGE_MENU,
  commandForReply,
  isPromptKey,
  keyboardMarkup,
  promptMarkup,
  promptText,
  resolveCommand,
} from "./keyboard.js";
import { childrenOf, isFlatObjective, rankObjectives, recommend } from "./scoring.js";
import { type InlineKeyboard, type Telegram, escapeHtml } from "./telegram.js";
import { daysLeftInWeek } from "./week.js";

export type Ctx = {
  db: D1Database;
  tg: Telegram;
  chatId: number;
  now: Date;
  /**
   * Whether to also send the section 6.2 PNG. Off on the free plan: the render
   * costs ~20 ms CPU against a 10 ms per-invocation budget (see IMPLEMENTATION.md).
   */
  chartImage: boolean;
};

/** Where a message should go: a new one, or an edit of the one just tapped. */
type Target = { edit: number } | { send: true };

async function emit(
  ctx: Ctx,
  target: Target,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if ("edit" in target) {
    await ctx.tg.editMessageText(ctx.chatId, target.edit, text, keyboard);
  } else {
    await ctx.tg.sendMessage(ctx.chatId, text, keyboard);
  }
}

// ------------------------------------------------------------------- keyboards

/**
 * The objective keyboard. An objective whose only child is its auto-created
 * default one records straight to that child on a single tap (section 2.2);
 * anything else opens its sub-objective keyboard.
 */
function logKeyboard(
  snapshot: Awaited<ReturnType<typeof load>>["snapshot"],
  recommended: { subId: number; label: string } | null,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (recommended) {
    rows.push([{ text: `⭐ ${recommended.label}`, callback_data: `rec:${recommended.subId}` }]);
  }

  for (const o of snapshot.objectives.filter((x) => x.active === 1)) {
    const kids = childrenOf(snapshot, o.id);
    if (kids.length === 0) continue;
    rows.push([
      // One shared definition of "flat", so this keyboard and every label
      // elsewhere can never disagree about the same objective.
      isFlatObjective(snapshot, o.id)
        ? { text: o.name, callback_data: `rec:${kids[0]!.id}` }
        : { text: `${o.name} ›`, callback_data: `obj:${o.id}` },
    ]);
  }
  return rows;
}

function subKeyboard(
  snapshot: Awaited<ReturnType<typeof load>>["snapshot"],
  objectiveId: number,
): InlineKeyboard {
  const rows: InlineKeyboard = childrenOf(snapshot, objectiveId).map((k) => [
    { text: k.name, callback_data: `rec:${k.id}` },
  ]);
  rows.push([{ text: "‹ Back", callback_data: "log" }]);
  return rows;
}

// -------------------------------------------------------------------- commands

const NOTHING_TO_PRACTICE =
  "Nothing to practice — no active objective has a weight above zero.";

/** /log and /start: the full keyboard with the recommendation pinned first. */
export async function showLog(ctx: Ctx, target: Target): Promise<void> {
  const { snapshot } = await load(ctx.db, ctx.now);
  const rec = recommend(snapshot);

  if (snapshot.objectives.filter((o) => o.active === 1).length === 0) {
    await emit(
      ctx,
      target,
      [
        "<b>No objectives yet.</b>",
        "",
        "<code>/add Guitar 3</code> — an objective with relative weight 3",
        "<code>/add Guitar &gt; Scales</code> — a sub-objective under it",
        "",
        "Then <code>/next</code> will have something to recommend.",
      ].join("\n"),
    );
    return;
  }

  const keyboard = logKeyboard(
    snapshot,
    rec ? { subId: rec.sub.id, label: nextLabel(snapshot, rec) } : null,
  );
  await emit(ctx, target, "What did you practice?", keyboard);
}

/** /next: the recommendation, with one tap to record it. */
export async function showNext(ctx: Ctx, target: Target): Promise<void> {
  const { snapshot } = await load(ctx.db, ctx.now);
  const rec = recommend(snapshot);
  if (!rec) {
    await emit(ctx, target, NOTHING_TO_PRACTICE);
    return;
  }

  // Why this one, in one line: it is the objective furthest behind its share.
  const ranked = rankObjectives(snapshot);
  const runnerUp = ranked[1];
  const because = runnerUp
    ? `<i>furthest behind its share; next would be ${escapeHtml(runnerUp.name)}</i>`
    : "<i>the only active objective</i>";

  await emit(ctx, target, `<b>${escapeHtml(nextLabel(snapshot, rec))}</b>\n${because}`, [
    [{ text: `✓ Record ${nextLabel(snapshot, rec)}`, callback_data: `rec:${rec.sub.id}` }],
    [{ text: "Something else…", callback_data: "log" }],
  ]);
}

/** Record one point, then acknowledge with new totals and an Undo. */
export async function record(ctx: Ctx, subId: number, target: Target): Promise<void> {
  // Check the id still exists BEFORE inserting. Inline keyboards live as long as
  // the chat scrollback, so a tap can arrive after its sub-objective was
  // deleted — which would either violate the foreign key (the tap silently
  // doing nothing) or leave an orphan row in the append-only log that no view
  // would ever surface.
  const before = await load(ctx.db, ctx.now);
  if (!before.snapshot.subs.some((x) => x.id === subId)) {
    await emit(
      ctx,
      target,
      "That entry no longer exists — it was renamed away or deleted since this message was sent.",
      [[{ text: "Log another…", callback_data: "log" }]],
    );
    return;
  }

  const sessionId = await recordSession(ctx.db, subId, ctx.now);
  // Reload so the acknowledgement and the follow-on recommendation reflect the
  // point just written, rather than being computed by hand.
  const { snapshot, bounds } = await load(ctx.db, ctx.now);
  const rec = recommend(snapshot);

  const keyboard: InlineKeyboard = [[{ text: "↩ Undo", callback_data: `undo:${sessionId}` }]];
  if (rec) {
    keyboard.push([{ text: `Next: ${nextLabel(snapshot, rec)}`, callback_data: `rec:${rec.sub.id}` }]);
  }
  keyboard.push([{ text: "Log another…", callback_data: "log" }]);

  await emit(ctx, target, formatRecorded(snapshot, subId, bounds), keyboard);
}

/** /undo, and the inline Undo button. */
export async function undo(ctx: Ctx, sessionId: number | null, target: Target): Promise<void> {
  const id = sessionId ?? (await latestSessionId(ctx.db));
  if (id === null) {
    await emit(ctx, target, "Nothing to undo — the log is empty.");
    return;
  }

  const removed = await deleteSession(ctx.db, id);
  if (!removed) {
    await emit(ctx, target, "That session is already gone.");
    return;
  }

  const label =
    removed.subName === removed.objectiveName
      ? removed.objectiveName
      : `${removed.objectiveName} → ${removed.subName}`;

  await emit(ctx, target, `↩ Removed <b>${escapeHtml(label)}</b>`, [
    [{ text: "Log another…", callback_data: "log" }],
  ]);
}

/**
 * /stats: this week's balance, then the all-time picture.
 *
 * Always sends rather than editing: it is two messages (plus an optional
 * photo), so there is no single message to edit in place.
 */
export async function showStats(ctx: Ctx): Promise<void> {
  const { snapshot, config, bounds } = await load(ctx.db, ctx.now);
  const rec = recommend(snapshot);
  const daysLeft = daysLeftInWeek(
    ctx.now,
    config.timezone,
    config.weekStartDay,
    config.windowDays,
  );

  await ctx.tg.sendMessage(ctx.chatId, formatBalance(snapshot, bounds, daysLeft, rec));
  await ctx.tg.sendMessage(ctx.chatId, formatAllTime(snapshot));

  // The image is a bonus on top of the text, never a replacement: if it is
  // disabled or fails to render, /stats has already answered the question.
  if (ctx.chartImage) {
    const photo = await renderDistribution(snapshot);
    if (photo) await ctx.tg.sendPhoto(ctx.chatId, photo);
  }
}

const HELP = [
  "<b>Practice Tracker</b>",
  "",
  "<b>Every day</b>",
  "/next — what to practice now, one tap to record",
  "/log — pick anything from the tree",
  "/stats — this week's balance, then all time",
  "/undo — remove the most recent session",
  "",
  "<b>Setting the tree up</b>",
  "/manage — buttons for everything below",
  "/tree — the whole tree, with weights and shares",
  "<code>/add Guitar 3</code> — an objective, relative weight 3",
  "<code>/add Guitar &gt; Scales</code> — a sub-objective under it",
  "<code>/weight Guitar 4</code> — or <code>30%</code>",
  "<code>/rename Guitar &gt; Classical guitar</code>",
  "<code>/pause Guitar</code> · <code>/resume Guitar</code> — keeps the history",
  "<code>/delete Guitar</code> — only while nothing is recorded against it",
].join("\n");

export async function showHelp(ctx: Ctx): Promise<void> {
  // Sending the persistent keyboard here (and on /start) is what puts the
  // buttons up; it then stays until explicitly replaced.
  await ctx.tg.sendMessage(ctx.chatId, HELP, keyboardMarkup);
}

/** The tree-editing actions, which are too rare for permanent keyboard space. */
export async function showManage(ctx: Ctx, target: Target): Promise<void> {
  await emit(
    ctx,
    target,
    ["<b>Manage the tree</b>", "", "Each of these asks for what it needs — no command to type."].join(
      "\n",
    ),
    MANAGE_MENU,
  );
}

// -------------------------------------------------------------------- dispatch

export async function handleCommand(ctx: Ctx, text: string): Promise<void> {
  // A keyboard button arrives as its own label, so resolve aliases first.
  const trimmed = resolveCommand(text);
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const cmd = head.split("@")[0]!.toLowerCase();
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  const send: Target = { send: true };

  switch (cmd) {
    case "/manage":
      await showManage(ctx, send);
      return;
    case "/add":
      await ctx.tg.sendMessage(ctx.chatId, await handleAdd(ctx.db, ctx.now, args));
      return;
    case "/tree":
      await ctx.tg.sendMessage(ctx.chatId, await handleTree(ctx.db, ctx.now));
      return;
    case "/weight":
    case "/weights":
      await ctx.tg.sendMessage(ctx.chatId, await handleWeight(ctx.db, ctx.now, args));
      return;
    case "/rename":
      await ctx.tg.sendMessage(ctx.chatId, await handleRename(ctx.db, ctx.now, args));
      return;
    case "/pause":
      await ctx.tg.sendMessage(ctx.chatId, await handleSetActive(ctx.db, ctx.now, args, false));
      return;
    case "/resume":
      await ctx.tg.sendMessage(ctx.chatId, await handleSetActive(ctx.db, ctx.now, args, true));
      return;
    case "/delete":
      await ctx.tg.sendMessage(ctx.chatId, await handleDelete(ctx.db, ctx.now, args));
      return;
    case "/start":
      // First contact: put the keyboard up and register the Menu list, then
      // behave like /log.
      await ctx.tg.setMyCommands(BOT_COMMANDS).catch(() => {});
      await ctx.tg.sendMessage(ctx.chatId, HELP, keyboardMarkup);
      await showLog(ctx, send);
      return;
    case "/log":
      await showLog(ctx, send);
      return;
    case "/next":
      await showNext(ctx, send);
      return;
    case "/stats":
      await showStats(ctx);
      return;
    case "/undo":
      await undo(ctx, null, send);
      return;
    case "/help":
      await showHelp(ctx);
      return;
    default:
      // Unknown input from the one allowed user is a typo, not an attack.
      await showHelp(ctx);
  }
}

/**
 * A reply to one of our forced-reply prompts. The quoted prompt says which
 * command it answers, so the reply body is the arguments — no stored state.
 * Returns false when the reply quotes something else, so it falls through to
 * ordinary handling.
 */
export async function handleReply(
  ctx: Ctx,
  quoted: string,
  text: string,
): Promise<boolean> {
  const cmd = commandForReply(quoted);
  if (!cmd) return false;
  await handleCommand(ctx, `${cmd} ${text.trim()}`);
  return true;
}

export async function handleCallback(
  ctx: Ctx,
  data: string,
  messageId: number,
): Promise<void> {
  const target: Target = { edit: messageId };
  const [kind, rawId] = data.split(":");
  const id = rawId === undefined ? null : Number(rawId);

  switch (kind) {
    case "log":
      await showLog(ctx, target);
      return;
    case "obj": {
      if (id === null || !Number.isFinite(id)) return;
      const { snapshot } = await load(ctx.db, ctx.now);
      const objective = snapshot.objectives.find((o) => o.id === id);
      if (!objective) {
        await showLog(ctx, target);
        return;
      }
      await emit(ctx, target, `<b>${escapeHtml(objective.name)}</b>`, subKeyboard(snapshot, id));
      return;
    }
    case "rec":
      if (id === null || !Number.isFinite(id)) return;
      await record(ctx, id, target);
      return;
    case "undo":
      if (id === null || !Number.isFinite(id)) return;
      await undo(ctx, id, target);
      return;
    case "next":
      await showNext(ctx, target);
      return;
    case "tree":
      await ctx.tg.sendMessage(ctx.chatId, await handleTree(ctx.db, ctx.now));
      return;
    case "ask": {
      // Ask for this command's arguments with a forced reply.
      if (!rawId || !isPromptKey(rawId)) return;
      await ctx.tg.sendMessage(ctx.chatId, promptText(rawId), promptMarkup(rawId));
      return;
    }
    default:
      await showLog(ctx, target);
  }
}
