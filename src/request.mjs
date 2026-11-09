// The review request, built from the paths the work changed: what the
// requester asks, and where the reviewer finds the changes itself. Shared by
// bridge_review (the MCP server) and auto mode's every-turn reviews (built by
// the broker), so both read the same way.

import path from "node:path";
import { MAX_DIFF, MAX_TEXT, REVIEWER_ROLE } from "./common.mjs";
import { AUTO_REVIEWER, EVERY_TURN_ROLE } from "./auto.mjs";
import { pathInfo, usableBase, reviewSummary, pathDiff, fingerprint } from "./git.mjs";

// what one review request may take of a message, leaving room for the
// bridge's own header and footer and a round's heading
export const REQUEST_ROOM = MAX_TEXT - 4_000;

// What a plan is reviewed for, sent with the plan (the reviewer thread may be
// one that was briefed for code)
export const PLAN_GUIDE =
  "This is a plan, not finished work: check it reaches the goal; missing or misordered steps; risks; simpler options; scope creep; how the result will be checked.";

// The review request: what the requester asks, and where the reviewer finds
// the changes itself. Nothing is pasted unless asked (include_diff): per
// path, a short status and stat and the command that shows the changes. In
// auto mode a path is compared from the commit it was last approved on (or
// entered on), and its content at this moment is recorded, so an approval
// covers exactly what was asked about.
export function reviewRequest({ side, request, plan, paths, folder, includeDiff, auto, previous }) {
  const { list, focus } = reviewPaths({ paths, plan, folder, auto });
  // pasted diffs share the room a message has
  const diffRoom = Math.floor(MAX_DIFF / Math.max(1, list.length));
  const described = list.map((p) => describePath(p, { auto, includeDiff, diffRoom }));
  const sections = described.map((d) => d.section);
  const reqPaths = described.map((d) => d.reqPath).filter(Boolean);
  // The whole request has to fit one message. Scope lines and commands are
  // never cut: pasted diffs go first, then the file lists; if it still
  // doesn't fit, the request is refused and has to be split.
  const compose = ({ diffs, lists }) =>
    [
      plan ? `Plan review requested by ${side}:` : `Review requested by ${side}:`,
      request.trim(),
      REVIEWER_ROLE,
      earlier(previous),
      plan && PLAN_GUIDE,
      auto && AUTO_REVIEWER,
      whereText(sections, { focus, lists, diffs }),
    ]
      .filter(Boolean)
      .join("\n\n");
  const text = [compose({ diffs: true, lists: true }), compose({ diffs: false, lists: true }), compose({ diffs: false, lists: false })].find(
    (t) => t.length <= REQUEST_ROOM,
  );
  if (!text)
    return { error: `This review doesn't fit one message (${list.length} paths). Split it into smaller reviews, or shorten the request.` };
  return { text, reqPaths };
}

// Where the reviewer finds the changes: per path, its scope, file list and
// command (and pasted diff, if asked for)
function whereText(sections, { focus = [], lists, diffs, intro = "If you can't read a path, say so: the requester will send the changes as text." }) {
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

// The request for one turn that auto mode reviews on its own: what the user
// asked, the agent's final message, the turn's own changes (pasted), and for
// each tracked path what an approval covers, with
// its content recorded now. It has to fit one message: the file lists go
// first, then the pasted changes (their command stays), then the user's and
// the agent's words are cut further; past that it fails and says why. With no
// tracked path, the turn's own folder is used (and recorded).
export function turnRequest({ chat, turnId, prompt, fixTurn, heading, previous, lastMessage, turnChanges, rest, gone, tracked = {}, folder }) {
  const known = Object.keys(tracked);
  const list = known.length ? known : folder ? [path.resolve(folder)] : [];
  const auto = { paths: tracked };
  const described = list.map((p) => describePath(p, { auto, includeDiff: false }));
  const sections = described.map((d) => d.section);
  const reqPaths = described.map((d) => d.reqPath).filter(Boolean);
  const cutTo = (t, room) => (room && t.length > room ? `${t.slice(0, room)}\n… (cut here to fit one message)` : t);
  const asked = (room) =>
    prompt?.trim()
      ? cutTo(prompt.trim(), room)
      : fixTurn
        ? "(None: this turn answers your previous review's changes requested.)"
        : "(None: the app or a bridge message started this turn, not the user.)";
  const changes = (diff) => {
    if (turnChanges == null)
      return gone
        ? "The turn's own changes: not available (its snapshots can't be read any more; git may have pruned them). The paths below show everything since the last approval."
        : "The turn's own changes: not available (no snapshot of its start or its end).";
    const cut = turnChanges.includes("… (diff truncated)");
    if (!diff) return `The turn's own changes are left out to fit one message${rest ? `; show them with:\n\`\`\`sh\n${rest}\n\`\`\`` : "."}`;
    return `The turn's own changes, from its start to its end:\n\`\`\`diff\n${turnChanges}\n\`\`\`` + (cut && rest ? `\nAll of them:\n\`\`\`sh\n${rest}\n\`\`\`` : "");
  };
  const compose = ({ lists, diff, room }) =>
    [
      `Automatic review of a turn of ${chat}${turnId ? ` (turn ${turnId})` : ""}, sent by the bridge: auto mode reviews every turn.`,
      heading,
      earlier(previous),
      `User's message:\n${asked(room)}`,
      `Agent's final message:\n${cutTo(lastMessage?.trim() || "(no text)", room)}`,
      changes(diff),
      REVIEWER_ROLE,
      EVERY_TURN_ROLE,
      AUTO_REVIEWER,
      whereText(sections, { lists, intro: "If you can't read a path, say so in your answer." }),
    ]
      .filter(Boolean)
      .join("\n\n");
  const text = [
    compose({ lists: true, diff: true }),
    compose({ lists: false, diff: true }),
    compose({ lists: false, diff: false }),
    compose({ lists: false, diff: false, room: 2_000 }),
  ].find((t) => t.length <= REQUEST_ROOM);
  if (!text) return { error: `the review of this turn doesn't fit one message even cut short (${list.length} tracked paths)` };
  return { text, reqPaths };
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
      command: "```sh\n" + summary.command + "\n```",
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
