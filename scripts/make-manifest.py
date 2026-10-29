#!/usr/bin/env python3
"""Rewrite manifest.json from the files in this repo.

Usage: python3 scripts/make-manifest.py [--check]
The version comes from VERSION. Tools are listed in TOOLS below; every file under skills/<name>/ is added.
--check writes nothing and exits 1 if manifest.json is out of date.

Each entry: path (in the repo), dest (where it goes), kind (tool or skill), bytes, sha256.
Tools also have targets (which computers get them) and purpose. A tool's dest is relative to the
tools folder, which stays flat: tools/windows/ and tools/macos/ files sit next to t3ctl when installed.
A skill's dest is relative to the agent's skills folder (see `t3ctl skills`).
"""
import hashlib, json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO = "Deepusleepy/t3-tots"
ALL = ["macos", "linux", "windows", "box"]
TOOLS = [  # repo path, installed path, targets, purpose
    ("tools/t3q.py", "t3q.py", ALL, "read-only T3 database queries"),
    ("tools/t3ctl", "t3ctl", ALL, "T3 local API client and skills installer (Node 22+)"),
    ("tools/windows/t3ctl.cmd", "t3ctl.cmd", ["windows", "box"], "Windows wrapper for t3ctl"),
    ("tools/t3listen", "t3listen", ALL, "pushes T3 questions (open and close) and thread finish, fail and cancel events to your webhook (Node 22+, optional)"),
    ("tools/t3inbox.js", "t3inbox.js", ALL, "local append-only T3 inbox (used by t3ctl and t3listen)"),
    ("tools/windows/t3listen.cmd", "t3listen.cmd", ["windows", "box"], "Windows wrapper for t3listen"),
    ("tools/export.js", "export.js", ALL, "redacted project export"),
    ("tools/survey.js", "survey.js", ALL, "thread activity survey"),
    ("tools/t3ui", "t3ui", ["macos", "box"], "macOS UI fallback"),
    *[(f"tools/macos/ui-{n}.applescript", f"ui-{n}.applescript", ["macos", "box"], "macOS UI fallback helper")
      for n in ("dump", "menuitem", "model", "press", "type")],
    ("tools/cleanup/scan.py", "cleanup/scan.py", ALL, "read-only disk scan"),
    ("tools/cleanup/make_report.py", "cleanup/make_report.py", ["box"], "cleanup report builder"),
    ("tools/report/report.py", "report/report.py", ["box"], "project report builder"),
]


def repo_files(folder):
    """Files under folder that git would commit (tracked or new, not ignored); every file if git isn't there."""
    r = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", folder], cwd=ROOT, capture_output=True, text=True)
    if r.returncode == 0:
        return [p for p in r.stdout.splitlines() if (ROOT / p).is_file()]
    return [f.relative_to(ROOT).as_posix() for f in (ROOT / folder).rglob("*")
            if f.is_file() and not f.name.startswith(".") and "__pycache__" not in f.parts and "out" not in f.relative_to(ROOT / folder).parts]


def entry(path, dest, kind, **extra):
    data = (ROOT / path).read_bytes()
    return {"path": path, "dest": dest, "kind": kind, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), **extra}


def build(version):
    files = [entry(p, d, "tool", targets=t, purpose=why) for p, d, t, why in TOOLS]
    shipped = {p for p, *_ in TOOLS}
    loose = sorted(set(repo_files("tools")) - shipped)
    if loose: raise SystemExit("UNLISTED_TOOL: add these to TOOLS in scripts/make-manifest.py: " + ", ".join(loose))
    for d in sorted(p for p in (ROOT / "skills").iterdir() if p.is_dir()) if (ROOT / "skills").is_dir() else []:
        for f in sorted(x for x in d.rglob("*") if x.is_file() and not x.name.startswith(".") and "__pycache__" not in x.parts):
            rel = f.relative_to(ROOT).as_posix()
            files.append(entry(rel, f.relative_to(ROOT / "skills").as_posix(), "skill"))
    return {"name": "t3-tots", "version": version, "repo": f"https://github.com/{REPO}",
            "raw_base": f"https://raw.githubusercontent.com/{REPO}/{version}/",
            "requires": {"python": ">=3.8", "node": ">=22 (t3ctl, t3listen), >=18 (export.js, survey.js)"},
            "files": files}


def main() -> int:
    version = (ROOT / "VERSION").read_text().strip()
    m = build(version)
    new = json.dumps(m, indent=1, ensure_ascii=False) + "\n"
    path = ROOT / "manifest.json"
    old = path.read_bytes().decode("utf-8") if path.exists() else ""
    counts = f"{sum(f['kind'] == 'tool' for f in m['files'])} tool files, {len({f['dest'].split('/')[0] for f in m['files'] if f['kind'] == 'skill'})} skills, {version}"
    if "--check" in sys.argv[1:]:
        if old != new:
            print("MANIFEST_STALE: manifest.json (run: python3 scripts/make-manifest.py)")
            return 1
        print(f"manifest ok ({counts})")
        return 0
    path.write_bytes(new.encode("utf-8"))
    print(f"wrote manifest.json ({counts})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
