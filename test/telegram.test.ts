import { describe, expect, it, vi } from "vitest";
import { Telegram, escapeHtml } from "../src/telegram.js";

/** Stub `fetch` with a fixed Bot API response. */
function withResponse(body: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

const tg = () => new Telegram("123:token", "http://stub.invalid");

describe("editMessageText", () => {
  it("treats an unchanged message as success, not an error", async () => {
    // Telegram answers ok:false for a no-op edit. It happens whenever a button
    // is double-tapped before the first edit lands, and throwing there aborts a
    // handler over a user action that was already satisfied.
    withResponse({ ok: false, description: "Bad Request: message is not modified" });
    await expect(tg().editMessageText(42, 7, "same text")).resolves.toBeUndefined();
  });

  it("still throws on a real failure", async () => {
    withResponse({ ok: false, description: "Bad Request: chat not found" });
    await expect(tg().editMessageText(42, 7, "x")).rejects.toThrow(/chat not found/);
  });
});

describe("error messages", () => {
  it("never leak the bot token", async () => {
    withResponse({ ok: false, description: "Unauthorized" });
    await expect(tg().sendMessage(42, "hi")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("123:token") }),
    );
  });
});

describe("reply markup", () => {
  it("marks a reply keyboard persistent and resizable", async () => {
    const calls = withResponse({ ok: true, result: { message_id: 1 } });
    await tg().sendMessage(42, "hi", { keyboard: [["A", "B"]] });
    const rm = (calls[0]!.body as Record<string, any>)["reply_markup"];
    expect(rm.is_persistent).toBe(true);
    expect(rm.resize_keyboard).toBe(true);
    expect(rm.keyboard).toEqual([[{ text: "A" }, { text: "B" }]]);
  });

  it("passes a forced reply with its placeholder", async () => {
    const calls = withResponse({ ok: true, result: { message_id: 1 } });
    await tg().sendMessage(42, "hi", { forceReply: true, placeholder: "Guitar 3" });
    const rm = (calls[0]!.body as Record<string, any>)["reply_markup"];
    expect(rm.force_reply).toBe(true);
    expect(rm.input_field_placeholder).toBe("Guitar 3");
  });

  it("accepts a bare inline keyboard array", async () => {
    const calls = withResponse({ ok: true, result: { message_id: 1 } });
    await tg().sendMessage(42, "hi", [[{ text: "Go", callback_data: "go" }]]);
    const rm = (calls[0]!.body as Record<string, any>)["reply_markup"];
    expect(rm.inline_keyboard).toEqual([[{ text: "Go", callback_data: "go" }]]);
  });
});

describe("escapeHtml", () => {
  it("escapes the three characters Telegram's HTML mode cares about", () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });
});
