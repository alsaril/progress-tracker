import { describe, expect, it } from "vitest";
import {
  BOT_COMMANDS,
  MAIN_KEYBOARD,
  MANAGE_MENU,
  PROMPTS,
  commandForReply,
  isPromptKey,
  promptMarkup,
  promptText,
  resolveCommand,
} from "../src/keyboard.js";

describe("resolveCommand", () => {
  it("maps every keyboard button label to a command", () => {
    // A label that fell out of the alias table would be handled as unknown
    // input, so the button would silently do nothing useful.
    for (const label of MAIN_KEYBOARD.flat()) {
      const resolved = resolveCommand(label);
      expect(resolved.startsWith("/"), `${label} -> ${resolved}`).toBe(true);
    }
  });

  it("maps labels to the commands you would expect", () => {
    expect(resolveCommand("▶️ Next")).toBe("/next");
    expect(resolveCommand("📊 Stats")).toBe("/stats");
    expect(resolveCommand("⚙️ Manage")).toBe("/manage");
  });

  it("passes typed commands through untouched, arguments included", () => {
    expect(resolveCommand("/add Guitar 3")).toBe("/add Guitar 3");
    expect(resolveCommand("  /next  ")).toBe("/next");
  });

  it("leaves unrelated text alone", () => {
    expect(resolveCommand("Guitar 3")).toBe("Guitar 3");
  });
});

describe("commandForReply", () => {
  it("routes a reply back to the command whose prompt it quotes", () => {
    expect(commandForReply(promptText("add").replace(/<[^>]+>/g, ""))).toBe("/add");
    expect(commandForReply(promptText("addSub").replace(/<[^>]+>/g, ""))).toBe("/add");
    expect(commandForReply(promptText("weight").replace(/<[^>]+>/g, ""))).toBe("/weight");
    expect(commandForReply(promptText("rename").replace(/<[^>]+>/g, ""))).toBe("/rename");
    expect(commandForReply(promptText("pause").replace(/<[^>]+>/g, ""))).toBe("/pause");
    expect(commandForReply(promptText("resume").replace(/<[^>]+>/g, ""))).toBe("/resume");
    expect(commandForReply(promptText("delete").replace(/<[^>]+>/g, ""))).toBe("/delete");
  });

  it("ignores a reply to anything else, rather than guessing a command", () => {
    // Replying to an old acknowledgement must not be read as arguments.
    expect(commandForReply("✓ Guitar\n1 this week · 1 all time")).toBeNull();
    expect(commandForReply("What did you practise?")).toBeNull();
    expect(commandForReply("")).toBeNull();
  });

  it("keys off the first line only, so prompt bodies can change freely", () => {
    expect(commandForReply(`${PROMPTS.weight}\nsomething entirely different`)).toBe("/weight");
  });

  it("gives every prompt a distinct first line", () => {
    // Two prompts sharing a prefix would make replies ambiguous.
    const firsts = Object.values(PROMPTS);
    expect(new Set(firsts).size).toBe(firsts.length);
    for (const a of firsts) {
      const clashes = firsts.filter((b) => b !== a && (a.startsWith(b) || b.startsWith(a)));
      expect(clashes, `${a} is prefix-ambiguous with ${clashes.join(", ")}`).toEqual([]);
    }
  });
});

describe("the manage menu", () => {
  it("only references prompts that exist", () => {
    for (const row of MANAGE_MENU) {
      for (const btn of row) {
        const [kind, key] = btn.callback_data.split(":");
        if (kind === "ask") {
          expect(key && isPromptKey(key), `${btn.callback_data} has no prompt`).toBe(true);
        }
      }
    }
  });

  it("carries no user-supplied text in callback data", () => {
    // Section 5.2: callback data carries ids and fixed keys, never names.
    for (const row of MANAGE_MENU) {
      for (const btn of row) {
        expect(btn.callback_data).toMatch(/^(ask:[a-zA-Z]+|tree|log|next)$/);
      }
    }
  });
});

describe("prompts", () => {
  it("supply a compose-box placeholder, so the expected shape is visible", () => {
    for (const key of Object.keys(PROMPTS)) {
      if (!isPromptKey(key)) continue;
      const m = promptMarkup(key);
      expect("forceReply" in m && m.forceReply).toBe(true);
      expect("placeholder" in m && (m.placeholder ?? "").length).toBeGreaterThan(0);
    }
  });

  it("escape the > separator for HTML parse mode", () => {
    // A raw ">" in an example would be swallowed by Telegram's HTML parser.
    expect(promptText("addSub")).toContain("&gt;");
    expect(promptText("addSub")).not.toMatch(/[^&]gt;|<code>[^<]*>[^<]*<\/code>/);
  });
});

describe("BOT_COMMANDS", () => {
  it("lists commands without a leading slash, as setMyCommands requires", () => {
    for (const c of BOT_COMMANDS) {
      expect(c.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("covers every command the keyboard can produce", () => {
    const listed = new Set(BOT_COMMANDS.map((c) => `/${c.command}`));
    for (const label of MAIN_KEYBOARD.flat()) {
      expect(listed.has(resolveCommand(label)), `${label} missing from the menu`).toBe(true);
    }
  });
});
