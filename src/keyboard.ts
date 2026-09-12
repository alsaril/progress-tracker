/**
 * The persistent keyboard, and the routing that lets every command be reached
 * by tapping rather than typing.
 *
 * Three layers, because they solve different problems:
 *
 *  1. A PERSISTENT REPLY KEYBOARD replaces the letter keys with the everyday
 *     actions, and stays up between messages — this is what BotFather does.
 *     Its buttons send their own label as an ordinary message, so each label is
 *     registered here as an alias for a command.
 *  2. A MANAGE MENU (inline) collects the tree-editing actions, which are rare
 *     enough that they do not deserve permanent space.
 *  3. FORCED REPLIES carry the arguments. Tapping "Add objective" opens the
 *     compose box quoting a prompt, and the reply is parsed as that command's
 *     arguments — so `Guitar 3` is all that gets typed, never `/add Guitar 3`.
 *
 * Layer 3 needs no stored conversation state: Telegram echoes the prompt back
 * in `reply_to_message`, so the pending intent is read off the quoted text.
 * Nothing to expire, nothing to clean up, and no way for two prompts to get
 * confused.
 */

import type { Markup } from "./telegram.js";

/** Labels are aliases, so the keyboard reads as buttons rather than commands. */
export const MAIN_KEYBOARD: string[][] = [
  ["▶️ Next", "✍️ Log"],
  ["📊 Stats", "🌳 Tree"],
  ["↩️ Undo", "⚙️ Manage"],
];

export const keyboardMarkup: Markup = { keyboard: MAIN_KEYBOARD };

/** Button label -> the command it stands for. */
const ALIASES: Record<string, string> = {
  "▶️ next": "/next",
  "✍️ log": "/log",
  "📊 stats": "/stats",
  "🌳 tree": "/tree",
  "↩️ undo": "/undo",
  "⚙️ manage": "/manage",
};

/**
 * Resolve a message to a command. Button taps arrive as their label, so they
 * are mapped here; anything already starting with "/" passes through.
 */
export function resolveCommand(text: string): string {
  const trimmed = text.trim();
  const alias = ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

// ------------------------------------------------------- forced-reply prompts

/**
 * Each prompt's first line is its identity: when a reply quotes it, that line
 * says which command the reply belongs to. Keep them distinct and stable.
 */
export const PROMPTS = {
  add: "➕ New objective",
  addSub: "➕ New sub-objective",
  weight: "⚖️ Change a weight",
  rename: "✏️ Rename",
  pause: "⏸ Pause",
  resume: "▶️ Resume",
  delete: "🗑 Delete",
} as const;

type PromptKey = keyof typeof PROMPTS;

/** The full prompt text, plus the placeholder shown in the compose box. */
const PROMPT_BODY: Record<PromptKey, { body: string; placeholder: string }> = {
  add: {
    body: "Send the name, optionally with a relative weight.\n\n<code>Guitar</code> · <code>Guitar 3</code>",
    placeholder: "Guitar 3",
  },
  addSub: {
    body: "Send it as <code>Parent &gt; Child</code>.\n\n<code>Guitar &gt; Scales</code>",
    placeholder: "Guitar > Scales",
  },
  weight: {
    body: "Send the objective and its new weight, raw or as a share.\n\n<code>Guitar 4</code> · <code>Guitar 30%</code> · <code>Guitar 0</code>",
    placeholder: "Guitar 4",
  },
  rename: {
    body: "Send it as <code>Old &gt; New</code>. Works for objectives and sub-objectives.\n\n<code>Guitar &gt; Classical guitar</code>",
    placeholder: "Guitar > Classical guitar",
  },
  pause: {
    body: "Send the name to pause. Its history is kept and the other weights renormalise around it.",
    placeholder: "Guitar",
  },
  resume: {
    body: "Send the name to bring back.",
    placeholder: "Guitar",
  },
  delete: {
    body: "Send the name to delete. Refused if anything has been recorded against it — use pause for that.",
    placeholder: "Guitar",
  },
};

export function promptText(key: PromptKey): string {
  return `<b>${PROMPTS[key]}</b>\n${PROMPT_BODY[key].body}`;
}

export function promptMarkup(key: PromptKey): Markup {
  return { forceReply: true, placeholder: PROMPT_BODY[key].placeholder };
}

/**
 * Given the text of the message being replied to, work out which command the
 * reply is answering. Returns null when the reply quotes something else, so an
 * ordinary reply to an old bot message is not misread as a command.
 */
export function commandForReply(quoted: string): string | null {
  // First non-blank line: tolerant of any leading whitespace a client might
  // include, so matching never hinges on exact framing.
  const firstLine = quoted.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  for (const [key, marker] of Object.entries(PROMPTS) as [PromptKey, string][]) {
    if (firstLine.startsWith(marker)) {
      return {
        add: "/add",
        addSub: "/add",
        weight: "/weight",
        rename: "/rename",
        pause: "/pause",
        resume: "/resume",
        delete: "/delete",
      }[key];
    }
  }
  return null;
}

// ------------------------------------------------------------- the manage menu

export const MANAGE_MENU = [
  [{ text: "➕ Objective", callback_data: "ask:add" }],
  [{ text: "➕ Sub-objective", callback_data: "ask:addSub" }],
  [{ text: "⚖️ Weight", callback_data: "ask:weight" }],
  [{ text: "✏️ Rename", callback_data: "ask:rename" }],
  [
    { text: "⏸ Pause", callback_data: "ask:pause" },
    { text: "▶️ Resume", callback_data: "ask:resume" },
  ],
  [{ text: "🗑 Delete", callback_data: "ask:delete" }],
  [{ text: "🌳 Show tree", callback_data: "tree" }],
];

export function isPromptKey(x: string): x is PromptKey {
  return x in PROMPTS;
}

/** What Telegram lists behind the Menu button (setMyCommands). */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "next", description: "What to practice now" },
  { command: "log", description: "Record anything from the tree" },
  { command: "stats", description: "This week's balance, then all time" },
  { command: "undo", description: "Remove the most recent session" },
  { command: "tree", description: "Show objectives, weights and shares" },
  { command: "manage", description: "Add, rename, reweight, pause, delete" },
  { command: "add", description: "Add an objective or sub-objective" },
  { command: "weight", description: "Change an objective's weight or share" },
  { command: "rename", description: "Rename an objective or sub-objective" },
  { command: "pause", description: "Pause, keeping the history" },
  { command: "resume", description: "Un-pause" },
  { command: "delete", description: "Delete, only if nothing is recorded" },
  { command: "help", description: "What everything does" },
];
