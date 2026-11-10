# agent-review-bridge

**AI agents review each other's work: Claude Code ↔ ChatGPT Desktop, in their own desktop apps, through your own subscriptions, with no API keys.**

agent-review-bridge connects a chat in the Code tab of Claude Desktop with a chat in ChatGPT Desktop. One chat writes the code; the other reviews it, either after every turn or when asked. Two chats of the same app can pair up too (joined with a code), for a second model or a fresh context. Both are ordinary chats in the official apps, using your own subscriptions: no model APIs and no API keys. Either app can take either role, and you can read both sides of the conversation in the chats themselves.

It is built and tested with the desktop apps. The Claude Code CLI uses the same setup (MCP server and hooks) but hasn't been tested yet; the Codex CLI isn't supported yet.

> **Status: alpha.** Reviews work end to end on Windows in both directions. On macOS, Claude Code reviewed by ChatGPT works; ChatGPT reviewed by Claude hasn't been tried on a Mac yet. Opening a closed app for you (see below) is tested only with simulated apps so far.
>
> The ChatGPT side relies on undocumented parts of the app (its bundled `codex app-server` experimental API and the `codex://threads/wake` link), so an app update can break it. The code you work on is sent to the other vendor's chat.

## Contents

Using agent-review-bridge:

- [What it does](#what-it-does)
- [Install](#install)
- [Use it](#use-it)
- [How reviews work](#how-reviews-work)
- [Auto mode](#auto-mode)
- [Your rules](#your-rules)
- [When the other side is closed](#when-the-other-side-is-closed)
- [Privacy and safety](#privacy-and-safety)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

Reference, for agents and contributors:

- [Tools](#tools)
- [How it works](#how-it-works)
- [Development](#development)

## What it does

| Mode | What happens | Use it for |
|---|---|---|
| **One-off review** | Your chat asks the other app once; the reviewer reads the changes from your folders itself. Follow-up rounds go to the same reviewer. | A finished change, a tricky fix, a commit you're unsure about. |
| **Plan review** | A one-off review of a plan before anything is built. Afterwards your agent shows you the plan and the verdict, and waits for your approval. | Design decisions, larger changes. |
| **Auto mode** | Your agent works with a chat in the other app (or, joined with a code, another chat of the same app) as its reviewer throughout: it asks for reviews itself at the moments that matter, always in the same reviewer chat, and doesn't move past them without approval. | Any longer piece of work where you want a second model to check each real step, without reviewing every small one. |
| **Auto mode, every turn** | The same reviewer chat, but the bridge sends it every turn of your chat on its own: what you asked, the answer, and a summary of that turn's changes with the command that shows them. Only "changes requested" interrupts the agent. | Longer work where you want a second opinion on each step. |

Every answer starts with **`[APPROVED]`** or **`[CHANGES REQUESTED]`**. On changes requested, the agent that wrote the code fixes what holds up, pushes back where it disagrees, and asks again until it is approved, or stops and asks you when it is going in circles.

## Install

Requirements: Node.js 22 or newer, git, and both desktop apps, signed in: Claude Desktop with its Code tab, and ChatGPT Desktop with its Codex-based coding chats.

1. Get the code and install it:

   ```bash
   git clone https://github.com/tolgaertunc/agent-review-bridge.git
   cd agent-review-bridge
   npm install
   node scripts/install.mjs
   ```

   The installer registers the bridge's MCP server in both apps, adds its hooks, and allows the bridge's own tools without approval prompts (a woken chat can't wait for a click). It backs up every file it changes and leaves your other settings and hooks alone. The hooks point at this folder, so re-run it if you move the folder. If it can't find the Claude Code CLI, it prints the command to register the server by hand (or set `AGENT_REVIEW_BRIDGE_CLAUDE_BIN`).

2. Restart both apps. Restart ChatGPT Desktop normally, with its window open: it reads hooks only at startup, and it silently skips a new or changed hook until it trusts it.

3. Check the setup:

   ```bash
   npm run doctor
   ```

   `doctor` doesn't change your app settings. It checks Node and git, the broker, the MCP registration and every hook on both sides (including whether ChatGPT trusts them), your settings, and active links, and prints a fix for each problem.

To remove it: `node scripts/install.mjs --uninstall`.

## Use it

You talk to your agent as usual and ask it to use the bridge; it calls the bridge's tools. For example, in Claude Code:

- *"Ask ChatGPT to review this change."* A new ChatGPT chat reviews your uncommitted changes and the answer comes back as a new turn.
- *"Get the plan reviewed by ChatGPT before you start."* A plan review: Claude shows you the reviewed plan and waits for your go-ahead.
- *"Work with GPT on this"* or *"auto mode on"*: auto mode (see below). From ChatGPT: *"work with Claude on this"*.
- *"Auto mode, every turn."* From now on every turn is reviewed (see [Every turn](#every-turn)).
- *"Use the same ChatGPT chat as last time."* The review continues in that chat, with its earlier context.
- *"Stop the reviews."* The agent turns auto mode off (its turns' reviews still open close with it) and closes any other review still open (`bridge_unlink`). A review not handed to the reviewer yet is never sent; an answer to one that was is refused.
- *"Read my ChatGPT chat 'Release checklist'."* The agent finds the chat on this computer by its name, however old it is, and reads it. No link and no review are needed, and ChatGPT Desktop can be closed. Each app reads the other's chats; for its own it uses its own tools, if it has them. If you don't say which app a chat is in, the agent asks.

You can pick the model and reasoning effort of a new ChatGPT chat ("…with gpt-6.1-sol, high effort"). The bridge checks the name against the models your ChatGPT Desktop offers; an unknown one is refused with the list, and nothing is created.

From ChatGPT, or to use an existing chat of either app as the reviewer, ask for a **join code** and paste it into the other chat: *"join the agent-review-bridge link with code 3fa9c1"*. The reviewer can be in the same app, for a second model or a fresh context: from Claude, *"auto mode, with another Claude chat as the reviewer"* gives a code for any chat; from ChatGPT, another ChatGPT chat can take the code auto mode gives.

Open the ChatGPT chat at any time to read the whole exchange: requests arrive starting with `CLAUDE:`, and the reviewer writes its answer there too.

## How reviews work

**Answers.** A reviewer answers with a decision, a short note, must-fix items, and nits:

```text
[CHANGES REQUESTED]

The empty list case breaks the page.

Must fix:
- prices=[] throws in reduce (price.js:3): handle the empty list first.

Nits (optional, don't block approval):
- Name the function averagePriceCents.
```

An approval with must-fix items, or a rejection without any, is refused, so the decision is always clear.

**The fix loop.** After `[CHANGES REQUESTED]` the bridge tells the requesting agent, in its own fixed words: fix what holds up, say why when a finding is wrong, ask again, and stop and ask you when going in circles. The reviewer is told to answer each objection. Nits never block approval.

- **One-off review:** the agent asks for the next round of the same review (*Round 2 of review L7*). It goes to the same reviewer with the same kind (a plan review stays one).
- **Auto mode, every turn:** the agent's next turn is reviewed as the next round, with the reviewer's last answer. A new message from you starts the count over. When an approval ends a fix loop, it comes with the chat's next prompt, so the loop's end is seen; a routine approval comes as one line. An answer about a turn from before your latest message no longer steers the loop, but it comes once with the next prompt, marked as being about an earlier turn.

**Emergency stop.** If two agents go 20 rounds in a row without approval, the loop stops and the agent is told to ask you (`AGENT_REVIEW_BRIDGE_MAX_ROUNDS` changes the number).

**Plan reviews.** The reviewer's `[APPROVED]` is not your approval: after a plan review the bridge tells the agent to show you the plan and the verdict and to wait for your explicit go-ahead.

## Auto mode

Auto mode is for working with a second model throughout, without reviewing every small step and without the agent quietly skipping the reviews. It uses the same reviews as above; turning it on adds a few things for that chat:

- **A standing instruction**, in full when auto mode is turned on and whenever the session starts again (after a compaction, for example), and in a short but complete form with each prompt: ask for a review before settling a direction, when the direction changes (a different approach, a larger change than expected, a dropped or added requirement), when a coherent step is done and before committing it, when stuck, before anything hard to undo, and before saying the work is done. Small edits, reading and questions go into the next review.
- **One reviewer chat** for the whole piece of work, so it remembers what was agreed. Each request still restates the goal, the step and anything that deviated. From Claude it is a ChatGPT chat the bridge makes on the first review (or one you name). From ChatGPT it is a Claude Code chat: the bridge can't make one, so the first review gives a join code to paste into the Claude chat that should review, and that chat stays the reviewer. Either app can take the code: another ChatGPT chat can review a ChatGPT chat, and from Claude, asking for a reviewer by code (`reviewer: "join"`) lets another Claude Code chat review it. Between reviews it keeps listening for the next one (it has to stay open in Claude Desktop, or the bridge asks to open it), and it doesn't read your other chats. If that chat is gone or you want another, say so: auto mode drops it and keeps what was approved, and the next review gets a new one. A reviewer told to stop reviewing (`bridge_unlink`) stops being auto mode's reviewer too.
- **A channel to the reviewer:** while auto mode is on, the two chats can message each other between reviews too (`bridge_send`): to ask why, give context, or answer a finding later. A Claude chat that asked something (through the pairing, or on a review since closed) listens for the answer and is woken by it; a message the reviewer starts on its own reaches an idle Claude chat when its next turn ends.
- **The reviewer watches the direction too:** besides the code, it says so when the plan or scope looks wrong. No plan is required when the work doesn't need one.
- **A check at the end of each turn:** if the reviewer hasn't approved the current changes, the agent is asked once to request a review or tell you why not; telling you doesn't count as approval. It never stops the agent while a review is waiting, or a second time for the same changes. It's a safety net, not a guarantee: it can't stop what happens inside a turn.
- **A gentle reminder** after five of your messages without a review, if nothing is waiting.
- **One review of the whole work, if you want it:** after a long, multi-step job, once you say it's done, the agent asks once whether you want a single review covering all of it. It doesn't ask again, and it doesn't replace the reviews along the way, nor the approval before it says the work is done.
- **Plans:** a plan review the agent starts on its own in auto mode goes on once the reviewer approves it. A plan review you asked for still waits for your approval. This is an instruction to the agent, not a lock.

The work can span several folders or files, git or not, for example an iOS repo and then the same feature in the Android repo from the same chat. Each review names them, and the end-of-turn check covers every folder or file named in a code review or when auto mode was turned on (a plan review's paths are only context). A folder the agent never names isn't checked, and one that was never approved and is gone drops out. Say "auto mode off" to stop; turning it on again starts fresh, with a new reviewer chat.

### Every turn

Auto mode can also review **every turn on its own**, instead of the agent asking at the moments that matter. The bridge then sends each turn that ends to the reviewer chat, whatever the agent does: what you asked (with anything you typed while it worked), its final answer, a summary of the turn's own changes with the command that shows them, and for each tracked path what an approval covers. It reads like any other review request; only the bridge writes it. Turn it on for a chat with *"auto mode, every turn"* (`bridge_auto` with `every_turn`), or for every chat that turns auto mode on with this in `config.json`, next to `rules.md`:

```json
{ "autoReviews": "every-turn" }
```

The setting is read when auto mode is turned on; a chat can switch either way while auto mode is on, keeping what was approved. In this way of working:

- **Only "changes requested" wakes the agent**, for the fix loop: it fixes what holds up or says why not, and its next turn is reviewed as the next round of the same review, with the reviewer's last answer. Twenty rounds in a row without approval stop the loop until you write.
- **Everything else comes quietly with the chat's next prompt** (usually your next message): an approval as one line ("Your reviewer approved the turn in review L12"), or in full with its minor points or when it ends a fix loop. An answer about a turn from before your latest message is marked as being about an earlier turn. The bridge's own notes (a failed review, a usage limit, a reviewer waiting for your approval) come the same way.
- **No end-of-turn check and no reminder:** every turn is reviewed anyway. The agent still asks for a plan review before settling a direction.
- **What waits, and what is dropped:** a turn's review is put together in the background and kept until it is sent. One review of a chat's turns is out to its reviewer at a time: the next goes once that one is answered, so a chat has at most one of its turns waiting in its reviewer's queue (a reviewer shared by several chats has one from each), and a request still waiting in a ChatGPT chat's queue is never taken for lost. While ChatGPT's usage limit is reached, or ChatGPT Desktop is closed (unless you said to always open closed apps), it waits and goes once it can; a Claude reviewer that isn't listening gets it when it is open again (you get one note about it). A review whose reviewer couldn't answer it is sent again, with the same turn and round and without waking the agent: while the reviewer is only unavailable (a usage limit, an overload, a failed delivery) with longer and longer waits in between, and for other failures three tries in all (a Claude reviewer whose turn ends without an answer, or that is stopped and stays silent for six hours, counts as one). If the next turn's review is held behind one that isn't answered for a while, you're told once. After about a day of unavailability the turn is set aside and kept: it goes once the reviewer answers again, or once auto mode has another reviewer (`new_reviewer`). What is dropped, and said: past ten waiting turns (retries included), the oldest waiting ones (their changes are in the next review); a turn whose review can't be put together still goes, without its own changes and, if they don't all fit one message, with as many tracked paths as do (the rest are counted, and the reviewer can ask for them). Not reviewed on their own: a turn that never reaches its end (you stopped it, or an API error ended it), whose changes are in the next review, and the turns still waiting when auto mode is turned off.
- **A reviewer's own turns:** a turn in which a chat answered a review isn't reviewed itself, so two chats that review each other don't go round.
- **The reviewer from the start:** from Claude, the ChatGPT reviewer chat is made when auto mode is turned on (or, with `reviewer: "join"`, a join code is given for any chat); from ChatGPT, turning it on gives the join code for the chat that should review, and turns wait until one joins.
- **Your own review counts:** if the agent asked for a code review of exactly what a turn ended with, that turn isn't reviewed twice. A plan review doesn't count for the code.

**It replaces advisor mode** (`bridge_link`), which reviewed every turn through a link of its own. An advisor link left from an earlier version is closed when the bridge starts, and its chat is told once. Its reviews and answers that the bridge hadn't handed over are never sent. One that already reached its chat, or may have (a send whose outcome the bridge never learned), can't be taken back: it may still be answered, and that answer is refused. Compared with advisor mode:

- You turn it on with auto mode (`every_turn`), not with `bridge_link`.
- The reviewer can be in either app, as in advisor mode: any chat that joins with a code (from Claude with `reviewer: "join"`). From Claude, an existing ChatGPT chat can also become the reviewer through its `thread_id`.
- `bridge_send` reaches the reviewer between reviews too, and the reviewer reaches the chat: auto mode pairs them for as long as it is on, though each turn's review is a link of its own.
- The bridge's own notices (a failed review, a usage limit, a reviewer waiting for your approval) come with the next prompt instead of waking the agent. Advisor mode had none of these three.
- An approval comes to the agent as one line with the next prompt, so it knows each turn's outcome. Advisor mode kept approvals silent.
- The same nits, or the same late answer, are noted again when another turn's review brings them: each turn's review is a review of its own. Advisor mode noted an identical one only once.
- The turn's diff isn't pasted: the reviewer reads it with a command, as in every other review. Advisor mode pasted it.

## Your rules

Standing instructions for every agent working through the bridge, in either app, go in one optional file:

| System | File |
|---|---|
| macOS, Linux | `~/.config/agent-review-bridge/rules.md` (or `$XDG_CONFIG_HOME/agent-review-bridge/rules.md`) |
| Windows | `%APPDATA%\agent-review-bridge\rules.md` |

Write plain sentences:

```markdown
Always answer in Turkish.
Never commit without my approval; staging is fine.
When you review, don't run the tests.
```

The whole file, up to 8,000 characters, reaches every chat that is linked or has just had a bridge message, with each prompt and with the bridge's tool results. It never travels inside a message from the other agent, so that agent can't forge your rules. What you say directly in a chat comes first. These are instructions, not enforcement: the bridge can't stop an agent from ignoring them.

## When the other side is closed

If your agent starts something with the other side and that side is closed (ChatGPT Desktop isn't running, or the Claude Code session isn't listening, usually because it isn't open), nothing is sent. The agent asks you whether to open it; if you agree, the bridge opens ChatGPT Desktop, or the exact Claude Code session in Claude Desktop, and sends.

Say "always" and it won't ask again: that sets `"openClosedApps": "always"` in `config.json`, next to `rules.md`. Delete the line to be asked again.

Messages the bridge sends on its own, like auto mode's review of each turn, don't ask: a closed Claude session's message waits until you open it, and ChatGPT is started by its wake link.

## Privacy and safety

- **What is sent:** the agent's request, or in auto mode reviewing every turn your message for the turn and the agent's final answer. By default no review pastes the changes: the reviewer reads them from your folders with the commands the request gives, so whatever it reads goes to that vendor too. `include_diff` pastes them, for a reviewer that can't read the paths.
- **Left out of diffs, summaries and the reviewer's commands:** files whose names suggest secrets, neither their content nor their names: `.env*`, keys and certificates, `*secret*`, `*credential*`, `.netrc`, `.npmrc`, and the folders `secrets/`, `.ssh/`, `.aws/` and any folder named like `*secret*` or `*credential*`. The reviewer is also told not to open them, and auto mode's check leaves them out too, in folders outside git as well. This goes by path only: secrets inside other files, in your messages or in the agents' answers are not removed.
- **The other agent can't give orders.** Its messages are marked as agent messages, not user instructions, and can't authorize anything. Your rules come only from your own file, through local channels.
- **Reviewer chats the bridge creates in ChatGPT run read-only.** A chat that joins with a code keeps its own permissions; it is only told not to act on the project.
- **Reading a chat sends it to the reader's vendor.** When a Claude chat reads a ChatGPT chat, that chat's text goes to Anthropic, and the other way round. Agents are told to read only a chat you asked for; that is an instruction, which the bridge can't check. Chats that review for another chat are refused outright: ones the bridge created for good (those created before this version only while their link is open), ones that joined with a code while their link is open, and auto mode's reviewer while it is one (until it stops reviewing or that auto mode is off). To allow them, set `"readChatsInReviewers": "allow"` in `config.json`. What is read is marked as data, not instructions, and agents are told not to pass it on to another chat unless you ask. Chat content isn't scanned for secrets. Tool output is never shown: with `include_tools`, each tool step is one line naming the command, file or tool and whether it succeeded.
- **Local only.** The broker listens on `127.0.0.1` and requires a token. State lives in your user folder; old messages are pruned after a day (read) or a week.

## Troubleshooting

Run `npm run doctor` first; it prints a fix for each problem it finds.

| Problem | Fix |
|---|---|
| ChatGPT never reviews anything | Its hooks may be untrusted. Restart ChatGPT Desktop normally, with its window open, and run `doctor`. |
| "Claude session isn't listening" | Open that Claude Code session in Claude Desktop; it picks up waiting messages when it starts. |
| Nothing happens after an update | Re-run `node scripts/install.mjs` and restart both apps. |
| The bundled `codex` isn't found | Set `AGENT_REVIEW_BRIDGE_CODEX_BIN` to ChatGPT Desktop's own `codex`; `doctor` shows which one is used. |

Other settings, read by the bridge's processes: `AGENT_REVIEW_BRIDGE_CLAUDE_BIN` (Claude Code CLI), `AGENT_REVIEW_BRIDGE_CONFIG_DIR` (where `rules.md` and `config.json` live), `AGENT_REVIEW_BRIDGE_DIR` (state), `AGENT_REVIEW_BRIDGE_PORT` (broker port, default 7457), `AGENT_REVIEW_BRIDGE_MAX_ROUNDS` (default 20).

## Known limits

- A Claude Code session can only be woken while it is open in Claude Desktop; messages for a closed one wait until it opens.
- Either chat may compact its context at any time. Requests carry what the reviewer needs, and a Claude reviewer gets its waiting reviews back when its session starts again. ChatGPT has no such hook: a ChatGPT reviewer that loses track ends its turn without an answer, and the requester is told and can ask again.
- After an API error ends a Claude turn, its listener isn't armed again until the next turn or session start, so once its limit resets, a waiting message arrives with your next prompt. The bridge knows when Claude's limit resets only if Claude's error message says so.
- A turn's snapshot refreshes a copy of the index, never yours: in a very large repository with many files git sees as touched, it can run past its time limit, and that turn's own changes then aren't listed (the folder's changes still are).
- After an update, quit and reopen both apps. An app still running the version from before is refused by the new one, with a note to restart it; left running on its own, it can still take over the bridge until it is restarted.
- A Claude session's listener runs for up to 12 hours at a time; each turn or session start arms it again.
- A ChatGPT thread runs the bridge's messages as prompts, and the bridge recognises its own by their text (if the app changes line endings or spacing, the message's first line and its fixed last line still identify it). If you paste one verbatim before the bridge's own turn for it runs, only the fix-loop count restarts.
- One-off reviews and auto mode: the reviewer reads the changes itself, so how carefully it reads is up to the model. In auto mode the bridge also makes sure an approval covers only what was there when the review was asked for.
- Auto mode runs from either app. From ChatGPT the reviewer is a Claude Code chat that joins with a code, since the bridge can't create a Claude chat or pick its model. Every-turn auto mode from ChatGPT rests on the same untested parts as auto mode from ChatGPT, and on ChatGPT running the bridge's messages as prompts. A Claude Code reviewer in its default permission mode may ask you to approve the `git` command each review gives; until you do, the reviews of your turns wait on it (you're told it waits for your approval). Auto mode from ChatGPT hasn't been tried with the real apps yet: it relies on ChatGPT going on with a turn its `Stop` hook stopped, and on its running the bridge's messages as prompts, as its documentation describes. The end-of-turn check compares file contents with what the reviewer approved; it doesn't run git's filters, so a repository with line-ending conversion may ask for one review too many after a commit.
- Reading chats covers only the other app's chats stored on this computer: from Claude, ChatGPT Desktop's Codex chats (through its app-server); from ChatGPT, Claude Code sessions (their transcript files). A chat in the agent's own app isn't read through the bridge. Ordinary chatgpt.com and claude.ai chats, and cloud sessions, aren't stored here. Both formats are the apps' own and undocumented. Reading with ChatGPT Desktop closed is verified on Windows only. Chats are found by name or id; the text inside them isn't searched. A search covers every chat, but stops and says so at about 30 seconds on Claude's sessions, and up to about 60 on ChatGPT's, where starting the app-server and the search each get the time left. A session that couldn't be checked in time is counted as not searched; a later search normally goes on from where its title scan stopped. A long list comes in pages, and a chat updated meanwhile moves to the top of it.
- Reading a Claude session shows the conversation as it stands now: what was rewound is left out and counted. The first read of a session scans its file once (streamed, not held in memory); a very large one can take more than one call. A session whose index would need over 128 MiB is refused and says so, which is somewhat over 1 GB of transcript. The history before a compaction is read back through it, and the compaction's summary is left out. Where that history can't be reconstructed (no way back, one that comes back round, as a resumed session can be written, or a break further back), the summary is shown in its place, as the Agent SDK does, and each page says so. If a session's history has a broken link, older messages are shown in file order with a warning, since rewound branches can't be told apart there. If its branch changes between pages (a rewind, or a record written again), the read stops and says so; new messages don't disturb it. This isn't a check of the content: transcripts are taken to be append-only, and an older message rewritten in place, at the same length, wouldn't be noticed. These rules come from the Agent SDK's reader and fixtures; a run on macOS read real rewound sessions without errors, but nobody has checked what it showed against an independent reading. Messages are cut at 25,000 characters and a message's tool steps at 2,000, with no way to read the rest (the agent is told to say so); a single record over 8 MB is left out and counted, and a message spread over more than 64 MB shows what was read and says so.
- CLIs: the Claude Code CLI should work, since it reads the same MCP server and hooks, but it hasn't been tested. The bridge can only reopen closed sessions that run in Claude Desktop; a CLI session has to be resumed by hand. The Codex CLI isn't supported: messages for the ChatGPT side wake ChatGPT Desktop, not a terminal session.

---

## Tools

The bridge's MCP tools, for agents. You normally don't call them yourself.

| Tool | What it does |
|---|---|
| `bridge_review` | Ask the other app for one review of `request`. `kind`: `"code"` (default) or `"plan"`. `paths`: the folders or files the work changed, git or not (default: the chat's folder; none for a plan); the request gives the reviewer a short status and the command to show the changes, and the reviewer reads them itself. `include_diff` also pastes the changes, for a reviewer that can't read the paths. `own_initiative`: in auto mode, a plan review the agent started on its own goes on once approved. `reviewer`: `"openai"` (from Claude: a new ChatGPT chat, with optional `model` and `effort`, or an existing one with `thread_id`) or `"join"` (returns a code). `round_of`: after `[CHANGES REQUESTED]`, the link id of that round, to send the next round to the same reviewer; after a review that got no answer, the same asks again; no `reviewer` needed. `thread_id` only picks the chat; it doesn't continue a review. |
| `bridge_auto` | Turn auto mode on or off. From Claude, `model`, `effort` or `thread_id` choose the ChatGPT reviewer chat, and `reviewer: "join"` takes the chat that joins with a code instead, in either app; from ChatGPT, the first review gives a join code and the chat that joins (Claude, or another ChatGPT chat) stays the reviewer. `every_turn` reviews every turn on its own (default: `autoReviews` in `config.json`); it can be switched while on. `new_reviewer` drops the reviewer chat and keeps what was approved. `paths` adds folders or files the work will change. |
| `bridge_link_join` | Become the reviewer of another chat's review, with its code (from `bridge_review` or `bridge_auto`), from either app. |
| `bridge_advise` | Answer a review request: `request_id`, `decision` (`"approved"` or `"changes_requested"`), `note`, `blocking`, `nits`. |
| `bridge_receive` | Read messages that are still unread, or one again by `id`. Messages normally arrive in full without it. |
| `bridge_send` | Send a free-form message to the chat on the other end of this chat's latest open review; with none open, to auto mode's reviewer, or from that reviewer to the chat it reviews for. With `reply_to` (a message id) the answer goes to that message's sender. |
| `bridge_status` | This chat's open links and up to 5 closed in the last hour (older ones are only counted), their health, whether Claude sessions are listening, ChatGPT's usage limits, and the last observed failure of linked chats. |
| `bridge_unlink` | Close this chat's open reviews, and stop being another chat's auto mode reviewer. |
| `bridge_read_chat` | Find and read one of the user's chats in the other app, on this computer: by `name` (or part of it) or `id`, with `folder` (and `archived`, for ChatGPT's) to narrow it. After a complete search, a single exact match is read at once, and so is a single partial match when nothing else matches; anything else gives a list to ask the user about, 15 at a time. A chat's pages go from the newest back; `cursor` gives the next page of either; each message comes once, though long ones are cut. A cursor that no longer fits the chat stops the read. `include_tools` also shows tool steps, one line each (the command, file or tool, marked as done or only attempted), never their output. Read-only: no link, no message, no wake. Refused in chats that review for another chat. |

`bridge_review` and `bridge_send` also take `open` and `remember`, used only after the user agreed to open a closed app.

**Models.** A new ChatGPT thread's `model` must be one your ChatGPT Desktop offers. The bridge checks it against the app's live model list first: the id (`gpt-6-astra`) or the name the picker shows (`GPT-6-Astra`) both work. An unknown model, or an `effort` the model doesn't support, is refused with the list, and nothing is created; the agent then picks one, or asks you. If the app version can't list its models, nothing is checked; if the list can't be read for another reason, nothing is created. On the Claude side the bridge never picks a model: a Claude chat joins with a code and keeps its own.

## How it works

```text
working chat ──Stop hook──▶ outbox ──▶ broker ──▶ reviewer chat
     ▲      (question, answer, snapshots)               │
     └─ [CHANGES REQUESTED]: wakes the working chat ◀───┘ bridge_advise
           [APPROVED] + nits: added to the chat's next prompt
```

That is auto mode reviewing every turn: the broker puts each review together from what the hooks wrote down. One-off reviews and auto mode at key moments work the other way round: the agent asks. Either way the request has the same form, and the reviewer reads the changes itself.

```text
agent ──bridge_review──▶ broker ──▶ reviewer chat ── reads the folders (git diff, files)
  ▲   (request, paths, git commands)                      │
  └──────────── [APPROVED] / [CHANGES REQUESTED] ◀────────┘ bridge_advise
  Stop hook (auto mode): unapproved changes left? ask once for a review
```

- **Review requests.** The request carries the agent's own description, and for each path a short status, a stat and a ready read-only `git diff` command (on Windows given twice: for Git Bash, which Claude Code runs, and for PowerShell, which ChatGPT runs). Auto mode's review of a turn has the same form: the bridge writes the description (what you asked, the agent's final answer) and adds the turn's own changes as a stat and a command between the snapshots of its start and its end. Nothing is pasted unless the reviewer says it can't read the paths. Each request also carries the reviewer's role in short, and a next round carries the reviewer's previous answer, since either chat may have compacted its context since. The whole request has to fit one message: the file lists are dropped first, and if it still doesn't fit, the agent is told to split it.
- **What an approval covers (auto mode).** When a review is asked for, the bridge records a fingerprint of the files under its paths: in git, the tracked and untracked files that aren't ignored; outside git, every file except `node_modules`; secret files left out in both. Changes to files it leaves out aren't caught. An approval covers that fingerprint, so a change made while the review ran stays unreviewed. Committing doesn't change the fingerprint, and the next review of the path compares from the commit that was approved.
- **Hooks.** In auto mode reviewing every turn, a `UserPromptSubmit` hook records the question when a turn starts and snapshots the working tree (`git stash create`, run on a copy of the index, so none of your files, your index or your refs is touched, and a git holding the index lock doesn't stop it). When the turn ends, the `Stop` hook stops nothing: it writes down the turn (its final answer, folder and a snapshot of its end), and the broker puts the review together later in a child process, so the hook's time limit never cuts it short. In auto mode at key moments the `Stop` hook compares the tracked paths with what was approved, and if something is left, stops the turn once to say so (a tracked folder that was deleted is named as gone). A `SessionStart` hook, in both apps, gives auto mode's rules again in full and, to a chat reviewing for another, the reviews still waiting for its answer. ChatGPT runs the bridge's messages, and the words the `Stop` check stopped a turn with, as prompts; neither counts as yours. Hooks never wait for the reviewer and never use the network.
- **Messages typed mid-turn** (auto mode reviewing every turn). Claude Code runs the prompt hook again, with the running turn's id, for a message you type while it works and for its own notices. These stay part of the running turn: the task and the diff baseline are kept, your message is added to the task, notices are left out, and none of them restarts the fix-loop count. A prompt without an id always starts a new turn.
- **Broker.** A small local store shared by both apps' MCP servers: HTTP on `127.0.0.1` with a token, plus a state file. Hooks read the state file and drop requests into an outbox folder. The broker keeps the names of the requests it has applied, so a takeover doesn't apply one twice. If the process holding the broker exits, another server takes over within about 2 seconds.
- **Waking ChatGPT.** The whole message is added to the thread's own queue through the app's bundled `codex app-server`, then `codex://threads/wake/<id>` makes the app run it, in the background if needed.
- **Waking Claude Code.** A background hook (`asyncRewake`) waits for messages for its session and wakes it with the whole message, in the same format a ChatGPT thread gets. It re-arms on every turn and session start. If a wake ever looks cut off, `bridge_receive` with the message's id returns it in full.
- **Identity.** The bridge learns which chat is calling from the host, never from the model's memory: `CLAUDE_CODE_SESSION_ID` on the Claude side, `_meta.threadId` on the ChatGPT side. Context compaction can't break a link.
- **Problems are visible.** A failed delivery or a Claude session that isn't listening shows up in the waiting chat's next prompt and in `bridge_status`.
- **When no answer is coming.** Before a review goes to ChatGPT, the bridge checks its usage limit: if it's reached, nothing is sent and the agent hears when it opens again. After a review request or a message is queued in a ChatGPT thread, the bridge follows that exact turn (by an id it gives the prompt): early checks, then every minute, for up to 6 hours. If the turn fails (a usage limit, an outage) or ends without the review answer, the waiting chat is woken and told; past 6 hours it hears that no answer was confirmed. On the Claude side a `StopFailure` hook does the same when an API error (Claude's own limit, an outage) ends a turn the bridge woke it for. For a review, the notice says how to ask the same reviewer again (`round_of`): the retry keeps its round number and carries the reviewer's last real findings. Each case is told once, an answer that already arrived stays, and `bridge_status` shows ChatGPT's limits and the last observed failure of linked chats. In auto mode reviewing every turn it comes with the chat's next prompt instead, and the turn's review is sent again (see [Every turn](#every-turn)).
- **When the answer waits for your approval.** If a Claude chat working for another one (a one-off reviewer, or a chat answering a bridge message) asks you to approve a tool, and you haven't answered after about six seconds, the waiting chat is told, so its agent can tell you where to look. It comes from Claude Code's `Notification` hook (`permission_prompt`), which fires only for a prompt that is really shown and still open; it covers sandboxed network requests too, and in Claude Desktop it needs Claude Code 2.1.233 or newer (an earlier fix). Each waiting message is told once. If the answer arrives before a Claude chat has read the notice, the notice is dropped; one already queued in a ChatGPT chat can't be taken back. On the ChatGPT side the bridge reads the reviewer thread's rollout file while it waits for an answer: a request to run a command outside the sandbox with no result after a minute is told as a possibility (it may be waiting for your approval, or the command may still be running), usually within one to two minutes. The rollout records the request but never the decision, and only commands asking to leave the sandbox show up. In auto mode reviewing every turn the notice comes with the chat's next prompt, so it can't start a turn that would be reviewed again.

## Development

```bash
npm test
```

| Test | Covers |
|---|---|
| `scripts/test-git.mjs` | Turn diffs (secret exclusion, repos without commits, untracked edits, size cap), review summaries and commands, and auto mode's fingerprint (edits, deletes, links, unreadable files, folders outside git). |
| `scripts/test-codex.mjs` | Model choice for new ChatGPT threads: ids, picker names, unknown models and efforts refused. |
| `scripts/test-chats.mjs` | Reading chats: titles anywhere in a session, finding every chat by name, lists and their memory, paging, huge records, what is left out, attempts vs results, errors that aren't "nothing found". |
| `scripts/test-chat-graph.mjs` | What a Claude session shows, against an oracle sharing no code with it: seeded random transcripts (rewinds, parallel calls, compactions, including ones whose history goes round or breaks, repeats, broken links) over many ways of cutting the pages, plus named cases, changes between pages, the tokenizer and the resource limits. |
| `scripts/test-platform.mjs` | Finding the apps' bundled CLIs. |
| `scripts/smoke.mjs` | End to end over MCP: two real server processes, the hooks, a throwaway git repo. |
| `scripts/test-link.mjs` | Links, reviews and rounds, hooks, rules, auto mode's approvals and end-of-turn check, auto mode reviewing every turn and its fix loop, advisor links from an earlier version, pruning, broker handover. |
| `scripts/test-failure.mjs` | When no answer is coming: failed ChatGPT turns and the 6-hour watch, Claude's `StopFailure`, usage limits, time-limited app-server calls, auto mode's fresh start. |
| `scripts/test-install.mjs` | Install, reinstall and uninstall against throwaway config folders. |
| `scripts/test-doctor.mjs` | `doctor` on a missing install, untrusted Codex hooks, the rules file. |

Repository layout:

- `src/server.mjs`: the MCP server and its tools.
- `src/broker.mjs`: shared state, delivery, links and reviews. `src/request.mjs`: review requests, a turn's included; `src/turnjob.mjs` puts a turn's review together in a child process. `src/common.mjs`: shared limits and texts.
- `src/hook.mjs`: the hooks for both apps.
- `src/auto.mjs`: auto mode's instructions and end-of-turn message.
- `src/git.mjs`: turn diffs, review summaries and fingerprints. `src/codex.mjs`: ChatGPT thread driver. `src/caller.mjs`: caller identity.
- `src/readchat.mjs`, `src/chats.mjs`: reading chats (shared paging and texts; Claude Code sessions). ChatGPT threads are read in `src/codex.mjs`.
- `src/rules.mjs`, `src/config.mjs`: your rules and settings. `src/platform.mjs`: OS paths and app launching.
- `scripts/`: installer, `doctor`, tests, and debugging helpers (`send.mjs`, `codex-thread.mjs`).

## License

[MIT](LICENSE)
