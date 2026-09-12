/**
 * The Worker. Exactly one route: POST /webhook. Everything else 404s
 * (design section 7).
 *
 * Defence in depth, in order:
 *  1. Method and path must match exactly.
 *  2. The webhook secret token must match, compared in constant time. This is
 *     the only thing standing between the Worker and the open internet.
 *  3. The sender must be the one allowed user id. Anything else gets silence —
 *     no reply, no error, no signal that the bot exists.
 *
 * The bot token is never logged and never appears in an error message.
 */

import { type Ctx, handleCallback, handleCommand } from "./commands.js";
import { Telegram } from "./telegram.js";

export type Env = {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ALLOWED_USER_ID: string;
  /** "on" enables the section 6.2 PNG; needs a paid plan's CPU budget. */
  CHART_IMAGE?: string;
  /** Local-testing seam only; unset in production. */
  TELEGRAM_API_BASE?: string;
};

type TgUser = { id?: number };
type TgChat = { id?: number };
type TgMessage = { message_id?: number; chat?: TgChat; from?: TgUser; text?: string };
type Update = {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: {
    id?: string;
    from?: TgUser;
    data?: string;
    message?: TgMessage;
  };
};

// Fresh Response objects per call: a single module-level instance would be
// reused across requests, which the runtime does not allow.
const notFound = (): Response => new Response(null, { status: 404 });
const forbidden = (): Response => new Response(null, { status: 403 });
/** Telegram is satisfied by a 200 and will not retry. */
const accepted = (): Response => new Response(null, { status: 200 });

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

/**
 * Constant-time comparison of the webhook secret.
 *
 * Both sides are hashed first so the buffers are always 32 bytes. That avoids
 * `timingSafeEqual`'s throw on mismatched lengths, and leaks nothing about the
 * expected secret's length. Fails closed when the secret is unset.
 */
async function secretMatches(req: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const presented = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return notFound();
    if (new URL(req.url).pathname !== "/webhook") return notFound();
    if (!(await secretMatches(req, env.WEBHOOK_SECRET))) return forbidden();

    let update: Update;
    try {
      update = (await req.json()) as Update;
    } catch {
      return accepted();
    }

    const allowed = Number(env.ALLOWED_USER_ID);
    if (!Number.isFinite(allowed)) {
      // Misconfigured rather than under attack; say so without leaking secrets.
      console.error("ALLOWED_USER_ID is not a number; rejecting every update");
      return accepted();
    }

    const from = update.callback_query?.from ?? update.message?.from;
    if (!from || from.id !== allowed) return accepted();

    const tg = new Telegram(env.BOT_TOKEN, env.TELEGRAM_API_BASE);
    const chartImage = env.CHART_IMAGE === "on";

    try {
      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const messageId = cq.message?.message_id;
        // Answer first so the client's spinner clears immediately, whatever the
        // handler goes on to do (design section 5.2).
        if (cq.id) await tg.answerCallbackQuery(cq.id);
        if (chatId === undefined || messageId === undefined || !cq.data) return accepted();

        const ctx: Ctx = { db: env.DB, tg, chatId, now: new Date(), chartImage };
        await handleCallback(ctx, cq.data, messageId);
        return accepted();
      }

      const msg = update.message;
      const chatId = msg?.chat?.id;
      if (!msg || chatId === undefined || !msg.text) return accepted();

      const ctx: Ctx = { db: env.DB, tg, chatId, now: new Date(), chartImage };
      await handleCommand(ctx, msg.text);
      return accepted();
    } catch (err) {
      // Answer 200 regardless: a 5xx makes Telegram retry the same update, and
      // a bug would become a retry storm.
      console.error("handler failed:", err instanceof Error ? err.message : String(err));
      return accepted();
    }
  },
} satisfies ExportedHandler<Env>;
