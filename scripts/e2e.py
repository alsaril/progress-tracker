#!/usr/bin/env python3
"""
End-to-end check against a locally running Worker. No Telegram account, no
Cloudflare login, no network.

It stands up a stub Bot API on 127.0.0.1:8799 (which `.dev.vars` points
TELEGRAM_API_BASE at), replays the fixtures in test/fixtures/ through
POST /webhook, and asserts on the calls the Worker makes back out.

The three rejection cases matter as much as the happy path: a wrong secret
token, an unknown sender, and a non-webhook route must all be turned away, and
must make no Bot API call at all.

Usage:
    npm run db:local && npm run seed:local
    npm run dev          # in another shell
    python3 scripts/e2e.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

WORKER = "http://127.0.0.1:8787"
STUB_PORT = 8799
SECRET = "local-dev-secret"
ALLOWED_ID = 42
FIXTURES = Path(__file__).resolve().parent.parent / "test" / "fixtures"

calls: list[dict] = []
failures: list[str] = []


# -- the stub Bot API ----------------------------------------------------------


class Stub(BaseHTTPRequestHandler):
    counter = 200

    def do_POST(self) -> None:  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        method = re.sub(r"^/bot[^/]+/", "", self.path)
        ctype = self.headers.get("content-type", "")
        if ctype.startswith("application/json"):
            try:
                body = json.loads(raw)
            except ValueError:
                body = {"_unparsed": True}
        else:
            png = raw.find(b"\x89PNG")
            body = {"_png_bytes": len(raw) - png if png >= 0 else 0}
        calls.append({"method": method, "body": body})

        Stub.counter += 1
        out = json.dumps(
            {"ok": True, "result": {"message_id": Stub.counter, "chat": {"id": ALLOWED_ID}}}
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *_: object) -> None:
        pass


# -- helpers -------------------------------------------------------------------


def send(payload: str | bytes, secret: str | None = SECRET, path: str = "/webhook",
         method: str = "POST") -> int:
    headers = {"content-type": "application/json"}
    if secret is not None:
        headers["X-Telegram-Bot-Api-Secret-Token"] = secret
    data = payload.encode() if isinstance(payload, str) else payload
    req = urllib.request.Request(
        WORKER + path, data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req) as res:
            return res.status
    except urllib.error.HTTPError as e:
        return e.code


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def replay(fixture: str) -> list[dict]:
    calls.clear()
    status = send(( FIXTURES / fixture).read_text())
    time.sleep(0.6)
    return [dict(c, _status=status) for c in calls]


def texts(made: list[dict]) -> str:
    return "\n".join(c["body"].get("text", "") for c in made)


def buttons(made: list[dict]) -> list[str]:
    out = []
    for c in made:
        for row in (c["body"].get("reply_markup") or {}).get("inline_keyboard", []):
            out += [b["callback_data"] for b in row]
    return out


_uid = [500]


def cmd(text: str) -> str:
    """Send a text command and return everything the bot said back."""
    calls.clear()
    _uid[0] += 1
    send(json.dumps({"update_id": _uid[0], "message": {
        "message_id": _uid[0], "chat": {"id": ALLOWED_ID},
        "from": {"id": ALLOWED_ID}, "text": text}}))
    time.sleep(0.7)
    return texts(list(calls))


def tap(data: str, message_id: int = 77) -> list[dict]:
    """Press an inline button."""
    calls.clear()
    _uid[0] += 1
    send(json.dumps({"update_id": _uid[0], "callback_query": {
        "id": f"cq{_uid[0]}", "from": {"id": ALLOWED_ID}, "data": data,
        "message": {"message_id": message_id, "chat": {"id": ALLOWED_ID}}}}))
    time.sleep(0.7)
    return list(calls)


def answer(quoted: str, text: str) -> str:
    """Reply to one of the bot's forced-reply prompts."""
    calls.clear()
    _uid[0] += 1
    send(json.dumps({"update_id": _uid[0], "message": {
        "message_id": _uid[0], "chat": {"id": ALLOWED_ID},
        "from": {"id": ALLOWED_ID}, "text": text,
        "reply_to_message": {"text": quoted}}}))
    time.sleep(0.7)
    return texts(list(calls))


def db(sql: str) -> list[dict]:
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "practice-tracker", "--local",
         "--command", sql, "--json"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(res.stdout[res.stdout.index("["):])[0]["results"]


# -- the checks ----------------------------------------------------------------


def main() -> int:
    server = HTTPServer(("127.0.0.1", STUB_PORT), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        send('{"probe":1}', path="/webhook")
    except OSError:
        print(f"Worker not reachable at {WORKER} — run `npm run dev` first.", file=sys.stderr)
        return 2

    print("rejections (must answer without calling Telegram at all):")
    calls.clear()
    check("GET /webhook is 404", send("", path="/webhook", method="GET") == 404)
    check("POST / is 404", send("{}", path="/") == 404)
    check("missing secret is 403", send((FIXTURES / "next.json").read_text(), secret=None) == 403)
    check("wrong secret is 403", send((FIXTURES / "next.json").read_text(), secret="nope") == 403)
    check("malformed JSON is 200", send("not-json") == 200)
    time.sleep(0.4)
    check("no Bot API call leaked", len(calls) == 0, f"{len(calls)} call(s) made")

    made = replay("stranger.json")
    check("unknown sender gets a silent 200", made == [] , f"{len(made)} call(s) made")

    print("\n/next:")
    made = replay("next.json")
    check("sends one message", len(made) == 1)
    check("offers a record button carrying ids only",
          any(re.fullmatch(r"rec:\d+", b) for b in buttons(made)), str(buttons(made)))
    check("never puts a name in callback data",
          all(re.fullmatch(r"(rec|obj|undo):\d+|log|next", b) for b in buttons(made)))

    print("\n/log:")
    made = replay("log.json")
    check("pins the recommendation first", buttons(made)[0].startswith("rec:"), str(buttons(made)))
    check("drills down for a multi-child objective", "obj:3" in buttons(made))
    check("records flat objectives in one tap",
          sum(1 for b in buttons(made) if b.startswith("rec:")) >= 4, str(buttons(made)))

    print("\ndrill-down callback:")
    made = replay("callback-drilldown.json")
    check("answers the callback query first",
          made and made[0]["method"] == "answerCallbackQuery")
    check("edits in place rather than sending a new message",
          any(c["method"] == "editMessageText" for c in made))
    check("offers a Back button", "log" in buttons(made))

    print("\nrecord then undo:")
    before = int(db("SELECT COUNT(*) c FROM sessions")[0]["c"])
    rec = next(b for b in buttons(replay("next.json")) if b.startswith("rec:"))
    calls.clear()
    send(json.dumps({"update_id": 90, "callback_query": {
        "id": "cq-rec", "from": {"id": ALLOWED_ID}, "data": rec,
        "message": {"message_id": 11, "chat": {"id": ALLOWED_ID}}}}))
    time.sleep(0.8)
    made = list(calls)
    after = int(db("SELECT COUNT(*) c FROM sessions")[0]["c"])
    check("writes exactly one session row", after == before + 1, f"{before} -> {after}")
    check("acknowledges with the new totals", "this week" in texts(made), texts(made))
    check("offers an inline Undo", any(b.startswith("undo:") for b in buttons(made)))

    undo = next(b for b in buttons(made) if b.startswith("undo:"))
    calls.clear()
    send(json.dumps({"update_id": 91, "callback_query": {
        "id": "cq-undo", "from": {"id": ALLOWED_ID}, "data": undo,
        "message": {"message_id": 11, "chat": {"id": ALLOWED_ID}}}}))
    time.sleep(0.8)
    check("undo removes the row again",
          int(db("SELECT COUNT(*) c FROM sessions")[0]["c"]) == before)
    check("undo says what it removed", "Removed" in texts(list(calls)))

    print("\n/stats:")
    made = replay("stats.json")
    check("sends the weekly balance and the all-time view", len(made) >= 2, f"{len(made)} message(s)")
    check("uses a <pre> block so alignment survives", "<pre>" in texts(made))
    check("shows a session count", re.search(r"\d+ sessions?", texts(made)) is not None)
    check("never claims a target count or completion",
          not re.search(r"complete|goal|\d+ of \d+", texts(made), re.I))

    print("\n/undo on an empty log:")
    made = replay("undo-command.json")
    check("says the log is empty rather than failing", "empty" in texts(made), texts(made))

    # ---- tree editing (design section 8 step 6) ----------------------------
    # Works on its own uniquely-named objective and cleans up after itself, so
    # it neither depends on nor disturbs the seeded tree.
    print("\n/add, /tree, /weight:")
    NAME, SUB = "ZzTestObjective", "ZzTestChild"
    cmd(f"/delete {NAME}")  # in case a previous run died halfway

    out = cmd(f"/add {NAME} 3")
    check("adds an objective with a weight", "Added" in out and NAME in out, out[:120])
    check("shows the resulting tree, so renormalising is visible", "w=3" in out, out[:160])

    out = cmd(f"/add {NAME} 3")
    check("refuses a duplicate objective name", "already" in out.lower(), out[:120])

    out = cmd("/tree")
    check("lists the new objective in /tree", NAME in out, out[:160])

    out = cmd(f"/weight {NAME} 30%")
    check("accepts a percentage and converts it to a raw weight",
          "weight 3 →" in out, out[:160])

    out = cmd(f"/weight {NAME} 0")
    check("weight 0 explains that history is kept",
          "never be recommended" in out, out[:160])
    out = cmd("/next")
    check("a zero-weight objective is not recommended", NAME not in out, out[:120])

    cmd(f"/weight {NAME} 2")
    out = cmd(f"/add {NAME} > {SUB}")
    check("adds a sub-objective", "Added" in out and SUB in out, out[:120])
    check("explains that the default child keeps its history",
          "default" in out.lower() or "original" in out.lower(), out[:200])

    print("\n/rename, /pause, /resume:")
    out = cmd(f"/rename {NAME} > {NAME}2")
    check("renames an objective", f"{NAME}2" in out, out[:120])
    out = cmd(f"/pause {NAME}2")
    check("pauses and says the history is kept", "paused" in out.lower(), out[:120])
    out = cmd("/next")
    check("a paused objective is not recommended", f"{NAME}2" not in out, out[:120])
    out = cmd(f"/resume {NAME}2")
    check("resumes", "resumed" in out.lower(), out[:120])

    print("\nerror handling:")
    out = cmd("/add")
    check("/add with no arguments shows usage", "/add" in out, out[:80])
    out = cmd("/weight NoSuchThing 3")
    check("names an unknown objective plainly", "No objective" in out, out[:120])
    out = cmd("/add A > B > C")
    check("refuses a third tree level", "two levels" in out, out[:120])
    out = cmd("/weight ZzTestObjective2 -5")
    check("refuses a negative weight", "negative" in out.lower(), out[:120])

    print("\n/delete guards the log:")
    # Record against it, then prove deletion is refused.
    rec = None
    out = cmd("/tree")
    subs = db("SELECT so.id FROM sub_objectives so JOIN objectives o ON o.id=so.objective_id "
              f"WHERE o.name='{NAME}2' AND so.is_default=1")
    if subs:
        rec = int(subs[0]["id"])
        calls.clear()
        send(json.dumps({"update_id": 900, "callback_query": {
            "id": "cq-x", "from": {"id": ALLOWED_ID}, "data": f"rec:{rec}",
            "message": {"message_id": 99, "chat": {"id": ALLOWED_ID}}}}))
        time.sleep(0.8)
    out = cmd(f"/delete {NAME}2")
    check("refuses to delete something with recorded sessions",
          "cannot be rebuilt" in out or "recorded" in out, out[:160])
    check("points at /pause as the safe alternative", "/pause" in out, out[:200])

    # Undo the session, then deletion is allowed again.
    sid = db("SELECT id FROM sessions ORDER BY id DESC LIMIT 1")
    if sid:
        calls.clear()
        send(json.dumps({"update_id": 901, "callback_query": {
            "id": "cq-u", "from": {"id": ALLOWED_ID}, "data": f"undo:{int(sid[0]['id'])}",
            "message": {"message_id": 99, "chat": {"id": ALLOWED_ID}}}}))
        time.sleep(0.8)
    out = cmd(f"/delete {NAME}2")
    check("deletes cleanly once nothing is recorded", "Deleted" in out, out[:160])
    out = cmd("/tree")
    check("the deleted objective is gone from /tree", f"{NAME}2" not in out, out[:200])

    # ---- tapping instead of typing ---------------------------------------
    print("\npersistent keyboard:")
    calls.clear()
    out_calls = []
    _uid[0] += 1
    send(json.dumps({"update_id": _uid[0], "message": {
        "message_id": _uid[0], "chat": {"id": ALLOWED_ID},
        "from": {"id": ALLOWED_ID}, "text": "/start"}}))
    time.sleep(1.0)
    out_calls = list(calls)
    kb = [c for c in out_calls
          if isinstance(c["body"].get("reply_markup"), dict)
          and "keyboard" in c["body"]["reply_markup"]]
    check("/start sends a persistent reply keyboard", len(kb) >= 1)
    if kb:
        rm = kb[0]["body"]["reply_markup"]
        check("the keyboard is persistent and resized",
              rm.get("is_persistent") is True and rm.get("resize_keyboard") is True, str(rm)[:120])
        labels = [b["text"] for row in rm["keyboard"] for b in row]
        check("it carries the everyday actions", len(labels) == 6, str(labels))
    check("/start registers the Menu command list",
          any(c["method"] == "setMyCommands" for c in out_calls),
          str([c["method"] for c in out_calls]))

    print("\nbutton labels act as commands:")
    out = cmd("▶️ Next")
    check("tapping Next behaves like /next", "furthest behind" in out or "Nothing to practice" in out, out[:100])
    out = cmd("🌳 Tree")
    check("tapping Tree behaves like /tree", "w=" in out or "No objectives" in out, out[:100])
    out = cmd("⚙️ Manage")
    check("tapping Manage opens the editing menu", "Manage the tree" in out, out[:100])

    print("\nadding an objective without typing a command:")
    made = tap("ask:add")
    # Quote the prompt message itself, not every call in the exchange.
    prompt = next(
        (c["body"].get("text", "") for c in made
         if (c["body"].get("reply_markup") or {}).get("force_reply")),
        "",
    )
    check("the menu asks for the name with a forced reply",
          any((c["body"].get("reply_markup") or {}).get("force_reply") for c in made), str(made)[:160])
    check("the compose box gets a placeholder showing the shape",
          any((c["body"].get("reply_markup") or {}).get("input_field_placeholder") for c in made))

    NEW = "ZzTapAdded"
    cmd(f"/delete {NEW}")
    stripped = re.sub(r"<[^>]+>", "", prompt)
    out = answer(stripped, f"{NEW} 5")
    check("replying with just the name creates the objective",
          "Added" in out and NEW in out, out[:160])
    check("and the weight from the reply is used", "w=5" in out, out[:200])

    print("\nreplies to anything else are not mistaken for arguments:")
    out = answer("✓ Guitar\n1 this week · 1 all time", "Alpha 9")
    check("an unrelated reply is not read as a command",
          "Added" not in out, out[:120])
    cmd(f"/delete {NEW}")

    # ---- regression: labels after an objective stops being flat -----------
    print("\ndefault child is named once it has siblings (reported bug):")
    G = "ZzLabelCase"
    cmd(f"/delete {G}")
    cmd(f"/add {G} 500")           # huge weight so /next always picks it
    out = cmd("/next")
    check("while flat, the recommendation is just the objective name",
          G in out and f"{G} →" not in out, out[:140])

    cmd(f"/add {G} > One")
    cmd(f"/add {G} > Two")
    # Now three children: the default plus One and Two. Every /next for this
    # objective must name which one, or the three read identically.
    seen = set()
    for _ in range(6):
        out = cmd("/next")
        m = re.search(rf"{G}[^<\n]*", re.sub(r"<[^>]+>", "", out))
        if m:
            seen.add(m.group(0).strip())
        btn = None
        made = list(calls)
        for c in made:
            for row in (c["body"].get("reply_markup") or {}).get("inline_keyboard", []):
                for b in row:
                    if b["callback_data"].startswith("rec:"):
                        btn = b["callback_data"]
        if btn:
            tap(btn)
    check("every recommendation now qualifies the child",
          all("→" in s for s in seen), str(seen))
    check("the three children are distinguishable from each other",
          len(seen) >= 3, str(seen))

    # Pausing the real children makes it a flat item again.
    cmd(f"/pause One")
    cmd(f"/pause Two")
    out = cmd("/next")
    check("collapses back to the bare name once siblings are paused",
          G in out and f"{G} →" not in out, out[:140])

    # clean up: undo the sessions we just recorded, then delete
    for _ in range(8):
        if not db(f"SELECT s.id FROM sessions s JOIN sub_objectives so ON so.id=s.sub_objective_id "
                  f"JOIN objectives o ON o.id=so.objective_id WHERE o.name='{G}' LIMIT 1"):
            break
        cmd("/undo")
    cmd(f"/delete {G}")

    # ---- review findings: ambiguity is now resolvable ---------------------
    print("\nambiguous child names can be qualified (finding 1):")
    for n in ("ZzAmbA", "ZzAmbB"):
        cmd(f"/delete {n}")
    cmd("/add ZzAmbA 1"); cmd("/add ZzAmbB 1")
    cmd("/add ZzAmbA > Shared"); cmd("/add ZzAmbB > Shared")

    out = cmd("/pause Shared")
    check("an unqualified ambiguous name still reports the clash",
          "matches more than one" in out, out[:140])
    check("and advises the qualified form", "&gt; Child" in out or "> Child" in out, out[:160])

    out = cmd("/pause ZzAmbA > Shared")
    check("the advised qualified form is ACCEPTED", "paused" in out.lower(), out[:160])
    out = cmd("/resume ZzAmbA > Shared")
    check("qualified resume works too", "resumed" in out.lower(), out[:140])
    out = cmd("/rename ZzAmbA > Shared > Renamed")
    check("qualified rename works", "Renamed" in out, out[:160])
    out = cmd("/delete ZzAmbB > Shared")
    check("qualified delete works", "Deleted" in out, out[:160])

    print("\nrename cannot create a duplicate sibling (finding 2):")
    cmd("/add ZzAmbA > One"); cmd("/add ZzAmbA > Two")
    out = cmd("/rename Two > One")
    check("refuses a rename that would duplicate a sibling",
          "already has" in out, out[:160])
    out = cmd("/tree")
    check("both siblings still exist under their parent",
          "One" in out and "Two" in out, out[:200])

    print("\nstale keyboard taps (finding 5):")
    cmd("/add ZzStale 1")
    made = replay("next.json")
    subs = db("SELECT so.id FROM sub_objectives so JOIN objectives o ON o.id=so.objective_id "
              "WHERE o.name='ZzStale'")
    stale = int(subs[0]["id"]) if subs else None
    cmd("/delete ZzStale")
    if stale is not None:
        n_before = int(db("SELECT COUNT(*) c FROM sessions")[0]["c"])
        made = tap(f"rec:{stale}")
        n_after = int(db("SELECT COUNT(*) c FROM sessions")[0]["c"])
        check("a tap on a deleted entry writes no session row",
              n_after == n_before, f"{n_before} -> {n_after}")
        check("and says so instead of failing silently",
              "no longer exists" in texts(made), texts(made)[:140])

    print("\nseed is idempotent (finding 6):")
    b = int(db("SELECT COUNT(*) c FROM objectives")[0]["c"])
    subprocess.run(["npm", "run", "seed:local"], capture_output=True, check=False)
    a = int(db("SELECT COUNT(*) c FROM objectives")[0]["c"])
    check("re-running the seed adds no duplicates", a == b, f"{b} -> {a}")

    for n in ("ZzAmbA", "ZzAmbB", "ZzStale"):
        cmd(f"/delete {n}")

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
