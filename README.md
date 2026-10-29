# T3 Tots

Grok Bot / chat companion for [T3 Code](https://github.com/pingdotgg/t3code), with skills and helper tools. Thread status, waiting items, new threads, answers, reports, watches, and updates.

T3 Tots is unofficial. `t3ctl` and `t3listen` use T3 Code's internal local websocket API, which isn't public or stable, and `t3q.py` reads its database read-only. A T3 Code update can break them. T3 Tots will move to the official API when T3 ships one.

[MIT](LICENSE). No accounts or telemetry. The only outbound send is optional `t3listen` to a webhook you set up.

Start with [t3-getting-started](skills/t3-getting-started/SKILL.md). Install and verify by following [AGENTS.md](AGENTS.md). Shared rules: [t3-tots-rules](skills/t3-tots-rules/SKILL.md).

## What's here

| Path | What it is |
|---|---|
| `skills/` | One folder per skill. |
| `tools/` | Scripts, installed flat into one folder per computer. |
| `manifest.json` | Version, dest path, size, SHA-256, and which OS gets each file. |
| `scripts/`, `tests/` | Checks, manifest builder, skill sync. |
| `assets/avatar.png` | Official face, 1024x1024 PNG. First setup downloads it from the pinned release. |

| Tool | Where | What |
|---|---|---|
| `t3q.py` | all | Read-only T3 DB queries. No token. |
| `t3ctl` | all | Local API client and `skills` installer. `node t3ctl` prints usage. |
| `t3listen` | all | Optional. Pushes questions and run ends to your webhook. |
| `t3inbox.js` | all | Local inbox store. `t3ctl` and `t3listen` load it. Not run on its own. |
| `export.js`, `survey.js` | all | Redacted export and activity survey. |
| `t3ui` + `ui-*.applescript` | macOS | UI fallback if the local API is down (needs Accessibility). |
| `cleanup/scan.py` | all | Read-only disk-usage scan. |
| `cleanup/make_report.py`, `report/report.py` | Grok Bot box | HTML cleanup report and briefing. |
| `t3ctl.cmd`, `t3listen.cmd` | Windows | `cmd` wrappers. From PowerShell use `node t3ctl`. |

## Install

Install from a release tag, not from `main`. Every file is checked against that tag's `manifest.json` before it is used.

**Grok Bot.** Skills are built in. Say "set up T3 Tots". After your yes it installs the tools on each computer. The template card uses a geometric mark. First setup sets the official face from [`assets/avatar.png`](assets/avatar.png) when that download works.

**Other agents** (Claude Code, Codex, Cursor, Hermes). Download a release or clone the tag, then install the skills:

```sh
gh release download -R Deepusleepy/t3-tots --archive tar.gz
tar xzf t3-tots-*.tar.gz && cd t3-tots-*/
node tools/t3ctl skills install --to ~/.claude/skills --dry-run
node tools/t3ctl skills install --to ~/.claude/skills
```

Clone the same tag:

```sh
git clone --branch <tag> --depth 1 https://github.com/Deepusleepy/t3-tots.git
cd t3-tots
node tools/t3ctl skills install --to ~/.claude/skills --dry-run
node tools/t3ctl skills install --to ~/.claude/skills
```

Windows: `gh release download -R Deepusleepy/t3-tots --archive zip`, expand, then `--to "$env:USERPROFILE\.claude\skills"`.

Skill folders: Claude Code `~/.claude/skills`, Codex `~/.agents/skills`, Cursor `~/.cursor/skills`, Hermes `~/.hermes/skills` (same paths under `%USERPROFILE%` on Windows). Install into one folder only. Cursor also loads the other three, so a second copy is listed twice.

Then ask the agent to set up T3 Tots. It follows [AGENTS.md](AGENTS.md) (hash-check against `manifest.json`. Grok Bot-only steps: `t3-tots-rules` "Grok Bot only"). Updates use the same commands. Edited skills are kept unless you pass `--force` (the old copy goes to `out/skills-backup/<timestamp>/`).

## Phone answers (optional)

`t3listen` POSTs live T3 events to a webhook you set up (`setup`, then `install` at login). Events: `request.opened` / `request.resolved`, and `thread.finished` / `failed` / `cancelled`. Approvals only if you turn them on. Usage-limit stops can arm T3's Resume at reset.

Setup, events, approvals, and autoresume: [t3-phone-answers](skills/t3-phone-answers/SKILL.md). Who may answer: [t3-tots-rules "Decisions"](skills/t3-tots-rules/SKILL.md).

## T3 inbox

One local list of open questions on each computer. The desktop (T3 Code in WSL, tools in `~/t3-tots`, listener as a systemd user unit) and the MacBook (macOS, including Intel, tools in `~/t3-tots`, listener as a LaunchAgent) each keep their own store in `~/.t3-inbox`. Every item has a `machine` label, the same name passed to `t3listen setup --machine`, so a chat can send the answer back to that computer. Approvals are not inbox items. They stay on `t3ctl answer`.

`t3listen` appends an item when a thread asks a `user_input` question, then sends the webhook it already sends, with `inboxItemId` added. The item id is `t3:<machine>:<request id>`, so a listener restart or a retried webhook does not create a second item. When the question is answered in T3, the item closes. `items.jsonl` is append-only. `state.json` is a cache rebuilt from that log and is safe to delete.

`~/.t3-inbox/routes.json` maps a project slug to a room name, or to `dm`. Edit it by hand:

```json
{
  "anesthassist": "AnesthAssist",
  "readyrt": "ReadyRT",
  "vibe-tutor": "dm",
  "_none": "dm"
}
```

A slug is the project name in lower case, with spaces turned into hyphens. A project with no route, and a thread with no project (`_none`), uses `dm`. These tools do not post into a room. After the chat posts an item, record that post so a restart does not post it twice:

```sh
node t3ctl inbox posted --item '<id>' --destination 'AnesthAssist' --ref '<message ref>'
```

From the tools folder on the computer named by `machine`:

```sh
node t3ctl inbox list --json
node t3ctl inbox list --due
node t3ctl inbox answer --item '<id>' --pick '8:A,9:B' --from owner --via room --ref '<message ref>'
```

`--from owner` is required, and only when the words are the owner's own. Any other value is `NOT_OWNER` and nothing is sent. Letters are A, B, C in option order. A multi-select answer is `9:A+B`. `--text` is for one free-text question. Several questions can also go in `--answers` as JSON keyed by question key.

`inbox answer` reads the live T3 request before it acts. If that request is still pending, it answers it (`runtime-request.respond`), the same path as `t3ctl answer`. If the request is gone and the thread is still there, it sends a turn the way `t3ctl send --queue` does (queued behind a running turn, or started when the thread is idle). If the thread is gone, it prints `REQUEST_GONE`, saves the answer, and closes the item. If the item is already closed, it prints `ALREADY_CLOSED` and the reason. `answered-in-t3` means it was answered in T3. Say so, and do not submit it again.

An unanswered item is due after 4 hours. `node t3ctl inbox list --due` lists those. It sends nothing. After one reminder, `node t3ctl inbox remind --item '<id>'` records it so it leaves the due list. That command sends nothing either.

### Linux and WSL

Install from a release tag into `~/t3-tots` (see Install). On WSL the store is the Linux home, `~/.t3-inbox`, not the Windows home. The listener has to be the same Linux user that runs T3 Code. Set the machine label, then install the user service:

```sh
cd ~/t3-tots
node t3listen setup --machine '<ListMachines label>'
node t3listen install
node t3listen status
```

`install` writes a systemd user unit (`~/.config/systemd/user/t3tots-listen.service`) and starts it. After an update, run `node t3listen install` again so the running listener loads the inbox. `status` should show `running: yes`. The webhook URL stays in `listen.json`. Do not print that file.

### macOS

Same folder, `~/t3-tots`, and the same store, `~/.t3-inbox`. Autostart is a LaunchAgent, on Intel and Apple silicon:

```sh
cd ~/t3-tots
node t3listen setup --machine '<ListMachines label>'
node t3listen install
node t3listen status
```

`install` writes `~/Library/LaunchAgents/com.t3tots.listen.plist` and starts it at login. Run `install` again after an update.

Set `T3_INBOX_MACHINE` to that same label for the MCP server below. The listener also writes the label to `~/.t3-inbox/machine` when it opens an item, and a later MCP process uses that file when the env var is unset. Set the env var before the first post so the label is right from the start.

### MCP server (Claude Code and Codex inside a T3 thread)

`node t3ctl inbox mcp` is a stdio server. It does not open a window and it does not need the webhook. Two tools:

- `send_message` posts a markdown body. Use `:::question` for one choice, `:::question-multi` for several, and `:::question-text` for free text. `Recommended:` and `Stakes:` lines are kept. Pass `thread` as the T3 thread id (not a Codex session id) and, when you know it, `project`. `idempotency_key` makes a retry return the first item.
- `read_thread` reports whether those questions have been answered. Pass `item_id` or `thread`.

A question posted this way is not a pending T3 user-input request. The answer comes back as a queued turn in that T3 thread. The turn starts with `T3 Inbox: <subject> (<item id>)`. `:::action` blocks are refused.

Register it once on that computer. Use the absolute path of `t3ctl`. A session that is already open does not see a server added during the session.

Claude Code, from a terminal on that computer:

```sh
claude mcp add --scope user t3-inbox -- node "$HOME/t3-tots/t3ctl" inbox mcp
```

To set the machine label, add `env` on the same server in `~/.claude.json`:

```json
{
  "mcpServers": {
    "t3-inbox": {
      "command": "node",
      "args": ["/home/USER/t3-tots/t3ctl", "inbox", "mcp"],
      "env": { "T3_INBOX_MACHINE": "desktop" }
    }
  }
}
```

Use the Mac home (`/Users/USER/...`) and that Mac's label on the MacBook. Quit Claude Code and start a new session.

Codex:

```sh
codex mcp add t3-inbox -- node "$HOME/t3-tots/t3ctl" inbox mcp
```

Then set the label in `~/.codex/config.toml`:

```toml
[mcp_servers.t3-inbox]
command = "node"
args = ["/Users/USER/t3-tots/t3ctl", "inbox", "mcp"]

[mcp_servers.t3-inbox.env]
T3_INBOX_MACHINE = "macbook"
```

Restart Codex. Inside the thread, pass the T3 thread id as `thread`. Do not pass `CODEX_THREAD_ID`.

## Delegated mode and approvals

Delegated mode starts only when you hand over control, for example "I'm away, keep it moving". The agent then answers routine questions, nudges stalled threads, and resumes threads after a usage limit.

Even a full-access thread can stop on "Allow running this command?" when a safety check flags it, for example a git hook that asks before `git reset --hard`. In delegated mode the agent never says yes to these. It declines them with `t3ctl answer --decision decline --redirect`, which tells the thread not to retry or work around it, to use a safer way or skip that step, and to keep going. You get the list of what was declined and why when you're back.

When you're around, each approval comes to you as a card with the reason it asks, and the agent accepts it only after your yes for that request. `t3ctl answer` backs this up. An accept without `--user-approved` is refused with `NEEDS_USER_APPROVAL`, and nothing is sent.

Threads that `t3ctl new` and `t3ctl tasks --upsert` start run in full access unless you pass `--runtime`.

## Requirements

- **Python 3.8+** for `t3q.py` and `cleanup/scan.py` (3.9+ for `report/report.py`). Windows: `py -3`.
- **Node 22+** for `t3ctl` and `t3listen` (Node 18+ for `export.js` and `survey.js`).
- **T3 Code** installed and opened at least once.

## Security

- `t3q.py` opens `statev2.sqlite` read-only. From `server-runtime.json` it reads only `host`, `port` and `pid`.
- Scripts never open T3's `secrets/` or other credentials. The only token they read sits next to them, after your yes, with a 90-day TTL, and is never printed. Issue and revoke: [t3-tots-rules "Token"](skills/t3-tots-rules/SKILL.md).
- Traffic stays on `127.0.0.1` except optional `t3listen` POSTs to your webhook. Exports redact API-key patterns and your home path.
- No token: read-only. With one, `t3ctl answer` sends only the answer you chose, and accepts an approval only with `--user-approved`. `t3ctl skills` writes only into `--to` and its own `out/`.

Report issues in [SECURITY.md](SECURITY.md).

## Developing

- `scripts/check.sh`. Syntax, tests, manifest freshness, CRLF on the Windows wrappers, private-word scan. Never-ship words go one per line in `~/.config/t3-tots/private-words.txt` (do not commit it). No list fails the check. `T3TOTS_NO_PRIVATE_WORDS=1` skips it on purpose.
- After changing a tool, add it to `TOOLS` in `scripts/make-manifest.py` and run that script. It rewrites `manifest.json` from `VERSION`.
- `scripts/sync-skills --from <folder>` (or `T3TOTS_SKILLS_SRC`) copies live skills into `skills/`, scans for private details, and updates the manifest. It copies nothing if the scan fails.
- Never decide an approval by reading its text. T3 often shows a description instead of the command. Approval decisions go through `approvalAuthority`.
- Release only from a tag. Installers download by tag and check every hash.
