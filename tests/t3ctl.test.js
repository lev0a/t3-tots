// Unit tests for t3ctl's pure helpers. Run: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const t = require(path.join(__dirname, "..", "tools", "t3ctl"));

test("deliveryOf: classifies where a sent message ended up", () => {
  const p = (runs, items = []) => ({ runs, turnItems: items });
  assert.equal(t.deliveryOf(p([{ userMessageId: "m", status: "running" }]), "m", "r1"), "started");
  assert.equal(t.deliveryOf(p([{ userMessageId: "m", status: "queued" }]), "m", "r1"), "queued");
  assert.equal(t.deliveryOf(p([{ userMessageId: "m", status: "queued" }]), "m", null), "stuck");
  assert.equal(t.deliveryOf(p([{ userMessageId: "m", status: "queued", queueHeld: true }]), "m", null), "held");
  assert.equal(t.deliveryOf(p([], [{ id: "x", messageId: "m" }]), "m", "r1"), "steered");
  assert.equal(t.deliveryOf(p([]), "m", null), "unknown");
});

test("stallHint: spots replies that wait on something", () => {
  assert.ok(t.stallHint("Started the capture in the background; I'll report back once it finishes."));
  assert.ok(t.stallHint("Waiting for the reviewer to finish."));
  assert.ok(!t.stallHint("All done. PR #12 is open and the tests pass."));
  assert.ok(!t.stallHint(""));
});

const th = (x = {}) => ({ id: "th1", title: "Demo", updatedAt: "2026-01-01T00:00:00Z", ...x });
const proj = (reply, extra = {}) => ({ runs: [], runtimeRequests: [], turnItems: reply ? [{ type: "assistant_message", text: reply }] : [], ...extra });

test("watchDiff: first check reports, an unchanged second check is silent", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const a = t.watchSnap(th({ activeRunId: "r" }), proj("working"), now);
  assert.equal(t.watchDiff(undefined, a, 20, now)[0].kind, "first");
  const b = t.watchSnap(th({ activeRunId: "r" }), proj("working"), now + 6e4);
  assert.deepEqual(t.watchDiff(a, b, 20, now + 6e4), []);
});
test("watchDiff: running to idle is 'finished' with the reply", () => {
  const now = Date.now();
  const a = t.watchSnap(th({ activeRunId: "r" }), proj("working"), now);
  const b = t.watchSnap(th({ updatedAt: "2026-01-01T01:00:00Z" }), proj("Done: merged."), now + 6e4);
  const ev = t.watchDiff(a, b, 20, now + 6e4);
  assert.equal(ev[0].kind, "finished"); assert.match(ev[0].text, /Done: merged/);
});
test("watchDiff: an idle thread waiting on a background job is reported stalled once", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z"); const reply = "Kicked off the screen capture in the background, will check back when it finishes.";
  let prev = t.watchSnap(th(), proj(reply), t0); t.watchDiff(undefined, prev, 20, t0);
  const mid = t.watchSnap(th(), proj(reply), t0 + 10 * 6e4); assert.deepEqual(t.watchDiff(prev, mid, 20, t0 + 10 * 6e4), []); prev = mid;
  const late = t.watchSnap(th(), proj(reply), t0 + 25 * 6e4); const ev = t.watchDiff(prev, late, 20, t0 + 25 * 6e4);
  assert.equal(ev.length, 1); assert.equal(ev[0].kind, "stalled");
  const later = t.watchSnap(th(), proj(reply), t0 + 40 * 6e4); assert.deepEqual(t.watchDiff(late, later, 20, t0 + 40 * 6e4), []);
});
test("watchDiff: new approvals are reported with why they ask, stuck queues are flagged", () => {
  const now = Date.now();
  const a = t.watchSnap(th(), proj("idle"), now);
  const p = proj("idle", { runs: [{ id: "q1", status: "queued", userMessageId: "m" }],
    runtimeRequests: [{ id: "req1", kind: "command", status: "pending", createdAt: "x" }],
    turnItems: [{ type: "assistant_message", text: "idle" }, { type: "approval_request", requestId: "req1", requestKind: "command", prompt: "git push --force", reason: "force push rewrites shared history" }] });
  const b = t.watchSnap(th({ updatedAt: "2026-01-01T02:00:00Z" }), p, now + 6e4);
  const ev = t.watchDiff(a, b, 20, now + 6e4), kinds = ev.map((e) => e.kind);
  assert.equal(b.pending[0].reason, "force push rewrites shared history");
  assert.equal(ev.find((e) => e.kind === "approval").text, "git push --force (why it asks: force push rewrites shared history)");
  assert.ok(kinds.includes("approval"), kinds.join()); assert.ok(kinds.includes("queue-stuck"), kinds.join());
});
test("watchDiff: usage limit is reported with the reset time", () => {
  const now = Date.now();
  const a = t.watchSnap(th({ activeRunId: "r" }), proj("x"), now);
  const b = t.watchSnap(th({ status: "failed", lastErrorClass: "usage_limit", lastError: { message: "limit" }, usageLimitResetAt: "2026-01-01T05:00:00Z" }), proj("x"), now + 6e4);
  const ev = t.watchDiff(a, b, 20, now + 6e4); assert.ok(ev.some((e) => e.kind === "limit" && /05:00/.test(e.text)));
});

test("parseEvery and parseWhen", () => {
  assert.equal(t.parseEvery("30m"), 30 * 6e4); assert.throws(() => t.parseEvery("10s"));
  const iso = t.parseWhen("+2h"); assert.ok(Math.abs(Date.parse(iso) - Date.now() - 2 * 36e5) < 5000);
});

// --- round 2 ---
test("decodeText: UTF-8 BOM, UTF-16 LE/BE (Windows PowerShell 5) and CRLF", () => {
  const s = "Line one\r\nLine two é\r\n";
  assert.equal(t.decodeText(Buffer.from(s, "utf8")), "Line one\nLine two é\n");
  assert.equal(t.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, "utf8")])), "Line one\nLine two é\n");
  assert.equal(t.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")])), "Line one\nLine two é\n");
  const be = Buffer.from(s, "utf16le"); be.swap16();
  assert.equal(t.decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), "Line one\nLine two é\n");
});
test("watchDiff: a run that ends on a question or a plan is 'finished'", () => {
  const now = Date.now();
  const a = t.watchSnap(th({ activeRunId: "r" }), proj("working"), now);
  const b = t.watchSnap(th({ updatedAt: "2026-01-01T01:00:00Z" }), proj("Should I merge it?"), now + 6e4);
  assert.equal(t.watchDiff(a, b, 20, now + 6e4)[0].kind, "finished");
  const c = t.watchSnap(th({ updatedAt: "2026-01-01T01:00:00Z", hasActionableProposedPlan: true }), proj("Plan ready."), now + 6e4);
  assert.equal(t.watchDiff(a, c, 20, now + 6e4)[0].kind, "finished");
});
test("watchDiff: a run that starts and ends between two checks is 'finished'", () => {
  const now = Date.now();
  const a = t.watchSnap(th(), proj("old reply"), now);
  const b = t.watchSnap(th({ updatedAt: "2026-01-01T03:00:00Z" }), proj("new reply"), now + 6e4);
  const ev = t.watchDiff(a, b, 20, now + 6e4); assert.equal(ev.length, 1); assert.equal(ev[0].kind, "finished"); assert.match(ev[0].text, /new reply/);
});
test("watchDiff: a request that can't be answered is reported once, not every check", () => {
  const now = Date.now();
  const p = proj("idle", { runtimeRequests: [{ id: "old", kind: "user_input", status: "pending", createdAt: "x", responseCapability: { type: "not_resumable" } }],
    turnItems: [{ type: "assistant_message", text: "idle" }] });
  const a = t.watchSnap(th(), proj("idle"), now);
  const b = t.watchSnap(th(), p, now + 6e4); const c = t.watchSnap(th(), p, now + 12e4);
  const first = t.watchDiff(a, b, 20, now + 6e4).filter((e) => e.kind === "stale-request");
  const again = t.watchDiff(b, c, 20, now + 12e4).filter((e) => e.kind === "stale-request");
  assert.equal(first.length, 1); assert.equal(again.length, 0);
});

test("isMainThread: hides threads agents spawned, keeps the user's", () => {
  assert.equal(t.isMainThread({ creationSource: "web" }), true);
  assert.equal(t.isMainThread({}), true);
  assert.equal(t.isMainThread({ creationSource: "mcp" }), false);
  assert.equal(t.isMainThread({ creationSource: "provider" }), false);
});
test("limitLine: marks a reset time that has already passed", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  assert.match(t.limitLine({ id: "a", title: "A", usageLimitResetAt: "2026-01-01T00:00:00Z" }, false, now), /\(passed\)/);
  assert.doesNotMatch(t.limitLine({ id: "b", title: "B", usageLimitResetAt: "2026-01-03T00:00:00Z" }, true, now), /passed|Z\b/);
  assert.match(t.limitLine({ id: "c", title: "C" }, false, now), /resets=\?/);
});
test("limitLine: title first, id last", () => {
  assert.match(t.limitLine({ id: "abc", title: "My thread" }, false), /^My thread  resets=.*  id=abc$/);
});
test("localT: names the zone (IST, not GMT+5:30)", () => {
  const { execFileSync } = require("child_process");
  const out = (tz) => execFileSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(path.join(__dirname, "..", "tools", "t3ctl"))}).localT("2026-01-01T12:00:00Z"))`], { env: { ...process.env, TZ: tz } }).toString().trim();
  assert.match(out("Asia/Kolkata"), /5:30 PM IST$|17:30 IST$/i);
  assert.doesNotMatch(out("America/Los_Angeles"), /GMT/);
  assert.equal(t.localT(null), "-");
});
test("isSettled: settledAt or a settled override, unless overridden back", () => {
  assert.equal(t.isSettled({ settledAt: "2026-01-01T00:00:00Z" }), true);
  assert.equal(t.isSettled({ settledOverride: "settled" }), true);
  assert.equal(t.isSettled({ settledAt: "2026-01-01T00:00:00Z", settledOverride: "unsettled" }), false);
  assert.equal(t.isSettled({}), false);
});
test("threadLine: a held queue shows as queue held, not the last run status", () => {
  const th0 = { id: "x", title: "Snig", status: "cancelled" };
  assert.equal(t.threadLine(th0, { runs: [{ status: "queued", queueHeld: true }] }), "x  queue held  Snig");
  assert.equal(t.threadLine(th0, { runs: [] }), "x  cancelled  Snig");
  assert.equal(t.threadLine({ ...th0, settledAt: "2026-01-01T00:00:00Z" }, null), "x  cancelled (settled)  Snig");
});
test("args: --key=value keeps a value that starts with --", () => {
  assert.deepEqual(t.args(["--text=--force is fine", "--thread", "x", "--json"]), { text: "--force is fine", thread: "x", json: true });
  assert.deepEqual(t.args(["--limit", "0"]), { limit: "0" });
});

test("usage names --timeout for new and send", () => {
  const { execFileSync } = require("child_process");
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "t3ctl")], { encoding: "utf8" });
  assert.match(out, /new --project p [^|]*--wait \[--timeout seconds\]/);
  assert.match(out, /send --thread id\|title --prompt t \[--wait \[--timeout seconds\]\]/);
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3ctl"), "utf8");
  assert.match(src, /"usage: new [^"]*--timeout seconds/); assert.match(src, /"usage: send [^"]*--timeout seconds/);
});

test("missingValue: a flag that needs a value but gets none is caught (--from --to dir)", () => {
  assert.equal(t.missingValue(t.args(["--from", "--to", "dir"]), "skills"), "from");
  assert.equal(t.missingValue(t.args(["--thread"]), "read"), "thread");
  assert.equal(t.missingValue(t.args(["--cancel"]), "queue"), "cancel");
  assert.equal(t.missingValue(t.args(["--cancel", "--thread", "x"]), "resume-at-reset"), undefined);
  assert.equal(t.missingValue(t.args(["--json", "--force", "--dry-run", "--main", "--wait"]), "threads"), undefined);
  assert.equal(t.missingValue(t.args(["--from=--odd", "--to", "d"]), "skills"), undefined);
});
test("a flag with no value exits 1 with usage before doing anything", () => {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "t3ctl"), "skills", "install", "--from", "--to", "/nonexistent-t3tots"], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /^USAGE: --from needs a value/);
});

test("pickThread: exact id, 8+ character prefix, exact title, one title match; several is AMBIGUOUS", () => {
  const ts = [{ id: "aaaa1111-0000", title: "Snig PR review", updatedAt: "2026-01-01" }, { id: "aaaa1112-0000", title: "Snig fixes", updatedAt: "2026-01-03" },
    { id: "cccc3333-0000", title: "Other", updatedAt: "2026-01-02" }, { id: "dddd4444-0000", title: "Other things", updatedAt: "2026-01-04" }];
  assert.equal(t.pickThread(ts, "aaaa1111-0000").id, "aaaa1111-0000");
  assert.equal(t.pickThread(ts, "cccc3333").id, "cccc3333-0000");
  assert.throws(() => t.pickThread(ts, "aaaa111"), /^Error: NOT_FOUND.*8 or more/); // short prefixes never match ids
  assert.throws(() => t.pickThread(ts, "aaaa11"), /NOT_FOUND/);
  assert.throws(() => t.pickThread([...ts, { id: "aaaa1111-9999", title: "x", updatedAt: "" }], "aaaa1111"), /^Error: AMBIGUOUS: 2 threads/);
  assert.equal(t.pickThread(ts, "other").id, "cccc3333-0000"); // exact title beats a longer title containing it
  assert.equal(t.pickThread(ts, "pr review").id, "aaaa1111-0000");
  assert.throws(() => t.pickThread(ts, "snig"), /AMBIGUOUS: 2 threads match "snig"[\s\S]*aaaa1112-0000  Snig fixes/);
});

test("sensitivePath: dotfiles, dot folders and token, auth, secret, credential or .env names are never copied", () => {
  const root = path.join(path.sep, "w", "proj");
  for (const f of [".env", ".env.production", "config/.npmrc", ".ssh/id_rsa", "secrets/db.txt", "api_token.txt", "auth.json", "creds/credentials.json", "my.env", "server.pem", "TOKEN"])
    assert.equal(t.sensitivePath(path.join(root, f), root), true, f);
  for (const f of ["src/app.ts", "README.md", "docs/guide.md"]) assert.equal(t.sensitivePath(path.join(root, f), root), false, f);
  assert.equal(t.sensitivePath(path.join(path.sep, "home", ".hidden", "proj", "a.ts"), path.join(path.sep, "home", ".hidden", "proj")), false); // a dot folder above the root is fine
});
test("pickProject: id, folder, exact title, one title match; several or none is an error, never the first one", () => {
  const P = [{ id: "p1", title: "Web", workspaceRoot: "/r/web" }, { id: "p2", title: "Web admin", workspaceRoot: "/r/admin" }, { id: "p3", title: "Website", workspaceRoot: "/r/site" }, { id: "p4", title: "API", workspaceRoot: "/r/api" }];
  assert.equal(t.pickProject(P, "p3").id, "p3");
  assert.equal(t.pickProject(P, "/r/admin/").id, "p2");
  assert.equal(t.pickProject(P, "web").id, "p1");            // exact title beats the two that contain it
  assert.equal(t.pickProject(P, "ap").id, "p4");             // one title contains it
  assert.throws(() => t.pickProject(P, "eb"), /AMBIGUOUS: 3 projects/);
  assert.throws(() => t.pickProject(P, "zzz"), /NOT_FOUND/);
  for (const q of ["", "   "]) assert.throws(() => t.pickProject(P, q), /--project .* is required/);
  assert.throws(() => t.pickProject([...P, { id: "p5", title: "web", workspaceRoot: "/x" }], "Web"), /AMBIGUOUS: 2/);
});
test("outPath: keeps the project-relative path so same-name files don't overwrite each other", () => {
  const root = path.resolve("/proj"), out = path.resolve("/out");
  const a = t.outPath(out, root, path.join(root, "src", "index.ts")), b = t.outPath(out, root, path.join(root, "test", "index.ts"));
  assert.equal(a, path.join(out, "src", "index.ts")); assert.notEqual(a, b);
  assert.equal(t.outPath(out, root, path.resolve("/elsewhere/x.md")), path.join(out, "x.md"));  // outside the project: never ../ out of out/
  assert.equal(t.outPath(out, null, path.resolve("/a/b.md")), path.join(out, "b.md"));
});

test("sensitivePath: auth is a whole word (author.md is fine); keys, .env, .ssh and .gnupg are caught", () => {
  const root = path.join(path.sep, "proj");
  for (const f of ["auth.json", "Auth.json", "oauth.json", "AuthSessions/x", "googleAuth.json", "auth-store/x", "authorize.ts", ".env", ".env.development", "prod.env", "id_rsa", "id_ed25519.pub", "key.pem", "cert.p12", ".ssh/config", ".gnupg/pubring.kbx", "private_key.txt"])
    assert.equal(t.sensitivePath(path.join(root, f), root), true, f);
  for (const f of ["author.md", "AUTHORS", "authors/list.md", "docs/authority.md", "envoy.yaml", "src/environment.ts"]) assert.equal(t.sensitivePath(path.join(root, f), root), false, f);
});

test("sensitivePath: acronyms before a sensitive word (HTTPAuth, getHTTPAuth, XMLAuth) are caught", () => {
  const root = path.join(path.sep, "proj");
  for (const f of ["HTTPAuth.json", "getHTTPAuth.ts", "XMLAuth.json"])
    assert.equal(t.sensitivePath(path.join(root, f), root), true, f);
  for (const f of ["author.md", "AUTHORS", "docs/authority.md"]) assert.equal(t.sensitivePath(path.join(root, f), root), false, f);
});

test("findThread: archivedThreads are searched like search/preview-finish", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const src = fs.readFileSync(path.join(__dirname, "..", "tools", "t3ctl"), "utf8");
  assert.match(src, /pickThread\(\[\.\.\.s\.threads, \.\.\.\(s\.archivedThreads \|\| \[\]\)\], q\)/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3ctl-find-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3ctl"), path.join(tmp, "t3ctl"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3inbox.js"), path.join(tmp, "t3inbox.js"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const threads = [{ id: "live-thread-01", title: "Live One", status: "idle" }];
  const archivedThreads = [{ id: "arch-thread-99", title: "Old archived", status: "completed" }];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads, archivedThreads }));
    const known = [...threads, ...archivedThreads];
    const hit = known.find((x) => u === "/api/orchestration/threads/" + x.id);
    if (hit) return res.end(JSON.stringify({ projection: { thread: hit, turnItems: [], runs: [], runtimeRequests: [] } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const run = (cmd, q) => new Promise((r) => execFile(process.execPath, [path.join(tmp, "t3ctl"), cmd, "--thread", q],
    { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } }, (err, out, errOut) => r({ code: err ? err.code : 0, out: out + errOut })));
  try {
    let r = await run("read", "arch-thread-99"); assert.equal(r.code, 0, r.out); assert.match(r.out, /arch-thread-99/);
    r = await run("read", "Old archived"); assert.equal(r.code, 0, r.out); assert.match(r.out, /Old archived/);
    r = await run("pending", "arch-thread-99"); assert.equal(r.code, 0, r.out);
    r = await run("read", "no-such-thread-xx"); assert.equal(r.code, 1); assert.match(r.out, /NOT_FOUND/);
  } finally { srv.close(); }
});

test("approvalAllowed: decline and cancel never need anyone; any grant needs the user's yes", () => {
  for (const d of ["decline", "cancel"]) assert.equal(t.approvalAllowed(d, undefined), true, d);
  for (const d of ["accept", "acceptForSession", "approve", ""]) { assert.equal(t.approvalAllowed(d, undefined), false, d); assert.equal(t.approvalAllowed(d, "yes"), false, d); assert.equal(t.approvalAllowed(d, true), true, d); }
});
test("answer: an approval goes through only with --user-approved; decline --redirect keeps the thread moving, end to end", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), crypto = require("crypto"), { execFile } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3ctl-answer-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3ctl"), path.join(tmp, "t3ctl"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3inbox.js"), path.join(tmp, "t3inbox.js"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const thread = { id: "thread-approve-01", title: "Approve me", status: "idle" };
  const options = [{ decision: "accept", label: "Allow" }, { decision: "acceptForSession", label: "Always allow" }, { decision: "decline", label: "Deny" }];
  let requests = [], sent = [], runs = [], dispatchMode = "ok";
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads: [thread] }));
    if (u === "/api/orchestration/threads/" + thread.id) return res.end(JSON.stringify({ projection: { thread, runs, runtimeRequests: requests.map(({ prompt, reason, ...r }) => r),
      turnItems: requests.map((r) => ({ type: "approval_request", requestId: r.id, requestKind: "command", prompt: r.prompt, reason: r.reason, options })) } }));
    res.statusCode = 404; res.end("{}");
  });
  srv.on("upgrade", (req, sock) => {
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2; if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const op = buf[0] & 15, mask = buf.subarray(off, off + 4), body = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
        buf = buf.subarray(off + 4 + len);
        if (op === 8) return sock.end();
        if (op !== 1) continue;
        const m = JSON.parse(body.toString("utf8")); sent.push(m.payload); requests = requests.map((r) => (r.id === m.payload.requestId ? { ...r, status: "resolved" } : r));
        const isMessage = m.payload.type === "message.dispatch";
        if (isMessage && dispatchMode === "ok") runs.push({ id: `run-${runs.length + 1}`, userMessageId: m.payload.messageId, status: "running" });
        if (isMessage && dispatchMode === "held") runs.push({ id: `run-${runs.length + 1}`, userMessageId: m.payload.messageId, status: "queued", queueHeld: true });
        const exit = isMessage && dispatchMode === "fail" ? { _tag: "Failure", cause: { message: "thread is busy" } } : { _tag: "Success", value: {} };
        const out = Buffer.from(JSON.stringify({ _tag: "Exit", requestId: m.id, exit }));
        sock.write(Buffer.concat([Buffer.from(out.length < 126 ? [0x81, out.length] : [0x81, 126, out.length >> 8, out.length & 255]), out]));
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const run = (...a) => new Promise((r) => execFile(process.execPath, [path.join(tmp, "t3ctl"), ...a], { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } },
    (err, out, errOut) => r({ code: err ? err.code : 0, out: out + errOut })));
  const pendingReq = (id, prompt, reason) => ({ id, kind: "command", status: "pending", createdAt: "x", prompt, reason });
  const reset = (p, reason) => { requests = [pendingReq("req-1", p, reason)]; sent = []; };
  const ask = (p, ...a) => { reset(p); return run("answer", "--thread", thread.id, ...a); };
  try {
    let r = await ask(`python3 -c "import shutil; shutil.rmtree('src')"`, "--decision", "accept");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^NEEDS_USER_APPROVAL/); assert.deepEqual(sent, []);
    r = await ask("git status", "--decision", "accept");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^NEEDS_USER_APPROVAL/); assert.deepEqual(sent, []);
    r = await ask("rm -rf ~", "--decision", "decline");
    assert.equal(r.code, 0, r.out); assert.equal(sent.length, 1); assert.equal(sent[0].type, "runtime-request.respond"); assert.equal(sent[0].decision, "decline");
    r = await ask("rm -rf build", "--decision", "accept", "--user-approved");
    assert.equal(r.code, 0, r.out); assert.equal(sent[0].decision, "accept");
    r = await ask("git status", "--decision", "acceptForSession");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^NEEDS_USER_APPROVAL/); assert.deepEqual(sent, []);
    r = await ask("git status && rm -rf ~", "--decision", "accept");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^NEEDS_USER_APPROVAL/); assert.deepEqual(sent, []);
    const why = "git reset --hard discards uncommitted work, including changes from other sessions in this checkout. Prefer git stash.";
    reset("Redo merges with PR names; gate the result", why);
    r = await run("pending", "--thread", thread.id, "--json");
    assert.equal(JSON.parse(r.out)[0].approval.reason, why);
    r = await run("pending", "--thread", thread.id); assert.match(r.out, /why it asks: git reset --hard discards uncommitted work/);
    r = await ask("Redo merges with PR names; gate the result", "--decision", "accept", "--redirect", "--user-approved");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /--redirect only goes with --decision decline/); assert.deepEqual(sent, []);
    reset("Redo merges with PR names; gate the result", why);
    r = await run("answer", "--thread", thread.id, "--decision", "decline", "--redirect");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /REDIRECTED/);
    assert.deepEqual(sent.map((p) => p.type), ["runtime-request.respond", "message.dispatch"]);
    assert.equal(sent[0].decision, "decline");
    assert.match(sent[1].text, /declined this permission request because the user is away: Redo merges with PR names/);
    assert.match(sent[1].text, /Why it asked: git reset --hard discards uncommitted work/);
    assert.match(sent[1].text, /Don't run it again, and don't get around the check/);
    assert.deepEqual(sent[1].dispatchMode, { type: "start_immediately" });
    assert.doesNotMatch(sent[1].text, /git restore|for example/, "the redirect names no command that could discard work");
    for (const mode of ["fail", "held"]) {
      dispatchMode = mode; reset("Redo merges with PR names; gate the result", why);
      r = await run("answer", "--thread", thread.id, "--decision", "decline", "--redirect");
      assert.equal(r.code, 1, `${mode}: ${r.out}`); assert.doesNotMatch(r.out, /REDIRECTED:/, mode); assert.equal(sent[0].decision, "decline", mode);
      const m = r.out.match(/REDIRECT_NOT_DELIVERED: .*Send it with: t3ctl send --thread \S+ --prompt-file (\S+)/);
      assert.ok(m, `${mode}: ${r.out}`); assert.match(fs.readFileSync(m[1], "utf8"), /Don't run it again/, mode);
    }
    dispatchMode = "ok";
    reset("rm -rf build");
    r = await run("answer", "--thread", thread.id, "--decision", "decline");
    assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /REDIRECTED/); assert.deepEqual(sent.map((p) => p.type), ["runtime-request.respond"]);
    requests = [pendingReq("A-42", "rm -rf build"), pendingReq("B-42", "npm install")]; sent = [];
    r = await run("answer", "--thread", thread.id, "--request", "42", "--decision", "accept", "--user-approved");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^AMBIGUOUS/); assert.deepEqual(sent, []);
    r = await run("answer", "--thread", thread.id, "--decision", "accept", "--user-approved");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^AMBIGUOUS/); assert.deepEqual(sent, []);
    r = await run("answer", "--thread", thread.id, "--request", "B-42", "--decision", "accept", "--user-approved");
    assert.equal(r.code, 0, r.out); assert.equal(sent.length, 1); assert.equal(sent[0].requestId, "B-42");
  } finally { srv.close(); }
});
test("tools updates never overwrite the data files t3ctl keeps next to itself", () => {
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const dests = new Set(m.files.filter((f) => f.kind === "tool").map((f) => f.dest));
  for (const data of ["token", "listen.json", "answered-here.json", "started-here.json"]) assert.ok(!dests.has(data), data);
  const fetcher = fs.readFileSync(path.join(__dirname, "..", "skills", "t3-install-tools", "SKILL.md"), "utf8");
  for (const del of fetcher.match(/rm -rf "[^"]+"|Remove-Item -Recurse -Force \$\w+/g)) assert.match(del, /\$T\b/, `installer deletes only its staging folder: ${del}`);
});
