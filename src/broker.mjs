// Shared message broker for the bridge.
//
// Each app (Claude Desktop, ChatGPT Desktop) launches its own stdio MCP server
// process. Whichever process starts first binds 127.0.0.1:PORT and owns the
// state; the others talk to it over HTTP. If the owner exits, the next request
// from a client promotes that client to owner (state is persisted to disk).
//
// Hooks never talk to the broker over the network (Codex sandboxes localhost):
// they read state.json and drop request files into outbox/, which the owner
// ingests. A link is one review: the chat that asks for it (the primary) and
// the chat that answers it (the field `advisor`, a name kept from the advisor
// mode the bridge once had); endpoints are
// { app: "claude"|"openai", id: Claude session id | Codex thread id }.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataDir, openUrl, claudeSessionUrl, chatgptRunningAsync } from "./platform.mjs";
import { autoKey, reviewerOf, standingReviewer, pairedIn } from "./auto.mjs";
import { readConfig } from "./config.mjs";
import { MAX_TEXT, REVIEWER_ROLE } from "./common.mjs";
import { minimalTurnRequest } from "./request.mjs";

export { MAX_TEXT, REVIEWER_ROLE };

export const DATA_DIR = dataDir();
export const STATE_FILE = path.join(DATA_DIR, "state.json");
export const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
export const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
export const LISTENERS_DIR = path.join(DATA_DIR, "listeners");
export const TURNS_DIR = path.join(DATA_DIR, "turns"); // per-chat turn baseline (git) for diffs
const TOKEN_FILE = path.join(DATA_DIR, "token");
const PORT = Number(process.env.AGENT_REVIEW_BRIDGE_PORT || 7457);
// Bumped whenever ops change. An owner running older code (a long-lived helper
// left over from before an update) steps down when a newer client calls.
export const PROTOCOL = Number(process.env.AGENT_REVIEW_BRIDGE_TEST_PROTOCOL || 22);

export const SIDES = ["claude", "openai"];
// Claude Desktop's session ids, as claude://code/continue?session= accepts them
export const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const MAX_PROMPT = 6_000;
// Claude Code's notice that a background task finished, delivered through
// UserPromptSubmit like a prompt (measured)
const HOST_NOTICE = /^\s*<task-notification>/;
// Heads what the user typed while a turn was running, in its review request
const MID_TURN = "Added by the user while the turn was running:";
const MAX_ANSWER = 10_000;
const DECISIONS = ["approved", "changes_requested"];
// Emergency stop for two agents stuck in a fix loop: rounds in a row without
// approval. The primary decides when it's stuck well before this.
const MAX_ROUNDS = () => {
  const n = Number(process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS);
  return Number.isInteger(n) && n > 0 ? n : 20; // a typo mustn't turn the stop off
};
const DAY = 24 * 3600_000;
// bridge_status shows closed links only from the last hour, at most this many
const STATUS_RECENT = { ms: 3600_000, count: 5 };
// free-form peer messages (bridge_send) can ping-pong; links can't
const PEER_BURST = { count: 60, windowMs: 10 * 60_000 };
// How long the bridge follows a prompt queued for a ChatGPT thread, to tell
// the waiting side if its turn fails: first checks, then a slower pace, then a
// deadline. Each read has its own time limit. (Tests scale it down.)
const WATCH_SCALE = Number(process.env.AGENT_REVIEW_BRIDGE_TEST_WATCH_SCALE) || 1;
const WATCH = Object.fromEntries(
  // (limits: how long ChatGPT's usage limits, once read, are taken as they were)
  Object.entries({ first: 15_000, second: 60_000, every: 60_000, deadline: 6 * 3600_000, read: 15_000, stuck: 60_000, approval: 60_000, unheard: 10 * 60_000, limits: 30_000 }).map(([k, v]) => [
    k,
    Math.max(20, v * WATCH_SCALE),
  ]),
);
// How long putting one turn's review together may take (the work tree is
// read in a child process, so the broker's own loop never waits on it)
const jobBudget = () => Number(process.env.AGENT_REVIEW_BRIDGE_TEST_JOB_BUDGET) || 60_000;
const TURN_JOB = fileURLToPath(new URL("./turnjob.mjs", import.meta.url));
// how often one turn's review is sent again after its reviewer couldn't
// answer it; a reviewer that was only unavailable for a while (a usage limit,
// an overload, a delivery that failed) doesn't use up a try, and is given
// more time before each new attempt
const TURN_TRIES = 3;
// ...and how long it keeps trying one that stays unavailable: about a day,
// then the turn is set aside (kept) until the reviewer answers again or auto
// mode gets another (the chat may be gone: new_reviewer)
const turnWaits = () => Number(process.env.AGENT_REVIEW_BRIDGE_TEST_TURN_WAITS) || 24;
// (tests set a shorter unit)
const retryUnit = () => Number(process.env.AGENT_REVIEW_BRIDGE_TEST_RETRY_MS) || WATCH.every;
const backoff = (n) => Math.min(60, 2 ** Math.max(0, n - 1)) * retryUnit();
// at most this many of a chat's turns wait for their review (set aside ones
// included); the oldest waiting go first, their changes in the next review
const MAX_WAITING = 10;
// a failure that only means "not now"
const UNAVAILABLE = /usage limit|usagelimit|rate.?limit|overload|capacity|too many requests|server.?error|unavailable|couldn't be handed|timed? ?out|network/i;

for (const d of [DATA_DIR, OUTBOX_DIR, LISTENERS_DIR, TURNS_DIR]) fs.mkdirSync(d, { recursive: true });

const sameEndpoint = (a, b) => !!a && !!b && a.app === b.app && a.id === b.id;
// an auto mode entry as tools show it: without the turns' own texts
const autoView = ({ jobs, turn, facts, parked, told, ...e }) => ({ ...e, ...(e.everyTurn && { waiting: (jobs ?? []).length, ...(parked?.length && { setAside: parked.length }) }) });

// a chat as the bridge names it to agents
export const chatName = (e) => (e.app === "openai" ? `ChatGPT chat ${e.id}` : `Claude Code session ${e.id}`);
const safeName = (endpoint) => `${endpoint.app}-${endpoint.id.replace(/[^\w.-]/g, "_")}`;

// Read-only view of the broker state for hooks (no broker process needed)
export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export const activeLinks = (state) => Object.values(state?.links ?? {}).filter((l) => l.active);

// Drop a request for the broker owner; atomic so the owner never reads half a file
export function writeOutbox(op, args) {
  const name = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}.json`;
  const tmp = path.join(OUTBOX_DIR, name + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify({ op, args }));
  fs.renameSync(tmp, path.join(OUTBOX_DIR, name));
}

// Messages that should wake a Claude endpoint (read by its listener hook)
export function pendingFor(state, endpoint) {
  return (state?.messages ?? []).filter((m) => sameEndpoint(m.toEndpoint, endpoint) && !m.readAt && (m.wakes ?? 0) < 2 && !advisorLeftover(state, m));
}

// What advisor mode (since removed) left in state: a turn's review, an
// advisory or a stop of an advisor link, and its links' status notes. The
// owner retires them when it takes the state (retireAdvisor); hooks, which
// may read state.json before that, pass them over too.
export const advisorLeftover = (state, m) => m.kind === "advisory" || (state?.links?.[m.linkId]?.mode === "advisor" && ["review-request", "stop"].includes(m.kind));
export const advisorNote = (state, n) => n.kind === "bridge" && state?.links?.[n.linkId]?.mode === "advisor";

export const listenerFile = (endpoint) => path.join(LISTENERS_DIR, `${safeName(endpoint)}.json`);
export const turnFile = (endpoint) => path.join(TURNS_DIR, `${safeName(endpoint)}.json`);

const OUTBOX_OPS = new Set(["turn_start", "turn_end", "turn_facts", "notes_ack", "wake_ack", "auto_prompt", "turn_ok", "turn_failed", "permission_wait"]);

function token() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    const t = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(TOKEN_FILE, t);
    return t;
  }
}

function freshState() {
  return { seq: 0, messages: [], links: {}, linkSeq: 0, notes: [], auto: {}, endpoints: {} };
}

function logEvent(event) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

function listenerAlive(endpoint) {
  try {
    const l = JSON.parse(fs.readFileSync(listenerFile(endpoint), "utf8"));
    return Date.now() - l.beat < 30_000 ? l : null;
  } catch {
    return null;
  }
}

// The bridge's own rule after a plan review, never the reviewer's words: the
// reviewer's verdict is not the user's approval.
export const PLAN_GATE =
  "This was a plan review: show the user the plan as it now stands and the reviewer's verdict, then wait for the user's explicit approval in this chat before implementing anything.";

// What to do with a message, by kind and decision. These are the bridge's
// fixed instructions, never the other agent's words. A plain message is not a
// review request, so it is answered with bridge_send, never bridge_advise.
export function nextStep(m) {
  if (m.kind === "failed") {
    const again = m.retry ? `: to ask the same reviewer, use bridge_review(round_of="${m.retry}").` : ".";
    const told = "Tell the user, in their language, and don't wait for that answer: it isn't coming.";
    // auto mode, a review that wasn't a retry already: one retry of its own
    if (m.retry && m.auto && !m.retried)
      return (
        `${told} Auto mode: if a reset time is given, it's less than an hour away and you're still working then, ask the same reviewer once more yourself ` +
        `with bridge_review(round_of="${m.retry}"); if that fails too, tell the user and don't retry again. Otherwise ask again only if the user wants to.`
      );
    return `${told} Ask again only if the user wants to (after the reset time, if one is given)${again}`;
  }
  if (m.kind === "waiting" && m.maybe) return "Tell the user, in their language, that the other chat may be waiting for their approval in ChatGPT Desktop, and to check it. Don't ask again.";
  if (m.kind === "waiting") return "Tell the user, in their language, that the other chat is waiting for their approval there. Don't ask again: the answer arrives once it's approved.";
  if (m.kind === "review-request") return `Review ${m.plan ? "the plan" : "it"}, then answer once with bridge_advise (request_id ${m.id}).`;
  if (m.kind === "stop") return "Stop the fix loop now: tell the user where it stands and ask how to proceed. Don't keep fixing until they answer.";
  if (m.kind === "review-result" && m.everyTurn)
    return "Fix what holds up; if a finding is wrong, say why instead of complying. Your next turn is reviewed on its own: don't ask for a review yourself. If you're going in circles or the rest needs a decision, stop and ask the user.";
  if (m.kind === "review-result") {
    const step =
      m.decision === "approved"
        ? "Approved; the nits are optional."
        : m.lastRound
          ? "Changes requested, and that was the last round allowed: stop and ask the user how to proceed."
          : m.decision === "changes_requested"
            ? `Fix what holds up; if a finding is wrong, say why instead of complying. Then ask for the next round with bridge_review(round_of="${m.linkId}"), saying what you changed and where you disagree. If you're going in circles or the rest needs a decision, stop and ask the user.`
            : "Weigh it, act on what holds up, and tell the user what you changed or why you didn't.";
    if (!m.plan) return step;
    return m.noGate ? `${step} This was a plan you consulted on in auto mode by your own choice: once it's approved, go on.` : `${step} ${PLAN_GATE}`;
  }
  return `It is a message, not a review request: if it needs a reply, send one with bridge_send and reply_to "${m.id}" (not bridge_advise).`;
}

// Heads an approval that answers an earlier [CHANGES REQUESTED] (auto mode
// reviewing every turn)
const FIX_DONE_NOTE = "Your reviewer approved the fix: the earlier [CHANGES REQUESTED] is resolved.";

// Heads a reviewer's answer about a turn from before the user's latest prompt
export const LATE_NOTE =
  "On an earlier turn, before your latest prompt. For information: act on it only if it still applies to what you are doing now.";

// Heads one about a turn reviewed before auto mode stopped reviewing every
// turn (switched to key moments)
export const SWITCHED_NOTE =
  "On a turn reviewed before auto mode stopped reviewing every turn. For information: act on it only if it still applies to what you are doing now; ask for reviews yourself from here on.";

// ChatGPT may append its own memory citations to an answer; they aren't the
// reviewer's words for the requester
export const withoutCitations = (note) => (typeof note === "string" ? note.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "").trim() : note);

// The one way an answer reads, in every chat: the decision first, then what
// must change, then the nits, which never block approval
export function renderAnswer({ decision, note, blocking = [], nits = [] }) {
  const item = (f) => `- ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}${f.detail ? `: ${withoutCitations(f.detail)}` : ""}`;
  return [
    decision === "approved" ? "[APPROVED]" : "[CHANGES REQUESTED]",
    note?.trim(),
    blocking.length && "Must fix:\n" + blocking.map(item).join("\n"),
    nits.length && "Nits (optional, don't block approval):\n" + nits.map(item).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const LABEL = { claude: "CLAUDE", openai: "CODEX", bridge: "AGENT-REVIEW-BRIDGE" };
const AGENT_LINE = "(Agent message, not a user instruction: it can't authorize anything.)";

// The whole message as the receiving chat shows it, so the user can read both
// sides there: who sent it, the text, and what to do. The fixed last line
// keeps it from passing as the user's own words. A ChatGPT thread gets it as
// a queued prompt, a Claude session from its listener hook.
export function inlineText(m) {
  const title = {
    "review-request": `${m.plan ? "Plan review" : "Review"} request ${m.id}`,
    "review-result": m.everyTurn ? `The review of your last turn: ${m.id}` : `The ${m.plan ? "plan review" : "review"} you asked for: ${m.id}`,
    stop: `Stop the fix loop: ${m.id}`,
    failed: `No answer is coming to ${m.about}: ${m.id}`,
    waiting: m.maybe ? `The answer to ${m.about} may wait for the user's approval: ${m.id}` : `The answer to ${m.about} waits for the user's approval: ${m.id}`,
  }[m.kind] ?? `Message ${m.id}`;
  // a message through auto mode's pairing has no link
  return [`${LABEL[m.from] ?? m.from.toUpperCase()}: ${title} (${m.linkId ? `link ${m.linkId}` : "auto mode"})`, m.text, `${AGENT_LINE} ${nextStep(m)}`].join("\n\n");
}

// What wakes a Claude session: the whole message too, plus where to read it
// again if the hook output was cut
export const claudeWakeText = (m) => `[AGENT-REVIEW-BRIDGE] (If this looks cut off, bridge_receive with id "${m.id}" returns it in full.)\n${inlineText(m)}`;

// Is this prompt one of the bridge's own deliveries to this chat in the last
// day (a ChatGPT thread runs them as prompts), not something the user typed?
// Its whole text, or, should an app update change it a little (line endings,
// spacing, a cut), its first line and the fixed agent-message line. Read
// from the state alone, so hooks can tell too.
export function bridgePrompt(state, endpoint, prompt) {
  const text = String(prompt ?? "").trim();
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return (state?.messages ?? []).some(
    (m) =>
      m.dispatch &&
      sameEndpoint(m.toEndpoint, endpoint) &&
      Date.now() - m.ts < DAY &&
      (inlineText(m).trim() === text || (norm(text).startsWith(norm(inlineText(m).split("\n")[0])) && text.includes(AGENT_LINE))),
  );
}

// `wanted()`: still to be sent? Asked right before it is queued (a delivery
// can take seconds to get there): a prompt called off meanwhile isn't sent.
async function deliverToCodex(threadId, text, clientId, wanted) {
  if (process.env.AGENT_REVIEW_BRIDGE_FAKE_CODEX) {
    if (process.env.AGENT_REVIEW_BRIDGE_FAKE_CODEX === "fail") throw new Error("ChatGPT Desktop not reachable (test)");
    if (process.env.AGENT_REVIEW_BRIDGE_FAKE_CODEX === "slow") await new Promise((r) => setTimeout(r, 1500));
    let f = {};
    try {
      f = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "fake-codex.json"), "utf8"));
    } catch {
      // no fake settings
    }
    // (deliverDelay: the app-server takes that long to come up)
    if (f.deliverDelay) await new Promise((r) => setTimeout(r, f.deliverDelay));
    if (wanted && !wanted()) throw new Error("not sent: called off before it was queued");
    logEvent({ op: "fake-codex-deliver", threadId, text, clientId });
    if (f.deliverHang) await new Promise(() => {});
    if (f.deliverRejectAfter) {
      await new Promise((r) => setTimeout(r, f.deliverRejectAfter));
      throw new Error("no answer from ChatGPT Desktop within 60 s (test)");
    }
    return;
  }
  const { sendToThread } = await import("./codex.mjs");
  await sendToThread(threadId, text, { clientId, deadlineMs: 60_000, wanted });
}

// The prompts whose fate the bridge follows: a review's request (its
// requester waits for the answer) and plain messages, never the bridge's own
// notices
const watched = (m) => m.kind === "review-request" || m.kind === "message";

// One turn's review, put together in a child process (src/turnjob.mjs) so the
// broker's loop doesn't wait on git and file reads: { text, reqPaths } or
// { error }, never later than its time budget
function buildTurn(input) {
  const budget = jobBudget();
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(process.execPath, [TURN_JOB], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (e) {
      return resolve({ error: String(e.message || e) });
    }
    let out = "";
    const timer = setTimeout(() => {
      p.kill();
      resolve({ error: `putting it together took longer than ${Math.max(1, Math.round(budget / 1000))} s` });
    }, budget);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: String(e.message || e) });
    });
    p.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ error: "putting it together gave no result" });
      }
    });
    p.stdin.on("error", () => {}); // a child that died early
    p.stdin.end(JSON.stringify(input));
  });
}

// ---------------------------------------------------------------- owner side

class BrokerState {
  constructor() {
    try {
      this.s = { ...freshState(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
    } catch {
      this.s = freshState();
    }
    delete this.s.widgets; // left over from the MCP Apps panel spike
    // auto mode's reviewer was a ChatGPT thread id before it could be a chat
    // in either app
    for (const e of Object.values(this.s.auto ?? {}))
      if (e && e.reviewer === undefined) {
        e.reviewer = reviewerOf(e);
        delete e.thread;
      }
  }

  // Advisor links left from before advisor mode was removed (auto mode
  // reviewing every turn replaces it): closed, each primary told once, and
  // what of theirs hasn't reached its chat (a turn's review, an advisory, a
  // stop) is never sent, nor its status notes shown. Something that did
  // reach its chat (handed to a ChatGPT thread, or read by a Claude session)
  // can't be taken back: an answer to it is refused, as on any closed link.
  // Plain messages and the advisor's own notes go as before. True if
  // anything changed.
  retireAdvisor() {
    const now = Date.now();
    let changed = false;
    for (const l of Object.values(this.s.links)) {
      if (l.mode !== "advisor") continue;
      if (l.lastPrompt) delete l.lastPrompt;
      if (!l.active) continue;
      Object.assign(l, { active: false, closedAt: now });
      this.note(
        l.primary,
        `${l.id}:advisor-gone`,
        `This chat's advisor link ${l.id} was closed: advisor mode has been removed from the bridge. To have every turn reviewed again, turn on auto mode reviewing every turn (bridge_auto with on and every_turn). An answer the advisor still sends to an earlier request is refused.`,
      );
      changed = true;
    }
    for (const m of this.s.messages) if (advisorLeftover(this.s, m) && this.dropUndelivered(m, "advisor mode removed")) changed = true;
    // their status notes not yet shown (a delivery that failed, an advisor
    // not listening) no longer hold; the advisor's own notes still come
    const notes = this.s.notes.filter((n) => n.deliveredAt || !advisorNote(this.s, n));
    if (notes.length !== this.s.notes.length) {
      this.s.notes = notes;
      changed = true;
    }
    if (changed) logEvent({ op: "advisor-retired" });
    return changed;
  }

  // A message not handed to its chat yet is never sent: one for a ChatGPT
  // thread is taken out of delivery, one for a Claude session counts as read,
  // so its listener never wakes it. One that reached its chat (handed to the
  // thread, or read) can't be taken back. True if it was dropped.
  dropUndelivered(m, why) {
    const reached = m.toEndpoint?.app === "openai" ? m.dispatch?.state === "sent" : !!m.readAt;
    if (reached || m.dropped) return false;
    if (m.toEndpoint?.app === "openai") m.dispatch = { ...m.dispatch, state: "dropped", at: Date.now() };
    m.readAt ??= Date.now();
    m.dropped = why;
    if (m.watch) m.watch.done = true;
    return true;
  }

  // Bounded state: read messages and delivered notes go after a day, anything
  // after a week; closed links after a week; a link keeps its last 50
  // advisories. Unread messages, and review requests still waiting for their
  // answer (read, or already handed to a ChatGPT thread), are only ever
  // dropped by age, never by count.
  prune() {
    const s = this.s;
    const now = Date.now();
    const open = (m) => m.kind === "review-request" && !m.answeredAt && s.links[m.linkId]?.active;
    const done = (m) => m.readAt && !open(m);
    const fresh = s.messages.filter((m) => !(done(m) && now - m.readAt > DAY) && now - m.ts < 7 * DAY);
    const keepRead = new Set(fresh.filter(done).slice(-500));
    s.messages = fresh.filter((m) => !done(m) || keepRead.has(m));
    s.notes = s.notes.filter((n) => !(n.deliveredAt && now - n.deliveredAt > DAY) && now - n.at < 7 * DAY);
    for (const [k, e] of Object.entries(s.endpoints ?? {})) if (now - Math.max(e.lastOkAt ?? 0, e.lastFailure?.at ?? 0) > 7 * DAY) delete s.endpoints[k];
    for (const [id, l] of Object.entries(s.links)) {
      if (!l.active && now - (l.closedAt ?? l.createdAt) > 7 * DAY) delete s.links[id];
      else l.advisories = (l.advisories ?? []).slice(-50);
    }
  }

  save() {
    this.prune();
    // which version wrote it: an older one that knows this doesn't take it over
    this.s.protocol = PROTOCOL;
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.s, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }

  handle(op, a, outboxFile) {
    const fn = this["op_" + op];
    if (!fn) throw new Error(`unknown op: ${op}`);
    const result = fn.call(this, a);
    // saved with the change it made, so an owner that dies before removing
    // the file doesn't apply it twice after a takeover
    if (outboxFile) this.s.outboxDone = [...(this.s.outboxDone ?? []), outboxFile].slice(-500);
    this.save();
    this.dispatch();
    return result;
  }

  // Requests hooks left in outbox/ (only the ops hooks are allowed to make)
  ingestOutbox() {
    let files;
    try {
      files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const f of files) {
      const file = path.join(OUTBOX_DIR, f);
      try {
        const { op, args } = JSON.parse(fs.readFileSync(file, "utf8"));
        if (this.s.outboxDone?.includes(f)) logEvent({ op: "outbox-replay-skipped", file: f });
        else if (OUTBOX_OPS.has(op)) this.handle(op, args ?? {}, f);
        else logEvent({ op: "outbox-rejected", file: f, requested: op });
      } catch (e) {
        logEvent({ op: "outbox-error", file: f, error: String(e.message || e) });
      }
      fs.rmSync(file, { force: true });
    }
  }

  // Codex endpoints are woken through the app's thread queue; Claude endpoints
  // by their listener hook, which watches state.json itself
  dispatch() {
    const due = [];
    for (const m of this.s.messages) {
      // a "sending" left behind by an owner that died mid-send is retried,
      // unless its turn already ran (the thread had it after all)
      const stuck = ["sending", "checking"].includes(m.dispatch?.state) && Date.now() - m.dispatch.at > WATCH.stuck;
      if (m.toEndpoint?.app !== "openai" || (m.dispatch && !stuck && m.dispatch.state !== "resend")) continue;
      if (stuck && m.promptMatched) {
        m.dispatch = { ...m.dispatch, state: "sent", at: Date.now() };
        m.readAt ??= Date.now();
        continue;
      }
      // the queueing may have gone through: ask the thread before sending again
      if (stuck && m.dispatch.clientId) {
        this.reconcile(m);
        continue;
      }
      // the id its turn will carry, and the watch, are recorded before the
      // prompt is queued: the turn can fail before queueing even returns. A
      // resend keeps the id, so the turn is still found.
      const clientId = m.dispatch?.clientId ?? crypto.randomUUID();
      m.dispatch = { state: "sending", at: Date.now(), clientId, attempt: (m.dispatch?.attempt ?? 0) + 1 };
      if (watched(m) && !m.watch) m.watch = { clientId, since: Date.now(), next: Date.now() + WATCH.first, checks: 0 };
      else if (m.watch) Object.assign(m.watch, { clientId, next: Date.now() + WATCH.first });
      due.push(m);
    }
    if (!due.length) return;
    // on disk before the thread can run it, so an owner that takes over still
    // knows the prompt is the bridge's
    this.save();
    for (const m of due) {
      // an answer counts only for the attempt it belongs to, on a live owner:
      // a late one from an earlier attempt can't undo what the thread confirmed
      const { attempt } = m.dispatch;
      const current = () => !this.retired && m.dispatch.attempt === attempt && m.dispatch.state === "sending";
      // (called off meanwhile, as when auto mode is turned off: not queued at all)
      deliverToCodex(m.toEndpoint.id, inlineText(m), m.dispatch.clientId, current).then(
        () => {
          if (!current()) return;
          m.dispatch = { ...m.dispatch, state: "sent", at: Date.now() };
          // the text is in the thread itself now (its queue, then its
          // history), so bridge_receive has nothing left to hand over
          m.readAt ??= Date.now();
          this.health(m, true);
          logEvent({ op: "dispatch", id: m.id, to: m.toEndpoint, ok: true });
          this.save();
        },
        (e) => {
          if (!current()) return;
          const error = String(e.message || e);
          logEvent({ op: "dispatch", id: m.id, to: m.toEndpoint, ok: false, error });
          // a watched one may have been queued anyway (a timeout): ask the
          // thread before telling whoever waits
          if (m.watch) return this.reconcile(m, error);
          m.dispatch = { ...m.dispatch, state: "error", at: Date.now(), error };
          this.health(m, false, error);
          this.save();
        },
      );
    }
  }

  // A send whose outcome isn't known: one that never reported back (its owner
  // died), or one that failed with `sendError` (it may have been queued all
  // the same). If the thread has the prompt (queued, or a turn carries its
  // id), it was sent. With no trace of it among the latest turns or the queue,
  // a send that never reported back goes again with the same id, and one that
  // failed is told to whoever waits. If the thread can't be read, nothing is
  // decided: a failed send stays "unconfirmed" and the watch settles it (a
  // trace of it later, a failed turn, no trace, or the deadline); one that
  // never reported back waits for the next try.
  async reconcile(m, sendError = null) {
    const attempt = (m.dispatch.attempt ?? 0) + 1;
    m.dispatch = { ...m.dispatch, state: "checking", at: Date.now(), attempt };
    this.save();
    let r = null;
    try {
      const { turnOf } = await import("./codex.mjs");
      r = await turnOf(m.toEndpoint.id, m.dispatch.clientId, { timeoutMs: WATCH.read });
    } catch (e) {
      logEvent({ op: "reconcile", id: m.id, error: String(e.message || e) });
    }
    if (this.retired || m.dispatch.attempt !== attempt || m.dispatch.state !== "checking") return;
    if (r && r.state !== "unknown") {
      m.dispatch = { ...m.dispatch, state: "sent", at: Date.now() };
      m.readAt ??= Date.now();
    } else if (sendError && r) this.notHanded(m, sendError);
    else if (sendError) m.dispatch = { ...m.dispatch, state: "unconfirmed", at: Date.now(), error: sendError };
    else m.dispatch = { ...m.dispatch, state: r ? "resend" : "sending", at: Date.now() };
    logEvent({ op: "reconcile", id: m.id, found: r?.state ?? null });
    this.save();
    this.dispatch();
  }

  // the thread has no trace of a send that failed: whoever waits is told
  notHanded(m, error) {
    m.dispatch = { ...m.dispatch, state: "error", at: Date.now(), error };
    this.health(m, false, error, { note: false });
    this.fail(m, `it couldn't be handed to ChatGPT Desktop (${error})`, { unavailable: true });
  }

  // ----------------------------------------------------- no answer coming
  // A watched prompt's turn in its ChatGPT thread: checked early, then less
  // often, until it is settled or the deadline passes. The record lives in
  // state.json, so a new owner picks it up; a read never blocks the deadline,
  // and a read started by an owner that has since stepped down is dropped.
  watchTick() {
    const now = Date.now();
    let changed = false;
    // turn reviews held back (no reviewer yet, a usage limit) go once they can
    this.runJobs();
    // a turn review that waits on a Claude reviewer that isn't listening: told
    // once, as a note (it may only be busy with a long review)
    for (const m of this.s.messages) {
      const link = this.s.links[m.linkId];
      if (!link?.everyTurn || !link.active || m.kind !== "review-request" || m.toEndpoint?.app !== "claude") continue;
      // woken with it, then neither answered nor ended its turn (the user
      // stopped that turn: no Stop runs) for as long as a ChatGPT reviewer
      // gets: no answer is coming, it is sent again (the next turn's review
      // waits for this one)
      if (m.wokenAt && !m.answeredAt && !m.settledAt && now - m.wokenAt > WATCH.deadline) {
        this.fail(m, `it was woken with it and gave no answer within ${Math.round(WATCH.deadline / 3600_000)} hours`);
        changed = true;
        continue;
      }
      if (m.readAt || m.unheardTold) continue;
      if (now - m.ts > WATCH.unheard && !listenerAlive(m.toEndpoint)) {
        m.unheardTold = now;
        const before = this.s.notes.length;
        this.note(
          link.primary,
          `auto:${autoKey(link.primary)}:unheard`,
          `Your reviewer, the Claude Code session ${m.toEndpoint.id}, isn't listening right now: the reviews of your turns wait for it, and go to it once it is open in Claude Desktop.`,
        );
        changed ||= this.s.notes.length !== before;
      }
    }
    for (const m of this.s.messages) {
      const w = m.watch;
      if (!w || w.done || !w.clientId) continue;
      const reading = w.inFlight && now - w.inFlight < 2 * WATCH.read + 1000;
      if (this.settled(m)) {
        w.done = true;
        changed = true;
      } else if (now - Math.max(w.since, w.queuedAt ?? 0) > WATCH.deadline) {
        // past the deadline, counted from when it was last seen still in the
        // thread's queue: one more read decides, never the clock alone (a
        // machine that slept, an owner that was down)
        if (!reading) {
          w.inFlight = now;
          w.final = true;
          this.readTurn(m);
        }
      } else if (now >= w.next && !reading) {
        w.inFlight = now;
        this.readTurn(m);
      }
    }
    if (changed) this.save();
  }

  async readTurn(m) {
    const w = m.watch;
    let r = null;
    let error = null;
    try {
      const { turnOf } = await import("./codex.mjs");
      r = await turnOf(m.toEndpoint.id, w.clientId, { timeoutMs: WATCH.read });
    } catch (e) {
      error = String(e.message || e);
    }
    if (this.retired || w.done) return;
    w.inFlight = null;
    w.checks++;
    w.next = Date.now() + (w.checks === 1 ? WATCH.second - WATCH.first : WATCH.every);
    // the deadline's read: a request still waiting in the thread's queue goes
    // on waiting (it is sent nowhere else); anything else not over by now
    // gets no answer, unreadable included
    const final = w.final;
    w.final = false;
    if (!error && r?.state === "queued") w.queuedAt = Date.now();
    const pastDeadline = () => this.fail(m, `no answer was confirmed within ${Math.round(WATCH.deadline / 3600_000)} hours`);
    // a turn still running in the desktop app reads as "interrupted" from
    // another process; only a turn with an end time is over
    // a send whose outcome wasn't known: a trace of it confirms it, none
    // (the thread read fine) means it never got there
    if (!error && m.dispatch?.state === "unconfirmed") {
      if (r.state === "unknown") {
        this.notHanded(m, m.dispatch.error);
        return this.save();
      }
      m.dispatch = { ...m.dispatch, state: "sent", at: Date.now() };
    }
    // not known to be over (running, queued, unreadable): the reviewer may be
    // waiting on an approval nobody sees
    if (!r?.completedAt)
      try {
        await this.checkApproval(m);
      } catch (e) {
        logEvent({ op: "approval-check", id: m.id, error: String(e.message || e) });
      }
    if (error) {
      logEvent({ op: "watch", id: m.id, error });
      if (final) pastDeadline();
    } else if (!r.completedAt) {
      // not over yet: past the deadline, only a queued one waits on
      if (final && r.state !== "queued") pastDeadline();
    } else if (r.state === "failed" || r.state === "interrupted") {
      const e = r.error;
      this.fail(m, `its turn ${r.state === "failed" ? "failed" : "was interrupted (someone may have stopped it in the app)"}${e?.message ? `: ${e.message}` : ""}${e?.codexErrorInfo && typeof e.codexErrorInfo === "string" ? ` (${e.codexErrorInfo})` : ""}`, {
        unavailable: r.state === "failed" && UNAVAILABLE.test(`${e?.message ?? ""} ${typeof e?.codexErrorInfo === "string" ? e.codexErrorInfo : ""}`),
      });
    } else if (r.state === "completed") {
      if (m.kind === "review-request" && !this.settled(m)) this.fail(m, "the reviewer's turn ended without an answer");
      else w.done = true;
    }
    this.save();
  }

  // Done with: a review answered or no longer open, a message replied to
  settled(m) {
    if (m.failure) return true;
    if (m.kind === "review-request") return !!m.answeredAt || !this.s.links[m.linkId]?.active;
    return this.s.messages.some((r) => r.replyTo === m.id);
  }

  // Tell whoever waits on m that no answer is coming. Once per message; never
  // for an answered review, a replied message or the bridge's own notices (two
  // unavailable sides can't bounce them); a review's link closes, a plain
  // message's link stays as it is.
  fail(m, why, { unavailable = false } = {}) {
    const link = this.s.links[m.linkId];
    if (!watched(m) || this.settled(m)) return;
    let to = m.fromEndpoint;
    if (m.kind === "review-request") {
      Object.assign(link, { active: false, closedAt: Date.now(), decision: "failed" });
      to = link.primary;
    }
    m.failure = { at: Date.now(), why };
    if (m.watch) m.watch.done = true;
    if (!to) return;
    const who = m.toEndpoint.app === "openai" ? `The ChatGPT chat ${m.toEndpoint.id}` : `The Claude Code session ${m.toEndpoint.id}`;
    const what = m.kind === "review-request" ? "review result" : "reply";
    const text = `${who} can't answer ${m.id}: ${why}. No ${what} was received.`;
    const review = m.kind === "review-request";
    // a turn auto mode reviewed on its own: a note, not a wake, so a failing
    // reviewer can't start a turn that is reviewed (and fails) again. The
    // next turn is reviewed as usual.
    // the request that only bound auto mode's reviewer: nothing to send again
    // or tell (the reviewer is bound already)
    if (link?.everyTurn && review && link.bind) {
      logEvent({ op: "failed", id: m.id, why, bind: true });
      return;
    }
    if (link?.everyTurn && review) {
      // the same turn's review is sent again once the reviewer can answer (at
      // ChatGPT's usage limit it waits for the reset), a few times at most;
      // the chat isn't woken and no fix round is used up
      const entry = this.s.auto?.[autoKey(link.primary)];
      // one note per turn while it is sent again (not one per try), one when it's left
      const turnKey = `auto:${autoKey(link.primary)}:retry:${link.turn?.endAt ?? link.id}`;
      const tries = (link.turn?.tries ?? 1) + (unavailable ? 0 : 1);
      const waits = (link.turn?.waits ?? 0) + (unavailable ? 1 : 0);
      const live = link.turn && entry?.on && entry.everyTurn && entry.since === link.autoSince;
      const tooLong = waits > turnWaits();
      const again = live && tries <= TURN_TRIES && !tooLong;
      const job = live && { ...link.turn, id: "j" + ++this.s.seq, tries, waits, retry: link.id };
      if (again) {
        (entry.jobs ??= []).unshift({ ...job, waitUntil: Date.now() + (unavailable ? backoff(waits) : retryUnit()) });
        setImmediate(() => this.runJobs());
      }
      // unavailable for too long: set aside, kept, out of the way of later turns
      const parked = live && unavailable && tooLong;
      if (parked) (entry.parked ??= []).push(job);
      if (again || parked) this.capWaiting(entry, to);
      delete link.turn; // the queued try has it now, or it isn't sent again
      this.dropWaitingNote(link.id);
      this.note(
        to,
        `${turnKey}:${again ? "again" : "left"}`,
        `${text} It was the review of one of your turns: ` +
          (again
            ? "it is sent again once the reviewer can answer."
            : parked
              ? "the reviewer has been unavailable for too long, so it is set aside and kept: it goes once the reviewer answers again, or once auto mode has another (bridge_auto with new_reviewer, if that chat is gone). Later turns are sent as usual."
              : "it isn't sent again; later turns are reviewed as usual."),
      );
      logEvent({ op: "failed", id: m.id, why, everyTurn: true, ...(again && { again: tries }), ...(unavailable && { unavailable: true }) });
      return;
    }
    // a plain message that got no reply, told to a chat in every-turn auto
    // mode: a note too, not a wake (a review it asked for itself still wakes
    // it, with how to ask again)
    if (m.kind === "message" && this.everyTurn(to)) {
      this.note(to, `${m.id}:failed`, text);
      logEvent({ op: "failed", id: m.id, why, note: true });
      return;
    }
    this.post({
      from: "bridge",
      toEndpoint: to,
      kind: "failed",
      linkId: m.linkId,
      text,
      about: m.id,
      retry: review ? link.id : undefined,
      // still the auto mode session the review was asked in
      auto: review && link.autoSince != null && link.autoSince === this.autoSession(link.primary) ? true : undefined,
      retried: review && link.retry ? true : undefined,
    });
    logEvent({ op: "failed", id: m.id, why });
  }

  // Delivery outcome per link; failures reach the chat that is waiting on it
  // with its next prompt (unless it is woken with a notice instead)
  health(m, ok, error, { note = true } = {}) {
    const link = this.s.links[m.linkId];
    // a message through auto mode's pairing (no link): its sender is told
    if (!link) {
      if (!ok && note && m.channel)
        this.note(m.fromEndpoint, `${m.id}:delivery`, `Couldn't hand message ${m.id} to the ChatGPT thread ${m.toEndpoint.id}: ${error}. Is ChatGPT Desktop installed and signed in?`);
      return;
    }
    link.health = { at: Date.now(), ok, ...(error && { error, message: m.id }) };
    if (ok || !note) return;
    const waiting = m.kind === "review-request" ? link.primary : link.advisor;
    this.bridgeNote(link, waiting, `delivery:${m.kind}`, `Couldn't hand ${m.kind} ${m.id} to the ChatGPT thread ${m.toEndpoint.id}: ${error}. Is ChatGPT Desktop installed and signed in?`);
  }

  // Status notes from the bridge itself, shown with the chat's next prompt;
  // one per key until delivered
  bridgeNote(link, to, key, text) {
    if (!to) return;
    const fullKey = `${link.id}:${key}`;
    if (this.s.notes.some((n) => n.key === fullKey && !n.deliveredAt)) return;
    this.s.notes.push({ id: "n" + ++this.s.seq, linkId: link.id, to, kind: "bridge", key: fullKey, text, at: Date.now(), deliveredAt: null });
  }

  op_status({ endpoint } = {}) {
    const s = this.s;
    const mine = (l) => !endpoint || sameEndpoint(l.primary, endpoint) || sameEndpoint(l.advisor, endpoint);
    // open links, and the few that closed in the last hour (a review that
    // was just answered); older ones are only counted
    const all = Object.values(s.links).filter(mine);
    const open = all.filter((l) => l.active);
    const recent = all
      .filter((l) => !l.active && Date.now() - (l.closedAt ?? l.createdAt) < STATUS_RECENT.ms)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, STATUS_RECENT.count);
    return {
      messages: s.messages.length,
      unread: Object.fromEntries(SIDES.map((x) => [x, s.messages.filter((m) => m.to === x && !m.readAt).length])),
      olderLinks: all.length - open.length - recent.length,
      links: [...open, ...recent]
        .map(({ advisories, request, reqPaths, turn, ...l }) => ({
          ...l,
          advisories: advisories?.length ?? 0,
          lastAdvice: advisories?.at(-1) ?? null,
          // Claude endpoints need a live listener hook to be woken
          listening: Object.fromEntries(["primary", "advisor"].filter((r) => l[r]?.app === "claude").map((r) => [r, !!listenerAlive(l[r])])),
        })),
      pendingNotes: s.notes.filter((n) => !n.deliveredAt && (!endpoint || sameEndpoint(n.to, endpoint))).length,
      // the last observed failure of each chat this one is linked with
      lastFailures: Object.fromEntries(
        Object.values(s.links)
          .filter((l) => l.active && mine(l))
          .flatMap((l) => [l.primary, l.advisor])
          .filter((e) => e && !sameEndpoint(e, endpoint) && s.endpoints?.[autoKey(e)]?.lastFailure)
          .map((e) => [autoKey(e), s.endpoints[autoKey(e)].lastFailure]),
      ),
      // auto mode, without the turns' own texts
      ...(endpoint &&
        s.auto?.[autoKey(endpoint)] && {
          auto: autoView(s.auto[autoKey(endpoint)]),
        }),
    };
  }

  // ------------------------------------------------------------ auto mode
  // Per chat: on/off, the reviewer it keeps using (a chat in either app), and
  // per path the content last approved and the commit to compare from. A
  // path enters when auto mode is turned on (the chat's folder, as it is then)
  // or when a review names it.

  op_auto_set({ endpoint, on, reviewer, model, effort, paths, everyTurn, joinReviewer }) {
    if (!endpoint?.app || !endpoint?.id) throw new Error("this chat is unknown");
    const key = autoKey(endpoint);
    if (!on) {
      // turns still waiting for their review go with it, and the reviews of
      // its turns still open close: one not handed to the reviewer yet is
      // never sent, and an answer to one that was is refused
      if (this.s.auto?.[key]) Object.assign(this.s.auto[key], { on: false, jobs: [], parked: [], turn: null });
      for (const l of Object.values(this.s.links)) {
        if (!l.active || !l.everyTurn || !sameEndpoint(l.primary, endpoint)) continue;
        Object.assign(l, { active: false, closedAt: Date.now() });
        delete l.turn;
        delete l.request;
        for (const m of this.s.messages) if (m.linkId === l.id && m.kind === "review-request") this.dropUndelivered(m, "auto mode turned off");
      }
      return { on: false };
    }
    const prev = this.s.auto?.[key];
    // turned on again after it was off: a fresh start, with a new reviewer
    // chat (unless one is named) and the paths as they are now. While on, the
    // same entry is changed in place, so a turn's review being put together
    // sees what changed meanwhile.
    const entry = prev?.on ? prev : { paths: {}, turns: 0, on: true, since: Date.now(), reviewer: null, generation: 0 };
    // codes from an earlier session's first review can't bind this one: closed
    if (!prev?.on)
      for (const l of Object.values(this.s.links))
        if (l.active && l.autoReviewer && !l.advisor && sameEndpoint(l.primary, endpoint)) {
          Object.assign(l, { active: false, closedAt: Date.now() });
          delete l.request;
          if (!l.bind)
            this.note(endpoint, `${l.id}:closed`, `Review ${l.id} was waiting for a chat to join with its code; it was closed when auto mode was turned on again, and no answer is coming. Ask again if it's still needed.`);
        }
    if (reviewer !== undefined) {
      const changed = !sameEndpoint(reviewerOf(entry), reviewer);
      entry.reviewer = reviewer;
      if (changed) this.unpark(entry); // another reviewer, or none yet: it waits for the next
    }
    // every turn reviewed on its own, or the agent asks at key moments; what
    // was approved stays when it switches
    if (everyTurn !== undefined && !!everyTurn !== !!entry.everyTurn) {
      entry.everyTurn = !!everyTurn;
      Object.assign(entry, { jobs: [], parked: [], turn: null, rounds: 0, stopped: false, chain: null });
    }
    if (model !== undefined) entry.model = model;
    if (effort !== undefined) entry.effort = effort;
    // its reviewer is the chat that joins with a code, in either app, instead
    // of a ChatGPT chat the bridge makes (from Claude; from ChatGPT it always is)
    if (joinReviewer !== undefined) entry.joinReviewer = !!joinReviewer;
    // paths named when turning it on start from their state at that moment
    for (const p of paths ?? []) entry.paths[p.path] ??= { approved: p.fp, base: p.head ?? null };
    this.s.auto = { ...(this.s.auto ?? {}), [key]: entry };
    return autoView(entry);
  }

  // the reviewer chat auto mode keeps using, once the bridge has made it, and
  // the model and effort it was made with if auto mode wasn't given them
  op_auto_reviewer({ endpoint, reviewer, model, effort }) {
    const entry = this.s.auto?.[autoKey(endpoint)];
    if (!entry?.on) return { ok: true };
    entry.reviewer = reviewer;
    this.unpark(entry);
    if (model && entry.model == null) entry.model = model;
    if (effort && entry.effort == null) entry.effort = effort;
    return { ok: true };
  }

  // A path first named in a review enters at the commit it is on: work
  // committed there before is the requester's to name
  registerPaths(endpoint, reqPaths) {
    const entry = this.s.auto?.[autoKey(endpoint)];
    if (!entry?.on) return;
    for (const p of reqPaths ?? []) entry.paths[p.path] ??= { approved: null, base: p.head ?? null };
  }

  approvePaths(link) {
    const entry = this.s.auto?.[autoKey(link.primary)];
    // a late answer to a review asked before auto mode was turned off and on
    // again doesn't touch the new session's paths
    if (!entry?.on || link.autoSince !== entry.since) return;
    for (const p of link.reqPaths ?? []) {
      // content changed while the review ran, or couldn't be read: nothing new is approved
      if (!p.fp) continue;
      entry.paths[p.path] = { approved: p.fp, base: p.head ?? entry.paths[p.path]?.base ?? null };
    }
  }

  // Turns set aside while the reviewer was unavailable for too long go back
  // in front of the queue, with their waits counted afresh: the reviewer has
  // answered again, or auto mode has another
  unpark(entry) {
    if (!entry?.parked?.length) return;
    entry.jobs = [...entry.parked.map(({ waitUntil, ...j }) => ({ ...j, waits: 0 })), ...(entry.jobs ?? [])];
    entry.parked = [];
    this.capWaiting(entry);
    setImmediate(() => this.runJobs());
  }

  // this chat's auto mode, if it is on and reviews every turn
  everyTurn(endpoint) {
    const e = endpoint && this.s.auto?.[autoKey(endpoint)];
    return e?.on && e.everyTurn ? e : null;
  }

  // Why a chat's turn reviews wait (no reviewer, ChatGPT closed, its usage
  // limit), told once per wait: again only after a review has gone out since,
  // not with every prompt meanwhile
  tellWaitOnce(entry, to, kind, text) {
    if (entry.told?.[kind]) return;
    (entry.told ??= {})[kind] = Date.now();
    this.note(to, `auto:${autoKey(to)}:${kind}`, text);
  }

  // A note for a chat, with its next prompt and without waking it; one per
  // key until delivered. Every-turn mode tells its chat everything this way
  // except a review that requests changes (kind "review": from the reviewer).
  note(to, key, text, kind = "bridge") {
    if (!to || this.s.notes.some((n) => n.key === key && !n.deliveredAt)) return;
    this.s.notes.push({ id: "n" + ++this.s.seq, linkId: null, to, kind, key, text, at: Date.now(), deliveredAt: null });
  }

  // A prompt of an every-turn chat. The user's own starts a new generation:
  // the fix loop's count starts over, a stop is lifted, and answers about
  // older turns become notes. One typed while the turn runs joins its task.
  // The app's own notices, the bridge's deliveries and the Stop check's own
  // words aren't the user's (`own`).
  everyTurnPrompt(entry, { turnId, prompt, own, at }) {
    const t = entry.turn;
    if (turnId && t?.turnId === turnId) {
      if (!own) t.text = [t.text, `${MID_TURN}\n${prompt}`].filter(Boolean).join("\n\n").slice(0, MAX_PROMPT);
      return true;
    }
    // when the turn started is the hook's time, not when this ran
    entry.turn = { turnId: turnId ?? null, text: own ? null : prompt.slice(0, MAX_PROMPT), at: at ?? Date.now() };
    if (!own) Object.assign(entry, { generation: (entry.generation ?? 0) + 1, rounds: 0, stopped: false, chain: null, lastRejected: null });
    return false;
  }

  // A turn of an every-turn chat ended: its review is put together and sent
  // in the background, in order, and the job stays in state until then (see
  // runJobs). Not while the fix loop is stopped at its cap.
  queueTurn(entry, endpoint, { turnId, lastMessage, cwd, base, snap, ends, at, more }) {
    const t = entry.turn && (!entry.turn.turnId || !turnId || entry.turn.turnId === turnId) ? entry.turn : null;
    entry.turn = null;
    const since = t?.at ?? entry.lastEnd ?? entry.since ?? 0;
    entry.lastEnd = Date.now();
    if (entry.stopped) {
      logEvent({ op: "turn_not_reviewed", endpoint, why: "stopped" });
      return null;
    }
    // a turn in which this chat answered a review was its work as a reviewer:
    // not reviewed itself, so two chats reviewing each other can't go round.
    // Not the fix turn of its own loop, though (woken with its own "changes
    // requested" and the other chat's request together): that one is reviewed.
    const fix = this.fixes(entry, at ?? Date.now(), entry.generation ?? 0);
    if (!fix && this.s.messages.some((m) => m.kind === "review-request" && sameEndpoint(m.toEndpoint, endpoint) && m.answeredAt >= since)) {
      logEvent({ op: "turn_not_reviewed", endpoint, why: "answered a review" });
      return null;
    }
    const job = {
      id: "j" + ++this.s.seq,
      endpoint,
      turnId: turnId ?? null,
      generation: entry.generation ?? 0,
      startedAt: t?.at ?? null,
      at: Date.now(),
      prompt: t?.text ?? null,
      lastMessage: String(lastMessage ?? "").slice(0, MAX_ANSWER),
      cwd: cwd ?? null,
      base: base ?? null,
      snap: snap ?? null,
      ends: ends ?? null,
      // the paths tracked at the turn's end: coverage needs each one's end
      tracked: Object.keys(entry.paths ?? {}),
      endAt: at ?? null,
      // the Stop hook sends the facts that take time (the end snapshot, what
      // each path holds) right after: a short wait for them, then the review
      // goes without them
      ...(more && { factsDue: Date.now() + WATCH.read }),
    };
    const early = at != null && entry.facts?.[at];
    if (early) {
      Object.assign(job, { snap: early.snap ?? null, ends: early.ends ?? null, factsDue: 0 });
      delete entry.facts[at];
    }
    (entry.jobs ??= []).push(job);
    logEvent({ op: "turn_queued", job: job.id, endpoint });
    this.capWaiting(entry, endpoint);
    setImmediate(() => this.runJobs());
    return job;
  }

  // At most MAX_WAITING of a chat's turns wait (set aside ones included),
  // wherever one is put in line (a new turn, a retry, one set aside or taken
  // back): the oldest waiting go, set aside ones first, never the first in
  // line (it may be being sent); said once
  capWaiting(entry, endpoint = entry.jobs?.[0]?.endpoint ?? entry.parked?.[0]?.endpoint) {
    const over = (entry.jobs?.length ?? 0) + (entry.parked?.length ?? 0) - MAX_WAITING;
    if (over <= 0) return;
    const gone = [...(entry.parked ?? []).splice(0, over)];
    gone.push(...(entry.jobs ?? []).splice(1, over - gone.length));
    if (endpoint)
      this.note(
        endpoint,
        `auto:${autoKey(endpoint)}:dropped`,
        `More than ${MAX_WAITING} of your turns were waiting for their review, so the oldest waiting ones won't be reviewed on their own; the next review of the same folder covers their changes.`,
      );
    logEvent({ op: "turns_dropped", endpoint, jobs: gone.map((j) => j.id) });
  }

  // Puts together and sends the turn reviews that wait: each chat's in order,
  // chats side by side (one slow chat doesn't hold up the others). After a
  // turn ends, after an answer and on every watch tick, so one held back (no
  // reviewer yet, ChatGPT's usage limit, ChatGPT closed, a review still out)
  // goes as soon as it can, without waiting for another turn. A job leaves
  // the queue once its review is sent, once it turns out to need none, or
  // once it can't be sent at all (said so).
  runJobs() {
    if (this.retired) return;
    this.jobsBusy ??= new Set();
    for (const [key, entry] of Object.entries(this.s.auto ?? {})) {
      if (!entry?.on || !entry.everyTurn || !entry.jobs?.length || this.jobsBusy.has(key)) continue;
      this.jobsBusy.add(key);
      this.runChat(key, entry).finally(() => this.jobsBusy.delete(key));
    }
  }

  async runChat(key, entry) {
    const notes = this.s.notes.length;
    try {
      while (!this.retired && entry.on && entry.everyTurn && entry.jobs?.length) {
        const job = entry.jobs[0];
        const done = await this.runJob(key, entry, job);
        if (this.retired || entry.jobs?.[0] !== job || !done) break;
        entry.jobs.shift();
        this.save();
        this.dispatch(); // a review for a ChatGPT reviewer goes now, not with the next op
      }
      // what a held-back job told its chat is on disk for the hooks
      if (!this.retired && this.s.notes.length !== notes) this.save();
    } catch (e) {
      logEvent({ op: "turn_jobs", key, error: String(e.message || e) });
    }
  }

  // ChatGPT's usage limits, read once for all chats a while (each read
  // starts an app-server); null when they can't be read
  chatgptLimits() {
    if (!this.limitsRead || Date.now() - this.limitsRead.at > WATCH.limits)
      this.limitsRead = {
        at: Date.now(),
        p: import("./codex.mjs").then(({ readLimits }) => readLimits()).catch(() => null),
      };
    return this.limitsRead.p;
  }

  // Is ChatGPT Desktop running? Checked at most every few seconds (a check
  // spawns a process; on Windows a slow one); null when it can't be told
  chatgptOpen() {
    if (!this.openRead || Date.now() - this.openRead.at > Math.min(15_000, WATCH.limits)) this.openRead = { at: Date.now(), p: chatgptRunningAsync().catch(() => null) };
    return this.openRead.p;
  }

  // From the Stop hook, after its turn_end: the snapshot of the turn's end and
  // what each tracked path held then, for the job of the turn that ended at
  // `at` (kept a while if they come in first)
  op_turn_facts({ endpoint, at, snap, ends }) {
    const entry = this.everyTurn(endpoint);
    if (!entry || at == null) return { skipped: true };
    const job = (entry.jobs ?? []).find((j) => j.endAt === at);
    if (job) {
      Object.assign(job, { snap: snap ?? null, ends: ends ?? null, factsDue: 0 });
      setImmediate(() => this.runJobs());
      return { ok: true };
    }
    const now = Date.now();
    entry.facts = Object.fromEntries(Object.entries(entry.facts ?? {}).filter(([, f]) => now - f.ts < 10 * 60_000));
    entry.facts[at] = { snap: snap ?? null, ends: ends ?? null, ts: now };
    return { ok: true, early: true };
  }

  // One job: true once it is finished with, false to try again later. After
  // each wait it checks the entry as it is now: the same auto session, still
  // every turn, the job still first, the same reviewer.
  async runJob(key, entry, job) {
    const to = job.endpoint;
    const since = entry.since;
    const stoppedHere = () => entry.stopped && job.generation === (entry.generation ?? 0);
    // the loop stopped at its cap: that generation's turns aren't reviewed
    if (stoppedHere()) {
      logEvent({ op: "turn_not_reviewed", job: job.id, why: "stopped" });
      return true;
    }
    const reviewer = reviewerOf(entry);
    if (!reviewer) {
      // how to get one: the code still waiting for it, else a new one
      const code = Object.values(this.s.links).find((l) => l.active && l.autoReviewer && !l.advisor && l.joinCode && sameEndpoint(l.primary, to) && l.autoSince === since)?.joinCode;
      this.tellWaitOnce(
        entry,
        to,
        code ? `no-reviewer:${code}` : "no-reviewer",
        "Auto mode reviews every turn, but it has no reviewer yet, so the reviews of your turns wait for one: " +
          (code
            ? `the chat that joins with code ${code} becomes it (the user pastes "join the agent-review-bridge link with code ${code}" there).`
            : "call bridge_auto with on and every_turn again; it makes a new reviewer chat, or gives a join code for one."),
      );
      return false;
    }
    if (job.waitUntil && Date.now() < job.waitUntil) return false;
    if (job.factsDue && Date.now() < job.factsDue) return false;
    // ChatGPT closed: delivering would open it, so the review waits unless
    // the user said to open closed apps (a Claude reviewer that isn't
    // listening isn't opened either: it gets the request once it's open)
    if (reviewer.app === "openai" && readConfig().openClosedApps !== "always" && (await this.chatgptOpen()) === false) {
      if (!this.liveJob(key, entry, job, since, reviewer)) return false;
      this.tellWaitOnce(entry, to, "closed", "The reviews of your turns wait: ChatGPT Desktop is closed. They are sent once it's open (or tell the bridge to always open closed apps).");
      return false;
    }
    // one review of this chat's turns out to its reviewer at a time: the next
    // waits for its answer, so that reviewer's queue never holds more than one
    // of them (one still out to a reviewer it no longer has doesn't count).
    // Held a while: said once per review (a Claude reviewer that hasn't read
    // it yet isn't listening: that has a note of its own; one that read it
    // and stopped is told here)
    const out = Object.values(this.s.links).find((l) => l.active && l.everyTurn && !l.bind && sameEndpoint(l.primary, to) && sameEndpoint(l.advisor, reviewer));
    if (out) {
      const asked = this.s.messages.find((m) => m.linkId === out.id && m.kind === "review-request");
      if (!out.heldTold && Date.now() - out.createdAt > WATCH.unheard && (reviewer.app !== "claude" || asked?.readAt)) {
        out.heldTold = Date.now();
        this.note(
          to,
          `auto:${key}:held:${out.id}`,
          `The reviews of your turns wait: your reviewer hasn't answered review ${out.id} yet (sent ${new Date(out.createdAt).toLocaleString()}), and they go to it one at a time.`,
        );
      }
      return false;
    }
    if (reviewer.app === "openai") {
      // unknown limits don't hold it back
      const limits = await this.chatgptLimits();
      if (!this.liveJob(key, entry, job, since, reviewer)) return false;
      if (limits?.blocked) {
        job.waitUntil = limits.resetsAt ?? Date.now() + 5 * WATCH.every;
        const until = limits.resetsAt ? ` until ${new Date(limits.resetsAt).toLocaleString()}` : "";
        this.tellWaitOnce(entry, to, "limit", `The reviews of your turns wait: ChatGPT's usage limit is reached${until}. They are sent once it opens again.`);
        this.save();
        return false;
      }
    } else if (!listenerAlive(reviewer) && readConfig().openClosedApps === "always" && this.s.hosts?.[reviewer.id] && !process.env.AGENT_REVIEW_BRIDGE_FAKE_OPEN) {
      // the user said to open closed apps: Claude Desktop opens the session
      try {
        openUrl(claudeSessionUrl(this.s.hosts[reviewer.id]));
      } catch {
        // it gets the request when it is opened
      }
    }
    // a fix turn's review is the next round of the review it answers (unless
    // that one was already continued, by hand: then this one starts afresh);
    // a review sent again after its reviewer couldn't answer keeps its round
    const failed = job.retry ? this.s.links[job.retry] : null;
    // (only a turn that ended after the "changes requested" reached the chat)
    const answered = !failed && this.fixes(entry, job.endAt ?? job.at, job.generation) ? this.s.links[entry.chain.linkId] : null;
    const prev = answered && !answered.continuedBy ? answered : null;
    const round = failed ? (failed.round ?? 1) : prev ? (prev.round ?? 1) + 1 : 1;
    const turn = {
      chat: chatName(to),
      turnId: job.turnId,
      prompt: job.prompt,
      fixTurn: !!(prev || failed?.roundOf),
      heading: failed
        ? `Retry of round ${round} of review ${this.firstRound(failed).id}: the previous attempt (${failed.id}) got no answer.`
        : prev
          ? `Round ${round} of review ${this.firstRound(prev).id}: this turn answers your changes requested in ${prev.id}. Answer each point the agent disagrees with: accept it or hold, and say why.`
          : null,
      previous: failed ? (failed.roundOf ? this.lastAnswer(failed) : null) : prev ? this.lastAnswer(prev) : null,
      lastMessage: job.lastMessage,
      cwd: job.cwd,
      base: job.base,
      snap: job.snap,
      tracked: entry.paths ?? {},
    };
    let built = await buildTurn(turn);
    if (stoppedHere()) return true;
    if (!this.liveJob(key, entry, job, since, reviewer)) return false;
    // the fix turn's job is done with here, whatever comes of it: its loop is
    // continued once, and a later turn isn't headed as this fix
    if (prev && entry.chain?.linkId === prev.id) entry.chain = null;
    if (built.error) {
      // it couldn't be put together (an error, a timeout, too big): the turn
      // still goes, without its changes, unless even that doesn't fit
      const minimal = minimalTurnRequest({ ...turn, folder: job.cwd, why: built.error });
      if (minimal.error) {
        const which = job.turnId ? `turn ${job.turnId}` : `the turn that ended at ${new Date(job.endAt ?? job.at).toLocaleString()}`;
        this.note(
          to,
          `auto:${key}:unsent:${job.id}`,
          `The review of ${which} couldn't be sent: ${built.error}, and even without its changes it doesn't fit one message. Ask for that review yourself, in parts (bridge_review with fewer paths).`,
        );
        logEvent({ op: "turn_unsent", job: job.id, error: built.error });
        return true;
      }
      logEvent({ op: "turn_build_failed", job: job.id, error: built.error, minimal: true });
      built = minimal;
    }
    if (!failed && this.coveredByOwn(job)) {
      logEvent({ op: "turn_covered", job: job.id });
      return true;
    }
    const id = "L" + ++this.s.linkSeq;
    const link = {
      id,
      mode: "review",
      everyTurn: true,
      name: null,
      active: true,
      createdAt: Date.now(),
      primary: to,
      advisor: reviewer,
      advisories: [],
      round,
      generation: job.generation,
      autoSince: entry.since,
      ...((prev || failed?.roundOf) && { roundOf: prev?.id ?? failed.roundOf }),
      ...(failed && { retry: true }),
      ...(built.reqPaths?.length && { reqPaths: built.reqPaths }),
      request: built.text,
      // what it was put together from, to send it again if it gets no answer
      turn: (({ id, retry, waitUntil, factsDue, ...t }) => t)(job),
    };
    if (prev) prev.continuedBy = id;
    if (failed) failed.continuedBy = id;
    this.s.links[id] = link;
    this.registerPaths(to, built.reqPaths);
    logEvent({ op: "turn_review", id, job: job.id, round });
    delete entry.told; // a review went out: a later wait is told afresh
    this.sendReviewRequest(link);
    return true;
  }

  // Is this job still the one to send, as things are now?
  liveJob(key, entry, job, since, reviewer) {
    const cur = this.s.auto?.[key];
    return !this.retired && cur === entry && cur.on && cur.everyTurn && cur.since === since && cur.jobs?.[0] === job && sameEndpoint(reviewerOf(cur), reviewer);
  }

  // A code review the agent asked for in this turn, of exactly the content
  // the turn ended with (as the Stop hook found it, whatever happened since),
  // needs no second review: one still waiting for its answer, or answered.
  // Not one that failed or was closed unanswered, and never a plan review.
  coveredByOwn(job) {
    // every path tracked at the turn's end, with what it held then: one the
    // hook couldn't check in time is unknown, and then the turn is reviewed
    const paths = job.tracked ?? Object.keys(job.ends ?? {});
    if (!job.startedAt || !paths.length || !paths.every((p) => job.ends?.[p])) return false;
    const ends = paths.map((p) => [p, job.ends[p]]);
    const own = Object.values(this.s.links).filter(
      (l) =>
        l.mode === "review" &&
        !l.plan &&
        !l.everyTurn &&
        sameEndpoint(l.primary, job.endpoint) &&
        l.createdAt >= job.startedAt &&
        l.createdAt <= job.at &&
        l.reqPaths?.length &&
        ((l.active && l.advisor) || ["approved", "changes_requested"].includes(l.decision)),
    );
    return ends.every(([p, fp]) => fp && own.some((l) => l.reqPaths.some((q) => q.path === p && q.fp === fp)));
  }

  // The answer to a turn auto mode reviewed on its own: only changes
  // requested wakes the chat (the fix loop, its next turn reviewed again).
  // An approval comes with the next prompt, in one line, or in full with its
  // nits or when it ends a fix loop; an answer about a turn before the user's
  // latest prompt is a note too. Past the round cap the chat is told to stop,
  // and turns aren't reviewed until the user writes.
  everyTurnAnswer(link, endpoint, { decision, text, nits }) {
    Object.assign(link, { active: false, closedAt: Date.now(), decision });
    delete link.turn; // answered: it won't be sent again
    // a note that the answer waited for an approval: not after the answer
    this.dropWaitingNote(link.id);
    // the next turn's review can go now (one is out at a time)
    setImmediate(() => this.runJobs());
    // the request that only bound the reviewer: its answer is only that
    if (link.bind) return { delivered: "none", text };
    if (decision === "approved") this.approvePaths(link);
    const entry = this.s.auto?.[autoKey(link.primary)];
    const key = autoKey(link.primary);
    // an approval without nits is one line, so every turn's outcome is seen
    const plain = decision === "approved" && !nits.length;
    const said = (full, when = "") => (plain ? `Your reviewer approved the turn in review ${link.id}${when}.` : full);
    // auto mode no longer reviews every turn (switched to key moments; turned
    // off, its reviews were closed): the answer still comes, with the next
    // prompt, nothing dropped
    if (!entry?.on || !entry.everyTurn || link.autoSince !== entry.since) {
      this.note(link.primary, `auto:${key}:answer:${link.id}`, said(`${SWITCHED_NOTE}\n\n${text}`, ", from before auto mode stopped reviewing every turn"), "review");
      return { delivered: "next prompt", text };
    }
    // auto mode's reviewer answers again: turns set aside while it was away
    // go now (not for an answer from a reviewer it no longer has)
    if (sameEndpoint(link.advisor, reviewerOf(entry))) this.unpark(entry);
    // the loop stopped at its cap: answers still coming in about this
    // generation's turns neither wake the chat nor start the loop again
    const generation = entry.generation ?? 0;
    if (entry.stopped && (link.generation ?? 0) === generation) {
      this.note(link.primary, `auto:${key}:answer:${link.id}`, said(text), "review");
      return { delivered: "next prompt", stopped: true, text };
    }
    // the approval of a fix: the review it answers had requested changes. It
    // ends the loop only if that was the loop's last "changes requested", not
    // with an approval of another turn's review
    const fixApproved = decision === "approved" && !!link.roundOf && this.s.links[link.roundOf]?.decision === "changes_requested";
    const endsLoop = fixApproved && !!entry.lastRejected && link.roundOf === entry.lastRejected;
    if ((link.generation ?? 0) !== generation) {
      const late = fixApproved ? `${LATE_NOTE}\n\n${FIX_DONE_NOTE}\n\n${text}` : said(`${LATE_NOTE}\n\n${text}`, ", from before your latest prompt");
      this.note(link.primary, `auto:${key}:answer:${link.id}`, late, "review");
      return { delivered: "next prompt", stale: true, text };
    }
    if (decision === "approved") {
      if (endsLoop) Object.assign(entry, { rounds: 0, chain: null, lastRejected: null });
      this.note(link.primary, `auto:${key}:answer:${link.id}`, endsLoop ? `${FIX_DONE_NOTE}\n\n${text}` : said(text), "review");
      return { delivered: "next prompt", text };
    }
    entry.rounds = (entry.rounds ?? 0) + 1;
    if (entry.rounds >= MAX_ROUNDS()) {
      Object.assign(entry, { stopped: true, chain: null });
      const stop = `${entry.rounds} rounds in a row without approval.\n\n${text}`;
      return { delivered: "now", text, stopped: true, ...this.post({ from: endpoint.app, toEndpoint: link.primary, kind: "stop", linkId: link.id, text: stop }) };
    }
    const result = this.post({ from: endpoint.app, toEndpoint: link.primary, kind: "review-result", linkId: link.id, text, decision, everyTurn: true });
    // the loop waits for the turn that answers it: one that ends after this
    // result reached the chat (see fixes)
    Object.assign(entry, { chain: { linkId: link.id, generation: link.generation, msg: result.id, at: Date.now() }, lastRejected: link.id });
    return { delivered: "now", text, ...result };
  }

  // Is a turn of this generation that ended at `endAt` the fix of its loop:
  // it ended after the "changes requested" reached the chat (a Claude session
  // woken with it, a ChatGPT chat running it as its prompt). A turn that
  // ended before isn't (it waited in the queue while that review was out, or
  // the chat was busy reviewing for another), nor is any while it hasn't
  // reached the chat. (A result no longer kept: from when it was sent.)
  fixes(entry, endAt, generation) {
    const c = entry.chain;
    if (!c || c.generation !== generation) return false;
    const result = c.msg && this.s.messages.find((x) => x.id === c.msg);
    const reached = result ? (result.wokenAt ?? result.promptMatched ?? null) : (c.at ?? 0);
    return reached != null && endAt > reached;
  }

  // which auto mode session a review belongs to, if any
  autoSession(endpoint) {
    const entry = this.s.auto?.[autoKey(endpoint)];
    return entry?.on ? entry.since : null;
  }

  // a review was asked for: the reminder count starts over
  consulted(endpoint) {
    const entry = this.s.auto?.[autoKey(endpoint)];
    if (entry?.on) entry.turns = 0;
  }

  // From the prompt hook: a new user turn in auto mode. The bridge's own
  // queued prompts and prompts within the running turn don't count.
  op_auto_prompt({ endpoint, turnId, prompt }) {
    const entry = this.s.auto?.[autoKey(endpoint)];
    if (!entry?.on || typeof prompt !== "string") return { skipped: "off" };
    if (turnId && entry.lastTurn === turnId) return { skipped: "same turn" };
    if (HOST_NOTICE.test(prompt) || this.looksFromBridge(endpoint, prompt)) return { skipped: "not the user" };
    entry.lastTurn = turnId ?? null;
    entry.turns = (entry.turns ?? 0) + 1;
    return { turns: entry.turns };
  }

  op_ping() {
    return { pid: process.pid, protocol: PROTOCOL };
  }

  op_reset() {
    this.s = freshState();
    logEvent({ op: "reset" });
    return { ok: true };
  }

  // Telemetry only (server start, caller identity)
  op_report({ side, event, data }) {
    logEvent({ op: "report", side, event, data });
    return { ok: true };
  }

  // ------------------------------------------------------------- links

  // One review: one request, one answer, then the link closes (a later round
  // is a link of its own). The reviewer (`advisor`) is bound now (a chat the
  // bridge knows or created) or later via code.
  op_link_create({ primary, advisor, name, request, plan, noGate, reqPaths, autoReviewer, everyTurn, mode }) {
    if (!primary?.app || !primary?.id) throw new Error("primary endpoint unknown (caller identity missing)");
    // the shapes of advisor mode (bridge_link: a mode, no request), refused
    // rather than taken for a review with nothing to send
    if (mode !== undefined && mode !== "review") throw new Error(`there is no "${mode}" link any more (advisor mode was removed): restart this app to load the update`);
    if (typeof request !== "string" || !request.trim()) throw new Error("a review needs its request");
    const id = "L" + ++this.s.linkSeq;
    const link = { id, mode: "review", name: name ?? null, active: true, createdAt: Date.now(), primary, advisor: advisor ?? null, advisories: [], round: 1 };
    if (!advisor) link.joinCode = crypto.randomBytes(3).toString("hex");
    if (request) link.request = request;
    if (plan) link.plan = true; // a plan to review, not code
    if (plan && noGate) link.noGate = true; // an auto-mode consult the agent started
    if (reqPaths?.length) link.reqPaths = reqPaths; // what an approval covers
    link.autoSince = this.autoSession(primary);
    // auto mode's first review where the bridge can't make the reviewer
    // chat: the chat that joins becomes auto mode's reviewer
    if (autoReviewer && !advisor && link.autoSince != null) link.autoReviewer = true;
    // a review in every-turn mode's own terms (its answer as a note, unless
    // it requests changes): only the bridge's own, never one the agent asks for
    const entry = this.everyTurn(primary);
    if (everyTurn && entry) Object.assign(link, { everyTurn: true, generation: entry.generation ?? 0 }, !reqPaths?.length && { bind: true });
    this.s.links[id] = link;
    // a plan's paths are context: a plan approval approves no content
    if (!plan) this.registerPaths(primary, reqPaths);
    logEvent({ op: "link_create", id, primary, advisor: advisor ?? null });
    if (advisor) this.sendReviewRequest(link);
    return { id, joinCode: link.joinCode ?? null };
  }

  op_link_join({ code, endpoint }) {
    const link = Object.values(this.s.links).find((l) => l.active && l.joinCode && l.joinCode === code);
    if (!link) throw new Error("no open link with that join code");
    // any chat but the requester itself, in either app (auto mode's reviewer
    // too: a second Claude Code chat can review a Claude Code chat)
    if (sameEndpoint(link.primary, endpoint)) throw new Error("a chat can't review itself");
    link.advisor = endpoint;
    delete link.joinCode;
    // the requester's auto mode keeps this chat as its reviewer: only for the
    // review auto mode itself sent out for one, in the same auto session, and
    // only while it has none
    const auto = this.s.auto?.[autoKey(link.primary)];
    const adopted = link.mode === "review" && !!link.autoReviewer && link.autoSince === this.autoSession(link.primary) && !reviewerOf(auto);
    if (adopted) {
      auto.reviewer = endpoint;
      this.unpark(auto);
      // codes from earlier tries at that first review aren't needed any more
      for (const l of Object.values(this.s.links))
        if (l !== link && l.active && l.autoReviewer && !l.advisor && sameEndpoint(l.primary, link.primary)) {
          Object.assign(l, { active: false, closedAt: Date.now() });
          delete l.request; // never sent
        }
      // turns that waited for a reviewer go now
      setImmediate(() => this.runJobs());
    }
    logEvent({ op: "link_join", id: link.id, advisor: endpoint, ...(adopted && { autoReviewer: true }) });
    this.sendReviewRequest(link);
    return { id: link.id, mode: link.mode, primary: link.primary, ...(link.plan && { plan: true }), ...(adopted && { autoReviewer: true }) };
  }

  // a link's one request, once its reviewer is known
  sendReviewRequest(link) {
    if (!link.request || !link.advisor) return;
    this.post({ from: link.primary.app, toEndpoint: link.advisor, kind: "review-request", linkId: link.id, text: link.request });
    this.consulted(link.primary);
    delete link.request;
  }

  // The previous round of a review, as its requester may continue it
  roundToContinue(primary, linkId) {
    const prev = this.s.links[linkId];
    if (!prev || prev.mode !== "review" || !sameEndpoint(prev.primary, primary)) throw new Error(`${linkId} is not a review this chat asked for`);
    if (prev.active) throw new Error(`${linkId} is still waiting for its answer`);
    if (prev.decision === "approved") throw new Error(`${linkId} was approved; there is nothing to re-review`);
    // a review that got no answer can be asked again, as a retry of its round
    if (!["changes_requested", "failed"].includes(prev.decision)) throw new Error(`${linkId} didn't end with changes requested or a failure, so it can't be continued`);
    if (prev.continuedBy) throw new Error(`${linkId} was already continued by ${prev.continuedBy}`);
    if (!prev.advisor) throw new Error(`${linkId} has no reviewer`);
    return prev;
  }

  // The reviewer's last real answer in a chain of rounds (a failed attempt
  // has none): the reviewer may have compacted its context since. "missing"
  // when an earlier round is no longer kept.
  lastAnswer(link) {
    for (let l = link; ; ) {
      if (l.advisories?.length) return { linkId: l.id, text: l.advisories.at(-1).text };
      if (!l.roundOf) return { none: true };
      l = this.s.links[l.roundOf];
      if (!l) return { missing: true };
    }
  }

  // The next round, or a retry of a round that got no answer (it keeps its
  // number: a failure isn't a verdict and doesn't count toward the cap)
  nextRound(prev) {
    const retry = prev.decision === "failed";
    return { retry, round: retry ? (prev.round ?? 1) : (prev.round ?? 1) + 1 };
  }

  // What the requester needs to build the next round's request
  op_round_info({ primary, roundOf }) {
    const prev = this.roundToContinue(primary, roundOf);
    return { plan: !!prev.plan, ...this.nextRound(prev), advisor: prev.advisor, previous: this.lastAnswer(prev) };
  }

  // The next round of a review: same reviewer, same kind, round + 1 (a retry
  // keeps the round). One continuation per round (checked and set in this one
  // op), and none past the emergency cap.
  op_link_continue({ primary, roundOf, request, plan, threadId, reqPaths }) {
    const prev = this.roundToContinue(primary, roundOf);
    if (plan !== undefined && !!plan !== !!prev.plan) throw new Error(`${roundOf} was a ${prev.plan ? "plan" : "code"} review; continue it as one`);
    if (threadId && !(prev.advisor.app === "openai" && prev.advisor.id === threadId)) throw new Error(`${roundOf} was reviewed in another chat; continue it there`);
    const { retry, round } = this.nextRound(prev);
    if (round > MAX_ROUNDS()) throw new Error(`${round - 1} rounds without approval: stop and ask the user how to proceed`);
    const id = "L" + ++this.s.linkSeq;
    prev.continuedBy = id;
    const heading = retry
      ? `Retry of round ${round} of review ${this.firstRound(prev).id}: the previous attempt (${roundOf}) got no answer.`
      : `Round ${round} of review ${roundOf} (earlier rounds ended with [CHANGES REQUESTED]). Answer each point the requester disagrees with: accept it or hold, and say why.`;
    const link = { id, mode: "review", name: prev.name ?? null, active: true, createdAt: Date.now(), primary, advisor: prev.advisor, advisories: [], round, roundOf };
    if (prev.plan) link.plan = true;
    if (prev.noGate) link.noGate = true;
    if (retry) link.retry = true; // a failure of this one gives no new retry
    if (reqPaths?.length) link.reqPaths = reqPaths;
    link.autoSince = this.autoSession(primary);
    link.request = `${heading}\n\n${request}`;
    this.s.links[id] = link;
    if (!link.plan) this.registerPaths(primary, reqPaths);
    logEvent({ op: "link_continue", id, roundOf, round, ...(retry && { retry }) });
    this.sendReviewRequest(link);
    return { id, round, advisor: prev.advisor, plan: !!prev.plan, ...(retry && { retry: true }) };
  }

  // the first link of a chain of rounds (as far as it is still kept)
  firstRound(link) {
    let l = link;
    while (l.roundOf && this.s.links[l.roundOf]) l = this.s.links[l.roundOf];
    return l;
  }

  op_link_close({ endpoint, linkId }) {
    const closed = [];
    for (const l of Object.values(this.s.links)) {
      if (!l.active) continue;
      if (linkId ? l.id === linkId : sameEndpoint(l.primary, endpoint) || sameEndpoint(l.advisor, endpoint)) {
        Object.assign(l, { active: false, closedAt: Date.now() });
        closed.push(l.id);
      }
    }
    // a chat that stops its reviews is no longer an auto mode's reviewer
    // either: that auto mode's next review asks for a new one
    const released = [];
    if (!linkId && endpoint)
      for (const [key, e] of Object.entries(this.s.auto ?? {})) {
        const r = e?.on && reviewerOf(e);
        if (r && sameEndpoint(r, endpoint)) {
          e.reviewer = null;
          released.push(key);
        }
      }
    logEvent({ op: "link_close", closed, ...(released.length && { released }) });
    return { closed, ...(released.length && { released }) };
  }

  // A prompt the bridge itself delivered (a ChatGPT thread runs its queue as
  // prompts): exactly the text of a message being handed to this chat, and
  // each delivery matches once, so the same text again is the user's. Limit:
  // a user pasting a delivery verbatim before its own turn runs takes its place.
  // Fallback, so the fix-loop cap holds even if an app update changes the
  // text a little (line endings, spacing, a cut): the delivery's own first
  // line and the fixed agent-message line.
  // (`at`: when the prompt hook ran, kept as when the chat had it: the
  // owner may take in that hook's record later, with the turn's Stop)
  fromBridge(endpoint, prompt, at) {
    const text = prompt.trim();
    const pending = this.s.messages.filter((m) => m.dispatch && !m.promptMatched && sameEndpoint(m.toEndpoint, endpoint));
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const m =
      pending.find((m) => inlineText(m).trim() === text) ??
      pending.find((m) => norm(text).startsWith(norm(inlineText(m).split("\n")[0])) && text.includes(AGENT_LINE));
    if (m) m.promptMatched = at ?? Date.now();
    return !!m;
  }

  // The same test without using a delivery up (turn_start may already have
  // matched it): any delivery to this chat in the last day
  looksFromBridge(endpoint, prompt) {
    return bridgePrompt(this.s, endpoint, prompt);
  }

  // From the UserPromptSubmit hook of a chat in auto mode reviewing every
  // turn: what was asked this turn (see everyTurnPrompt). The hook also runs,
  // with the running turn's id, for a message the user types while the turn
  // runs and for the app's own notices (a background task finished): those
  // belong to the turn. Only ids that are both present and equal count as
  // the same turn. Each delivery of the bridge's own matches once, so the
  // same text again is the user's.
  op_turn_start({ endpoint, turnId, prompt, user, at }) {
    const entry = this.everyTurn(endpoint);
    if (!entry || typeof prompt !== "string") return { skipped: "off" };
    const notice = HOST_NOTICE.test(prompt);
    const bridged = !notice && this.fromBridge(endpoint, prompt, at);
    // the hook knows the Stop check's own words (user: false); the bridge's
    // deliveries and the app's notices are told here
    const sameTurn = this.everyTurnPrompt(entry, { turnId, prompt, own: notice || bridged || user === false, at });
    return { ok: true, ...(sameTurn && { sameTurn: true }), ...(notice && { notice: true }), ...(bridged && { fromBridge: true }) };
  }

  // From the Stop hook of a chat in auto mode reviewing every turn: the turn
  // waits for its review (see queueTurn)
  op_turn_end({ endpoint, turnId, lastMessage, cwd, base, snap, ends, at, more }) {
    const entry = this.everyTurn(endpoint);
    if (!entry) return { skipped: "off" };
    const job = this.queueTurn(entry, endpoint, { turnId, lastMessage, cwd, base, snap, ends, at, more });
    return job ? { job: job.id } : { skipped: "not reviewed" };
  }

  // From a reviewer (bridge_advise), for one named request. A review the
  // agent asked for: the answer always goes back and the link closes; changes
  // requested can be continued with the next round (bridge_review round_of).
  // A turn auto mode sent on its own: see everyTurnAnswer.
  op_advise({ endpoint, requestId, decision, note, blocking = [], nits = [] }) {
    if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join("|")}`);
    if (decision === "approved" && blocking.length) throw new Error("an approval can't have must-fix items; put minor points in nits, or request changes");
    if (decision === "changes_requested" && !blocking.length) throw new Error("changes requested needs at least one must-fix item; if only nits are left, approve");
    if (!requestId) throw new Error("request_id is required: the id of the review request you answer (e.g. m9)");
    const req = this.s.messages.find((m) => m.id === requestId && sameEndpoint(m.toEndpoint, endpoint));
    if (!req) throw new Error(`no review request ${requestId} for this chat`);
    if (req.kind !== "review-request") throw new Error(`${requestId} is a ${req.kind}, not a review request; reply to it with bridge_send and reply_to "${requestId}"`);
    if (req.answeredAt) throw new Error(`review request ${requestId} is already answered`);
    const link = this.s.links[req.linkId];
    if (!link?.active) throw new Error(`review request ${requestId} belongs to a closed link`);
    req.answeredAt = Date.now();
    this.answered(req.id);
    const text = renderAnswer({ decision, note: withoutCitations(note), blocking, nits });
    link.advisories.push({ at: Date.now(), decision, text });
    if (link.everyTurn) return this.everyTurnAnswer(link, endpoint, { decision, text, nits });
    const lastRound = decision === "changes_requested" && (link.round ?? 1) >= MAX_ROUNDS();
    Object.assign(link, { active: false, closedAt: Date.now(), decision });
    if (decision === "approved" && !link.plan) this.approvePaths(link);
    const r = this.post({ from: endpoint.app, toEndpoint: link.primary, kind: "review-result", linkId: link.id, text, decision, lastRound });
    return { delivered: "now", text, ...r };
  }

  op_notes_ack({ ids }) {
    for (const n of this.s.notes) if (ids?.includes(n.id)) n.deliveredAt = Date.now();
    return { ok: true };
  }

  // From a Claude listener that woke its session with these messages in full,
  // at the time it did (not when this runs: the woken turn may already be over)
  op_wake_ack({ ids, at }) {
    const when = at ?? Date.now();
    for (const m of this.s.messages)
      if (ids?.includes(m.id)) {
        m.wakes = (m.wakes ?? 0) + 1;
        m.readAt ??= when;
        m.wokenAt = Math.max(m.wokenAt ?? 0, when);
      }
    return { ok: true };
  }

  // A Claude turn ended (Stop, turn_ok) or an API error ended it (StopFailure,
  // turn_failed), at the hook's own time `at`. Messages woken before a
  // successful end are settled; those woken before a failed end and not
  // settled get a notice to whoever waits. Times decide, not the order these
  // arrive in, so a late or repeated event can't settle or fail the wrong ones.
  endpointState(endpoint) {
    this.s.endpoints ??= {};
    return (this.s.endpoints[autoKey(endpoint)] ??= {});
  }

  op_turn_ok({ endpoint, at }) {
    if (!endpoint?.id || !at) return { skipped: true };
    for (const m of this.s.messages) {
      if (!sameEndpoint(m.toEndpoint, endpoint) || !m.wokenAt || m.wokenAt > at || m.settledAt) continue;
      m.settledAt = at;
      // a Claude reviewer's turn that ended without answering the review of
      // a turn: no answer is coming from it, as when a ChatGPT reviewer's turn
      // completes without one; it is sent again (the next turn's review waits
      // for this one's answer, so it mustn't stay open for good)
      if (m.kind === "review-request" && !m.answeredAt && this.s.links[m.linkId]?.everyTurn) this.fail(m, "the reviewer's turn ended without an answer");
    }
    const ep = this.endpointState(endpoint);
    ep.lastOkAt = Math.max(ep.lastOkAt ?? 0, at);
    if (ep.lastFailure && ep.lastFailure.at < at) delete ep.lastFailure;
    return { ok: true };
  }

  op_turn_failed({ endpoint, at, error, details }) {
    if (!endpoint?.id || !at) return { skipped: true };
    const ep = this.endpointState(endpoint);
    // a success after it means the session has recovered
    if (!(ep.lastOkAt >= at) && !(ep.lastFailure?.at >= at)) ep.lastFailure = { at, error: error ?? "unknown", details: details ?? null };
    const why = `an error ended its turn (${error ?? "unknown"}${details ? `: ${String(details).slice(0, 300)}` : ""})`;
    for (const m of this.s.messages)
      if (sameEndpoint(m.toEndpoint, endpoint) && m.wokenAt && m.wokenAt <= at && !m.settledAt) this.fail(m, why, { unavailable: UNAVAILABLE.test(`${error ?? ""} ${details ?? ""}`) });
    return { ok: true };
  }

  // A Claude chat working for another waits on the user to approve a tool:
  // whoever waits on what woke it is told, once per message: a review's
  // requester, or a plain message's sender. In auto mode reviewing every turn
  // it is a note, so it can't start a turn that is reviewed again.
  op_permission_wait({ endpoint, at, what }) {
    if (!endpoint?.id || !at) return { skipped: true };
    const asked = what && String(what).replace(/^Claude needs your permission to use /, "").slice(0, 200);
    const tool = asked ? ` (${asked})` : "";
    for (const m of this.s.messages) {
      if (!watched(m) || !sameEndpoint(m.toEndpoint, endpoint)) continue;
      if (!m.wokenAt || m.wokenAt > at || m.settledAt || m.approvalToldAt || this.settled(m)) continue;
      if (!this.openFor(m)) continue; // closed: no answer can come back on it
      const to = m.kind === "review-request" ? this.s.links[m.linkId]?.primary : m.fromEndpoint;
      if (!to) continue;
      m.approvalToldAt = at;
      this.tellWaiting(m, to, `The Claude Code session ${endpoint.id} is waiting for the user to approve a tool in Claude Desktop${tool}. Its answer to ${m.id} comes after that.`);
      logEvent({ op: "waiting", id: m.id });
    }
    return { ok: true };
  }

  // Whoever waits on m is told it waits for an approval: with the next
  // prompt for auto mode's review of a turn (a wake would start a turn that
  // is reviewed again), else by a notice that wakes it
  // (a plain message to a chat in every-turn mode: a note too, as fail() does)
  tellWaiting(m, to, text, extra = {}) {
    if (this.s.links[m.linkId]?.everyTurn) this.note(to, `${m.linkId}:waiting`, text);
    else if (m.kind === "message" && this.everyTurn(to)) this.note(to, `${m.id}:waiting`, text);
    else this.post({ from: "bridge", toEndpoint: to, kind: "waiting", linkId: m.linkId, text, about: m.id, ...extra });
  }

  // that notice no longer holds: the answer is here, or the review failed
  dropWaitingNote(linkId) {
    this.s.notes = this.s.notes.filter((n) => n.deliveredAt || n.key !== `${linkId}:waiting`);
  }

  // The answer to `id` is here: a notice that it waits for an approval, not
  // delivered yet, would only contradict it
  answered(id) {
    for (const w of this.s.messages) if (w.kind === "waiting" && w.about === id && !w.readAt) w.readAt = Date.now();
    this.dropWaitingNote(id); // the note form, for a plain message (keyed by its id)
  }

  // A ChatGPT reviewer asked to run a command outside its sandbox and has no
  // result after a minute: it may be waiting on an approval nobody sees. Told
  // once, as a possibility: its rollout records the request, never the decision.
  async checkApproval(m) {
    if (m.to !== "openai" || m.approvalToldAt || this.settled(m)) return;
    const to = m.kind === "review-request" ? this.s.links[m.linkId]?.primary : m.fromEndpoint;
    if (!to || !this.openFor(m)) return;
    const w = m.watch;
    const { rolloutOf, pendingEscalation } = await import("./codex.mjs");
    // looked for on every check until found (it may not exist yet)
    if (!w.rollout) w.rollout = rolloutOf(m.toEndpoint.id);
    if (!w.rollout) return;
    const p = pendingEscalation(w.rollout, w.since);
    if (!p || p.partial || Date.now() - p.at < WATCH.approval || m.approvalToldAt) return;
    m.approvalToldAt = Date.now();
    const why = p.justification ? ` (${p.justification})` : "";
    const text = `The ChatGPT chat ${m.toEndpoint.id} asked to run a command outside its sandbox more than a minute ago and has no result yet${why}: it may be waiting for the user's approval in ChatGPT Desktop, or the command may still be running. Its answer to ${m.id} comes after that.`;
    this.tellWaiting(m, to, text, { maybe: true });
    logEvent({ op: "waiting", id: m.id, maybe: true });
  }

  post({ from, toEndpoint, kind, linkId, text, decision, lastRound, about, retry, auto, retried, maybe, everyTurn }) {
    const msg = { id: "m" + ++this.s.seq, from, to: toEndpoint.app, toEndpoint, kind, linkId, text: text.slice(0, MAX_TEXT), ts: Date.now(), readAt: null };
    // a review's request and result say whether it is a plan, and whether
    // its plan waits for the user, as its link decided (each message is
    // rendered on its own later, by the hooks too)
    const link = ["review-request", "review-result"].includes(kind) ? this.s.links[linkId] : null;
    Object.assign(msg, link?.plan && { plan: true }, link?.plan && link.noGate && { noGate: true }, decision && { decision }, lastRound && { lastRound: true }, about && { about }, retry && { retry }, auto && { auto: true }, retried && { retried: true }, maybe && { maybe: true }, everyTurn && { everyTurn: true });
    this.s.messages.push(msg);
    logEvent({ op: "send", id: msg.id, from, to: toEndpoint, kind, linkId, len: msg.text.length });
    return { id: msg.id };
  }

  // The reviewer this chat's auto mode keeps, while it is on
  autoReviewerOf(endpoint) {
    const e = endpoint && this.s.auto?.[autoKey(endpoint)];
    return e?.on ? reviewerOf(e) : null;
  }

  // The chats whose auto mode, on, keeps this chat as its reviewer
  reviewedBy(endpoint) {
    return Object.entries(this.s.auto ?? {})
      .filter(([, e]) => e?.on && sameEndpoint(reviewerOf(e), endpoint))
      .map(([key]) => ({ app: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1) }));
  }

  // Two chats auto mode pairs (see pairedIn)
  paired(a, b) {
    return pairedIn(this.s, a, b);
  }

  // Can m still be answered: its link is open, or, a message between two
  // chats auto mode pairs (through the pairing, or on a review since
  // closed), the two are still paired
  openFor(m) {
    if (this.s.links[m.linkId]?.active) return true;
    return m.kind === "message" && this.paired(m.fromEndpoint, m.toEndpoint);
  }

  // Who bridge_send reaches: the chat on the other end of this chat's most
  // recent active link, or of the link named (the one checked before sending).
  // With no open review, auto mode's pairing: the chat's own reviewer, else
  // the one chat whose auto mode it reviews. A reply (replyTo) goes to the
  // sender of that message, on its own link, or through the pairing once that
  // link closed.
  // (`channel`: the pairing was the target checked before sending, so a link
  // opened meanwhile doesn't take its place)
  sendTarget(endpoint, linkId, replyTo, channel = false) {
    const mine = (l) => l.active && l.advisor && (sameEndpoint(l.primary, endpoint) || sameEndpoint(l.advisor, endpoint));
    if (replyTo) {
      const orig = this.s.messages.find((m) => m.id === replyTo && sameEndpoint(m.toEndpoint, endpoint));
      if (!orig) throw new Error(`no message ${replyTo} for this chat to reply to`);
      const link = this.s.links[orig.linkId];
      const to = orig.fromEndpoint ?? (link && (sameEndpoint(link.primary, endpoint) ? link.advisor : link.primary));
      if (link && mine(link)) {
        if (linkId && linkId !== link.id) throw new Error(`${replyTo} belongs to ${link.id}, not ${linkId}; try again`);
        return { link, to };
      }
      if (!linkId && this.paired(endpoint, to)) return { link: null, to };
      throw new Error(`${replyTo} belongs to a link that is no longer open`);
    }
    const link = channel ? null : linkId ? this.s.links[linkId] : Object.values(this.s.links).filter(mine).at(-1);
    if (linkId && !(link && mine(link))) throw new Error(`link ${linkId} is no longer open for this chat; try again`);
    if (link) return { link, to: sameEndpoint(link.primary, endpoint) ? link.advisor : link.primary };
    const own = this.autoReviewerOf(endpoint);
    if (own) return { link: null, to: own };
    const reviewed = this.reviewedBy(endpoint);
    if (reviewed.length === 1) return { link: null, to: reviewed[0] };
    if (reviewed.length > 1) throw new Error("this chat reviews for several chats in auto mode: answer one of their messages with reply_to");
    throw new Error("this chat has no active link: a message goes to the other chat of an open review (bridge_review), until it's answered, or to auto mode's reviewer and back");
  }

  op_send_target({ endpoint, replyTo }) {
    const { link, to } = this.sendTarget(endpoint, undefined, replyTo);
    return { to, linkId: link?.id ?? null };
  }

  // A chat the bridge itself created to review: it stays one after
  // its link closes, so bridge_read_chat can refuse it for good
  op_reviewer_chat({ endpoint }) {
    if (!endpoint?.app || !endpoint?.id) throw new Error("this chat is unknown");
    this.s.reviewerChats = { ...(this.s.reviewerChats ?? {}), [`${endpoint.app}:${endpoint.id}`]: Date.now() };
    return { ok: true };
  }

  // May this chat read the user's other chats? Not one the bridge created to
  // review, nor one reviewing through an open link, nor
  // an auto mode's reviewer between its reviews
  op_read_chat_allowed({ endpoint }) {
    if (this.s.reviewerChats?.[`${endpoint.app}:${endpoint.id}`] || standingReviewer(this.s, endpoint)) return { allowed: false };
    return { allowed: !Object.values(this.s.links).some((l) => l.active && sameEndpoint(l.advisor, endpoint)) };
  }

  // Claude Desktop's own id for a Claude Code session (claude://code/continue
  // opens it), reported by that session's own server
  op_host({ endpoint, hostId }) {
    if (endpoint?.app !== "claude" || !HOST_ID.test(hostId ?? "")) throw new Error("not a Claude Desktop session id");
    this.s.hosts = { ...(this.s.hosts ?? {}), [endpoint.id]: hostId };
    const keys = Object.keys(this.s.hosts);
    if (keys.length > 500) delete this.s.hosts[keys[0]];
    return { ok: true };
  }

  // Can a Claude endpoint be reached now (its listener is up), and can it be
  // opened (its host id is known)?
  op_reach({ endpoint }) {
    return { listening: !!listenerAlive(endpoint), hostId: this.s.hosts?.[endpoint?.id] ?? null };
  }

  // Free-form message (bridge_send) to the chat on the other end of this
  // chat's most recent active link, or of its auto mode pairing (see
  // sendTarget), so it is delivered and wakes it like any other message. A
  // reply (replyTo) goes to whoever sent that message, so a chat in several
  // links can't answer the wrong one. Guarded against two agents chatting in
  // a loop.
  op_send({ endpoint, text, linkId, replyTo, channel, to: checked }) {
    if (typeof text !== "string" || !text.trim()) throw new Error("empty message");
    if (text.length > MAX_TEXT) throw new Error(`message too long (${text.length} > ${MAX_TEXT})`);
    const { link, to } = this.sendTarget(endpoint, linkId, replyTo, !!channel);
    // through the pairing: to the chat checked before sending, or to none
    if (!link && checked && !sameEndpoint(to, checked)) throw new Error("auto mode's pairing changed while this message was being sent, so nothing was sent; try again");
    const recent = this.s.messages.filter((m) => m.kind === "message" && sameEndpoint(m.fromEndpoint, endpoint) && Date.now() - m.ts < PEER_BURST.windowMs).length;
    if (recent >= PEER_BURST.count) throw new Error(`more than ${PEER_BURST.count} messages in 10 minutes; looks like a loop, wait a bit`);
    const r = this.post({ from: endpoint.app, toEndpoint: to, kind: "message", linkId: link?.id ?? null, text });
    // no link: it goes through auto mode's pairing (channel)
    Object.assign(this.s.messages.at(-1), { fromEndpoint: endpoint }, replyTo && { replyTo }, !link && { channel: true });
    if (replyTo) this.answered(replyTo);
    // the chat it goes to was last seen failing: say so
    const failure = this.s.endpoints?.[autoKey(to)]?.lastFailure;
    return { ...r, to, linkId: link?.id ?? null, ...(failure && { lastFailure: failure }) };
  }

  // Unread messages, or one by id, read or not (e.g. a wake that looked cut
  // off). Messages for a specific chat only reach that chat; untargeted ones
  // any chat of the side.
  op_receive({ side, endpoint, id }) {
    const now = Date.now();
    const mine = (m) => m.to === side && (!m.toEndpoint || sameEndpoint(m.toEndpoint, endpoint));
    const out = id ? this.s.messages.filter((m) => m.id === id && mine(m)) : this.s.messages.filter((m) => mine(m) && !m.readAt);
    if (id && !out.length) throw new Error(`no message ${id} for this chat`);
    for (const m of out) {
      m.readAt ??= now;
      // handed to a Claude turn by this call: settled or failed with that turn
      if (side === "claude") m.wokenAt = Math.max(m.wokenAt ?? 0, now);
    }
    logEvent({ op: "receive", side, endpoint, ids: out.map((m) => m.id) });
    // everything nextStep reads goes along, so the instruction is the same as in a wake
    return {
      messages: out.map(({ id, from, kind, linkId, text, ts, plan, noGate, decision, lastRound, about, retry, auto, retried, maybe, everyTurn }) => ({
        id,
        from,
        kind,
        linkId,
        text,
        ts,
        plan,
        noGate,
        decision,
        lastRound,
        about,
        retry,
        auto,
        retried,
        maybe,
        everyTurn,
      })),
    };
  }
}

// ------------------------------------------------------------- client side

let owner = null; // BrokerState when this process owns the port
const TOKEN = token();

// the protocol of a newer version that last wrote the state, when this
// process found it so (then it takes no ownership, and says so)
let newerState = null;

function listen() {
  return new Promise((resolve) => {
    const state = new BrokerState();
    // state a newer version wrote: this older code doesn't take it over
    // (nothing ingested, dispatched or saved), whatever its records and
    // outbox files mean there now
    newerState = (state.s.protocol ?? 0) > PROTOCOL ? state.s.protocol : null;
    if (newerState) return resolve(null);
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/rpc" || req.headers["x-bridge-token"] !== TOKEN) {
        res.writeHead(403).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let out;
        let stepDown = false;
        try {
          const { op, args, protocol } = JSON.parse(body);
          if ((protocol ?? 0) > PROTOCOL) {
            stepDown = true;
            out = { ok: false, stale: true, error: `broker owner runs protocol ${PROTOCOL}, client ${protocol}; stepping down` };
          } else if ((protocol ?? 0) < PROTOCOL && op !== "ping")
            // a server from before an update (its app wasn't restarted): its
            // operations may mean something else now, so none is run. A ping
            // is answered (it changes nothing): the doctor probes with
            // protocol 0, and an old server's keep-alive then sees an owner
            // and doesn't try to take over.
            out = {
              ok: false,
              error: `This app runs an older version of agent-review-bridge (protocol ${protocol ?? 0}) than the one running now (${PROTOCOL}), so nothing was done. Quit the app fully and open it again to load the update.`,
            };
          else out = { ok: true, result: state.handle(op, args || {}) };
        } catch (e) {
          out = { ok: false, error: String(e.message || e) };
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        if (stepDown) {
          logEvent({ op: "broker-step-down", pid: process.pid, protocol: PROTOCOL });
          clearInterval(state.ingestTimer);
          state.retired = true; // reads still running are dropped
          srv.close();
          srv.closeAllConnections?.();
          if (owner === state) owner = null;
        }
      });
    });
    srv.once("error", () => resolve(null));
    srv.listen(PORT, "127.0.0.1", () => {
      srv.unref();
      logEvent({ op: "broker-start", pid: process.pid });
      // the state is this process's now: what advisor mode left is retired
      // before anything else can send or read it
      if (state.retireAdvisor()) state.save();
      state.ingestOutbox();
      state.dispatch(); // messages left undelivered by a previous owner
      let lastWatch = 0;
      state.ingestTimer = setInterval(() => {
        state.ingestOutbox();
        if (Date.now() - lastWatch >= Math.min(2000, WATCH.first)) {
          lastWatch = Date.now();
          state.watchTick();
        }
      }, Math.min(500, WATCH.first));
      state.ingestTimer.unref();
      resolve(state);
    });
  });
}

function post(op, args) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/rpc", method: "POST", headers: { "x-bridge-token": TOKEN, "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let r;
          try {
            r = JSON.parse(body);
          } catch {
            return reject(new Error(`broker HTTP ${res.statusCode}`));
          }
          if (r.ok) return resolve(r.result);
          const e = new Error(r.error);
          if (r.stale) e.code = "STALE_OWNER";
          reject(e);
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ op, args, protocol: PROTOCOL }));
  });
}

let triedListen = false;

// Long-lived processes (the MCP servers) keep a broker owner alive: if the
// owner dies, the next ping takes over within intervalMs, so hook requests in
// outbox/ never wait for some unrelated call to come along.
export function keepOwner(intervalMs = 2000) {
  const t = setInterval(() => call("ping").catch(() => {}), intervalMs);
  t.unref();
  return t;
}

export async function call(op, args = {}) {
  if (!owner && !triedListen) {
    triedListen = true;
    owner = await listen();
  }
  if (owner) return owner.handle(op, args);
  try {
    return await post(op, args);
  } catch (e) {
    if (e.code !== "ECONNREFUSED" && e.code !== "ECONNRESET" && e.code !== "STALE_OWNER") throw e;
    // previous owner is gone or just stepped down; take over
    for (let i = 0; i < 10 && !owner; i++) {
      owner = await listen();
      if (!owner) await new Promise((r) => setTimeout(r, 100));
    }
    if (owner) return owner.handle(op, args);
    if (newerState)
      throw new Error(
        `The bridge's state was last written by a newer version of agent-review-bridge (protocol ${newerState}) than this app runs (${PROTOCOL}), so nothing was done. ` +
          `Quit the app fully and open it again to load the update. (If you went back to an older version on purpose, remove ${STATE_FILE} to start over; open reviews are lost.)`,
      );
    return post(op, args);
  }
}
