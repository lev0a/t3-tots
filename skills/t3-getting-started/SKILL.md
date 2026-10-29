---
name: t3-getting-started
description: >-
  First conversation with a new owner of T3 Tots: detect their setup, install
  the helper tools, optionally issue the T3 token, verify, and show what to try.
  Use on the first chat, when no T3 Tots setup is saved in memory, or when the
  user says "set up T3 Tots" / "getting started" / "reinstall the tools".
---
If you are not Grok Bot, stop here. Install and verify the tools by following AGENTS.md in this release, and skip every step below (box, ListMachines, routines, cards, memory, phone setup; t3-tots-rules "Grok Bot only" lists what to do instead).

Follow the t3-tots-rules skill (skills/t3-tots-rules/SKILL.md). Detection is read-only. Nothing is written to the user's computers until they say yes, and the token needs its own yes.

Open with one line: "I'm T3 Tots. Give me a few seconds to look at your setup."

## 1. Detect (no questions yet)
1. **Box tools:** if `/workspace/t3-tots-tools/manifest.json` is missing, run t3-install-tools "Box copy" now (box only, nothing touches the user's computers). If it fails (no network, `HASH_MISMATCH`, or `REPO_PRIVATE_OR_MISSING`), say so in the report and use t3-install-tools "Private repo" later. The read-only probe still runs.
2. **Computers:** ListMachines. Use desktops only (phones can't run the tools). If none is registered or connected, say: "Install the Grok Bot desktop app on the computer that runs T3 Code, sign in, and tell me when it shows up," then stop.
3. **Each connected desktop, in parallel**, run the read-only probe for its OS. It never opens token or secret files, and its file list leaves out `token`, `listen.json` and logs. If memory already names a tools folder, add it to the probe's folder list.
   macOS / Linux (zsh-safe):
   ```
   f(){ t(){ echo "$1" | sed "s|^$HOME|~|"; }; echo "os=$(uname -s) $(uname -m)"; H="${T3CODE_HOME:-$HOME/.t3}"; echo "t3home=$(t "$H")"
   for d in userdata dev; do [ -f "$H/$d/statev2.sqlite" ] && echo "t3data=$d"; done
   [ -f "$H/userdata/server-runtime.json" ] && echo "t3runtime=yes"; [ -x "$H/bin/t3" ] && echo "t3cli=yes"
   [ -d /Applications ] && find /Applications -maxdepth 1 -name 'T3 Code*.app' 2>/dev/null
   if [ "$(uname -s)" = Darwin ] && [ "$(command -v python3)" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then echo "python=missing (macOS stub)"; elif command -v python3 >/dev/null; then echo "python=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')"; else echo "python=missing"; fi
   command -v node >/dev/null && echo "node=$(node -v)" || echo "node=missing"
   for d in "$HOME/t3-tots"; do [ -d "$d" ] && echo "tools=$(t "$d"): $(ls "$d" | grep -vE '^(token|listen\.json)$|\.log$' | tr '\n' ' ')"; done; true; }; f
   ```
   Windows (PowerShell):
   ```
   $H = if ($env:T3CODE_HOME) { $env:T3CODE_HOME } else { "$env:USERPROFILE\.t3" }; "os=Windows $([Environment]::OSVersion.Version) $env:PROCESSOR_ARCHITECTURE"
   foreach ($d in 'userdata','dev') { if (Test-Path "$H\$d\statev2.sqlite") { "t3data=$d" } }
   if (Test-Path "$H\userdata\server-runtime.json") { 't3runtime=yes' }; if (Test-Path "$H\bin\t3.cmd") { 't3cli=yes' }
   $v = $null; try { $v = py -3 -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null } catch {}; if ($v) { "python=$v (py -3)" } else { try { $v = python -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null } catch {}; if ($v) { "python=$v (python)" } else { 'python=missing' } }
   try { "node=$(node -v)" } catch { 'node=missing' }
   foreach ($t in "$env:USERPROFILE\t3-tots") { if (Test-Path $t) { "tools=$t`: $((Get-ChildItem $t -Name | Where-Object { $_ -notmatch '^(token|listen\.json)$|\.log$' }) -join ' ')" } }
   ```
4. Work out defaults: tools folder = the one in memory or found by the probe, else `~/t3-tots` (Windows `%USERPROFILE%\t3-tots`); name and timezone = what you already know about the user. The projects folder comes later from `t3q.py projects`.

## 2. Report and ask once
One message, at most 8 lines:
- Per computer: T3 Code found or not (and stable/Nightly), Python/Node versions or "missing", tools folder found or not.
- Blockers with the fix (see "Missing pieces").
- Then the batched ask, with defaults filled in:
  "Reply **yes** and I'll (1) install my helper scripts into `<tools folder>` on <computers> and (2) issue a T3 access token so I can start threads and send follow-ups for you (90 days, revocable). Say **yes, read-only** to skip the token. Optional: your sandbox project for throwaway asks, and any long-running jobs I must never interrupt (process name + log)."
Don't ask anything else. Name, timezone and projects folder use the defaults unless they correct them; the projects folder is guessed after install.

## Missing pieces (give the exact line for their OS; install only after a yes)
- **T3 Code not found / never ran:** install it from the T3 Code releases page (github.com/pingdotgg/t3code/releases), open it once and add a project, then say "check again".
- **Python 3.8+ missing** (needed for the read-only status queries): macOS `xcode-select --install` (or `brew install python`); Windows `winget install -e --id Python.Python.3.13`; Debian/Ubuntu `sudo apt install -y python3`; Fedora `sudo dnf install -y python3`.
- **Node 22+ missing or older** (needed for starting threads and reports): macOS `brew install node` (or the LTS installer from nodejs.org); Windows `winget install -e --id OpenJS.NodeJS.LTS`; Linux `nvm install --lts` (no sudo) or the NodeSource repo for Node 22+ (distro packages are often too old).
- You may run brew/winget for them after a yes; on Windows refresh PATH in the same shell afterwards: `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`. `sudo` commands: give them to the user to run.
- Without Python: status, waiting, health and usage are unavailable on that computer. Without Node: no threads, follow-ups, reports or digests. Say so and continue with what works.

## 3. On yes
1. Install: t3-install-tools "Install on a computer" for each computer with T3 data (every file verified by sha256).
2. Token (only if they didn't say read-only, and only where `t3runtime=yes`; otherwise ask them to open T3 Code first): t3-tots-rules "Token", then `t3ctl projects` must list projects. Fill in the token date and expiry in the tools folder's `README.md` (t3-install-tools "README").
3. Verify each computer and fix anything red before moving on: `t3q.py health`, `t3q.py projects` (its "projects folder guess" becomes the default projects folder), `t3ctl projects` (if token). If `t3ctl` prints `NODE_TOO_OLD`, give the Node line above.
4. **Official face (first setup only):** set this bot's picture after the tools are installed and the token step is finished (token issued, or they chose read-only). If you asked them to open T3 Code, wait until that token step finishes. Skip this when a setup note is already in memory, so a reinstall leaves the current picture in place. Download the pinned-release avatar on the box. The tag is the one t3-install-tools pins (`v1.5.0`). Save it outside T3 and outside the tools folder:
   ```
   curl -fsSL -o /workspace/t3-tots-avatar.png https://raw.githubusercontent.com/Deepusleepy/t3-tots/v1.5.0/assets/avatar.png
   ```
   The file must be a PNG under 5 MB whose sha256 is `ae44bdac0842f21d74b7cc93975af0a3abc29e7c7b306e87f737d5f07c950f2e` (`sha256sum /workspace/t3-tots-avatar.png`). Then call UpdateAvatar with action `set` and path `/workspace/t3-tots-avatar.png`. Never open T3's `secrets/`, the tools folder `token` or `listen.json`, or any auth file. If the download fails, the hash does not match, or UpdateAvatar fails or is missing, say one line that they can set a picture later, and continue. Setup still succeeds. Do not retry.
5. Save one memory note: setup done, tools version, per computer (label, OS, tools folder, Python command such as `py -3`, Node version, token yes/no and expiry date), whether the official face was set, projects folder, sandbox project, protected jobs, that phone answers are off, and that decisions are in the default mode (t3-tots-rules "Decisions"). The oversight mode and pstack status are saved in section 4, and routines separately in section 6.
6. macOS only, optional: the `t3ui` UI fallback needs Accessibility permission for the Grok Bot app (System Settings > Privacy & Security > Accessibility). Mention it once; don't ask now.

## 4. Oversight mode and pstack
1. **Oversight mode:** ask once, as a tap-to-answer card: "How hands-on should I be: Monitor, Orchestrate, or PM coworker?" Explain in one line each. Monitor: I relay questions, handle approvals per your saved autonomy, report finishes, and step in only if a thread is truly stuck or broken. Orchestrate: Monitor plus starting watches and routines and coordinating several threads when you ask, without interrupting healthy runs. PM coworker: I actively plan and drive project work with you (including project-manager threads), and still never merge or take irreversible actions without your OK. In every mode, never steer a thread that is running or already knows its next step. Save the pick to memory.
2. **pstack (required):** pstack, the principles pack by Lauren Tan (poteto), sets this bot's quality bar and is a required install. Ask: "pstack (Lauren Tan's poteto principles) is required for the quality bar this bot works to. Set it up now?" If yes, install Lauren Tan's poteto/pstack principles from the Cursor plugin catalog (`/add-plugin pstack`). For other agents, a community mirror is `npx skills add backnotprop/pstack`. That mirror is not her official repo. Her work is the Cursor poteto/pstack principles plugin. If no, say quality checks will be lighter and the bot won't work as intended until it is installed, and offer it again in the finish message. Save the answer to memory.

## 5. Optional: answer from your phone
Only if a token was issued. Offer it once, in one line: "Want me to message you here the moment a thread asks you something, so you can answer from this chat on your phone or computer? It needs a small listener on each computer and a webhook routine; say **phone answers** to set it up." On yes, follow t3-phone-answers "Setup": you open a setup window on each computer yourself, and the user only pastes two lines (the Webhook URL, then the Authorization header). On no, don't ask again.

## 6. Routines (one tap each)
This bot ships with six routines, all paused. Show them in one multi-select card, nothing pre-selected, each option labelled with its name and time in the user's timezone, plus a **none** option:
- **Daily digest**: weekdays at 9:00 AM
- **Weekly wrap-up**: Fridays at 5:00 PM
- **Waiting-on-you check**: weekdays at 11:00 AM and 4:00 PM
- **Weekly health check**: Mondays at 10:00 AM (disk scan about once a month)
- **Out-of-date check**: Wednesdays at 10:00 AM
- **Weekly usage estimate**: Mondays at 9:30 AM
This list is the one place for the routine names and times; other skills point here. Weekly health check runs t3-checkup every Monday, and runs the t3-cleanup scan only when the last scan is 25 or more days old.
Lead line: "I can also send these on a schedule. Pick any you want on; you can change this any time."
On the answer: save one memory note "Routines on: <names>" (or "Routines on: none"), resume the picked routines, and leave the rest paused (pause any that are still active). Confirm in one line with the times. If the user asks for another time, change only that routine's schedule.
Later, "turn on <routine>" / "turn off <routine>" / "move <routine> to <time>" resumes, pauses or reschedules that routine and updates the "Routines on" note. Never create a second copy of a shipped routine.

## 7. Finish
One short line first: what was installed where, token yes/no and expiry, whether the official face was set, the oversight mode, whether phone answers are on, whether pstack is installed (if not, offer it again), and which routines are on. Then run t3-status (overview) as a first look, then this list:

Things to try:
- what's waiting on me
- status
- new thread in <project>: <ask>
- catch me up on <project>
- watch <thread>
- make a PM thread for <project>
- health check
- what's out of date
- daily digest
- update T3 Tots
