// t3ctl skills: install only what's missing or changed, keep local edits, verify hashes, need no token.
const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { execFileSync } = require("child_process");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "t3tots-skills-"));
// A tools folder with only t3ctl in it (no token), so backups land in this temp folder.
const toolsDir = tmp(); fs.copyFileSync(path.join(__dirname, "..", "tools", "t3ctl"), path.join(toolsDir, "t3ctl")); fs.copyFileSync(path.join(__dirname, "..", "tools", "t3inbox.js"), path.join(toolsDir, "t3inbox.js"));
const run = (...a) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(toolsDir, "t3ctl"), "skills", ...a], { encoding: "utf8", stdio: "pipe" }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };

// A release-shaped folder: skills/<name>/SKILL.md plus a manifest.json that pins each file.
function release(skills, version = "v9.9.9") {
  const root = tmp(), files = [];
  for (const [name, body] of Object.entries(skills)) {
    fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), body);
    files.push({ path: `skills/${name}/SKILL.md`, dest: `${name}/SKILL.md`, kind: "skill", sha256: sha(Buffer.from(body)) });
  }
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ name: "t3-tots", version, files }));
  return root;
}
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

test("list needs no token and names every skill", () => {
  const r = run("list", "--from", release({ "t3-a": "a1\n", "t3-b": "b1\n" }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /hashes verified/); assert.match(r.out, /t3-a/); assert.match(r.out, /2 skills/);
});

test("dry run writes nothing", () => {
  const to = path.join(tmp(), "skills");
  const r = run("install", "--from", release({ "t3-a": "a1\n" }), "--to", to, "--dry-run");
  assert.equal(r.code, 0, r.out); assert.match(r.out, /would install 1 new/); assert.equal(fs.existsSync(to), false);
});

test("list --to shows each skill's state and changes nothing", () => {
  const src = release({ "t3-a": "a1\n", "t3-b": "b1\n" }), to = path.join(tmp(), "skills");
  run("install", "--from", src, "--to", to, "--only", "t3-a");
  fs.writeFileSync(path.join(to, "t3-a", "SKILL.md"), "mine\n");
  const r = run("list", "--from", src, "--to", to);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /1 not installed, 0 to update, 0 up to date, 1 changed here/);
  assert.equal(read(to, "t3-a", "SKILL.md"), "mine\n"); assert.equal(fs.existsSync(path.join(to, "t3-b")), false);
});

test("installs missing skills, then reports them up to date", () => {
  const src = release({ "t3-a": "a1\n", "t3-b": "b1\n" }), to = path.join(tmp(), "skills");
  assert.match(run("install", "--from", src, "--to", to).out, /installed 2 new/);
  assert.equal(read(to, "t3-a", "SKILL.md"), "a1\n");
  assert.ok(JSON.parse(read(to, ".t3-tots-skills.json")).skills["t3-b"].hash);
  assert.match(run("install", "--from", src, "--to", to).out, /installed 0 new, updated 0, 2 up to date/);
});

test("updates a skill that changed in the release and wasn't edited here", () => {
  const to = path.join(tmp(), "skills");
  run("install", "--from", release({ "t3-a": "a1\n", "t3-b": "b1\n" }), "--to", to);
  const r = run("install", "--from", release({ "t3-a": "a2\n", "t3-b": "b1\n" }), "--to", to);
  assert.match(r.out, /t3-a {2}update/); assert.match(r.out, /updated 1, 1 up to date/);
  assert.equal(read(to, "t3-a", "SKILL.md"), "a2\n");
});

test("keeps a skill edited here unless --force, and backs it up outside --to", () => {
  const to = path.join(tmp(), "skills");
  run("install", "--from", release({ "t3-a": "a1\n" }), "--to", to);
  fs.writeFileSync(path.join(to, "t3-a", "SKILL.md"), "mine\n");
  const src = release({ "t3-a": "a2\n" });
  assert.match(run("install", "--from", src, "--to", to).out, /kept: changed here/);
  assert.equal(read(to, "t3-a", "SKILL.md"), "mine\n");
  const r = run("install", "--from", src, "--to", to, "--force");
  assert.equal(read(to, "t3-a", "SKILL.md"), "a2\n");
  const backup = r.out.match(/old copy: (.+)/)[1].trim();
  assert.equal(read(backup, "SKILL.md"), "mine\n");
  assert.ok(!backup.startsWith(to), "backup must not sit inside the skills folder");
  assert.deepEqual(fs.readdirSync(to).filter((n) => !n.startsWith(".")), ["t3-a"]);
});

test("a skill already there with no install record counts as edited", () => {
  const to = path.join(tmp(), "skills"); fs.mkdirSync(path.join(to, "t3-a"), { recursive: true });
  fs.writeFileSync(path.join(to, "t3-a", "SKILL.md"), "older\n");
  assert.match(run("install", "--from", release({ "t3-a": "a1\n" }), "--to", to).out, /1 kept/);
});

test("--only limits the install and rejects unknown names", () => {
  const src = release({ "t3-a": "a1\n", "t3-b": "b1\n" }), to = path.join(tmp(), "skills");
  run("install", "--from", src, "--to", to, "--only", "t3-b");
  assert.deepEqual(fs.readdirSync(to).filter((n) => !n.startsWith(".")), ["t3-b"]);
  assert.notEqual(run("install", "--from", src, "--to", to, "--only", "t3-zzz").code, 0);
});

test("a file that doesn't match manifest.json installs nothing", () => {
  const src = release({ "t3-a": "a1\n", "t3-b": "b1\n" }), to = path.join(tmp(), "skills");
  fs.writeFileSync(path.join(src, "skills", "t3-b", "SKILL.md"), "tampered\n");
  const r = run("install", "--from", src, "--to", to);
  assert.notEqual(r.code, 0); assert.match(r.out, /HASH_MISMATCH/); assert.equal(fs.existsSync(to), false);
});

test("install needs --to; a folder with no skills says NO_SKILLS_SOURCE", () => {
  assert.notEqual(run("install", "--from", release({ "t3-a": "a1\n" })).code, 0);
  const r = run("list", "--from", tmp()); assert.notEqual(r.code, 0); assert.match(r.out, /NO_SKILLS_SOURCE/);
});

test("the repo's own skills verify against manifest.json", () => {
  const r = run("list", "--from", path.join(__dirname, ".."));
  assert.equal(r.code, 0, r.out); assert.match(r.out, /hashes verified/); assert.match(r.out, new RegExp(`${fs.readdirSync(path.join(__dirname, "..", "skills")).length} skills`));
});

test("install refuses a folder with no manifest.json (BAD_MANIFEST) and writes nothing", () => {
  const src = release({ "t3-a": "a1\n" }); fs.renameSync(path.join(src, "manifest.json"), path.join(src, "manifest.json.off"));
  const to = path.join(tmp(), "skills"), r = run("install", "--from", src, "--to", to);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /BAD_MANIFEST/); assert.equal(fs.existsSync(to), false);
  assert.match(run("list", "--from", src).out, /unverified|unversioned/); // listing still works and says so
});
