/**
 * Minimal Telegram Bot API client: the five calls this bot makes, and nothing
 * else. No dependency — a middleware framework buys nothing for one route and
 * five commands, and every package is trust surface.
 *
 * The token appears in the request URL and must never reach a log line or an
 * error message (design section 7), so `call` throws with the method name and
 * the API's own description only.
 */

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineKeyboardButton[][];

/**
 * The three shapes of reply markup this bot uses.
 *
 *  - an inline keyboard, attached under one message (the daily path);
 *  - a persistent reply keyboard, which replaces the user's letter keys with
 *    buttons that stay put between messages — what BotFather does;
 *  - a forced reply, which opens the compose box already quoting our prompt, so
 *    an argument can be typed without also typing the command name.
 *
 * A plain `InlineKeyboard` array is still accepted directly, so the common case
 * reads as it did before.
 */
export type Markup =
  | { inline: InlineKeyboard }
  | { keyboard: string[][] }
  | { removeKeyboard: true }
  | { forceReply: true; placeholder?: string };

function replyMarkup(markup: InlineKeyboard | Markup | undefined): unknown {
  if (!markup) return undefined;
  if (Array.isArray(markup)) return { inline_keyboard: markup };
  if ("inline" in markup) return { inline_keyboard: markup.inline };
  if ("keyboard" in markup) {
    return {
      keyboard: markup.keyboard.map((row) => row.map((text) => ({ text }))),
      resize_keyboard: true,
      // Keeps the buttons up instead of collapsing behind the grid icon after
      // each message, which is the whole point of a persistent keyboard.
      is_persistent: true,
    };
  }
  if ("removeKeyboard" in markup) return { remove_keyboard: true };
  return {
    force_reply: true,
    ...(markup.placeholder ? { input_field_placeholder: markup.placeholder } : {}),
  };
}

/** Escape for parse_mode: "HTML". Objective names are user-supplied text. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type PhotoPayload = { png: Uint8Array; filename: string };

const DEFAULT_API_BASE = "https://api.telegram.org";

export class Telegram {
  readonly #token: string;
  readonly #base: string;

  /**
   * `apiBase` exists so local end-to-end runs can point at a recording stub
   * instead of the real API. It defaults to Telegram and is never set in
   * production.
   */
  constructor(token: string, apiBase?: string) {
    this.#token = token;
    this.#base = (apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  #url(method: string): string {
    return `${this.#base}/bot${this.#token}/${method}`;
  }

  async #call(method: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(this.#url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.#unwrap(method, res);
  }

  async #unwrap(method: string, res: Response): Promise<Record<string, unknown>> {
    // Telegram occasionally answers a transient 502 with HTML rather than JSON.
    // Letting res.json() throw surfaced a bare SyntaxError with no indication of
    // which call failed, defeating the careful message below.
    let json: { ok?: boolean; description?: string; result?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new Error(`Telegram ${method} failed: HTTP ${res.status}, non-JSON response`);
    }
    if (!json.ok) {
      // Editing a message to exactly what it already says is a no-op, not a
      // failure. It happens whenever a button is double-tapped before the first
      // edit lands, and treating it as an error would surface a scary log line
      // for a user action that was already satisfied.
      if ((json.description ?? "").includes("message is not modified")) {
        return {};
      }
      // Deliberately excludes the URL, which carries the token.
      throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return (json.result ?? {}) as Record<string, unknown>;
  }

  async sendMessage(
    chatId: number,
    text: string,
    markup?: InlineKeyboard | Markup,
  ): Promise<{ messageId: number }> {
    const reply_markup = replyMarkup(markup);
    const result = await this.#call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(reply_markup ? { reply_markup } : {}),
    });
    return { messageId: Number(result["message_id"]) };
  }

  /** Tell Telegram which commands to list behind the Menu button. */
  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.#call("setMyCommands", { commands });
  }

  /**
   * Edit in place rather than sending a new message, so the chat does not fill
   * with noise (design section 5.2).
   */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    await this.#call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard ?? [] },
    });
  }

  /** Always answer, promptly, or the client shows a spinner until it times out. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.#call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  /** Multipart upload, so the image never leaves the account as a URL. */
  async sendPhoto(chatId: number, photo: PhotoPayload, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("photo", new Blob([photo.png], { type: "image/png" }), photo.filename);

    const res = await fetch(this.#url("sendPhoto"), { method: "POST", body: form });
    await this.#unwrap("sendPhoto", res);
  }
}
