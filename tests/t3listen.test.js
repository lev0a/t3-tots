// Unit tests for t3listen's pure helpers. Run: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const l = require(path.join(__dirname, "..", "tools", "t3listen"));

test("pickThread: same rules as t3ctl (8+ character prefix, exact title, AMBIGUOUS, NOT_FOUND)", () => {
  const t3ctl = require(path.join(__dirname, "..", "tools", "t3ctl"));
  const ts = [{ id: "aaaa1111-0000", title: "Snig PR review", updatedAt: "2026-01-01T00:00:00Z" }, { id: "aaaa2222-0000", title: "Snig fixes", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "cccc3333-0000", title: "Other", updatedAt: "2026-01-02T00:00:00Z" }, { id: "dddd4444-0000", title: "other notes", updatedAt: "2026-01-02T00:00:00Z" }];
  assert.equal(l.pickThread(ts, "aaaa1111-0000").id, "aaaa1111-0000");
  assert.equal(l.pickThread(ts, "cccc3333").id, "cccc3333-0000");
  assert.equal(l.pickThread(ts, "pr review").id, "aaaa1111-0000");
  assert.equal(l.pickThread(ts, "OTHER").id, "cccc3333-0000"); // exact title beats the substring match on "other notes"
  assert.throws(() => l.pickThread(ts, "snig"), /^Error: AMBIGUOUS: 2 threads/);
  assert.throws(() => l.pickThread(ts, "aaaa"), /^Error: (AMBIGUOUS|NOT_FOUND)/);
  assert.throws(() => l.pickThread(ts, "ccc"), /NOT_FOUND: .*8 or more characters/);
  assert.throws(() => l.pickThread(ts, "nothing like it"), /^Error: NOT_FOUND/);
  for (const q of ["aaaa1111-0000", "cccc3333", "pr review", "OTHER", "snig", "aaaa", "ccc", "nothing like it", "aaaa"]) {
    const run = (f) => { try { return f(ts, q).id; } catch (e) { return e.message.split(":")[0]; } };
    assert.equal(run(l.pickThread), run(t3ctl.pickThread), `t3listen and t3ctl disagree on "${q}"`);
  }
});
test("cleanEvent: questions, option labels, approval prompt, titles and answers are redacted; ids are kept", () => {
  const os = require("os"), home = os.homedir();
  const e = { event: "request.opened", threadId: "t-1", requestId: "r-1", title: `fix ${home}/x`, questions: [{ id: "q1", question: "use key " + "sk_" + "live_abcdefghijklmnop1234?", header: "token: abcdefghijkl",
    options: [{ label: "ghp_" + "a".repeat(30), description: `in ${home}/proj`, value: "whsec_" + "b".repeat(24) }] }], answers: { q1: ["sk-ant-" + "c".repeat(24)] },
    approval: { requestKind: "command", prompt: `cat ${home}/.ssh/id && echo glpat-${"d".repeat(20)}`, options: [{ decision: "accept", label: "xo" + "xb-1234567890-abc" }] } };
  l.cleanEvent(e); const s = JSON.stringify(e);
  for (const bad of [home + "/", "sk_live_", "ghp_", "whsec_", "sk-ant-", "glpat-", "xoxb-", "abcdefghijkl"]) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
  assert.equal(e.threadId, "t-1"); assert.equal(e.requestId, "r-1"); assert.equal(e.questions[0].id, "q1");
  assert.match(e.approval.prompt, /~\/\.ssh\/id/);
  assert.match(l.summary({ ...e, machine: "m", questions: undefined }), /\[redacted\]/);
});
test("localTime: names the zone (IST, not GMT+5:30)", () => {
  const { execFileSync } = require("child_process");
  const out = execFileSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(path.join(__dirname, "..", "tools", "t3listen"))}).localTime("2026-01-01T12:00:00Z"))`], { env: { ...process.env, TZ: "Asia/Kolkata" } }).toString().trim();
  assert.match(out, /IST$/);
});

test("approvalsLine names which switch turned approvals on", () => {
  const { approvalsLine } = l;
  assert.equal(approvalsLine(false, false), "off");
  assert.equal(approvalsLine(true, false), "on (listen.json)");
  assert.equal(approvalsLine(false, true), "on (installed with --approvals)");
  assert.equal(approvalsLine(true, true), "on (listen.json and installed with --approvals)");
});

test("staleMinutes: missing means the documented 1440; 0 stays off", () => {
  for (const v of [undefined, null, "", "abc", -5]) assert.equal(l.staleMinutes(v), 1440, String(v));
  assert.equal(l.staleMinutes(0), 0); assert.equal(l.staleMinutes("30"), 30);
});
test("redaction catches github_pat_, npm_, xapp- and glpat- keys", () => {
  const keys = ["github_pat_" + "A1".repeat(15), "npm_" + "a1B2".repeat(9), "xapp-" + "1-A0".repeat(5), "glpat-" + "x_Y-".repeat(6), "sk-" + "a".repeat(24), "token = abcdefghij"];
  for (const k of keys) assert.equal(`see ${k} here`.replace(l.RED, "[redacted]"), "see [redacted] here", k);
});
test("log lines never print a raw thread title (titles go through clean)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tools", "t3listen"), "utf8");
  const raw = src.split("\n").filter((l) => /\blog\(/.test(l) && /\$\{t\.title\}/.test(l));
  assert.deepEqual(raw, []);
});

test("reportEnd redacts the event before it is first saved to listen-state.json", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const body = src.slice(src.indexOf("async function reportEnd"), src.indexOf("\n}\n", src.indexOf("async function reportEnd")));
  assert.ok(body.includes("cleanEvent(e)"), "reportEnd cleans the event");
  assert.ok(body.indexOf("cleanEvent(e)") < body.indexOf("saveState()"), "cleanEvent runs before the first saveState");
});
test("restart catch-up: any thread in the window (busy too), not only END[t.status]; buildEnd still skips", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("const since = S.lastAlive");
  const end = src.indexOf("afterSnapshotListen(", start);
  const block = src.slice(start, end);
  assert.ok(block.includes("catchUpThreads("), block);
  assert.ok(block.includes("reportEnd(ep, t, null, { since })"), block);
  assert.ok(!block.includes("END[t.status]"), block);
  assert.ok(!block.includes("!isBusy(t)"), block); // failed ends must still report when the thread is busy
  assert.ok(!/\b36e5\b/.test(block) && !block.includes("3600000"), block); // no hour cap; buildEnd skips completedAt < since
  assert.ok(src.includes('skip: "ended before the listener\'s last run"'));
  assert.ok(src.includes("sub-task thread that didn't fail"));
  assert.ok(src.includes("thread is going on with its next queued message"));
  assert.ok(src.includes("listening = false"), "socket close freezes lastAlive");
  assert.ok(src.includes("afterSnapshotListen("), "snapshot completion goes through afterSnapshotListen");
});

test("endedAt: missing completedAt uses now, not Date.parse(0)", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(l.endedAt({ completedAt: "2026-10-25T11:00:00Z" }, now), Date.parse("2026-10-25T11:00:00Z"));
  assert.equal(l.endedAt({}, now), now);
  assert.equal(l.endedAt({ completedAt: "" }, now), now);
  assert.equal(l.endedAt({ completedAt: "not-a-date" }, now), now);
  assert.ok(l.endedAt({}, now) !== Date.parse(0));
  assert.ok(l.endedAt({}, now) > 1e12); // a real "now", not epoch / year-2000 Date.parse(0)
});

test("tickLastAlive: freeze lastAlive while the socket is down", () => {
  const last = Date.parse("2026-10-25T10:00:00Z"), now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(l.tickLastAlive(true, last, now), now);
  assert.equal(l.tickLastAlive(false, last, now), last);
  assert.equal(l.tickLastAlive(false, undefined, now), undefined);
});

test("afterSnapshotListen: a close wins over an in-flight snapshot completion", async () => {
  const st = { listening: false, lastAlive: 1000, liveGen: 1 };
  const snapshotGen = st.liveGen;
  let finish;
  const inflight = new Promise((r) => { finish = r; }).then(() => {
    const next = l.afterSnapshotListen({
      socketOpen: false, gen: snapshotGen, liveGen: st.liveGen, lastAlive: st.lastAlive, now: 9999,
    });
    st.listening = next.listening;
    st.lastAlive = next.lastAlive;
  });
  st.listening = false; // onclose first
  st.liveGen += 1;
  finish();
  await inflight;
  assert.equal(st.listening, false);
  assert.equal(st.lastAlive, 1000);
});

test("afterSnapshotListen: still-open same generation advances lastAlive; gen mismatch does not", () => {
  assert.deepEqual(l.afterSnapshotListen({ socketOpen: true, gen: 3, liveGen: 3, lastAlive: 1000, now: 2000 }),
    { listening: true, lastAlive: 2000 });
  assert.deepEqual(l.afterSnapshotListen({ socketOpen: true, gen: 1, liveGen: 2, lastAlive: 1000, now: 2000 }),
    { listening: false, lastAlive: 1000 });
  assert.deepEqual(l.afterSnapshotListen({ socketOpen: false, gen: 1, liveGen: 1, lastAlive: 1000, now: 2000 }),
    { listening: false, lastAlive: 1000 });
});

test("usageLimitFields: busy failed run still carries usageLimit / autoResumeSet / resumeAt", () => {
  const reset = "2026-01-01T05:00:00Z";
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const busy = { id: "t", status: "running", activeRunId: "r2", latestRunId: "r2" };
  const a = l.usageLimitFields(busy, ended);
  assert.equal(a.usageLimit, true);
  assert.equal(a.autoResumeSet, false);
  assert.equal(a.resumeAt, reset);
  assert.equal(a.autoResumeNote, "thread is already busy");
  const armed = l.usageLimitFields({ ...busy, limitRecovery: { runId: "r1", resetAt: reset, autoResume: true } }, ended);
  assert.equal(armed.usageLimit, true);
  assert.equal(armed.autoResumeSet, true);
  assert.equal(armed.resumeAt, reset);
  const fromRun = l.usageLimitFields({ id: "t", status: "running", activeRunId: "r2" }, { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset });
  assert.equal(fromRun.usageLimit, true);
  assert.equal(fromRun.resumeAt, reset);
  assert.equal(l.usageLimitFields({ id: "t", status: "failed", lastErrorClass: "other" }, { id: "r", status: "failed" }), null);
});

test("usageLimitFields: ended-run lastErrorClass / reset; leftover shell + server_error is not usage_limit", () => {
  const reset = "2026-01-01T05:00:00Z";
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const moved = { id: "t", status: "running", activeRunId: "r2", latestRunId: "r2", lastErrorClass: "server_error" };
  const a = l.usageLimitFields(moved, ended);
  assert.equal(a.usageLimit, true);
  assert.equal(a.resumeAt, reset);
  assert.equal(a.autoResumeSet, false);
  const leftover = { id: "t", status: "failed", lastErrorClass: "server_error", usageLimitResetAt: reset, latestRunId: "r1" };
  assert.equal(l.usageLimitFields(leftover, { id: "r1", status: "failed", lastErrorClass: "server_error" }), null);
  assert.equal(l.usageLimitFields(leftover, { id: "r1", status: "failed" }), null);
});

test("usageLimitFields: autoResumeSet matches the ended run id, not a later latestRunId record", () => {
  const reset = "2026-01-01T05:00:00Z";
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const later = l.usageLimitFields({
    id: "t", status: "running", activeRunId: "r2", latestRunId: "r2",
    limitRecovery: { runId: "r2", resetAt: reset, autoResume: true },
  }, ended);
  assert.equal(later.usageLimit, true);
  assert.equal(later.autoResumeSet, false);
  const same = l.usageLimitFields({
    id: "t", status: "failed", latestRunId: "r1",
    limitRecovery: { runId: "r1", resetAt: reset, autoResume: true },
  }, ended);
  assert.equal(same.autoResumeSet, true);
});

test("usageLimitFields: server_error text mentioning usage limit is not a usage limit", () => {
  const reset = "2026-01-01T05:00:00Z";
  const run = { id: "r1", status: "failed", lastErrorClass: "server_error",
    lastError: { message: "upstream said usage limit" }, usageLimitResetAt: reset };
  const t = { id: "t", status: "failed", latestRunId: "r1", lastErrorClass: "server_error",
    lastError: { message: "upstream said usage limit" }, usageLimitResetAt: reset };
  assert.equal(l.usageLimitFields(t, run), null);
  assert.equal(l.usageLimitFields(t, { ...run, error: "upstream said usage limit" }), null);
  const noClass = { id: "r2", status: "failed", lastError: { message: "hit a usage limit" }, usageLimitResetAt: reset };
  assert.equal(l.usageLimitFields({ id: "t", status: "failed", latestRunId: "r2" }, noClass).usageLimit, true);
});

test("canArmResume: only the latest ended run; shellReadyToArm retries while busy", () => {
  const ended = { id: "r1", status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: "2026-01-01T05:00:00Z" };
  const olderFailed = { id: "t", status: "failed", latestRunId: "r2", lastErrorClass: "server_error" };
  assert.equal(l.usageLimitFields(olderFailed, ended).usageLimit, true);
  assert.equal(l.canArmResume(olderFailed, ended), false);
  assert.equal(l.canArmResume({ id: "t", status: "failed", latestRunId: "r1" }, ended), true);
  assert.equal(l.canArmResume({ id: "t", status: "failed" }, ended), true);
  assert.equal(l.shellReadyToArm({ id: "t", status: "running", activeRunId: "r2", latestRunId: "r2" }), false);
  assert.equal(l.shellReadyToArm({ id: "t", status: "failed", latestRunId: "r1" }), true);
  assert.equal(l.shellReadyToArm(null), false);
  assert.equal(l.canArmResume({ id: "t", status: "running", activeRunId: "r2", latestRunId: "r2" }, ended), false);
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("async function armResume");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("!shellReadyToArm(t)"), body);
  assert.ok(body.includes("canArmResume(t, run)"), body);
  assert.ok(!/for \(let i = 0; i < 3 && !t;/.test(body), body);
});

test("catchUpThreads: includes a busy thread so a failed downtime end is still seen", () => {
  const since = Date.parse("2026-10-25T10:00:00Z");
  const idle = { id: "a", status: "idle", updatedAt: "2026-10-25T11:00:00Z" };
  const busy = { id: "b", status: "running", activeRunId: "r2", updatedAt: "2026-10-25T11:30:00Z" };
  const old = { id: "c", status: "idle", updatedAt: "2026-10-25T09:00:00Z" };
  const got = l.catchUpThreads([idle, busy, old], since).map((t) => t.id);
  assert.deepEqual(got, ["a", "b"]);
});

test("restart catch-up: reportEnd with since and no run id reports every ended run, not only ended.at(-1)", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("async function reportEnd");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("!runId && opts.since"), body);
  assert.ok(body.includes("for (const run of ended) await reportEnd(ep, t, run.id, opts)"), body);
  assert.ok(!/ended\.at\(-1\)/.test(body), body);
});

test("idLike: a full id or an 8+ character prefix, never a title with spaces", () => {
  for (const q of ["abcdefgh", "thread-0b6e2f1c-full-id"]) assert.equal(l.idLike(q), true, q);
  for (const q of ["abcdefg", "fix the login bug", "a/b/c/d/e/f"]) assert.equal(l.idLike(q), false, q);
});
test("idLike: no whitespace, length >= 8, colons allowed (thread:project:…, thread:delegated-task:…)", () => {
  for (const q of ["thread:project:abc12345", "thread:delegated-task:deadbeef", "thread:p"]) assert.equal(l.idLike(q), true, q);
  for (const q of ["thread:", "a:b:c", "fix the login"]) assert.equal(l.idLike(q), false, q);
});

test("systemdUnit: quotes and escapes paths and env values so spaces, quotes, % and $ survive", () => {
  const u = l.systemdUnit("/opt/my node/node", ["/srv/a b/100%/t3listen", "run"], "/srv/a b/100%", { T3_HOME: '/x "y" $HOME\\z' });
  assert.match(u, /^ExecStart="\/opt\/my node\/node" "\/srv\/a b\/100%%\/t3listen" "run"$/m);
  assert.match(u, /^WorkingDirectory=\/srv\/a b\/100%%$/m);
  assert.ok(u.split("\n").includes('Environment="T3_HOME=/x \\"y\\" $HOME\\\\z"'), u);
  assert.ok(l.systemdUnit("/n", ["/a$b"], "/d").includes('ExecStart="/n" "/a$$b"'));
});

test("preview-finish: NOT_FOUND in the shell list still reads an id-like query from T3; AMBIGUOUS and titles still stop", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-preview-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), path.join(tmp, "t3listen"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3inbox.js"), path.join(tmp, "t3inbox.js"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const threads = [{ id: "abcdefgh-1", title: "One" }, { id: "abcdefgh-2", title: "Two" }];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads }));
    if (u === "/api/orchestration/threads/hidden-thread-42") return res.end(JSON.stringify({ projection: { thread: { id: "hidden-thread-42", title: "Hidden" }, runs: [] } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const run = (q) => new Promise((r) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread", q],
    { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } }, (err, out, errOut) => r({ code: err ? err.code : 0, out: out + errOut })));
  try {
    let r = await run("hidden-thread-42"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await new Promise((res) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread=hidden-thread-42"], { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } },
      (err, out, errOut) => res({ code: err ? err.code : 0, out: out + errOut }))); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/); // --key=value works too
    r = await run("abcdefgh"); assert.equal(r.code, 1); assert.match(r.out, /AMBIGUOUS/);
    r = await run("some missing title"); assert.equal(r.code, 1); assert.match(r.out, /NOT_FOUND/);
    r = await run("missing-id-999"); assert.equal(r.code, 1); assert.match(r.out, /NOT_FOUND/);
  } finally { srv.close(); }
});

test("preview-finish: archivedThreads are searched; colon ids are id-like; AMBIGUOUS still stops", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-preview-arch-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), path.join(tmp, "t3listen"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3inbox.js"), path.join(tmp, "t3inbox.js"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const threads = [{ id: "abcdefgh-1", title: "Live One" }, { id: "abcdefgh-2", title: "Live Two" }];
  const archivedThreads = [{ id: "arch-thread-99", title: "Old archived" }];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads, archivedThreads }));
    const known = [...threads, ...archivedThreads, { id: "thread:project:abc12345", title: "By id" }, { id: "thread:delegated-task:deadbeef", title: "Delegated" }];
    const hit = known.find((t) => u === "/api/orchestration/threads/" + t.id);
    if (hit) return res.end(JSON.stringify({ projection: { thread: hit, runs: [] } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const run = (q) => new Promise((r) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread", q],
    { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } }, (err, out, errOut) => r({ code: err ? err.code : 0, out: out + errOut })));
  try {
    let r = await run("Old archived"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await run("thread:project:abc12345"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await run("thread:delegated-task:deadbeef"); assert.equal(r.code, 0, r.out); assert.match(r.out, /would not report: no run/);
    r = await run("Live One"); assert.equal(r.code, 0, r.out);
    r = await run("abcdefgh"); assert.equal(r.code, 1); assert.match(r.out, /AMBIGUOUS/);
  } finally { srv.close(); }
});

test("preview-finish: usage-limit fields come from the ended run; armResume is not called", async () => {
  const fs = require("fs"), os = require("os"), http = require("http"), { execFile } = require("child_process");
  const src = fs.readFileSync(path.join(__dirname, "..", "tools", "t3listen"), "utf8");
  const start = src.indexOf("async function previewFinish");
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("usageLimitFields("), body);
  assert.ok(!body.includes("armResume("), body);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3listen-preview-limit-"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3listen"), path.join(tmp, "t3listen"));
  fs.copyFileSync(path.join(__dirname, "..", "tools", "t3inbox.js"), path.join(tmp, "t3inbox.js"));
  fs.writeFileSync(path.join(tmp, "token"), "test-fixture");
  const reset = "2026-01-01T05:00:00Z";
  const thread = { id: "limit-thread-01", title: "Limited", status: "running", activeRunId: "r2", latestRunId: "r2" };
  const ended = { id: "r1", status: "failed", startedAt: "2026-01-01T04:00:00Z", completedAt: "2026-01-01T04:05:00Z",
    lastErrorClass: "usage_limit", usageLimitResetAt: reset };
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.method + " " + decodeURIComponent(req.url));
    const u = decodeURIComponent(req.url);
    if (u === "/api/orchestration/shell") return res.end(JSON.stringify({ projects: [], threads: [thread] }));
    if (u === "/api/orchestration/threads/" + thread.id) {
      return res.end(JSON.stringify({ projection: { thread, turnItems: [], runs: [ended] } }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(tmp, "t3")); fs.writeFileSync(path.join(tmp, "t3", "server-runtime.json"), JSON.stringify({ host: "127.0.0.1", port: srv.address().port }));
  const r = await new Promise((done) => execFile(process.execPath, [path.join(tmp, "t3listen"), "preview-finish", "--dry-run", "--thread", thread.id],
    { env: { ...process.env, T3_HOME: path.join(tmp, "t3") } }, (err, out, errOut) => done({ code: err ? err.code : 0, out: out + errOut })));
  srv.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PREVIEW payload/);
  const json = r.out.slice(r.out.indexOf("{"));
  const payload = JSON.parse(json);
  assert.equal(payload.usageLimit, true);
  assert.equal(payload.resumeAt, reset);
  assert.equal(payload.autoResumeSet, false);
  assert.ok(!hits.some((h) => /dispatch|ws/i.test(h)), hits.join("\n"));
});
