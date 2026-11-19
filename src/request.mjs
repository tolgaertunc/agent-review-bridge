// The review request, built from the paths the work changed: what is asked,
// and where the reviewer finds the changes itself. One form for every review:
// bridge_review (the MCP server) and auto mode's review of each turn (built
// by the broker) differ only in who writes the request.

import path from "node:path";
import { MAX_DIFF, MAX_TEXT, REVIEWER_ROLE } from "./common.mjs";
import { AUTO_REVIEWER, EVERY_TURN_ROLE } from "./auto.mjs";
import { pathInfo, usableBase, reviewSummary, pathCommand, pathDiff, fingerprint, REVIEW_SHELLS } from "./git.mjs";

// A command as the request shows it: one sh block, or on Windows one block
// per shell the reviewer may run it in (labeled), from build(shell)
export function commandBlocks(build, shells = REVIEW_SHELLS) {
  if (shells.length === 1) return "```sh\n" + build(shells[0]) + "\n```";
  const label = { posix: "In bash (Claude Code on Windows runs Git Bash):\n```sh\n", powershell: "In PowerShell (ChatGPT on Windows runs PowerShell):\n```powershell\n" };
  return shells.map((sh) => label[sh] + build(sh) + "\n```").join("\n");
}

// what one review request may take of a message, leaving room for the
// bridge's own header and footer and a round's heading
export const REQUEST_ROOM = MAX_TEXT - 4_000;

// What a plan is reviewed for, sent with the plan (the reviewer thread may be
// one that was briefed for code)
export const PLAN_GUIDE =
  "This is a plan, not finished work: check it reaches the goal; missing or misordered steps; risks; simpler options; scope creep; how the result will be checked.";

// A review asked for with bridge_review: the requester's text, and where the
// reviewer finds the changes itself. Nothing is pasted unless asked
// (include_diff): per path, a short status and stat and the command that
// shows the changes. In auto mode a path is compared from the commit it was
// last approved on (or entered on), and its content at this moment is
// recorded, so an approval covers exactly what was asked about.
export function reviewRequest({ side, request, plan, paths, folder, includeDiff, auto, previous }) {
  const { list, focus } = reviewPaths({ paths, plan, folder, auto });
  return buildRequest({
    title: plan ? `Plan review requested by ${side}:` : `Review requested by ${side}:`,
    request: request.trim(),
    previous,
    plan,
    auto,
    list,
    focus,
    includeDiff,
    intro: "If you can't read a path, say so: the requester will send the changes as text.",
    tooBig: (n) => `This review doesn't fit one message (${n} paths). Split it into smaller reviews, or shorten the request.`,
  });
}

// The review of one turn that auto mode sends on its own, in the same form:
// the bridge writes the request (what the user asked, the agent's final
// message), and the turn's own changes come as a summary and the command
// that shows them, between the snapshots of its start and its end. With no
// tracked path, the turn's own folder is used (and recorded).
export function turnRequest({ chat, turnId, prompt, fixTurn, heading, previous, lastMessage, summary, command, gone, tracked = {}, folder }) {
  return buildRequest({
    ...turnIntro({ chat, turnId, prompt, fixTurn, heading, lastMessage }),
    previous,
    auto: { paths: tracked },
    roles: [EVERY_TURN_ROLE],
    turn: turnChanges({ summary, command, gone }),
    list: turnPaths(tracked, folder),
    intro: "If you can't read a path, say so in your answer.",
    tooBig: (n) => `the review of this turn doesn't fit one message (${n} tracked paths)`,
  });
}

// The same turn when its review couldn't be put together (`why`: an error, a
// timeout, too big): what was asked and answered, in full, without the
// turn's changes and with each path named only, so the bridge runs no git
// for it. Its approval approves no content (no paths recorded). Paths that
// don't fit one message are counted, never dropped silently: the reviewer can
// ask for them. (Refused only if what was asked and answered can't fit, which
// their own caps rule out.)
export function minimalTurnRequest({ chat, turnId, prompt, fixTurn, heading, previous, lastMessage, tracked = {}, folder, why }) {
  const { title, request } = turnIntro({ chat, turnId, prompt, fixTurn, heading, lastMessage });
  const list = turnPaths(tracked, folder);
  const base = [title, request, REVIEWER_ROLE, EVERY_TURN_ROLE, earlier(previous), AUTO_REVIEWER, `This turn's own changes: not available (the bridge couldn't put them together: ${why}).`]
    .filter(Boolean)
    .join("\n\n");
  if (!list.length) return base.length <= REQUEST_ROOM ? { text: base, reqPaths: [] } : { error: "even without its changes, the review doesn't fit one message" };
  const intro =
    "Where the changes are: the bridge couldn't list them, so read them yourself, read-only, in these paths (in a git repository, git status and git diff show them). " +
    "Don't open secret files (.env*, keys, certificates, credentials). An approval of this review approves no content: the next review covers these paths again.";
  const more = (n) => `- … and ${n} more tracked path${n === 1 ? "" : "s"} that don't fit one message: ask the requester for them (bridge_send) if you need them.`;
  // as many paths as fit, with room kept for the count of the rest
  let room = REQUEST_ROOM - base.length - 2 - intro.length - 1 - more(list.length).length - 1;
  const shown = [];
  for (const p of list) {
    if (room < p.length + 3) break;
    shown.push(`- ${p}`);
    room -= p.length + 3;
  }
  if (room < 0) return { error: "even without its changes, the review doesn't fit one message" };
  const where = [intro, ...shown, shown.length < list.length && more(list.length - shown.length)].filter(Boolean).join("\n");
  return { text: `${base}\n\n${where}`, reqPaths: [] };
}

// How a turn's review begins: whose turn, what the user asked (or who
// started it), and the agent's final message
function turnIntro({ chat, turnId, prompt, fixTurn, heading, lastMessage }) {
  const asked =
    prompt?.trim() || (fixTurn ? "(None: this turn answers your previous review's changes requested.)" : "(None: the app or a bridge message started this turn, not the user.)");
  return {
    title: `Automatic review of a turn of ${chat}${turnId ? ` (turn ${turnId})` : ""}, sent by the bridge: auto mode reviews every turn.`,
    request: [heading, `User's message:\n${asked}`, `Agent's final message:\n${lastMessage?.trim() || "(no text)"}`].filter(Boolean).join("\n\n"),
  };
}

// the tracked paths, or with none the turn's own folder
const turnPaths = (tracked, folder) => (Object.keys(tracked).length ? Object.keys(tracked) : folder ? [path.resolve(folder)] : []);

// One request, whoever asks: the request, the reviewer's role, the earlier
// answer of a round, the turn's own changes (auto mode's review of a turn),
// then where the changes are. It has to fit one message: pasted diffs go
// first, then the file lists; scope lines, commands, roles and the earlier
// answer are never cut. If it still doesn't fit, it is refused.
function buildRequest({ title, request, previous, plan, auto, roles = [], turn, list, focus = [], includeDiff, intro, tooBig }) {
  // pasted diffs share the room a message has
  const diffRoom = Math.floor(MAX_DIFF / Math.max(1, list.length));
  const described = list.map((p) => describePath(p, { auto, includeDiff, diffRoom }));
  const sections = described.map((d) => d.section);
  const reqPaths = described.map((d) => d.reqPath).filter(Boolean);
  const compose = ({ diffs, lists }) =>
    [title, request, REVIEWER_ROLE, ...roles, earlier(previous), plan && PLAN_GUIDE, auto && AUTO_REVIEWER, turn, whereText(sections, { focus, lists, diffs, intro })]
      .filter(Boolean)
      .join("\n\n");
  const text = [compose({ diffs: true, lists: true }), compose({ diffs: false, lists: true }), compose({ diffs: false, lists: false })].find(
    (t) => t.length <= REQUEST_ROOM,
  );
  if (!text) return { error: tooBig(list.length) };
  return { text, reqPaths };
}

// A turn's own changes, from its start to its end: what changed, and the
// command that shows it (command(shell)). Untracked files are kept by name only.
function turnChanges({ summary, command, gone }) {
  if (summary == null)
    return `This turn's own changes: not available (${gone ? "its snapshots couldn't be read (git may have pruned them, or git failed)" : "no snapshot of its start or its end"}). The paths below show everything since the last approval.`;
  if (!summary) return "This turn's own changes: none.";
  return (
    "This turn's own changes, from its start to its end (review these first; an approval covers everything under \"Where the changes are\"):\n" +
    "```text\n" +
    summary +
    "\n```\n" +
    "Show them (untracked files, and before a repository's first commit its staged files, aren't in it: read them directly, as they are now, not as the turn left them):\n" +
    commandBlocks(command) +
    "\n" +
    "If the command fails, say so in your answer and don't approve what you couldn't read."
  );
}

// Where the reviewer finds the changes: per path, its scope, file list and
// command (and pasted diff, if asked for)
function whereText(sections, { focus = [], lists, diffs, intro }) {
  if (!sections.length) return null;
  return (
    "Where the changes are: read them yourself with the commands below, from these paths only. Run each command whole (the file lists can be cut short). " +
    "Don't open secret files (.env*, keys, certificates, credentials); they're left out on purpose. " +
    `${intro}\n\n` +
    (focus.length ? `Focus on ${focus.join(", ")}; the rest of the folder's changes are listed too, since an approval covers them.\n\n` : "") +
    (lists ? "" : "(The file lists are left out to fit one message; the commands show everything.)\n\n") +
    sections.map((x) => [x.head, lists && x.list, x.how, x.command, diffs && x.diff].filter(Boolean).join("\n")).join("\n\n")
  );
}

// The paths a review looks at: those named, else this chat's folder (none
// for a plan). In auto mode a path inside a tracked folder is reviewed as that
// folder, so an approval never leaves the folder's other changes unaccounted
// for: the reviewer sees all of them, and the named path stays the focus.
export function reviewPaths({ paths, plan, folder, auto }) {
  let list = paths?.length ? paths : plan || !folder ? [] : [folder];
  const focus = [];
  if (auto) {
    const tracked = Object.keys(auto.paths ?? {});
    list = list.map((p) => {
      const abs = path.resolve(p);
      const root = tracked.find((t) => abs !== t && abs.startsWith(t + path.sep));
      if (root) focus.push(abs);
      return root ?? abs;
    });
    list = [...new Set(list)];
  }
  return { list, focus };
}

// One path's part of the request, and in auto mode what its approval would
// cover: its content now and its commit
export function describePath(p, { auto, includeDiff, diffRoom }) {
  let info;
  try {
    info = pathInfo(p);
  } catch {
    info = { path: p, exists: false, git: false };
  }
  const covers = (head) => auto && { path: info.path, fp: fingerprint(info.path, { fresh: true }).hash ?? null, head };
  if (!info.git)
    return {
      section: {
        head:
          `${info.path} (${info.exists ? "not in a git repository" : "not found"}): read the files you need directly. ` +
          "There is no history here, so what changed is only as the request describes it: you can check the current content, not the earlier one.",
      },
      reqPath: covers(null),
    };
  const known = auto?.paths?.[info.path];
  let base = info.head;
  let scope = "uncommitted changes against HEAD";
  if (known?.base && known.base !== info.head) {
    if (usableBase(info, known.base)) {
      base = known.base;
      scope = `everything since ${known.base.slice(0, 12)}, the commit approved last time (later commits included)`;
    } else scope += `; the commit approved last time (${known.base.slice(0, 12)}) isn't on this branch's history any more, so earlier commits aren't covered`;
  }
  if (auto && !known) scope += "; this path is new to this work: commits made here before now are covered only if the request names them";
  let summary;
  try {
    summary = reviewSummary(info, base);
  } catch {
    return { section: { head: `${info.path}: git couldn't list the changes here; read the files the request names directly.` } };
  }
  return {
    section: {
      head: `${info.path} (git: ${scope})`,
      list: "```text\n" + (summary.status || "(no uncommitted changes)") + (summary.stat ? `\n\n${summary.stat}` : "") + "\n```",
      how: "Show the changes (new files, marked ?? in the status, aren't in it: read them directly; run git status --short with the same paths to list them):",
      command: commandBlocks((sh) => pathCommand(info, base, sh)),
      diff: includeDiff && "The changes as text:\n```diff\n" + pathDiff(info, base, diffRoom) + "\n```",
    },
    reqPath: covers(info.head),
  };
}

// A round carries the reviewer's last real answer in this review, since its
// chat may have been compacted since
export const EARLIER_ROOM = 3_000;
export function earlier(previous) {
  if (!previous) return null;
  if (previous.none) return "No earlier answer in this review.";
  if (previous.missing) return "The bridge no longer keeps the earlier answers in this review; if you can't see them, say so.";
  const cut = previous.text.length > EARLIER_ROOM;
  return (
    `Your answer to the previous round (${previous.linkId}):\n` +
    (cut
      ? `${previous.text.slice(0, EARLIER_ROOM)}\n… (cut here: the rest isn't shown. Don't assume points you can't see were resolved; ask the requester if you need them.)`
      : previous.text)
  );
}
