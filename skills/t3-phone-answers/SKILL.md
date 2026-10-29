---
name: t3-phone-answers
description: >-
  Answer T3 Code thread questions from this chat (e.g. on the phone): set up the
  t3listen listener and the "T3 questions to chat" webhook routine, show each new
  question as tap-to-answer options, and answer it in T3 as t3-tots-rules "Decisions" allows.
  Use for "phone answers", "tell me when a thread asks something", runs of that
  routine, and pausing or removing it.
---
Follow the t3-tots-rules skill (skills/t3-tots-rules/SKILL.md). Steps that use the box, ListMachines, routines, cards or SendToUser are Grok Bot only; other agents follow t3-tots-rules "Grok Bot only". Its "Decisions" section says who may answer. Phone answers need the token (t3-tots-rules "Token") and tools v1.4.0 or later (t3-install-tools).

## How it works
`t3listen` runs on each computer, follows T3's live event stream (no polling) and POSTs JSON to the routine's webhook:
- `request.opened`: `machine`, `threadId`, `title`, `project`, `requestId`, `kind` (`user_input`, or an approval kind if approvals are on), `createdAt`, `answerable`, `context` (up to 400 characters of what the thread said just before asking, or `Task: <its prompt>` if it said nothing; may be missing), `text` (a ready summary), and either `questions` [{`id`, `header`, `question`, `options` [{`label`, `description`, `value`?}], `multiSelect`, `allowCustomAnswer`, `required`}] or `approval` {`requestKind`, `prompt`, `options` [{`decision`, `label`, `warning`?}]}. A `user_input` event also has `inboxItemId` when the listener wrote an inbox item on that computer. Approvals do not get an inbox item. API-key patterns and the home path are redacted in every text field, including questions, option labels and approval prompts.
- `request.resolved`: the same ids plus `status` (`resolved`, `cancelled`, `expired`, `archived`, `deleted`, `archived-or-deleted`, `gone`), `answeredHere`, and `answers` or `decision` when T3 has them. A resolved `user_input` also has `inboxItemId` when an inbox item exists. It fires when the question is answered anywhere (in T3 too), cancelled or expired, including changes made while the listener was off. `answeredHere` is `true` when it was answered with `t3ctl answer` or `t3ctl inbox answer` on that computer, i.e. from this chat. `t3ctl` records a short hash of the request id in `answered-here.json` in the tools folder before responding, and keeps it for 7 days. The listener closes the inbox item when the request is no longer pending. If this chat did not answer it, the close reason is `answered-in-t3`.
- `thread.finished` / `thread.cancelled` / `thread.failed` (`kind` `thread-finished|thread-cancelled|thread-failed`): `machine`, `threadId`, `title`, `project`, `delegated`, `runId`, `status`, `threadStatus`, `startedAt`, `completedAt`, `completedAtLocal`, `durationSec`, `lastReply` (up to 600 characters, redacted), `error` (failed only), `text`, `eventId`; for a usage-limit stop also `usageLimit: true`, `autoResumeSet`, `resumeAt`/`resumeAtLocal`, or `autoResumeNote` when it wasn't armed (still present when catch-up finds the failed run on a thread that is already busy, because Resume at reset can't be armed then). Finished and cancelled fire only when the thread is left idle (a queued message starting next doesn't count); failed always fires. Sub-task threads (`thread:delegated-task:`) arrive only when they fail. Each run is reported once (kept in `listen-state.json`); after a restart it reports runs that ended while it was down, including a failed run on a thread that is already busy again. Catch-up uses the last time the listener was connected, so a long outage is not clipped. `node t3listen preview-finish --thread <id>` prints the event without sending it.
- `test`: sent by `t3listen test`.
At startup, questions older than `skipStaleMinutes` (default 1440) are skipped. A delivered question is never sent twice. One the webhook refused is retried every minute (rate limits, network errors and 5xx for up to 24h, other 4xx 10 times) and resent when the listener restarts.

## Setup (opt-in, after the user's yes)
1. Create a routine named **T3 questions to chat** with a webhook trigger (UpdateRoutine) and exactly the prompt under "Routine prompt" below. You never see its key: the user copies the URL and the Authorization header from the routine panel, so link both with the panel's Webhook URL and Authorization header links.
2. Pick the computers (default: every connected computer with a token). The `--machine` label is the computer's ListMachines label. After the user's yes, open a visible window on each computer with setup already running, so the user only pastes two lines. The key never passes through chat or your tools:
   - macOS (via Shell on that machine; the folder and label go in as arguments after `--`, never inside the AppleScript source; `quoted form of` then shell-quotes them for `do script`. `$`, backticks and `\` still expand inside double quotes, so prefer single quotes or escape those too. Escape `\"` inside those double quotes, or `'\''` inside single quotes): `osascript -e 'on run argv' -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "cd " & quoted form of (item 1 of argv) & " && node t3listen setup --machine " & quoted form of (item 2 of argv)' -e 'end run' -- "<tools folder>" "<label>"`
   - Windows (via Shell on that machine; double any `'` in the folder or label): `Start-Process powershell -ArgumentList '-NoExit','-Command',"cd '<tools folder>'; node t3listen setup --machine '<label>'"`
   - Linux: give the user `cd '<tools folder>' && node t3listen setup --machine '<label>'` to run.
   The window shows "Line 1: Webhook URL starting https://" and "Line 2: Authorization header starting Authorization:". Tell the user the same thing in one short message. Setup finishes on its own after the Authorization line and prints `saved listen.json`. A wrong paste does no harm: open setup again and it replaces the old values. Never read, print or copy `listen.json`.
3. `node t3listen test` must print `OK`, and the routine must receive a `test` event. Then `node t3listen install`, which starts it at login: a LaunchAgent on macOS, a hidden logon task on Windows (or a Startup shortcut if Task Scheduler refuses), a systemd user unit on Linux. `node t3listen status` should show `running: yes`.
4. Tell the user it's on and that they can answer either here or in T3. Save to memory: phone answers on, the computers, approvals off.

## Routine prompt
Use this text verbatim for the routine. The details live in "On an event", so changes there don't need a new prompt:

> A T3 Tots listener on one of the user's computers POSTed a T3 Code event to this webhook. Follow t3-phone-answers "On an event" and t3-tots-rules.

## On an event (routine runs)
Anything for the user goes to the main chat as a hand-off, with `machine`, `threadId`, `requestId` and the question ids.
- `test`: nothing unless setup is in progress, then one line: "Phone answers are connected on <machine>."
- `request.opened` with `questions`, in the main chat:
  1. One short briefing message first: what the thread is doing and what it's asking about, in one or two sentences built from `title`, `project`, `machine` and `context`. Don't list the questions or options in it, and don't recommend anything.
  2. Then each question as its own card, one at a time, in order (the next one after the user answers). Use the option labels exactly, put each option's description in the card if it fits, allow multiple choices if `multiSelect`, and add a typed-answer choice only if `allowCustomAnswer`. Nothing is pre-selected.
  3. Keep each pick (for each question `id`: its label, list of labels, or typed text). When every required question has an answer, submit them all at once (see "Answering"). Several events that arrive together: explain them together, then cards per thread.
- In delegated mode, answer questions as t3-tots-rules "Decisions" allows, with `t3ctl answer` instead of cards, and tell the user after in one line what you picked and why. Decline approvals with `--redirect` as "Decisions" says, and tell the user in one line what was declined and why it asked.
- `request.opened` with `approval` (only when the user turned approvals on): show the prompt, its reason ("why it asks") and the options verbatim, warnings included. Otherwise stay quiet.
- `answerable: false` or no questions: tell the user to answer it in T3.
- `request.resolved`: if `answeredHere` is true, stay quiet. Otherwise, if it's still unanswered here, say in one line that it closed ("answered in T3: Blue", "cancelled", "expired") and drop any remaining cards for it.
- `thread.finished` / `thread.cancelled` / `thread.failed`: in the main chat, skip it if a watch already reported this run. Otherwise check the result and take the next step the user already asked for (a review, follow-up or watch); otherwise tell them in a line or two what finished and what it said. A cancelled run the user didn't stop: say so and offer to continue it. A `thread.failed` with `usageLimit` and `autoResumeSet`: one line that it continues at `resumeAtLocal`, nothing else; with `usageLimit` but not set: offer `t3ctl resume-at-reset`, or run it in delegated mode.
- Malformed or unknown events: send nothing.

## Inbox
Inbox commands need tools v1.5.0 or later. Each computer keeps its own inbox in `~/.t3-inbox`. The item's `machine` is the computer the answer command must run on. Setup for Linux/WSL (systemd user unit) and macOS (LaunchAgent), and how to register `t3ctl inbox mcp` in Claude Code and Codex, is in the repo README under "T3 inbox".

When an event has `inboxItemId`, answer with `t3ctl inbox answer` on that computer, not with a second copy of the question. `--from owner` only, and only for the user's own words (`NOT_OWNER` sends nothing). `--pick` uses letters in option order (`8:A,9:A+B`). `--via` is `room`, `dm` or `terminal`, and `--ref` is the chat message you are answering from. If the T3 request is still pending, the thread is answered. If the request is gone and the thread remains, the answer is queued. `ALREADY_CLOSED` means it was already answered: say the reason (`answered-in-t3` when they answered in T3) and do not submit again. `REQUEST_GONE` means the thread is gone: tell the user it could not be delivered.

`node t3ctl inbox list --due` lists unanswered items open for 4 hours or more. Remind the user once. Then `node t3ctl inbox remind --item '<id>'`, which sends nothing, so the next `--due` leaves it out. Do not post the reminder from the tool itself. After you post the question to a room, record it with `node t3ctl inbox posted --item '<id>' --destination '<room or dm>' --ref '<message ref>'` so a restart does not post it twice. `routes.json` in the inbox folder names the room. A missing route means `dm`.

The older `t3ctl answer` command still answers a pending question. The listener then closes the inbox item. Prefer `inbox answer` when `inboxItemId` is present, because it re-checks T3 first.

## Answering
When the user has picked, on the computer whose ListMachines label matches `machine` (ask if none matches), from the tools folder. If the event has `inboxItemId`, use "Inbox" above. Otherwise:
- One question: `node t3ctl answer --thread '<threadId>' --request '<requestId>' --pick '<exact label>'`. For typed words use `--text '<their words>'`.
- Several questions (one request) or multi-select: once all are answered, one call: `--answers '{"<question id>": "<label>", "<other id>": ["<label>", "<label>"], "<typed id>": "<their words>"}'`. Typed text goes in as the value for questions with `allowCustomAnswer`.
- Approval: after the user's yes for that request, `--decision <accept option> --user-approved`. For their no, `--decision decline`. Without `--user-approved`, t3ctl accepts nothing and prints `NEEDS_USER_APPROVAL` (t3-tots-rules "Decisions").
Success prints `answered "<title>": ... (request resolved)`; confirm in one line. `NOT_PENDING` means it was already answered or closed, so say so. `NOT_ANSWERABLE` means the run ended, so offer a follow-up (`t3ctl send`) instead. An option error means the label didn't match, so show the options again. In the default mode, never answer without the user's pick, never reuse an earlier pick for a new question, and never answer a question the user didn't see. In delegated mode, answer as t3-tots-rules "Decisions" allows and tell the user what you picked.

After a successful answer, t3ctl lists any other requests still open in that thread. Deal with them, or tell the user to clear them in T3.

## Status, pause, off
- `node t3listen status`: autostart, running, how many open questions were sent, and the last log lines (`listen.log` in the tools folder).
- Approvals: the listener sends them when `listen.json` has `"approvals": true` or the service was installed with `--approvals`, and `node t3listen status` says which. Turn them on only when the user explicitly asks: `node t3listen install --approvals`. `node t3listen install` drops the flag again; if status still says `listen.json`, the user turns it off in that file.
- Pause one computer: `node t3listen uninstall` (keeps `listen.json`). Turn off completely: uninstall on each computer, then with a yes delete `listen.json` there and delete the routine.
- `listen.log` and `WEBHOOK_REJECTED` include the webhook's reply, with the URL and key redacted. HTTP 401/403 means the routine's key changed, so redo setup step 2. A rate-limit reply (even as HTTP 400, e.g. "Automation run rate limit exceeded") comes from the routine platform. The listener keeps retrying, so tell the user the question may arrive late. `TOKEN_REJECTED` means reissuing the token (t3-tots-rules "Token"); the listener picks it up within 5 minutes.
