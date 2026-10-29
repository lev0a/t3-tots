# AGENTS.md: installing and verifying T3 Tots

Non-Grok agents follow this file to install and verify. For Grok Bot only steps, do what `skills/t3-tots-rules/SKILL.md` "Grok Bot only" says instead. The skills are in `skills/`; follow `skills/t3-tots-rules/SKILL.md` throughout.

## Rules
- Install only after the user's yes. Never print, copy or overwrite the `token` file or `listen.json` (it holds the user's webhook URL and key), and never open T3 Code's `secrets/` or any auth, token or credential file.
- Who may answer a thread's question or approval (`t3ctl answer`), and when delegated mode applies: `skills/t3-tots-rules/SKILL.md`, "Decisions".
- Install from a **tag**, never from `main`: a release, a checkout of the tag, or `https://raw.githubusercontent.com/Deepusleepy/t3-tots/<tag>/<path>`. Download the release with `gh release download <tag> -R Deepusleepy/t3-tots --archive tar.gz`, or one file with `gh api "repos/Deepusleepy/t3-tots/contents/<path>?ref=<tag>" -H "Accept: application/vnd.github.raw"`.
- Check every file's SHA-256 against `manifest.json` from the same tag **before** moving it into place. On any mismatch install nothing and report `HASH_MISMATCH <path>`.
- Files are stored byte-exact (`.gitattributes`: `* -text`). The `.cmd` wrappers have CRLF line endings on purpose.

## Tools
Tools folder: `~/t3-tots` (Windows `%USERPROFILE%\t3-tots`) unless the user picked another one. It is flat: copy each `manifest.json` entry with `"kind": "tool"` whose `targets` include the computer's OS from its repo `path` to `<tools folder>/<dest>`. For example `tools/t3ctl` goes to `t3ctl`, `tools/windows/t3ctl.cmd` to `t3ctl.cmd`, `tools/cleanup/scan.py` to `cleanup/scan.py`.

| Target | Installed files |
|---|---|
| macOS | `t3q.py`, `t3ctl`, `t3listen`, `t3inbox.js`, `export.js`, `survey.js`, `cleanup/scan.py`, `t3ui`, `ui-dump.applescript`, `ui-menuitem.applescript`, `ui-model.applescript`, `ui-press.applescript`, `ui-type.applescript` |
| Linux | `t3q.py`, `t3ctl`, `t3listen`, `t3inbox.js`, `export.js`, `survey.js`, `cleanup/scan.py` |
| Windows | `t3q.py`, `t3ctl`, `t3ctl.cmd`, `t3listen`, `t3listen.cmd`, `t3inbox.js`, `export.js`, `survey.js`, `cleanup/scan.py` |

Then run `chmod +x t3ctl t3listen` on macOS and Linux (on macOS also `chmod +x t3ui`), and put the release's `manifest.json` and the tag (in `VERSION`) in the tools folder. Never touch the `token`, `listen.json` or other data files already there.

Hash each installed file and compare with its manifest `sha256`: macOS `shasum -a 256 <file>`, Linux `sha256sum <file>`, Windows `(Get-FileHash -Algorithm SHA256 <file>).Hash.ToLower()`. Then, from the tools folder:
- `python3 t3q.py health` (Windows `py -3 t3q.py health`) prints the T3 server state, or `NO_T3_DATA`.
- `node t3ctl` with no arguments prints usage; `node t3ctl projects` needs the token.
- `node t3listen --dry-run --once --timeout 5` connects and prints any open questions (exit 2 = none). Don't run `t3listen install` unless the user asked for phone answers and `listen.json` exists.

## Skills
From the repo checkout or unpacked release: `node tools/t3ctl skills install --to <the agent's skills folder> --dry-run`, then without `--dry-run` after the user's yes (folders per agent are in the README). It checks every file against `manifest.json`, installs only missing or changed skills, and keeps skills the user edited unless `--force`.

## Status words
The scripts print status words instead of stack traces. What each means and the next step: `skills/t3-tots-rules/SKILL.md`, "Status words".

## Updating
Check the latest release (`gh release view -R Deepusleepy/t3-tots`). If its tag is newer than the installed `VERSION`, show the user the release notes and which files changed (compare the two `manifest.json` files), and update only after their yes: tools as above, then `t3ctl skills install` again. If `t3listen` runs on that computer (`node t3listen status`), run `node t3listen install` again so it restarts on the new version. Add `--approvals` only if `node t3listen status` said "installed with --approvals" before the update; `listen.json` is kept. The listener also sends approvals when `listen.json` has `"approvals": true`, and reinstalling doesn't change that.
