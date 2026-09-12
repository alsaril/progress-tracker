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
    const json = (await res.json()) as { ok?: boolean; description?: string; result?: unknown };
    if (!json.ok) {
      // Deliberately excludes the URL, which carries the token.
      throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return (json.result ?? {}) as Record<string, unknown>;
  }

  async sendMessage(
    chatId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<{ messageId: number }> {
    const result = await this.#call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
    return { messageId: Number(result["message_id"]) };
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
