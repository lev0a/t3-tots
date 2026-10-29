// Unit tests for the T3 inbox: append-only log, idempotent ids, answer routing, the 4-hour due flag, MCP tools.
// Run: node --test tests/inbox.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const inbox = require(path.join(__dirname, "..", "tools", "t3inbox"));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "t3inbox-")); }
function run(root, fn) { return inbox.withRoot(root, fn); }
function lines(root, project) {
  const f = path.join(root, inbox.slug(project), "items.jsonl");
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
}
function fakeT3(live, calls) {
  return {
    async lookup() { return { threadExists: true, pending: false, answerable: false, status: null, ...live }; },
    async respond(x) { calls.push({ op: "respond", ...x }); return { status: "resolved" }; },
    async queueTurn(x) { calls.push({ op: "queue", ...x }); return { result: "queued" }; },
  };
}
const owner = { from: "owner", via: "room", ref: "msg-1" };
async function openT3(root, extra = {}) {
  const res = await run(root, () => inbox.openFromRequest({
    machine: "desktop", threadId: "thread-1", threadTitle: "Scratch", project: "anesthassist",
    requestId: "req-1", at: "2026-10-29T00:00:00.000Z", questions: [{
      id: "8", header: "Keep", question: "Where should we keep it?", multiSelect: false,
      options: [{ label: "Local only", description: "cheap" }, { label: "Server" }], allowCustomAnswer: true,
    }, {
      id: "9", header: "Logs", question: "Which logs?", multiSelect: true,
      options: [{ label: "API" }, { label: "Worker" }],
    }], ...extra,
  }));
  return res.item;
}

test("fold rebuilds an item from a hand-made log, and state.json is only a cache", async () => {
  const root = tmp();
  const events = [
    { v: 1, at: "2026-10-29T00:00:00.000Z", by: "t3listen", type: "item.opened", id: "t3:desktop:req-9", source: "t3-request", machine: "desktop", threadId: "t", threadTitle: "T", project: "demo", projectSlug: "demo", requestId: "req-9", questions: [], route: "dm", subject: "Hi" },
    { v: 1, at: "2026-10-29T00:01:00.000Z", by: "t3ctl", type: "item.posted", id: "t3:desktop:req-9", destination: "dm", ref: "m" },
    { v: 1, at: "2026-10-29T00:02:00.000Z", by: "owner", type: "item.answered", id: "t3:desktop:req-9", answers: { q: "Yes" }, answeredBy: "owner", via: "dm", ref: "m" },
    { v: 1, at: "2026-10-29T00:02:01.000Z", by: "t3ctl", type: "item.delivered", id: "t3:desktop:req-9", method: "respond", result: "ok" },
    { v: 1, at: "2026-10-29T00:02:02.000Z", by: "t3ctl", type: "item.closed", id: "t3:desktop:req-9", reason: "delivered" },
  ];
  const folded = inbox.fold(events);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].state, "closed");
  assert.equal(folded[0].reason, "delivered");
  assert.equal(folded[0].answers.q, "Yes");
  assert.equal(folded[0].posted.destination, "dm");
  const dir = path.join(root, "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "items.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const cache = await run(root, () => inbox.rebuild("demo"));
  assert.equal(cache.items[0].state, "closed");
  fs.rmSync(path.join(dir, "state.json"));
  const again = await run(root, () => inbox.rebuild("demo"));
  assert.equal(again.items[0].id, "t3:desktop:req-9");
  assert.equal(again.items[0].state, "closed");
});

test("a repeated request.opened appends nothing", async () => {
  const root = tmp();
  const a = await openT3(root);
  const b = await openT3(root);
  assert.equal(a.id, "t3:desktop:req-1");
  assert.equal(b.id, a.id);
  assert.equal(lines(root, "anesthassist").length, 1);
  assert.equal(a.machine, "desktop");
  assert.equal(a.route, "dm");
  const log = lines(root, "anesthassist")[0];
  await run(root, () => inbox.markPosted({ item: a.id, destination: "AnesthAssist", ref: "room-1" }));
  const after = lines(root, "anesthassist");
  assert.equal(after[0], log, "items.jsonl is append-only");
  assert.equal(after.length, 2);
  await run(root, () => inbox.markPosted({ item: a.id, destination: "AnesthAssist", ref: "room-1" }));
  assert.equal(lines(root, "anesthassist").length, 2);
});

test("routes.json picks the room, and a project with no route goes to dm", async () => {
  const root = tmp();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "routes.json"), JSON.stringify({ anesthassist: "AnesthAssist", "vibe-tutor": "dm", _none: "dm" }));
  const item = await openT3(root);
  assert.equal(item.route, "AnesthAssist");
  const none = await run(root, () => inbox.openFromRequest({
    machine: "macbook", threadId: "t2", threadTitle: "Loose", project: null, requestId: "req-2", questions: [{ id: "1", question: "Go on?", options: [] }],
  }));
  assert.equal(none.item.projectSlug, "_none");
  assert.equal(none.item.route, "dm");
  assert.equal(none.item.machine, "macbook");
});

test("letters map for one, multi and text questions", async () => {
  const root = tmp();
  const item = await openT3(root);
  assert.deepEqual(item.questions[0].options.map((o) => o.letter), ["A", "B"]);
  assert.equal(item.questions[0].kind, "one");
  assert.equal(item.questions[1].kind, "multi");
  const picked = inbox.resolveAnswers(item, { pick: "8:A,9:A+B" });
  assert.deepEqual(picked, { "8": "Local only", "9": ["API", "Worker"] });
  const textItem = await run(root, () => inbox.openFromRequest({
    machine: "desktop", threadId: "t", threadTitle: "T", project: "demo", requestId: "req-text",
    questions: [{ id: "1", question: "Name it", options: [], allowCustomAnswer: true }],
  }));
  assert.equal(textItem.item.questions[0].kind, "text");
  assert.equal(inbox.resolveAnswers(textItem.item, { text: "Blue room" })["1"], "Blue room");
  const blocks = inbox.parseQuestionBlocks([
    ":::question",
    "Where should we keep the edit?",
    "",
    "Two devices can edit one note offline.",
    "",
    "- [ ] Local only — cheap",
    "- [ ] Server — survives reinstall",
    "",
    "Recommended: Local only",
    "Stakes: the other edit is dropped",
    ":::",
    ":::question-multi",
    "Which logs should we keep?",
    "- [ ] API",
    "- [ ] Worker",
    "Recommended: API and Worker",
    ":::",
    ":::question-text",
    "What should the room be called?",
    "Stakes: shown on every card",
    ":::",
  ].join("\n"));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, "one");
  assert.equal(blocks[0].options[0].label, "Local only");
  assert.equal(blocks[0].options[0].description, "cheap");
  assert.equal(blocks[0].recommended, "Local only");
  assert.equal(blocks[0].stakes, "the other edit is dropped");
  assert.deepEqual(blocks[1].recommended, ["API", "Worker"]);
  assert.equal(blocks[2].kind, "text");
  assert.equal(blocks[2].stakes, "shown on every card");
  assert.throws(() => inbox.parseQuestionBlocks(":::action\nApprove the deploy\n:::"), /validation_error: :::action/);
});

test("an answer not marked from the owner is refused and writes nothing", async () => {
  const root = tmp();
  const item = await openT3(root);
  const calls = [];
  await assert.rejects(() => run(root, () => inbox.answerItem({ ...owner, from: "pm", item: item.id, pick: "8:A,9:A" }, fakeT3({}, calls))), /NOT_OWNER/);
  await assert.rejects(() => run(root, () => inbox.answerItem({ ...owner, from: "", item: item.id, pick: "8:A,9:A" }, fakeT3({}, calls))), /NOT_OWNER/);
  assert.equal(calls.length, 0);
  assert.equal(lines(root, "anesthassist").length, 1);
});

test("a pending request is answered with runtime-request.respond, letters mapped to labels", async () => {
  const root = tmp();
  const item = await openT3(root);
  const calls = [];
  const live = { pending: true, answerable: true, status: "pending", responseMode: "live" };
  const res = await run(root, () => inbox.answerItem({ ...owner, item: item.id, pick: "8:B,9:A+B" }, fakeT3(live, calls)));
  assert.equal(res.method, "respond");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "respond");
  assert.equal(calls[0].requestId, "req-1");
  assert.deepEqual(calls[0].answers, { "8": "Server", "9": ["API", "Worker"] });
  assert.equal(calls[0].commandId, inbox.commandIdFor(item.id, "respond"));
  assert.match(calls[0].commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const done = await run(root, () => inbox.listItems({ all: true }));
  assert.equal(done[0].state, "closed");
  assert.equal(done[0].reason, "delivered");
  assert.equal(done[0].delivery.method, "respond");
});

test("answering in T3 closes the item, and a later inbox answer is ALREADY_CLOSED", async () => {
  const root = tmp();
  const item = await openT3(root);
  const closed = await run(root, () => inbox.closeFromResolution({
    machine: "desktop", requestId: "req-1", status: "resolved", answers: { "8": "Local only", "9": ["API"] }, answeredHere: false,
  }));
  assert.equal(closed.reason, "answered-in-t3");
  assert.equal(closed.state, "closed");
  const calls = [];
  await assert.rejects(
    () => run(root, () => inbox.answerItem({ ...owner, item: item.id, pick: "8:A,9:A" }, fakeT3({ pending: true, answerable: true }, calls))),
    /ALREADY_CLOSED: item t3:desktop:req-1 is closed \(answered-in-t3\)/,
  );
  assert.equal(calls.length, 0);
  assert.equal(lines(root, "anesthassist").filter((l) => l.includes("item.closed")).length, 1);
});

test("a request that is already resolved closes as answered-in-t3 and does not queue", async () => {
  const root = tmp();
  const item = await openT3(root);
  const calls = [];
  const live = { pending: false, status: "resolved", recordedAnswers: { "8": "Server" }, threadExists: true };
  await assert.rejects(
    () => run(root, () => inbox.answerItem({ ...owner, item: item.id, pick: "8:A,9:A" }, fakeT3(live, calls))),
    /ALREADY_CLOSED:.*answered-in-t3/,
  );
  assert.equal(calls.length, 0);
  const [got] = await run(root, () => inbox.listItems({ all: true }));
  assert.equal(got.reason, "answered-in-t3");
});

test("when the request is gone but the thread remains, the answer is a queued turn", async () => {
  const root = tmp();
  const item = await openT3(root);
  const calls = [];
  const res = await run(root, () => inbox.answerItem({ ...owner, via: "dm", item: item.id, pick: "8:A,9:B" }, fakeT3({ pending: false, status: null, threadExists: true }, calls)));
  assert.equal(res.method, "queued-turn");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "queue");
  assert.equal(calls[0].text, `Answer to your earlier question (${item.id}): 8=Local only; 9=Worker`);
  assert.equal(calls[0].commandId, inbox.commandIdFor(item.id, "queued-turn"));
  const [got] = await run(root, () => inbox.listItems({ all: true }));
  assert.equal(got.delivery.method, "queued-turn");
  assert.equal(got.state, "closed");
  await assert.rejects(() => run(root, () => inbox.answerItem({ ...owner, item: item.id, pick: "8:A,9:A" }, fakeT3({}, calls))), /ALREADY_CLOSED:.*delivered/);
  assert.equal(calls.length, 1);
});

test("a deleted thread is saved as request-gone and nothing is sent", async () => {
  const root = tmp();
  const item = await openT3(root);
  const calls = [];
  const res = await run(root, () => inbox.answerItem({ ...owner, via: "terminal", item: item.id, pick: "8:A,9:A" }, fakeT3({ threadExists: false }, calls)));
  assert.equal(res.status, "request-gone");
  assert.equal(calls.length, 0);
  const [got] = await run(root, () => inbox.listItems({ all: true }));
  assert.equal(got.reason, "request-gone");
  assert.equal(got.answers["8"], "Local only");
});

test("an agent question outside a T3 request is delivered as a queued turn", async () => {
  const root = tmp();
  const body = ":::question\nShip the drawer?\n- [ ] A — current\n- [ ] B — pinned total\nRecommended: B\nStakes: ships Thursday\n:::";
  const sent = await run(root, () => inbox.callTool("send_message", { body, thread: "thread-9", project: "readyrt", subject: "Checkout drawer", idempotency_key: "k1" }));
  const payload = JSON.parse(sent.content[0].text);
  assert.equal(payload.created, true);
  assert.ok(payload.machine);
  assert.match(payload.item_id, /^agent:/);
  const again = await run(root, () => inbox.callTool("send_message", { body, thread: "thread-9", project: "readyrt", subject: "Checkout drawer", idempotency_key: "k1" }));
  const payload2 = JSON.parse(again.content[0].text);
  assert.equal(payload2.created, false);
  assert.equal(payload2.item_id, payload.item_id);
  assert.equal(lines(root, "readyrt").length, 1);
  const other = await run(root, () => inbox.callTool("send_message", { body: body + "\n", thread: "thread-9", project: "readyrt", idempotency_key: "k1" }));
  assert.equal(JSON.parse(other.content[0].text).isError, true);
  const calls = [];
  const res = await run(root, () => inbox.answerItem({ ...owner, via: "terminal", item: payload.item_id, pick: `${payload.questions[0].key}:B` }, fakeT3({ threadExists: true }, calls)));
  assert.equal(res.method, "queued-turn");
  assert.match(calls[0].text, new RegExp(`^T3 Inbox: Checkout drawer \\(${payload.item_id}\\)`));
  assert.match(calls[0].text, /B/);
  const read = await run(root, () => inbox.callTool("read_thread", { item_id: payload.item_id }));
  const view = JSON.parse(read.content[0].text);
  assert.equal(view.items[0].answered, true);
  assert.equal(view.items[0].questions[0].state, "answered");
  assert.equal(view.items[0].questions[0].answer, "B");
});

test("an unanswered item is due after 4 hours, and remind only records that", async () => {
  const root = tmp();
  const opened = "2026-10-29T00:00:00.000Z";
  const item = await openT3(root, { at: opened });
  const t0 = Date.parse(opened);
  const before = await run(root, () => inbox.listItems({ due: true, now: t0 + inbox.DUE_MS - 1 }));
  assert.equal(before.length, 0);
  const due = await run(root, () => inbox.listItems({ due: true, now: t0 + inbox.DUE_MS }));
  assert.equal(due.length, 1);
  assert.equal(due[0].due, true);
  assert.equal(due[0].id, item.id);
  await assert.rejects(() => run(root, () => inbox.markReminded({ item: item.id, now: t0 + inbox.DUE_MS - 1 })), /NOT_DUE/);
  const marked = await run(root, () => inbox.markReminded({ item: item.id, now: t0 + inbox.DUE_MS }));
  assert.equal(marked.created, true);
  const after = await run(root, () => inbox.listItems({ due: true, now: t0 + inbox.DUE_MS + 60000 }));
  assert.equal(after.length, 0);
  const raw = lines(root, "anesthassist").map((l) => JSON.parse(l));
  assert.ok(raw.some((e) => e.type === "item.reminded"));
  assert.ok(!raw.some((e) => e.type === "item.delivered" || e.type === "item.answered"));
  const posted = await openT3(root, { requestId: "req-posted", at: opened });
  await run(root, () => inbox.answerItem({ ...owner, item: posted.id, pick: "8:A,9:A" }, fakeT3({ pending: true, answerable: true, status: "pending" }, [])));
  const notDue = await run(root, () => inbox.listItems({ due: true, now: t0 + inbox.DUE_MS * 2 }));
  assert.ok(!notDue.some((it) => it.id === posted.id));
});

test("a late item.posted does not reopen a closed item", async () => {
  const root = tmp();
  const item = await openT3(root);
  await run(root, () => inbox.closeFromResolution({ machine: "desktop", requestId: "req-1", status: "resolved", answers: { "8": "Server" } }));
  await run(root, () => inbox.markPosted({ item: item.id, destination: "dm", ref: "late" }));
  const [got] = await run(root, () => inbox.listItems({ all: true }));
  assert.equal(got.state, "closed");
  assert.equal(got.reason, "answered-in-t3");
  assert.equal(got.posted.destination, "dm");
});

test("MCP tools/list and send_message refuse a missing thread and an action block", async () => {
  const root = tmp();
  const listed = await run(root, () => inbox.handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const names = listed.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["read_thread", "send_message"]);
  const init = await run(root, () => inbox.handleMcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }));
  assert.equal(init.result.serverInfo.name, "t3-inbox");
  assert.equal(await run(root, () => inbox.handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" })), null);
  const missing = await run(root, () => inbox.callTool("send_message", { body: ":::question\nShip it?\n- [ ] Yes\n:::" }));
  assert.match(JSON.parse(missing.content[0].text).error, /validation_error: thread is required/);
  const action = await run(root, () => inbox.callTool("send_message", { thread: "t", body: ":::action\nApprove it\n:::" }));
  assert.match(JSON.parse(action.content[0].text).error, /validation_error: :::action/);
  const frame = inbox.encodeFrame({ jsonrpc: "2.0", id: 7, method: "ping" });
  const parsed = inbox.parseFrames(Buffer.concat([frame, Buffer.from("Content-Length: 5")]));
  assert.equal(parsed.msgs.length, 1);
  assert.equal(parsed.msgs[0].id, 7);
  assert.ok(parsed.rest.length > 0);
});

test("t3ctl inbox list and a non-owner answer do not need T3, and usage stays compatible", async () => {
  const root = tmp();
  const bin = path.join(__dirname, "..", "tools", "t3ctl");
  const { execFileSync, spawnSync } = require("child_process");
  const usage = execFileSync(process.execPath, [bin], { encoding: "utf8" });
  assert.match(usage, /new --project p [^|]*--wait \[--timeout seconds\]/);
  assert.match(usage, /inbox list \[--project p\] \[--open\] \[--due\] \[--json\]/);
  assert.match(usage, /answer --thread t \[--request id\]/);
  const list = spawnSync(process.execPath, [bin, "inbox", "list", "--json"], { encoding: "utf8", env: { ...process.env, T3_INBOX_DIR: root } });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trim(), "[]");
  const denied = spawnSync(process.execPath, [bin, "inbox", "answer", "--item", "t3:desktop:nope", "--from", "someone", "--via", "room", "--ref", "m", "--pick", "8:A"], { encoding: "utf8", env: { ...process.env, T3_INBOX_DIR: root } });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /^NOT_OWNER:/);
  assert.equal(fs.readdirSync(root).length, 0);
});

test("t3listen only opens inbox items for user_input, and startup sweeps resolved requests", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  assert.match(src, /r\.kind !== "user_input"/);
  assert.match(src, /inbox\.openFromRequest/);
  assert.match(src, /inbox\.closeFromResolution/);
  assert.match(src, /await sweepInbox\(ep, live\)/);
  const openFn = src.slice(src.indexOf("async function inboxOpen"), src.indexOf("async function inboxClose"));
  assert.match(openFn, /user_input/);
  assert.doesNotMatch(openFn, /approval/);
});

test("stdio MCP server lists tools and posts one item", async () => {
  const root = tmp();
  const bin = path.join(__dirname, "..", "tools", "t3ctl");
  const child = spawn(process.execPath, [bin, "inbox", "mcp"], { env: { ...process.env, T3_INBOX_DIR: root, T3_INBOX_MACHINE: "macbook" }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = Buffer.alloc(0);
  const waiters = [];
  const poke = () => { const queued = waiters.splice(0, waiters.length); for (const fn of queued) fn(); };
  child.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); poke(); });
  const err = [];
  child.stderr.on("data", (c) => err.push(c.toString()));
  function next(n) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout, stderr=${err.join("")} buf=${buf.toString()}`)), 5000);
      const check = () => {
        const parsed = inbox.parseFrames(buf);
        if (parsed.msgs.length >= n) {
          clearTimeout(timer);
          const extra = parsed.msgs.slice(n).reduce((acc, msg) => Buffer.concat([acc, inbox.encodeFrame(msg)]), Buffer.alloc(0));
          buf = Buffer.concat([extra, parsed.rest]);
          resolve(parsed.msgs.slice(0, n));
          if (extra.length) poke();
        } else waiters.push(check);
      };
      check();
    });
  }
  const send = (obj) => child.stdin.write(inbox.encodeFrame(obj));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const first = await next(2);
  assert.equal(first[0].result.serverInfo.name, "t3-inbox");
  assert.ok(first[1].result.tools.some((t) => t.name === "send_message"));
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: {
    thread: "thread-mac", project: "vibe-tutor", subject: "Tutor name",
    body: ":::question-text\nWhat should we call the tutor?\nStakes: it is on the home screen\n:::",
  } } });
  const second = await next(1);
  const body = JSON.parse(second[0].result.content[0].text);
  assert.equal(body.created, true);
  assert.equal(body.machine, "macbook");
  assert.equal(body.questions[0].kind, "text");
  assert.equal(body.questions[0].stakes, "it is on the home screen");
  child.stdin.end();
  child.kill();
  await new Promise((r) => child.on("exit", r));
});
