---
name: t3-tots-rules
description: >-
  Shared rules and tools for every t3-* (T3 Tots) skill. Read before running any of them.
---
# T3 Tots rules

Every t3-* skill follows these rules. Other skills link here instead of repeating them.

## Writes
Change nothing on the user's computers unless the user approved that exact change in chat. Approval for one change is not approval for the next. These skills may write, and only the thing named:

| Skill | What it may write |
|---|---|
| t3-new-thread, t3-templates, t3-get-output, t3-pm-thread | Prompts into T3 |
| t3-thread-actions | The thread action asked: `settle`, `unsettle`, `rename`, `interrupt`, `stop`, `subagent-stop`, `fork`, `model`, `snooze`, `unsnooze`, `resume-at-reset`, `snooze-until-reset` (and `--cancel`), and `queue` changes (`--steer`, `--cancel`, `--edit`, `--move`, `--resume`) |
| t3-waiting, t3-phone-answers, t3-watch | Answers to questions and approvals, under "Decisions" below |
| t3-watch (delegated mode) | One nudge per stall (`send`), `queue --resume` once for a stuck queue, and `resume-at-reset` on a usage limit |
| t3-phone-answers | `t3listen` setup, after a yes. In delegated mode also `resume-at-reset` for a thread that stopped on a usage limit |
| t3-update, t3-sync | The items the user picked |
| t3-project-tracker | Its tracker file |
| t3-save-learnings | `AGENTS.md` or `CLAUDE.md`, after a yes to the diff |
| t3-cleanup | Only the items the user picked, after a confirm |
| t3-getting-started, t3-install-tools | The tools folder, after the setup or update yes |

A saved sync list or update level is approval for a later "sync everything" or "update <level>" only for items already in that list, and only after this turn's diff is shown. Anything new still needs a yes.

Windows admin steps: the remote shell has no admin rights. When an approved step needs them, write a `.ps1` that starts with `Start-Transcript <log>`, launch it with `Start-Process pwsh -Verb RunAs -ArgumentList '-File','<script>'`, tell the user to click Yes on the UAC prompt, then poll the log until it shows done or an error. Don't ask the user to paste admin commands when this works.

## T3 database
T3 Code keeps its state in `<T3 home>/userdata`. T3 home is `T3CODE_HOME` if set, else `~/.t3` (Windows `%USERPROFILE%\.t3`). The stable app and Nightly share that folder. Open `statev2.sqlite` there only read-only. Never INSERT, UPDATE, DELETE or VACUUM it, and never edit a copy. Writes into T3 go only through `t3ctl`.

## Secrets
- Never open, list, print or copy T3's `secrets/`, `clerk-tokens.json`, `cloud-auth-token.json`, `auth_sessions`, or any `*token*`, `*auth*`, `.env` or credential file.
- From `server-runtime.json`, read only `host`, `port` and `pid`.
- The one token in use is the `token` file in the tools folder. Only t3ctl, t3listen, export.js and survey.js read it. Never print it.
- `t3listen setup` alone writes `listen.json`, which holds the webhook URL and key. Never open, print or copy it.
- If thread text contains a key, never repeat it.

## Threads and settings
Never delete or archive threads, and never change T3 settings. t3-update may update T3 Code, and t3-sync may copy the settings the user picked. Every thread action in the Writes table, and scheduled tasks (`t3ctl tasks --upsert`, `--enable`, `--run`, `--delete`), needs the user's OK for that exact action. The one exception is what delegated mode allows below.

## Decisions
This section is the one source for who decides; other skills and AGENTS.md point here. A thread asks for two kinds of decision. A question (`user_input`) asks what to build. An approval asks permission to run a command or change files. Who decides depends on the mode the user set, which is saved in memory:

1. Default mode: show questions to the user as cards (or numbered options; see "Grok Bot only") and answer only with their exact pick for that question (t3-phone-answers "Answering"). Summarise approvals and leave them for the app, unless the user says yes to that request in chat. Offer thread actions such as `resume-at-reset`; don't run them.
2. Delegated mode starts when the user says something like "decide for me", "do whatever you need" or "I'm away, keep it moving". Record the scope and the end condition in memory. In this mode:
   - Answer routine questions yourself and tell the user afterwards what you picked and why.
   - Never accept an approval yourself. A thread asks for one only when a safety check flagged the command (for example a git hook on `git reset --hard`), even in full access. Decline it with `t3ctl answer --thread <t> --request <id> --decision decline --redirect`. That also tells the thread not to retry or work around it, to use a safer way or skip that step, and to carry on. Log it, and list every declined approval with its reason in your report.
   - Run the delegated-mode actions in the Writes table, and log each one.
   - Escalate questions about product direction, money, publishing, or anything the user said to keep for themselves.

The prompt T3 shows is often a short description ("Redo merges with PR names"), not the command itself. `t3ctl pending` prints `why it asks:` with the reason the safety check gave, and `pending --json` has it as `approval.reason`. Show the reason to the user on the card. Never judge an approval safe from its text.

`t3ctl answer --decision` accepts an approval only with `--user-approved`. Pass it only after the user's yes for that request. Otherwise it refuses with `NEEDS_USER_APPROVAL` and sends nothing. `decline` and `cancel` need neither. Always pass `--request <id>` with the id the user saw. When several approvals are open, or the id matches more than one, t3ctl stops with `AMBIGUOUS` instead of picking one.

`t3ctl inbox answer` is only for a user_input question that already has an inbox item. Pass `--from owner` only when the words are the user's own. Any other `--from` is refused with `NOT_OWNER` and nothing is sent. Never use the inbox for an approval. Approvals stay on `t3ctl answer`.

Never invent the user's preferences. The thread decides how to do the work. The user decides what to build. Your prompts carry the user's context, not your design choices.

## Sending into threads
- Before a follow-up, read the thread's recent history (`t3ctl read --thread <t> --last 6`) so you don't repeat or contradict it.
- `t3ctl send` steers into a running run by default and checks that the message arrived. Relay its notes:
  - `DELIVERY_FIXED`: the queue was stuck and t3ctl resumed it.
  - `QUEUE_HELD`: someone held the queue on purpose. Ask before `t3ctl queue --thread <t> --resume`.
  - `SEND_STUCK`: the message is waiting in the queue. Check `t3ctl queue --thread <t>`.
- Use `--prompt-file <file>` for any prompt over a few lines. `new`, `send` and `tasks --upsert` accept it, in UTF-8 or the UTF-16 that Windows PowerShell writes.
- Write prompt files to `<tools folder>/out/prompts/<date>-<short name>.md`, not `/tmp`. They survive a restart, and the user can see what was sent.
- Keep messages to a thread short and concrete. Say what the thread already did right, then the next step. Leave out check-ins ("how is it going?"), your own process, and these rules. The thread gets only what it needs to act.
- After answering a request, t3ctl lists the requests still open in that thread. Clear leftovers in T3 or tell the user.

## Finding a thread
Many skills start from words the user typed. Run `T3_Q='<words>' python3 t3q.py thread` on every computer and take the best score overall. `T3_Q` also takes a thread id or an id prefix of 8 or more characters. Threads that agents spawned match only with `T3_ALL=1`. t3q.py exits 1 with `AMBIGUOUS` when the top two are within 0.1 and with `NO_GOOD_MATCH` when the best is under 0.6; list the closest ones it prints and ask. If you act on the best and another match scored 0.6 or more, name it in one line so the user can correct you. If `worktreePath` is empty and the messages name another working folder, use that folder and say which one. A thread lives on one computer: search all, act only on the owner. With a token, `t3ctl search --query '<words>'` also finds a thread by content. `t3ctl --thread` takes a full id, an id prefix of 8 or more characters, an exact title, or words found in exactly one title. More than one match exits 1 with `AMBIGUOUS` and the candidates, so pass the full id.

## Grok Bot only
These steps need tools only Grok Bot has. A skill that uses them points here in one line. Any other agent (Claude Code, Codex, Cursor and so on) runs on one computer and does this instead:

| Grok Bot step | Other agents |
|---|---|
| ListMachines, every connected computer | Only the computer you run on |
| The box (`/workspace`, `/workspace/t3-tots-tools`, its `google-chrome`), CopyToBox, CopyFromBox | Run the same script from the tools folder and write to `<tools folder>/out/` (report helpers need local Python 3.9+; skip screenshots) |
| SendToUser | Give the file path |
| Routines (scheduled or webhook) and watches | Run the check once when asked; schedule it only with the user's own tools if they ask |
| Tap-to-answer cards | Ask in plain text with numbered options; answers still follow "Decisions" |
| Memory | Ask, or use the notes file the user names |
| Phone answers (`t3listen` to a chat webhook) | Skip unless the user gives their own webhook |

## Computers
Grok Bot only (see "Grok Bot only"). Call ListMachines every run. Never hard-code machine ids or home paths. The default scope is every connected computer with T3 data, run in parallel and labelled by name. Narrow it only when the user names one ("mac only"). To create things, use the computer the user names, else the one their message came from. Say which computers were offline, once per outage, then check quietly until each is back. Keep a Mac awake (`caffeinate -dimsu -w <pid>` tied to the job, or ask the user to change the setting) when a watch or delegated run must last overnight.

## Shells
macOS zsh: wrap commands in a function, `f(){ ...; }; f`, and use quoted heredocs. Windows: PowerShell. Linux: bash. Examples in skills are POSIX. On Windows, translate them:

| POSIX | Windows |
|---|---|
| `python3` | the saved Python command (`py -3`) |
| `VAR='x' cmd` | `$env:VAR='x'; cmd` |
| `tail -n N`, `head -N` | `Get-Content -Tail N`, `Select-Object -First N` |
| `wc -l` | `Measure-Object -Line` |
| `pgrep -fl X` | `Get-CimInstance Win32_Process \| ? CommandLine -like '*X*'` |
| `"$(cat f)"` | `(Get-Content f -Raw)` |

An `$env:` setting stays for the rest of the session, so clear it after use: `$env:T3_Q='x'; py -3 t3q.py thread; Remove-Item Env:T3_Q`.

## Tools on each computer
The tools folder is the one saved in memory at setup. If memory has none, use `~/t3-tots` (Windows `%USERPROFILE%\t3-tots`) if it exists, else ask, and save the answer to memory. A new install defaults to `~/t3-tots`. Every script works from wherever it lives and reads the `token` file next to it.

Run scripts from the tools folder. Use `python3` on macOS and Linux. On Windows use `py -3`, else `python`, and never the bare `python3` Store alias. Run Node scripts as `node <file>`. On Windows always run `node t3ctl` and `node t3listen`, never the `.cmd` wrappers, which drop double quotes. A value that starts with `--` goes in as `--key=value`, for example `--text=--force`. Minimum versions: Python 3.8 (3.9 for report.py), Node 22 for `t3ctl` and `t3listen`, Node 18 for `export.js` and `survey.js`.

### t3q.py
Read-only database queries. It needs no token. Commands: `overview`, `waiting`, `thread`, `projects`, `health`, `usage`. Settings: `T3_DAYS`, `T3_ALL=1`, `T3_Q` (thread words or id), `T3_LAST`, `T3_WEEK=1`.

### t3ctl
Uses T3's local API and needs the token, except `skills`. Running it with no arguments prints usage. This is the full command list for this release; other skills use these names. If a command prints the usage line instead of running, that computer has older tools: say so once and offer t3-install-tools "Updating". Don't retry other spellings.

| Area | Commands |
|---|---|
| Find | `projects`, `models`, `threads [--project p] [--main] [--limit n]`, `search --query q [--limit n]` |
| Read | `read --thread t [--last n]`, `status --thread t [--json]`, `pending --thread t [--json]`, `diff`, `files [--last-turn] [--copy no]`, `raw`, `limits [--json]`, `subtasks --thread t [--all]`, `prs --project p` (required) `[--state open\|closed\|merged\|all]`, `pr --thread t [--number n] [--all]`, `pr --project p --repo owner/name --number n` |
| Watch | `watch --thread a[,b] [--state file] [--stall-min 20] [--json]` |
| Send | `new --project p (--prompt t \| --prompt-file f) [--model m --effort e --title x --mode plan --attach a.png] [--wait [--timeout seconds]]`, `send --thread t (--prompt t \| --prompt-file f) [--queue] [--no-verify] [--wait [--timeout seconds]]` (`--wait` gives up after 300 seconds unless `--timeout` says otherwise) |
| Answer | `answer --thread t [--request id] (--pick label \| --text words \| --answers json \| --decision d [--user-approved \| --redirect])` |
| Inbox | `inbox list [--project p] [--open] [--due] [--json]`, `inbox answer --item id (--pick q:A or --text t or --answers json) --from owner --via room\|dm\|terminal --ref msg`, `inbox posted --item id --destination d [--ref msg]`, `inbox remind --item id`, `inbox mcp`. Each computer has its own `~/.t3-inbox`. The item's `machine` is where the answer command runs. `--due` lists unanswered items open 4 hours or more and sends nothing. `inbox remind` records that one reminder and sends nothing. |
| Queue | `queue --thread t [--steer id\|all \| --cancel id\|all \| --resume \| --edit id --text x \| --move id (--before id\|end \| --first)]` |
| Thread actions | `settle`, `unsettle`, `rename --title x`, `interrupt [--hold]`, `stop`, `subagent-stop --subagent id`, `fork [--run id --title x]`, `model [--model m --effort e --provider p]`, `snooze --until +2h\|HH:MM\|ISO`, `unsnooze`, `resume-at-reset [--cancel]`, `snooze-until-reset [--cancel]` |
| Scheduled tasks | `tasks [--upsert ... \| --enable id \| --disable id \| --run id \| --delete id --yes]` |
| Skills | `skills [list] [--from dir] [--to dir]`, `skills install --to dir [--from dir] [--only a,b] [--dry-run] [--force]` (copies these skills into another agent's skills folder; see the repo README) |

`--project` takes a project id, its folder, an exact title, then the one title containing the words. Several matches print `AMBIGUOUS` with the candidates (never the first one); an empty value is a usage error.

`status --json` adds `queued` (messages waiting in the queue) and `queueHeld` (the queue was held on purpose); `threads` and `status` show a held queue as `queue held` and settled threads as `(settled)`. `threads --main` hides threads that agents spawned (reviewers, sub-tasks), the same split t3q.py uses. A PM's or a thread's sub-task threads are listed by `subtasks --thread t`. `models` lists the models already used in T3, with the name of each provider's effort setting; skip the `<synthetic>` entry. `limits` prints reset times in local time and marks a reset that already passed with `(passed)`.

The default token scopes don't cover usage or cost totals, T3 settings (including "Auto-resume limited threads"), worktrees, file writes or terminals.

`t3ctl watch` prints only what changed since its last run, so an empty output means nothing changed, with or without `--json`. Its state lives in the file given with `--state`, relative to the folder it runs from (default `watch-state.json` in the tools folder). Events:

| Event | Meaning |
|---|---|
| `first` | The first check of a thread, with its state |
| `finished` | A run ended and the thread is idle, asking, or has a plan ready. Also a run that started and ended between two checks |
| `state` | Any other state change |
| `question`, `approval` | A new request. An approval shows its prompt and why it asks |
| `stale-request` | An open request that can't be answered, because its run ended. Reported once per request |
| `queue-held`, `queue-stuck` | The queue was held on purpose, or is stuck |
| `limit` | The thread stopped on a usage limit |
| `error` | The run failed |
| `reply` | A new reply while the thread is still running or waiting |
| `quiet` | Running, with no activity for twice the stall time |
| `stalled` | Idle, and the last reply says it is waiting on something |
| `unreadable` | That thread couldn't be read. Reported once per distinct error. The other threads still report |

### t3listen
Optional. It needs the token and `listen.json`. It follows T3's live events and POSTs question and finish events to the user's webhook routine (t3-phone-answers). Commands: `setup`, `test`, `install [--approvals]`, `uninstall`, `status`, `preview-finish --thread id|title` (same thread rules as `t3ctl`: full id, an 8+ character prefix, an exact title or one title match, else `AMBIGUOUS`); `--dry-run` prints instead of sending. It sends approvals too when `listen.json` has `"approvals": true` or the service was installed with `--approvals`; `status` prints which. Running `install` again keeps the `listen.json` setting and drops the flag unless you pass it again. When a main thread stops on a usage limit, t3listen arms T3's Resume at reset if the project is listed in `autoresume.json` (`{"enabled":true,"projects":[...]}`) or `t3ctl new` started the thread (recorded in `started-here.json` for 60 days).

### Other scripts and data files
- `export.js` writes a redacted JSON export for reports. Options work like t3ctl (`--project Foo` or `--project=Foo`; an unknown option is `USAGE`). `--project` is a filter: an exact id, else a folder, else an exact title (case ignored) picks that project, and two exact matches stop with `AMBIGUOUS` listing them; otherwise every project whose title contains the words is exported, and it prints a note naming them. No `--project` means all. `survey.js` lists activity and stale threads.
- `t3ui` and `ui-*.applescript` are a macOS-only UI fallback. They use the running T3 Code app, or `T3_APP`.
- Data files the skills create in the tools folder: `templates.md`, `trackers/`, `update-prefs.json`, `sync-prefs.json`, `sync-backups/`, `out/`, `README.md`, `watch-state.json`, `watch-<name>.json`, `autoresume.json`. `t3ctl new` writes `started-here.json`. t3listen writes `listen.json` (private), `listen-state.json`, `answered-here.json` and `listen.log`.
- The inbox store is `~/.t3-inbox` on that computer (or `T3_INBOX_DIR`). `items.jsonl` is append-only. `state.json` is a cache and is safe to delete. `routes.json` and `machine` are local config. The store is not in the tools folder. Do not put the webhook or the token in it.
- Don't leave scratch files (CSVs, `.bak` copies, screenshots) in the tools folder. Put scratch files in `out/`. On Grok Bot, pages are built on the box (`/workspace`).

### Master copy
The reference copy lives on the box at `/workspace/t3-tots-tools/`, installed and sha256-verified by t3-install-tools. Its `manifest.json` is the reference for every computer. Skill folders don't carry their own copies of the scripts. If the master copy is missing, run t3-install-tools "Box copy". If a computer lacks a script or a hash differs from `manifest.json`, say so and offer to reinstall.

### Status words
Scripts print these words. Relay them in plain words, not as errors. This is the one list; AGENTS.md and other skills point here.

| Word | Meaning and next step |
|---|---|
| `NO_T3_DATA` | T3 Code never ran there, or `T3CODE_HOME` points elsewhere |
| `T3_NOT_RUNNING`, `T3_NOT_REACHABLE`, `NO_T3` | Open T3 Code |
| `NO_TOKEN`, `TOKEN_REJECTED` | Issue or reissue the token ("Token" below) |
| `NODE_TOO_OLD`, `PYTHON_TOO_OLD` | Upgrade (t3-getting-started lists per-OS commands) |
| `T3_SCHEMA_CHANGED` | This T3 Code version changed its database. The read-only queries need an update (t3-install-tools "Updating"); use `t3ctl` meanwhile |
| `T3_DB_BUSY` | Retry in a few seconds |
| `BAD_SETTING` | A number setting such as `T3_DAYS` or `T3_LAST` isn't a whole number of 1 or more. Fix it and rerun |
| `USAGE` | A flag that needs a value got none (for example `--from --to dir`). Nothing ran. Give the value, as `--key=value` if it starts with `--` |
| `NO_USAGE_CACHE` | Ask the user to open T3's Usage view once |
| `AMBIGUOUS`, `NO_GOOD_MATCH` | See "Finding a thread". From `t3ctl` or `t3listen preview-finish`, several threads, projects or open approvals match: it lists them; ask which, or pass the id (or the project folder, or `--request <full id>`) |
| `NOT_FOUND` | No thread matches. List the closest ones and ask |
| `NOT_PENDING` | That question was already answered or closed |
| `NOT_ANSWERABLE` | Its run ended, so it can't be answered. Offer a follow-up instead |
| `NEEDS_USER_APPROVAL` | `t3ctl answer` won't accept that approval on its own. Nothing was sent. Show it to the user, and after their yes for that request rerun with `--user-approved` |
| `ALREADY_CLOSED` | That inbox item is already closed. The reason in parentheses says how (`answered-in-t3` means it was answered in T3). Say so. Do not submit it again. |
| `NOT_OWNER` | `t3ctl inbox answer` only accepts `--from owner`, for the owner's own words. Nothing was sent. |
| `REQUEST_GONE` | The thread is gone. The answer was saved and the item closed. Tell the user it could not be delivered. |
| `NOT_DUE` | That inbox item is not due for a reminder yet (4 hours, still unanswered). Nothing was sent. |
| `REDIRECTED` | The approval was declined and the thread was told to skip it or take a safer way and keep going. Note it for the user's report |
| `REDIRECT_NOT_DELIVERED` | The approval was declined, but the follow-up didn't reach the thread. Don't rerun `answer` (the request is closed). Run the `t3ctl send ... --prompt-file` command it prints |
| `NOT_LIMITED` | The thread isn't stopped on a usage limit, so there is nothing to resume |
| `SENT_UNCONFIRMED` | Sent, but T3 still shows it open. Check `t3ctl pending` |
| `DELIVERY_FIXED`, `QUEUE_HELD`, `SEND_STUCK` | See "Sending into threads" |
| `NO_LISTEN_CONFIG`, `BAD_LISTEN_CONFIG`, `BAD_URL`, `BAD_HEADER` | `listen.json` is missing or wrong. Run `t3listen setup` again |
| `WEBHOOK_REJECTED` | The webhook refused the event. HTTP 401 or 403 means a wrong key, so redo setup. A rate-limit reply clears on its own; the listener keeps retrying |
| `WEBHOOK_UNREACHABLE` | The webhook can't be reached. The listener keeps retrying |
| `ALREADY_RUNNING` | A listener already runs there |
| `INSTALL_FAILED` | `t3listen install` couldn't register the autostart. Relay the message |
| `HASH_MISMATCH`, `MANIFEST_MISMATCH`, `BAD_MANIFEST` | A file or manifest didn't match the pinned release, or `t3ctl skills install` found no `manifest.json` to check. Install nothing and tell the user |
| `REPO_PRIVATE_OR_MISSING` | The box can't download the release. Use t3-install-tools "Private repo" |
| `DOWNLOAD_FAILED`, `MISSING_IN_FROM`, `NO_BOX_COPY` | The download failed, the `--from` folder lacks a file, or the box copy is missing. Nothing was installed |
| `NO_SKILLS_SOURCE` | `t3ctl skills` found no skills. Pass `--from <repo checkout or unpacked release>` |
| `NO_SKILLS`, `SYNC_BLOCKED` | Repo checks: `scripts/sync-skills` needs a source folder (`--from` or `T3TOTS_SKILLS_SRC`), or it found a private detail or bad frontmatter and copied nothing |
| `NO_PRIVATE_WORDS` | Repo checks: no private-word list, so `scripts/check.sh` fails. Add one (see `scripts/scan-private.py`) or set `T3TOTS_NO_PRIVATE_WORDS=1` to skip it on purpose |
| `MANIFEST_STALE`, `UNLISTED_TOOL` | Repo checks: a file changed without `scripts/make-manifest.py`, or a new tool isn't listed in it |

The T3 CLI is `~/.t3/bin/t3` (Windows `%USERPROFILE%\.t3\bin\t3.cmd`, or under `T3CODE_HOME/bin`). T3 Code writes it when the app starts.

## Token
The token gives write access to T3. Issue or reissue it only after the user's yes. Run from the tools folder, never echo it, and write it straight to the file:
- macOS and Linux: `(umask 077; ~/.t3/bin/t3 auth session issue --scope orchestration:read --scope orchestration:operate --ttl 90d --label t3-tots --subject t3-tots --token-only > token)`
- Windows PowerShell: `& "$env:USERPROFILE\.t3\bin\t3.cmd" auth session issue --scope orchestration:read --scope orchestration:operate --ttl 90d --label t3-tots --subject t3-tots --token-only | Out-File -Encoding ascii token; icacls token /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null`. Plain `>` in Windows PowerShell writes UTF-16 and breaks the token.

Check the token only by running `t3ctl projects`. Record the issue date and the 90-day expiry in `README.md`, with how to revoke it: `t3 auth session list`, then `t3 auth session revoke <id>`.

## Opt-in features
Digests, the recurring cleanup scan, stale-thread lists, watches and phone answers run only after the user turns them on. Leave out usage and cost figures unless the user asks (t3-usage). The shipped routines (t3-getting-started section 6) stay paused until the user turns them on. Turning one on counts as asking for what it reports. To turn one on, resume the shipped routine and update the "Routines on" memory note. Never create a duplicate.

## Memory
- Save decisions, modes and preferences, not activity. A check where nothing changed is not worth a memory entry or a journal line.
- Keep personal facts (names, machines, projects, model picks) in the user's memory, never in a skill.
- When the user corrects you, save the correction in their memory so it holds next time.
- A follow-up you promise for later ("I'll check when the run ends") goes into a watch or a routine, not only into memory, so it happens.

## Output
- Give times in the user's timezone with a label, sizes in decimal GB, and home paths shortened to `~`.
- Answer first, in short plain words. Say what you couldn't check.
- Send one message per event. If a watch and t3listen both report the same finish, say it once.
- Send files with SendToUser rather than pasting them. Pass `box_path` to CopyToBox when the file must land somewhere other than uploads.
- Don't present the user's own rules back to them as blockers. Follow the rule and say what you did.
- Grok Bot: when you start a cloud agent, leave fast mode off.
