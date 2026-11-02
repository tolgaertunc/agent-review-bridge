# peer-bridge

**Let Claude Code and ChatGPT Desktop review each other's work, from their own desktop apps.**

peer-bridge connects a chat in the Code tab of Claude Desktop with a chat in ChatGPT Desktop. One chat writes the code; the other reviews it, either after every turn or when asked. Both are ordinary chats in the official apps, using your own subscriptions: no model APIs and no API keys. Either app can take either role, and you can read both sides of the conversation in the chats themselves.

It is built and tested with the desktop apps. The Claude Code CLI uses the same setup (MCP server and hooks) but hasn't been tested yet; the Codex CLI isn't supported yet.

> **Status: alpha.** Reviews work end to end on Windows in both directions. On macOS, Claude Code reviewed by ChatGPT works; ChatGPT reviewed by Claude hasn't been tried on a Mac yet. Opening a closed app for you (see below) is tested only with simulated apps so far.
>
> The ChatGPT side relies on undocumented parts of the app (its bundled `codex app-server` experimental API and the `codex://threads/wake` link), so an app update can break it. The code you work on is sent to the other vendor's chat.

## Contents

Using peer-bridge:

- [What it does](#what-it-does)
- [Install](#install)
- [Use it](#use-it)
- [How reviews work](#how-reviews-work)
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
| **Advisor** | After every turn of your chat (the *primary*), a chat in the other app reviews it: what you asked, the answer, and the diff of that turn. | Longer work where you want a second opinion on each step. |
| **One-off review** | Your chat asks the other app once, normally with its uncommitted changes attached. Follow-up rounds go to the same reviewer. | A finished change, a tricky fix, a commit you're unsure about. |
| **Plan review** | A one-off review of a plan before anything is built. Afterwards the primary shows you the plan and the verdict, and waits for your approval. | Design decisions, larger changes. |

Every answer starts with **`[APPROVED]`** or **`[CHANGES REQUESTED]`**. On changes requested, the agent that wrote the code fixes what holds up, pushes back where it disagrees, and asks again until it is approved, or stops and asks you when it is going in circles.

## Install

Requirements: Node.js 22 or newer, git, and both desktop apps, signed in: Claude Desktop with its Code tab, and ChatGPT Desktop with its Codex-based coding chats.

1. Get the code and install it:

   ```bash
   git clone https://github.com/tolgaertunc/peer-bridge.git
   cd peer-bridge
   npm install
   node scripts/install.mjs
   ```

   The installer registers the bridge's MCP server in both apps, adds its hooks, and allows the bridge's own tools without approval prompts (a woken chat can't wait for a click). It backs up every file it changes and leaves your other settings and hooks alone. The hooks point at this folder, so re-run it if you move the folder. If it can't find the Claude Code CLI, it prints the command to register the server by hand (or set `PEER_BRIDGE_CLAUDE_BIN`).

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
- *"Link a ChatGPT advisor to this chat."* From now on every turn is reviewed.
- *"Use the same ChatGPT chat as last time."* The review continues in that chat, with its earlier context.
- *"Stop the reviews."* The link is closed.

You can pick the model and reasoning effort of a new ChatGPT chat ("…with gpt-6.1-sol, high effort"). The bridge checks the name against the models your ChatGPT Desktop offers; an unknown one is refused with the list, and nothing is created.

From ChatGPT, or to use an existing chat of either app as the reviewer, ask for a **join code** and paste it into the other chat: *"join the peer-bridge link with code 3fa9c1"*.

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
- **Advisor:** the agent's next turn is reviewed again. A new message from you starts the count over. When an approval ends a fix loop, it comes with your next message, so you see the loop end; routine approvals stay silent. An answer about a turn from before your latest message no longer steers the loop, but it comes once with your next message, marked as being about an earlier turn.

**Emergency stop.** If two agents go 20 rounds in a row without approval, the loop stops and the agent is told to ask you (`PEER_BRIDGE_MAX_ROUNDS` changes the number).

**Plan reviews.** The reviewer's `[APPROVED]` is not your approval: after a plan review the bridge tells the agent to show you the plan and the verdict and to wait for your explicit go-ahead.

## Your rules

Standing instructions for every agent working through the bridge, in either app, go in one optional file:

| System | File |
|---|---|
| macOS, Linux | `~/.config/peer-bridge/rules.md` (or `$XDG_CONFIG_HOME/peer-bridge/rules.md`) |
| Windows | `%APPDATA%\peer-bridge\rules.md` |

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

Messages the bridge sends on its own, like an advisor's review of each turn, don't ask: a closed Claude session's message waits until you open it, and ChatGPT is started by its wake link.

## Privacy and safety

- **What is sent:** your message for the turn, the agent's final answer, and the diff of the turn or of your uncommitted changes (capped at 20,000 characters). It goes to the other app's chat, and so to that vendor.
- **Left out of attached diffs:** files whose names suggest secrets, neither their content nor their names: `.env*`, keys and certificates, `*secret*`, `*credential*`, `.netrc`, `.npmrc`, and the folders `secrets/`, `.ssh/`, `.aws/` and any folder named like `*secret*` or `*credential*`. This goes by path only: secrets inside other files, in your messages or in the agents' answers are not removed.
- **The other agent can't give orders.** Its messages are marked as agent messages, not user instructions, and can't authorize anything. Your rules come only from your own file, through local channels.
- **Reviewer chats the bridge creates in ChatGPT run read-only.** A chat that joins with a code keeps its own permissions; it is only told not to act on the project.
- **Local only.** The broker listens on `127.0.0.1` and requires a token. State lives in your user folder; old messages are pruned after a day (read) or a week.

## Troubleshooting

Run `npm run doctor` first; it prints a fix for each problem it finds.

| Problem | Fix |
|---|---|
| ChatGPT never reviews anything | Its hooks may be untrusted. Restart ChatGPT Desktop normally, with its window open, and run `doctor`. |
| "Claude session isn't listening" | Open that Claude Code session in Claude Desktop; it picks up waiting messages when it starts. |
| Nothing happens after an update | Re-run `node scripts/install.mjs` and restart both apps. |
| The bundled `codex` isn't found | Set `PEER_BRIDGE_CODEX_BIN` to ChatGPT Desktop's own `codex`; `doctor` shows which one is used. |

Other settings, read by the bridge's processes: `PEER_BRIDGE_CLAUDE_BIN` (Claude Code CLI), `PEER_BRIDGE_CONFIG_DIR` (where `rules.md` and `config.json` live), `PEER_BRIDGE_DIR` (state), `PEER_BRIDGE_PORT` (broker port, default 7457), `PEER_BRIDGE_MAX_ROUNDS` (default 20).

## Known limits

- A Claude Code session can only be woken while it is open in Claude Desktop; messages for a closed one wait until it opens.
- A Claude session's listener runs for up to 12 hours at a time; each turn or session start arms it again.
- A ChatGPT thread runs the bridge's messages as prompts, and the bridge recognises its own by their text (if the app changes line endings or spacing, the message's first line and its fixed last line still identify it). If you paste one verbatim before the bridge's own turn for it runs, only the fix-loop count restarts.
- On macOS, ChatGPT as the primary with a Claude advisor hasn't been verified yet.
- CLIs: the Claude Code CLI should work, since it reads the same MCP server and hooks, but it hasn't been tested. The bridge can only reopen closed sessions that run in Claude Desktop; a CLI session has to be resumed by hand. The Codex CLI isn't supported: messages for the ChatGPT side wake ChatGPT Desktop, not a terminal session.

---

## Tools

The bridge's MCP tools, for agents. You normally don't call them yourself.

| Tool | What it does |
|---|---|
| `bridge_review` | Ask the other app for one review of `request`. `kind`: `"code"` (default) or `"plan"`. `include_diff` attaches the chat's uncommitted changes; default true for code, false for a plan (on the ChatGPT side only when its project folder is known). `reviewer`: `"openai"` (from Claude: a new ChatGPT chat, with optional `model` and `effort`, or an existing one with `thread_id`) or `"join"` (returns a code). `round_of`: after `[CHANGES REQUESTED]`, the link id of that round, to send the next round to the same reviewer; no `reviewer` needed. `thread_id` only picks the chat; it doesn't continue a review. |
| `bridge_link` | Make this chat a primary whose every turn is reviewed. `advisor`: `"openai"` (from Claude) or `"join"`. |
| `bridge_link_join` | Become the advisor or reviewer of a link, with its code. |
| `bridge_advise` | Answer a review request: `request_id`, `decision` (`"approved"` or `"changes_requested"`), `note`, `blocking`, `nits`. |
| `bridge_receive` | Read messages that are still unread, or one again by `id`. Messages normally arrive in full without it. |
| `bridge_send` | Send a free-form message to the chat on the other end of this chat's latest link. With `reply_to` (a message id) the answer goes to that message's sender, on its own link. |
| `bridge_status` | This chat's links, their health, and whether Claude sessions are listening. |
| `bridge_unlink` | Close this chat's links. |

`bridge_review`, `bridge_link` and `bridge_send` also take `open` and `remember`, used only after the user agreed to open a closed app.

**Models.** A new ChatGPT thread's `model` must be one your ChatGPT Desktop offers. The bridge checks it against the app's live model list first: the id (`gpt-6-astra`) or the name the picker shows (`GPT-6-Astra`) both work. An unknown model, or an `effort` the model doesn't support, is refused with the list, and nothing is created; the agent then picks one, or asks you. If the app version can't list its models, nothing is checked; if the list can't be read for another reason, nothing is created. On the Claude side the bridge never picks a model: a Claude chat joins with a code and keeps its own.

## How it works

```text
primary chat ──Stop hook──▶ outbox ──▶ broker ──▶ advisor chat
     ▲          (question, answer, diff)              │
     └─ [CHANGES REQUESTED]: wakes the primary ◀─────┘ bridge_advise
           [APPROVED] + nits: added to the user's next prompt
```

- **Hooks.** When a turn starts, a `UserPromptSubmit` hook records the question and snapshots the working tree (`git stash create`, which touches no files or refs). When it ends, a `Stop` hook queues the question, the final answer and the turn's diff for review. Hooks never wait for the reviewer and never use the network.
- **Messages typed mid-turn.** Claude Code runs the prompt hook again, with the running turn's id, for a message you type while it works and for its own notices. These stay part of the running turn: the task and the diff baseline are kept, your message is added to the task, notices are left out, and none of them restarts the fix-loop count. A prompt without an id always starts a new turn.
- **Broker.** A small local store shared by both apps' MCP servers: HTTP on `127.0.0.1` with a token, plus a state file. Hooks read the state file and drop requests into an outbox folder. The broker keeps the names of the requests it has applied, so a takeover doesn't apply one twice. If the process holding the broker exits, another server takes over within about 2 seconds.
- **Waking ChatGPT.** The whole message is added to the thread's own queue through the app's bundled `codex app-server`, then `codex://threads/wake/<id>` makes the app run it, in the background if needed.
- **Waking Claude Code.** A background hook (`asyncRewake`) waits for messages for its session and wakes it with the whole message, in the same format a ChatGPT thread gets. It re-arms on every turn and session start. If a wake ever looks cut off, `bridge_receive` with the message's id returns it in full.
- **Identity.** The bridge learns which chat is calling from the host, never from the model's memory: `CLAUDE_CODE_SESSION_ID` on the Claude side, `_meta.threadId` on the ChatGPT side. Context compaction can't break a link.
- **Problems are visible.** A failed delivery or a Claude session that isn't listening shows up in the waiting chat's next prompt and in `bridge_status`.

## Development

```bash
npm test
```

| Test | Covers |
|---|---|
| `scripts/test-git.mjs` | Turn diffs: secret exclusion, repos without commits, untracked edits, size cap. |
| `scripts/test-codex.mjs` | Model choice for new ChatGPT threads: ids, picker names, unknown models and efforts refused. |
| `scripts/test-platform.mjs` | Finding the apps' bundled CLIs. |
| `scripts/smoke.mjs` | End to end over MCP: two real server processes, the hooks, a throwaway git repo. |
| `scripts/test-link.mjs` | Links, reviews and rounds, the fix loop, hooks, rules, pruning, broker handover. |
| `scripts/test-install.mjs` | Install, reinstall and uninstall against throwaway config folders. |
| `scripts/test-doctor.mjs` | `doctor` on a missing install, untrusted Codex hooks, the rules file. |

Repository layout:

- `src/server.mjs`: the MCP server and its tools.
- `src/broker.mjs`: shared state, delivery, links and reviews.
- `src/hook.mjs`: the hooks for both apps.
- `src/git.mjs`: turn diffs. `src/codex.mjs`: ChatGPT thread driver. `src/caller.mjs`: caller identity.
- `src/rules.mjs`, `src/config.mjs`: your rules and settings. `src/platform.mjs`: OS paths and app launching.
- `scripts/`: installer, `doctor`, tests, and debugging helpers (`send.mjs`, `codex-thread.mjs`).
- `docs/notes/`: working notes (in Turkish) with the experiments and measurements behind the design.

## License

[MIT](LICENSE)
