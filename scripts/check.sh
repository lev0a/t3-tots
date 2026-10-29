#!/usr/bin/env bash
# Run every check before a commit or release: syntax, tests, manifest, install pins, public safety.
# Usage: scripts/check.sh   (from anywhere; needs bash 3.2+ (macOS default is fine), node 22+, python3)
# Private words to block are read by scripts/scan-private.py (see its header). With none set, the public safety step fails
# unless T3TOTS_NO_PRIVATE_WORDS=1 says you skip them on purpose.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
step() { printf '%-28s' "$1"; }
ok() { echo "${1:-ok}"; }
bad() { echo "FAIL"; [ -n "${1:-}" ] && printf '%s\n' "$1" | sed 's/^/    /'; fail=1; }

step "node --check"
out=""; for f in tools/t3ctl tools/t3listen tools/t3inbox.js tools/export.js tools/survey.js; do r=$(node --check "$f" 2>&1) || out+="$f: $r"$'\n'; done
[ -z "$out" ] && ok || bad "$out"

step "python compile"
r=$(python3 - <<'PY' 2>&1
for f in ["tools/t3q.py", "tools/cleanup/scan.py", "tools/cleanup/make_report.py", "tools/report/report.py",
          "scripts/make-manifest.py", "scripts/scan-private.py", "scripts/sync-skills"]:
    compile(open(f, encoding="utf-8").read(), f, "exec")  # syntax only, writes no .pyc
PY
) && ok || bad "$r"

step "unit tests"
r=$(node --test tests/*.test.js 2>&1) && ok || bad "$r"

step "python tests"
out=""; for f in tests/*_test.py; do r=$(python3 "$f" 2>&1) || out+="$f: $r"$'\n'; done
[ -z "$out" ] && ok || bad "$out"

step "manifest"
r=$(python3 scripts/make-manifest.py --check 2>&1) && ok "$r" || bad "$r"

step "line endings"
out=""; for f in tools/windows/*.cmd; do python3 -c "import sys; d=open(sys.argv[1],'rb').read(); sys.exit(0 if d.count(b'\n') == d.count(b'\r\n') else 1)" "$f" || out+="$f must use CRLF line endings"$'\n'; done
[ -z "$out" ] && ok || bad "$out"

step "public safety"
r=$( { git ls-files --cached --others --exclude-standard 2>/dev/null || find . -type f -not -path './.git/*'; } | while IFS= read -r f; do [ -f "$f" ] && printf '%s\0' "$f"; done | xargs -0 python3 scripts/scan-private.py --require-words 2>&1) && ok "${r##*$'\n'}" || bad "$r"
# a missing private-word list must be seen, not hidden behind "ok"
case "$r" in *"warning: no private words"*) printf '%s\n' "$r" | grep '^warning: no private words' | sed 's/^/    /';; esac

[ $fail = 0 ] && echo "ALL CHECKS PASSED" || echo "CHECKS FAILED"
exit $fail
