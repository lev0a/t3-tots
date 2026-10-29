#!/usr/bin/env node
// t3inbox.js - local append-only inbox for T3 questions. Required by t3ctl and t3listen.
// One store per computer: ~/.t3-inbox (or T3_INBOX_DIR). Items carry a machine label so a
// chat on another computer can send the answer back to this one. Nothing here sends chat
// messages or touches T3 approvals. The log is items.jsonl (append-only). state.json is a
// cache rebuilt from that log and is safe to delete.
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const DUE_MS = 4 * 60 * 60 * 1000; // unanswered items are due for one reminder after 4 hours
const RANK = { open: 1, posted: 2, answered: 3, delivered: 4, closed: 5 };
const ctx = new AsyncLocalStorage();

const fail = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });
function rootDir() {
  const s = ctx.getStore();
  if (s && s.root) return s.root;
  return process.env.T3_INBOX_DIR || path.join(os.homedir(), ".t3-inbox");
}
function withRoot(root, fn) { return ctx.run({ ...(ctx.getStore() || {}), root, held: false }, fn); }

function version() {
  try { return fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").trim(); } catch { return "dev"; }
}
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// Stable UUID-shaped id from the item id, so a retried T3 command can reuse one key.
function commandIdFor(itemId, method) {
  const b = Buffer.from(sha256(`${itemId}\0${method}`).slice(0, 32), "hex");
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function slug(project) {
  const s = String(project || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "_none";
}
function letterOf(i) {
  let n = i + 1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function itemIdForRequest(machine, requestId) { return `t3:${String(machine).trim()}:${requestId}`; }
function agentItemId(machine, fields) {
  const material = fields.idempotencyKey
    ? `key\0${fields.idempotencyKey}`
    : `body\0${fields.threadId}\0${fields.subject || ""}\0${fields.body}`;
  return `agent:${String(machine).trim()}:${sha256(material).slice(0, 20)}`;
}
function machineName(explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (process.env.T3_INBOX_MACHINE && process.env.T3_INBOX_MACHINE.trim()) return process.env.T3_INBOX_MACHINE.trim();
  try { const s = fs.readFileSync(path.join(rootDir(), "machine"), "utf8").trim(); if (s) return s; } catch {}
  return os.hostname();
}
function rememberMachine(name, force) {
  if (!name) return;
  const f = path.join(rootDir(), "machine");
  // The listener's --machine label wins, so MCP items use the same label the chat already routes on.
  if (force || !fs.existsSync(f)) fs.writeFileSync(f, String(name).trim() + "\n");
}
function loadRoutes() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(rootDir(), "routes.json"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
function routeFor(project, projectSlug) {
  const routes = loadRoutes();
  if (projectSlug && routes[projectSlug] != null) return String(routes[projectSlug]);
  if (project && routes[project] != null) return String(routes[project]);
  return "dm";
}

// --- question shapes -------------------------------------------------------
// T3 user_input questions become lettered blocks. `kind` is one, multi or text.
function questionsFromT3(qs) {
  return (qs || []).map((q, i) => {
    if (q && q.kind && q.key && q.prompt != null && Array.isArray(q.options)) return q;
    const options = (q.options || []).map((o, n) => ({
      letter: letterOf(n), label: String(o.label ?? ""),
      description: o.description && o.description !== o.label ? String(o.description) : "",
    }));
    return {
      key: String(q.id != null ? q.id : `q${i + 1}`),
      kind: q.multiSelect ? "multi" : options.length ? "one" : "text",
      prompt: String(q.question || q.header || ""),
      header: q.header ? String(q.header) : "",
      options, recommended: null, stakes: null,
      allowCustomAnswer: q.allowCustomAnswer !== false,
      required: q.required !== false,
    };
  });
}
const FENCE = /^:::(question(?:-multi|-text)?|action)\s*$/;
const FENCE_END = /^:::\s*$/;
const META = /^(Stopped|Holds up|Replaces|Stakes|Shows|Why|Reversible|Recommended)\s*:\s*(.*)$/;
const CHOICE = /^\s*-\s+(?:\[(?: |x|X)\]\s*)?(.+)\s*$/;
function splitChoice(raw) {
  const parts = String(raw).trim().split(/\s+(?:—|–|-)\s+/);
  return { label: parts[0].trim(), description: parts.slice(1).join(" - ").trim() };
}
function matchRecommended(options, raw, kind) {
  if (!raw) return null;
  if (kind === "text") return raw;
  const parts = raw.split(/\s*,\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  const labels = parts.map((p) => {
    const exact = options.find((o) => o.label === p || o.letter.toUpperCase() === p.toUpperCase());
    if (exact) return exact.label;
    if (p.length > 2) { const pre = options.find((o) => o.label.startsWith(p)); if (pre) return pre.label; }
    return p;
  });
  return kind === "multi" ? labels : (labels[0] || null);
}
function parseOneBlock(kindTag, lines, index) {
  let prompt = "", stakes = "", recommendedRaw = "", seen = false;
  const context = [], options = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const meta = line.match(META);
    if (meta) {
      const k = meta[1].toLowerCase();
      if (k === "recommended") recommendedRaw = meta[2].trim();
      else if (k === "stakes") stakes = meta[2].trim();
      continue; // Stopped, Holds up, Replaces, Shows, Why, Reversible are not v1 fields
    }
    if (seen && CHOICE.test(line)) {
      const parts = splitChoice(line.match(CHOICE)[1]);
      if (parts.label) options.push({ letter: letterOf(options.length), label: parts.label, description: parts.description });
      continue;
    }
    if (!seen) { prompt = line; seen = true; continue; }
    context.push(line);
  }
  if (!prompt) throw fail("validation_error", "a question block needs its question on the first line");
  let kind = kindTag === "question-multi" ? "multi" : kindTag === "question-text" ? "text" : (options.length ? "one" : "text");
  if (kindTag === "question-text") { kind = "text"; options.length = 0; }
  const key = "q-" + sha256(`${index}\0${kind}\0${prompt}`).slice(0, 8);
  const full = context.length ? `${prompt}\n\n${context.join("\n")}` : prompt;
  return {
    key, kind, prompt: full, options, recommended: matchRecommended(options, recommendedRaw, kind),
    stakes: stakes || null, allowCustomAnswer: true, required: true, header: "",
  };
}
// Plannotator-style blocks: :::question, :::question-multi, :::question-text, with Recommended and Stakes.
function parseQuestionBlocks(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const questions = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE);
    if (!m) continue;
    if (m[1] === "action") throw fail("validation_error", ":::action items are not inbox items in v1. Ask with a :::question block.");
    const buf = [];
    i++;
    while (i < lines.length && !FENCE_END.test(lines[i])) buf.push(lines[i++]);
    if (i >= lines.length || !FENCE_END.test(lines[i])) throw fail("validation_error", "a question block is missing its closing :::");
    questions.push(parseOneBlock(m[1], buf, questions.length));
  }
  if (!questions.length) throw fail("validation_error", "body needs a :::question, :::question-multi or :::question-text block");
  return questions;
}

function oneValue(q, token, allowText) {
  const t = String(token).trim();
  if (!t) throw fail("USAGE", "an answer is empty");
  const byLetter = (q.options || []).find((o) => o.letter.toUpperCase() === t.toUpperCase());
  if (byLetter) return byLetter.label;
  const byLabel = (q.options || []).find((o) => o.label === t || o.label.toLowerCase() === t.toLowerCase());
  if (byLabel) return byLabel.label;
  if ((q.kind === "text" || allowText) && q.allowCustomAnswer !== false) return t;
  const letters = (q.options || []).map((o) => `${o.letter} ${o.label}`).join(", ");
  throw fail("USAGE", `"${t}" is not an option for ${q.key}${letters ? ` (${letters})` : ""}`);
}
function valueFor(q, v, allowText) {
  if (Array.isArray(v)) {
    if (q.kind !== "multi") throw fail("USAGE", `question ${q.key} takes a single answer`);
    if (!v.length) throw fail("USAGE", `no option picked for ${q.key}`);
    return v.map((x) => oneValue(q, x, false));
  }
  const s = String(v).trim();
  if (q.kind === "multi" && s.includes("+")) return s.split("+").map((x) => oneValue(q, x.trim(), false));
  if (q.kind === "text") return oneValue(q, s, true);
  return oneValue(q, s, allowText);
}
function ensureRequired(item, answers) {
  for (const q of item.questions) {
    const v = answers[q.key];
    if (q.required !== false && (v === undefined || v === "" || (Array.isArray(v) && !v.length)))
      throw fail("USAGE", `question ${q.key} needs an answer`);
  }
  return answers;
}
// --pick "8:A,9:B" (multi-select is 8:A+B). --text for the one free-text question. --answers is JSON.
function resolveAnswers(item, opts) {
  if (opts.answers !== undefined && opts.answers !== true && opts.answers !== "") {
    let a = opts.answers;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { throw fail("USAGE", "--answers must be JSON, for example {\"q1\":\"A\"}"); } }
    if (!a || typeof a !== "object" || Array.isArray(a)) throw fail("USAGE", "--answers must be a JSON object keyed by question key");
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      const q = item.questions.find((q) => q.key === k);
      if (!q) throw fail("USAGE", `unknown question "${k}" (keys: ${item.questions.map((q) => q.key).join(", ")})`);
      out[k] = valueFor(q, v, true);
    }
    return ensureRequired(item, out);
  }
  if (opts.text !== undefined && opts.text !== true) {
    if (item.questions.length !== 1) throw fail("USAGE", `this item has ${item.questions.length} questions; use --pick key:letter or --answers`);
    const q = item.questions[0];
    return ensureRequired(item, { [q.key]: valueFor(q, String(opts.text), true) });
  }
  if (opts.pick !== undefined && opts.pick !== true) {
    const parts = String(opts.pick).split(",").map((s) => s.trim()).filter(Boolean);
    const out = {};
    if (!parts.length) throw fail("USAGE", "--pick is empty");
    if (parts.length === 1 && !parts[0].includes(":") && item.questions.length === 1) {
      out[item.questions[0].key] = valueFor(item.questions[0], parts[0], false);
      return ensureRequired(item, out);
    }
    for (const part of parts) {
      const i = part.indexOf(":");
      if (i < 0) throw fail("USAGE", `--pick entries look like 8:A,9:B (got "${part}")`);
      const key = part.slice(0, i).trim(), rest = part.slice(i + 1).trim();
      const q = item.questions.find((q) => q.key === key);
      if (!q) throw fail("USAGE", `unknown question "${key}" (keys: ${item.questions.map((q) => q.key).join(", ")})`);
      out[key] = valueFor(q, rest, false);
    }
    return ensureRequired(item, out);
  }
  throw fail("USAGE", "give --pick, --text or --answers");
}
function wireAnswers(answers, live) {
  const out = {};
  for (const [k, v] of Object.entries(answers)) out[k] = live && live.responseMode === "message" && Array.isArray(v) ? v.join(", ") : v;
  return out;
}
function answerText(v) { return Array.isArray(v) ? v.join(", ") : String(v); }
function inlineAnswers(item, answers) {
  return item.questions.filter((q) => answers[q.key] !== undefined).map((q) => `${q.key}=${answerText(answers[q.key])}`).join("; ");
}
function queuedTurnText(item, answers) {
  if (item.source === "agent") {
    const lines = item.questions.filter((q) => answers[q.key] !== undefined).map((q) => `- ${q.prompt.split("\n")[0]}: ${answerText(answers[q.key])}`).join("\n");
    return `T3 Inbox: ${item.subject || "question"} (${item.id})\n\n${lines}`;
  }
  return `Answer to your earlier question (${item.id}): ${inlineAnswers(item, answers)}`;
}

// --- log -------------------------------------------------------------------
function readEvents(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}
function blankItem(e) {
  return {
    id: e.id, source: e.source, machine: e.machine, threadId: e.threadId, threadTitle: e.threadTitle || "",
    project: e.project || null, projectSlug: e.projectSlug, requestId: e.requestId || null,
    subject: e.subject || "", questions: e.questions || [], route: e.route || "dm", openedAt: e.at,
    state: "open", posted: null, answers: null, answeredBy: null, via: null, ref: null, delivery: null,
    reason: null, closedAnswers: null, remindedAt: null, bodyHash: e.bodyHash || null,
    idempotencyKey: e.idempotencyKey || null, answeredHere: null,
  };
}
// Furthest stage wins, so a late item.posted cannot reopen a closed item. The log itself is never rewritten.
function fold(events) {
  const items = new Map();
  for (const e of events) {
    if (!e || !e.id) continue;
    if (e.type === "item.opened") { if (!items.has(e.id)) items.set(e.id, blankItem(e)); continue; }
    const it = items.get(e.id);
    if (!it) continue;
    if (e.type === "item.reminded") { it.remindedAt = e.at; continue; }
    const next = { "item.posted": "posted", "item.answered": "answered", "item.delivered": "delivered", "item.closed": "closed" }[e.type];
    if (!next) continue;
    if (RANK[next] >= RANK[it.state]) it.state = next;
    if (e.type === "item.posted") it.posted = { destination: e.destination || null, postedAt: e.postedAt || e.at, ref: e.ref || null };
    if (e.type === "item.answered") { it.answers = e.answers || null; it.answeredBy = e.answeredBy || null; it.via = e.via || null; it.ref = e.ref || null; }
    if (e.type === "item.delivered") it.delivery = { method: e.method, at: e.at, result: e.result || null, commandId: e.commandId || null, messageId: e.messageId || null };
    if (e.type === "item.closed") { it.reason = e.reason || null; it.closedAnswers = e.answers || null; if (e.answeredHere != null) it.answeredHere = e.answeredHere; }
  }
  return [...items.values()];
}
function projectDirs() {
  const root = rootDir();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}
function readAllUnlocked() {
  const items = [];
  for (const name of projectDirs()) items.push(...fold(readEvents(path.join(rootDir(), name, "items.jsonl"))));
  return items;
}
function findById(id) { return readAllUnlocked().find((it) => it.id === id) || null; }
function findByRequest(machine, requestId) {
  const all = readAllUnlocked().filter((it) => it.requestId === requestId && it.source === "t3-request");
  if (machine) { const hit = all.find((it) => it.machine === machine); if (hit) return hit; }
  return all[0] || null;
}
function writeCache(projectSlug) {
  const dir = path.join(rootDir(), projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  const items = fold(readEvents(path.join(dir, "items.jsonl")));
  const body = JSON.stringify({ v: 1, rebuiltAt: new Date().toISOString(), items }, null, 1) + "\n";
  const f = path.join(dir, "state.json"), tmp = f + ".part";
  fs.writeFileSync(tmp, body); fs.renameSync(tmp, f);
  return items;
}
function appendEvent(projectSlug, event) {
  const dir = path.join(rootDir(), projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "items.jsonl"), JSON.stringify(event) + "\n");
  writeCache(projectSlug);
}
function lockIsLive(lockPath) {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(lockPath, "utf8"), 10) || 0; } catch { return false; }
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
async function acquire(lockPath) {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      return fd;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!lockIsLive(lockPath)) { try { fs.unlinkSync(lockPath); } catch {} continue; }
      if (Date.now() - start > 20000) throw fail("INBOX_LOCKED", "the inbox lock was held too long");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
async function withLock(fn) {
  const prev = ctx.getStore() || {};
  if (prev.held) return fn();
  fs.mkdirSync(rootDir(), { recursive: true });
  const lockPath = path.join(rootDir(), "lock");
  const fd = await acquire(lockPath);
  try { return await ctx.run({ ...prev, held: true }, fn); }
  finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockPath); } catch {} }
}
function stamp(by, extra) { return { v: 1, at: new Date().toISOString(), by, ...extra }; }

function isDue(item, now) {
  if (!item || item.remindedAt) return false;
  if (item.state !== "open" && item.state !== "posted") return false;
  const t = Date.parse(item.openedAt);
  return Number.isFinite(t) && (now - t) >= DUE_MS;
}
function isTerminal(item) { return !!item && (item.state === "answered" || item.state === "delivered" || item.state === "closed"); }
function alreadyClosed(item) {
  const how = item.state === "closed" ? (item.reason || "closed") : item.state;
  return fail("ALREADY_CLOSED", `item ${item.id} is closed (${how})`);
}
function closureReason(info) {
  if (info.threadGone) return "request-gone";
  const s = String(info.status || "");
  if (/expired/i.test(s)) return "expired";
  if (/resolved|answered/i.test(s)) return "answered-in-t3";
  return "request-gone";
}

async function openFromRequest(fields) {
  const machine = String(fields.machine || "").trim();
  if (!machine) throw fail("USAGE", "an inbox item needs a machine label");
  if (!fields.requestId) throw fail("USAGE", "a T3 inbox item needs a request id");
  const projectSlug = slug(fields.project);
  const id = itemIdForRequest(machine, fields.requestId);
  const questions = questionsFromT3(fields.questions);
  return withLock(async () => {
    rememberMachine(machine, true);
    const existing = findById(id);
    if (existing) return { item: existing, created: false };
    const at = fields.at || new Date().toISOString();
    appendEvent(projectSlug, stamp(fields.by || "t3listen", {
      at, type: "item.opened", id, source: "t3-request", machine, threadId: fields.threadId, threadTitle: fields.threadTitle || "",
      project: fields.project || null, projectSlug, requestId: String(fields.requestId), questions,
      route: routeFor(fields.project, projectSlug), subject: (questions[0] && questions[0].prompt || "").split("\n")[0].slice(0, 160),
    }));
    return { item: findById(id), created: true };
  });
}
async function openFromAgent(fields) {
  const machine = machineName(fields.machine);
  const threadId = fields.threadId || fields.thread;
  if (!threadId) throw fail("validation_error", "thread is required (the T3 thread id). Pass thread, or set T3_THREAD_ID.");
  const subjectIn = fields.subject != null ? String(fields.subject) : "";
  if (subjectIn && (/[\r\n]/.test(subjectIn) || /<\/subject>/i.test(subjectIn)))
    throw fail("validation_error", "subject must be one line of plain text");
  const questions = fields.questions || parseQuestionBlocks(fields.body);
  const subject = subjectIn.trim() || (questions[0] && questions[0].prompt.split("\n")[0].slice(0, 160)) || "question";
  const id = agentItemId(machine, { idempotencyKey: fields.idempotencyKey, threadId, subject, body: fields.body || "" });
  const bodyHash = sha256(fields.body || JSON.stringify(questions));
  const projectSlug = slug(fields.project);
  return withLock(async () => {
    rememberMachine(machine);
    const existing = findById(id);
    if (existing) {
      if (existing.bodyHash && existing.bodyHash !== bodyHash)
        throw fail("validation_error", "idempotency_key was already used with a different body");
      return { item: existing, created: false };
    }
    appendEvent(projectSlug, stamp("agent", {
      type: "item.opened", id, source: "agent", machine, threadId, threadTitle: fields.threadTitle || "",
      project: fields.project || null, projectSlug, requestId: null, questions, route: routeFor(fields.project, projectSlug),
      subject, bodyHash, idempotencyKey: fields.idempotencyKey || null,
    }));
    return { item: findById(id), created: true };
  });
}
async function markPosted(opts) {
  if (!opts.item) throw fail("USAGE", "--item <id> is required");
  return withLock(async () => {
    const item = findById(opts.item);
    if (!item) throw fail("NOT_FOUND", `no inbox item ${opts.item}`);
    if (item.posted) return { item, created: false };
    const at = new Date().toISOString();
    appendEvent(item.projectSlug, stamp("t3ctl", {
      type: "item.posted", id: item.id, destination: opts.destination || item.route || "dm", postedAt: at, ref: opts.ref || null,
    }));
    return { item: findById(item.id), created: true };
  });
}
async function markReminded(opts) {
  if (!opts.item) throw fail("USAGE", "--item <id> is required");
  const now = opts.now || Date.now();
  return withLock(async () => {
    const item = findById(opts.item);
    if (!item) throw fail("NOT_FOUND", `no inbox item ${opts.item}`);
    if (item.remindedAt) return { item, created: false };
    if (!isDue(item, now)) throw fail("NOT_DUE", "that item is not due for a reminder yet (an unanswered item is due after 4 hours). Nothing was sent.");
    appendEvent(item.projectSlug, stamp("t3ctl", { type: "item.reminded", id: item.id }));
    return { item: findById(item.id), created: true };
  });
}
// The listener calls this when a user_input request is no longer pending. Approvals never get here.
async function closeFromResolution(info) {
  return withLock(async () => {
    const item = findByRequest(info.machine, info.requestId);
    if (!item) return null;
    if (isTerminal(item)) return item;
    const reason = closureReason(info);
    appendEvent(item.projectSlug, stamp(info.by || "t3listen", {
      type: "item.closed", id: item.id, reason, answers: info.answers || null,
      answeredHere: !!info.answeredHere, status: info.status || null,
    }));
    return findById(item.id);
  });
}
async function answerItem(opts, t3) {
  if (String(opts.from || "") !== "owner")
    throw fail("NOT_OWNER", "answers are only accepted with --from owner, and only for the owner's own words. Nothing was sent.");
  const via = String(opts.via || "");
  if (!["room", "dm", "terminal"].includes(via)) throw fail("USAGE", "--via must be room, dm or terminal");
  if (!opts.ref || opts.ref === true) throw fail("USAGE", "--ref <message ref> is required");
  if (!opts.item || opts.item === true) throw fail("USAGE", "--item <id> is required");
  if (!t3) throw fail("USAGE", "no T3 client");
  return withLock(async () => {
    let item = findById(opts.item);
    if (!item) throw fail("NOT_FOUND", `no inbox item ${opts.item}`);
    if (isTerminal(item)) throw alreadyClosed(item);
    const answers = resolveAnswers(item, opts);
    const live = await t3.lookup(item);
    item = findById(item.id);
    if (isTerminal(item)) throw alreadyClosed(item);
    const atAnswer = () => stamp("owner", { type: "item.answered", id: item.id, answers, answeredBy: "owner", via, ref: String(opts.ref) });
    if (!live || live.threadExists === false) {
      appendEvent(item.projectSlug, atAnswer());
      appendEvent(item.projectSlug, stamp("t3ctl", { type: "item.closed", id: item.id, reason: "request-gone", answers }));
      return { status: "request-gone", item: findById(item.id), answers };
    }
    const resolved = item.source === "t3-request" && item.requestId && !live.pending && /^(resolved|answered)$/i.test(String(live.status || ""));
    if (resolved) {
      appendEvent(item.projectSlug, stamp("t3listen", {
        type: "item.closed", id: item.id, reason: "answered-in-t3", answers: live.recordedAnswers || null, status: live.status,
      }));
      throw alreadyClosed(findById(item.id));
    }
    const canRespond = item.source === "t3-request" && item.requestId && live.pending && live.answerable;
    if (canRespond) {
      const commandId = commandIdFor(item.id, "respond");
      try {
        await t3.respond({ threadId: item.threadId, requestId: item.requestId, answers: wireAnswers(answers, live), commandId, itemId: item.id });
      } catch (err) {
        const again = await t3.lookup(item);
        if (again && again.threadExists !== false && !again.pending && /^(resolved|answered)$/i.test(String(again.status || ""))) {
          appendEvent(item.projectSlug, stamp("t3listen", {
            type: "item.closed", id: item.id, reason: "answered-in-t3", answers: again.recordedAnswers || null, status: again.status,
          }));
          throw alreadyClosed(findById(item.id));
        }
        throw err;
      }
      appendEvent(item.projectSlug, atAnswer());
      appendEvent(item.projectSlug, stamp("t3ctl", { type: "item.delivered", id: item.id, method: "respond", commandId, result: "ok" }));
      appendEvent(item.projectSlug, stamp("t3ctl", { type: "item.closed", id: item.id, reason: "delivered", answers }));
      return { status: "ok", method: "respond", item: findById(item.id), answers };
    }
    const text = queuedTurnText(item, answers);
    const commandId = commandIdFor(item.id, "queued-turn");
    const messageId = commandIdFor(item.id, "message");
    const sent = await t3.queueTurn({
      threadId: item.threadId, text, commandId, messageId, title: item.threadTitle, activeRunId: live.activeRunId || null, itemId: item.id,
    });
    appendEvent(item.projectSlug, atAnswer());
    appendEvent(item.projectSlug, stamp("t3ctl", {
      type: "item.delivered", id: item.id, method: "queued-turn", commandId, messageId, result: (sent && sent.result) || "ok",
    }));
    appendEvent(item.projectSlug, stamp("t3ctl", { type: "item.closed", id: item.id, reason: "delivered", answers }));
    return { status: "ok", method: "queued-turn", item: findById(item.id), answers, text };
  });
}

function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
async function listItems(opts = {}) {
  const now = opts.now || Date.now();
  return withLock(async () => {
    let items = readAllUnlocked();
    if (opts.project && opts.project !== true) {
      const s = slug(opts.project);
      items = items.filter((it) => it.projectSlug === s || it.project === opts.project);
    }
    const openish = (it) => it.state === "open" || it.state === "posted";
    if (opts.due) items = items.filter((it) => isDue(it, now));
    else if (!opts.all) items = items.filter(openish);
    if (opts.open) items = items.filter(openish);
    if (opts.threadId) items = items.filter((it) => it.threadId === opts.threadId);
    return items.map((it) => ({ ...it, due: isDue(it, now), ageMs: now - Date.parse(it.openedAt) }));
  });
}
function formatList(items, opts = {}) {
  if (opts.json) return JSON.stringify(items.map((it) => ({
    id: it.id, state: it.state, machine: it.machine, threadId: it.threadId, threadTitle: it.threadTitle,
    project: it.project, projectSlug: it.projectSlug, route: it.route, source: it.source, requestId: it.requestId,
    subject: it.subject, age: ageText(it.ageMs), due: it.due, remindedAt: it.remindedAt, reason: it.reason,
    posted: it.posted, answers: it.answers, closedAnswers: it.closedAnswers, questions: it.questions, openedAt: it.openedAt,
  })), null, opts.pretty === false ? 0 : 1);
  if (!items.length) return opts.due ? "no inbox items are due" : "no open inbox items";
  const lines = [];
  for (const it of items) {
    lines.push(`${it.id}  ${it.state}  ${ageText(it.ageMs)}  ${it.projectSlug} -> ${it.route}  machine=${it.machine}  posted=${it.posted ? "yes" : "no"}  due=${it.due ? "yes" : "no"}`);
    lines.push(`  ${it.threadId}  "${it.threadTitle || ""}"`);
    for (const q of it.questions || []) {
      lines.push(`  [${q.key}] ${q.kind}  ${String(q.prompt || "").split("\n")[0]}`);
      for (const o of q.options || []) lines.push(`    ${o.letter}. ${o.label}${o.description ? " - " + o.description : ""}`);
      if (q.recommended) lines.push(`    recommended: ${Array.isArray(q.recommended) ? q.recommended.join(", ") : q.recommended}`);
      if (q.stakes) lines.push(`    stakes: ${q.stakes}`);
    }
  }
  return lines.join("\n");
}
async function rebuild(projectSlug) {
  return withLock(async () => {
    writeCache(projectSlug || slug());
    return JSON.parse(fs.readFileSync(path.join(rootDir(), projectSlug || "_none", "state.json"), "utf8"));
  });
}
function openRequestItems() {
  return readAllUnlocked().filter((it) => it.source === "t3-request" && (it.state === "open" || it.state === "posted"));
}

// --- MCP (stdio, Content-Length framing, same idea as `plannotator inbox mcp`) ---
const MCP_TOOLS = [
  {
    name: "send_message",
    description: "Post a question to this computer's T3 inbox. body is markdown with :::question, :::question-multi or :::question-text blocks (Recommended and Stakes lines are kept). The owner's answer comes back later as a queued turn in the T3 thread, starting with 'T3 Inbox:'. This does not wait, and it does not ask with a blocking question tool.",
    inputSchema: { type: "object", properties: {
      body: { type: "string", description: "Markdown with one or more question blocks." },
      subject: { type: "string", description: "One line. Defaults to the first question." },
      thread: { type: "string", description: "T3 thread id. Defaults to T3_THREAD_ID. This is not the Codex session id." },
      project: { type: "string", description: "T3 project name. Defaults to T3_PROJECT. Threads with no project land in _none." },
      idempotency_key: { type: "string", description: "Sending again with the same key returns the first item. The same key with a different body is refused." },
    }, required: ["body"] },
  },
  {
    name: "read_thread",
    description: "Read whether inbox questions have been answered. Pass item_id, or thread (a T3 thread id). With neither, lists open items on this computer.",
    inputSchema: { type: "object", properties: {
      item_id: { type: "string" },
      thread: { type: "string" },
      include_closed: { type: "boolean" },
    } },
  },
];
function questionView(item) {
  const answers = item.answers || item.closedAnswers || {};
  return (item.questions || []).map((q) => ({
    key: q.key, kind: q.kind, prompt: q.prompt, options: q.options, recommended: q.recommended, stakes: q.stakes,
    state: answers[q.key] !== undefined ? "answered" : (item.state === "closed" ? "closed" : "open"),
    answer: answers[q.key] !== undefined ? answers[q.key] : null,
  }));
}
function toolText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 1) }], isError: !!obj.isError };
}
async function callTool(name, args) {
  args = args || {};
  if (name === "send_message") {
    if (args.subject && (/[\r\n]/.test(String(args.subject)) || /<\/subject>/i.test(String(args.subject))))
      return toolText({ isError: true, error: "validation_error: subject must be one line of plain text" });
    let questions;
    try { questions = parseQuestionBlocks(args.body); }
    catch (e) { return toolText({ isError: true, error: e.message }); }
    const thread = args.thread || process.env.T3_THREAD_ID || "";
    if (!thread) return toolText({ isError: true, error: "validation_error: thread is required (the T3 thread id). Pass thread, or set T3_THREAD_ID. Do not pass a Codex session id." });
    try {
      const { item, created } = await openFromAgent({
        body: String(args.body), subject: args.subject, threadId: thread,
        project: args.project || process.env.T3_PROJECT || null, idempotencyKey: args.idempotency_key, questions,
      });
      return toolText({
        item_id: item.id, created, thread_id: item.threadId, machine: item.machine, project: item.projectSlug,
        subject: item.subject, questions: questionView(item),
        note: `The answer comes back as a queued turn in this T3 thread, starting with "T3 Inbox: ${item.subject} (${item.id})". End your turn. Do not also ask it with a blocking question tool.`,
      });
    } catch (e) { return toolText({ isError: true, error: e.message }); }
  }
  if (name === "read_thread") {
    if (args.item_id) {
      const one = findLoose(args.item_id);
      if (!one) return toolText({ isError: true, error: `NOT_FOUND: no inbox item ${args.item_id}` });
      const row = decorate(one);
      return toolText({
        items: [{
          id: row.id, state: row.state, answered: !!(row.answers || row.closedAnswers), source: row.source,
          thread_id: row.threadId, subject: row.subject, machine: row.machine, due: row.due, reason: row.reason,
          questions: questionView(row),
        }],
      });
    }
    // A thread read includes closed items so the agent can see that an answer landed.
    const items = await listItems({
      all: !!(args.include_closed || args.thread), threadId: args.thread || undefined, now: Date.now(),
    });
    const rows = items;
    return toolText({
      items: rows.map((it) => ({
        id: it.id, state: it.state, answered: !!(it.answers || it.closedAnswers), source: it.source,
        thread_id: it.threadId, subject: it.subject, machine: it.machine, due: it.due, reason: it.reason,
        questions: questionView(it),
      })),
    });
  }
  return toolText({ isError: true, error: `validation_error: unknown tool ${name}` });
}
function decorate(it) {
  const now = Date.now();
  return { ...it, due: isDue(it, now), ageMs: now - Date.parse(it.openedAt) };
}
function findLoose(id) {
  // read_thread may run outside the lock; a torn read only misses a line mid-append, and the next read sees it.
  return readAllUnlocked().find((it) => it.id === id) || null;
}
function mcpResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function mcpError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
async function handleMcp(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || !msg.method) return null;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification
  if (method === "initialize") return mcpResult(id, {
    protocolVersion: "2024-11-05", capabilities: { tools: {} },
    serverInfo: { name: "t3-inbox", version: version() },
  });
  if (method === "ping") return mcpResult(id, {});
  if (method === "tools/list") return mcpResult(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const known = MCP_TOOLS.some((t) => t.name === name);
    if (!known) return mcpResult(id, toolText({ isError: true, error: `validation_error: unknown tool ${name}` }));
    return mcpResult(id, await callTool(name, args));
  }
  return mcpError(id, -32601, `method not found: ${method}`);
}
function parseFrames(buffer) {
  const msgs = [];
  let buf = buffer;
  while (buf.length) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) break;
    const header = buf.slice(0, sep).toString("utf8");
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) break;
    const len = +m[1], start = sep + 4;
    if (buf.length < start + len) break;
    msgs.push(JSON.parse(buf.slice(start, start + len).toString("utf8")));
    buf = buf.slice(start + len);
  }
  return { msgs, rest: buf };
}
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}
function serveMcp() {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0), pending = Promise.resolve();
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let parsed;
      try { parsed = parseFrames(buf); } catch (e) { process.stderr.write(`t3 inbox mcp: ${e.message}\n`); return; }
      buf = parsed.rest;
      for (const msg of parsed.msgs) {
        try {
          const res = await handleMcp(msg);
          if (res) process.stdout.write(encodeFrame(res));
        } catch (e) {
          if (msg && msg.id != null) process.stdout.write(encodeFrame(mcpError(msg.id, -32603, e.message)));
        }
      }
    };
    process.stdin.on("data", (c) => { pending = pending.then(() => onData(c)).catch((e) => process.stderr.write(`t3 inbox mcp: ${e.message}\n`)); });
    process.stdin.on("end", () => { pending.then(() => resolve()); });
    if (process.stdin.isTTY) process.stderr.write("t3 inbox mcp: waiting for MCP messages on stdin\n");
  });
}

const USAGE = `t3ctl inbox list [--project p] [--open] [--due] [--all] [--json]
t3ctl inbox answer --item <id> (--pick 8:A,9:B | --text words | --answers json) --from owner --via room|dm|terminal --ref <message ref>
t3ctl inbox posted --item <id> --destination <room or dm> [--ref <message ref>]
t3ctl inbox remind --item <id>
t3ctl inbox mcp`;

async function cli(sub, o, deps = {}) {
  if (sub === "list") {
    const items = await listItems({ project: o.project, open: !!o.open, due: !!o.due, all: !!o.all });
    console.log(formatList(items, { json: !!o.json, due: !!o.due }));
    return;
  }
  if (sub === "posted") {
    const r = await markPosted({ item: o.item, destination: o.destination, ref: o.ref });
    console.log(`${r.created ? "posted" : "already posted"} ${r.item.id} -> ${r.item.posted ? r.item.posted.destination : o.destination}`);
    return;
  }
  if (sub === "remind") {
    const r = await markReminded({ item: o.item });
    console.log(`${r.created ? "reminded" : "already reminded"} ${r.item.id} (nothing sent)`);
    return;
  }
  if (sub === "mcp") return serveMcp();
  if (sub === "answer") {
    if (String(o.from || "") !== "owner")
      throw fail("NOT_OWNER", "answers are only accepted with --from owner, and only for the owner's own words. Nothing was sent.");
    if (deps.ensureT3) deps.ensureT3();
    const r = await answerItem(o, deps.adapter ? deps.adapter() : null);
    if (r.status === "request-gone") {
      console.log(`REQUEST_GONE: the thread for ${r.item.id} is gone. The answer is saved and the item is closed. Tell the user it could not be delivered.`);
      return;
    }
    console.log(`answered ${r.item.id} via ${r.method}`);
    return;
  }
  console.log(USAGE);
}

module.exports = {
  DUE_MS, slug, letterOf, commandIdFor, itemIdForRequest, agentItemId, questionsFromT3, parseQuestionBlocks,
  resolveAnswers, queuedTurnText, fold, isDue, withRoot, rootDir, openFromRequest, openFromAgent, markPosted,
  markReminded, closeFromResolution, answerItem, listItems, formatList, rebuild, openRequestItems, closureReason,
  callTool, handleMcp, parseFrames, encodeFrame, serveMcp, cli, MCP_TOOLS, machineName, USAGE,
};
