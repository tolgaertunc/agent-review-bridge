// Claude Code sessions stored on this computer, for bridge_read_chat: found by
// title or folder, and read as units (see src/readchat.mjs).
//
// <claude config dir>/projects/<folder key>/<session id>.jsonl, one record
// per line, append-only. The title the user set is in <folder key>/<session
// id>/custom-title.json and in "custom-title" records (the last one wins);
// without one, an automatic title is in "ai-title" records. A session moved to
// another folder (a worktree) can sit under several folder keys; the newest
// file is the session. The format is Claude Code's own and undocumented: only
// known shapes are read, other records are metadata.
//
// Transcripts can be huge and this runs in the MCP server, which may also own
// the broker: files are read in chunks, asynchronously, and never held. A record
// over MAX_RECORD isn't held in memory or parsed. What a read shows comes from
// the session's index (src/chatindex.mjs), by the current branch.

import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir } from "./platform.mjs";
import { normalizeName, inFolder, MAX_COMMAND, MAX_MESSAGE, assemble } from "./readchat.mjs";
import { CHUNK, MAX_RECORD, F, countBetween, fileIdentity, historyDigest, humanQueued, humanText, openIndex, parse, pause, sameFile, sha, textOf } from "./chatindex.mjs";

export { MAX_RECORD, humanText };

const META_BYTES = 4 * 1024 * 1024; // from the end, for a session's title and folder
const HEAD_BYTES = 1024 * 1024; // from the start, for an untitled session's first message
const TITLE_LINE = 64 * 1024; // a line this long or shorter is looked at whole for a title
const MARK_OVERLAP = 1024; // kept between chunks when looking through a longer one
const MAX_TITLE_MEMO = 5_000;
const TITLE_FILE_BYTES = 64 * 1024;
export const PAGE_BYTES = 64 * 1024 * 1024; // read for a page, and for one message on it
const MAX_TOOL_LINES = 200;
const HEADER_MS = 5_000; // for a page's title, if it isn't settled yet

const projectsDir = () => path.join(claudeConfigDir(), "projects");
const gone = (e) => e.code === "ENOENT" || e.code === "ENOTDIR";

// What goes wrong with a chat the user didn't ask about is reported by count
// and reason: its path is no business of the agent reading another chat.
const UNREADABLE = "unreadable";
const TITLE_UNSETTLED = "title not settled";
const FOLDER_UNSETTLED = "folder not found within the limit";

// Every session, newest first, one file per session id, and what couldn't
// be read. No projects folder at all is no sessions; a folder that can't be
// read is a problem, never taken for an empty one. At the deadline it stops and
// says so.
export async function scanSessions({ deadline = Infinity } = {}) {
  const byId = new Map();
  const problems = [];
  let cutShort = false;
  let dirs = [];
  try {
    dirs = (await fs.promises.readdir(projectsDir(), { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch (e) {
    if (e.code === "ENOENT") return { sessions: [], problems, cutShort };
    throw new Error(`can't read the sessions folder (${e.code ?? e.message})`);
  }
  scan: for (const d of dirs) {
    if (Date.now() > deadline) {
      cutShort = true;
      break;
    }
    const dir = path.join(projectsDir(), d.name);
    let names = [];
    try {
      names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch (e) {
      if (!gone(e)) problems.push(UNREADABLE);
      continue;
    }
    for (const f of names) {
      if (Date.now() > deadline) {
        cutShort = true;
        break scan;
      }
      const file = path.join(dir, f);
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch (e) {
        if (!gone(e)) problems.push(UNREADABLE);
        continue;
      }
      if (!st.isFile()) {
        problems.push(UNREADABLE);
        continue;
      }
      const id = f.slice(0, -".jsonl".length);
      const prev = byId.get(id);
      if (!prev || st.mtimeMs > prev.mtime) byId.set(id, { id, file, mtime: st.mtimeMs, size: st.size });
    }
  }
  return { sessions: [...byId.values()].sort((a, b) => b.mtime - a.mtime), problems, cutShort };
}

export const claudeSessions = async () => (await scanSessions()).sessions;

// One session by id. `partial`: something couldn't be read, so its not being
// found doesn't prove it isn't there.
export async function lookupClaude(id) {
  const { sessions, problems } = await scanSessions();
  return { session: sessions.find((s) => s.id === id) ?? null, partial: problems.length > 0 };
}
export const claudeSession = async (id) => (await lookupClaude(id)).session;

// The file's records from the end back to its beginning, as { raw }; raw is null
// for one over MAX_RECORD, whose bytes are never kept. Ends with { budget: true }
// once more than `budget` bytes were read.
export async function* reverseRecords(file, { budget = Infinity } = {}) {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = size;
    let carry = Buffer.alloc(0);
    let skipping = false;
    while (pos > 0) {
      const from = Math.max(0, pos - CHUNK);
      const chunk = Buffer.alloc(pos - from);
      await fh.read(chunk, 0, chunk.length, from);
      pos = from;
      await pause();
      let body = chunk;
      if (skipping) {
        const nl = chunk.lastIndexOf(10);
        if (nl === -1) {
          if (size - pos > budget && pos > 0) return void (yield { budget: true });
          continue;
        }
        yield { raw: null };
        skipping = false;
        body = chunk.subarray(0, nl + 1);
        carry = Buffer.alloc(0);
      }
      const all = carry.length ? Buffer.concat([body, carry]) : body;
      let end = all.length;
      while (end > 0) {
        const nl = all.lastIndexOf(10, end - 1);
        if (nl === -1) break;
        if (end > nl + 1) {
          yield { raw: end - nl - 1 > MAX_RECORD ? null : all.subarray(nl + 1, end) };
          if (size - pos > budget) return void (yield { budget: true });
        }
        end = nl;
      }
      carry = Buffer.from(all.subarray(0, end));
      if (carry.length > MAX_RECORD) {
        skipping = true;
        carry = Buffer.alloc(0);
      }
    }
    if (skipping) yield { raw: null };
    else if (carry.length) yield { raw: carry };
  } finally {
    await fh.close();
  }
}

async function readTitleFile(s) {
  const file = path.join(path.dirname(s.file), s.id, "custom-title.json");
  let fh;
  try {
    fh = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(TITLE_FILE_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > TITLE_FILE_BYTES) throw new Error("too large");
    return JSON.parse(buf.toString("utf8", 0, bytesRead)).customTitle ?? null;
  } catch (e) {
    // no title file is common; one that can't be read might hold the name asked for
    if (gone(e)) return null;
    throw new Error(UNREADABLE);
  } finally {
    await fh?.close();
  }
}

// The first thing the user wrote, within the first part of the file. Only a
// label for a session with no title, so not finding it hides no name.
async function firstMessage(s) {
  const fh = await fs.promises.open(s.file, "r");
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, s.size));
    await fh.read(buf, 0, buf.length, 0);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl === -1) return null;
      const r = parse(buf.subarray(start, nl));
      start = nl + 1;
      if (r?.type === "user" && !r.isSidechain && !r.isMeta && !r.isCompactSummary) {
        const t = humanText(textOf(r.message?.content));
        if (t) return t;
      }
    }
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- titles

// In the raw bytes: quotes inside a JSON string are escaped, so this can't match
// the text of a message. What it finds is only a candidate, checked by parsing.
const TITLE_MARK = /"type"\s*:\s*"(?:custom-title|ai-title)"/;
const TITLE_HINT = Buffer.from('-title"');
const hasMark = (buf) => TITLE_MARK.test(buf.latin1Slice(0, buf.length));

const titleScans = new Map();
export const clearTitleMemo = () => titleScans.clear();

// The titles anywhere in a large session, when its end settled no custom one: a
// forward scan that can stop at any chunk and go on from there next time, and
// that only reads what grew. It settles "no title" only by reaching the end with
// no candidate left unresolved: a candidate that doesn't parse, or one in a line
// over TITLE_LINE, isn't held or parsed there and stays unresolved. Whitespace
// over MARK_OVERLAP long inside a marker, in such a line, isn't looked for: "no
// title" holds for the format the app writes (records of a few hundred bytes),
// not for any JSON. A last line with no newline yet is pending.
// maxChunks is for tests: stop as a deadline would, at an exact place.
export async function deepTitles(s, { deadline = Infinity, maxChunks = Infinity } = {}) {
  const fh = await fs.promises.open(s.file, "r");
  try {
    const st = await fh.stat();
    let e = titleScans.get(s.file);
    if (e && !(await sameFile(fh, st, e.id))) e = null;
    if (e?.complete && e.id.size === st.size) return result(e);
    if (!e) e = { frontier: 0, longLine: false, custom: null, ai: null, unresolved: false, pending: false, complete: false, id: null };
    e.complete = false;
    e.pending = false;
    const check = (line) => {
      if (!hasMark(line)) return;
      const r = parse(line);
      if (!r) e.unresolved = true;
      else if (r.type === "custom-title" && r.customTitle) e.custom = r.customTitle;
      else if (r.type === "ai-title" && r.aiTitle) e.ai = r.aiTitle;
    };
    let pos = e.frontier;
    let inLong = e.longLine;
    let carry = Buffer.alloc(0);
    let chunks = 0;
    const chunk = Buffer.allocUnsafe(CHUNK);
    let stopped = false;
    while (pos < st.size) {
      if (Date.now() > deadline || chunks >= maxChunks) {
        stopped = true;
        break;
      }
      chunks++;
      const { bytesRead } = await fh.read(chunk, 0, Math.min(CHUNK, st.size - pos), pos);
      if (!bytesRead) break;
      const fresh = chunk.subarray(0, bytesRead);
      const buf = carry.length ? Buffer.concat([carry, fresh]) : fresh;
      const base = pos - carry.length;
      pos += bytesRead;
      let start = 0;
      if (buf.indexOf(TITLE_HINT) === -1) {
        const nl = buf.lastIndexOf(10);
        if (nl !== -1) {
          start = nl + 1;
          inLong = false;
        }
      } else {
        for (;;) {
          const nl = buf.indexOf(10, start);
          if (nl === -1) break;
          const line = buf.subarray(start, nl);
          if (inLong || line.length > TITLE_LINE) {
            if (hasMark(line)) e.unresolved = true;
          } else check(line);
          inLong = false;
          start = nl + 1;
        }
      }
      const rest = buf.subarray(start);
      if (inLong || rest.length > TITLE_LINE) {
        if (hasMark(rest)) e.unresolved = true;
        inLong = true;
        carry = Buffer.from(rest.subarray(Math.max(0, rest.length - MARK_OVERLAP)));
        e.frontier = pos - carry.length;
      } else {
        carry = Buffer.from(rest);
        e.frontier = base + start;
      }
      e.longLine = inLong;
      await pause();
    }
    if (!stopped) {
      e.complete = true;
      if (!inLong && carry.length && hasMark(carry)) e.pending = true;
    }
    e.id = await fileIdentity(fh, st, e.frontier);
    titleScans.delete(s.file);
    titleScans.set(s.file, e);
    if (titleScans.size > MAX_TITLE_MEMO) titleScans.delete(titleScans.keys().next().value);
    return result(e);
  } finally {
    await fh.close();
  }
}
const result = (e) => ({ custom: e.custom, ai: e.ai, settled: e.complete && !e.unresolved && !e.pending, complete: e.complete, scanned: e.frontier });

// Title and folder. The end of the file settles most (titles are written again
// and again, and most records carry the folder); a custom title in it settles
// the name, whatever lies further back. A large session with none there is
// searched whole, if its folder is in scope. `titleKnown`/`folderKnown` say
// whether they were settled: if not, a name found may not be its name.
export async function claudeMeta(s, { deadline = Infinity, inScope = () => true } = {}) {
  let custom = await readTitleFile(s);
  let ai = null;
  let folder = null;
  let scannedAll = true;
  let unresolved = false;
  if (s.size > 0)
    for await (const rec of reverseRecords(s.file, { budget: META_BYTES })) {
      if (rec.budget) {
        scannedAll = false;
        break;
      }
      if (custom && folder) break;
      if (!rec.raw) continue;
      const r = parse(rec.raw);
      if (!r) {
        if (hasMark(rec.raw)) unresolved = true;
        continue;
      }
      if (!custom && r.type === "custom-title" && r.customTitle) custom = r.customTitle;
      if (!ai && r.type === "ai-title" && r.aiTitle) ai = r.aiTitle;
      if (!folder && typeof r.cwd === "string") folder = r.cwd;
    }
  let titleKnown = !!custom || (scannedAll && !unresolved);
  if (!custom && !scannedAll) {
    // The end of a file and the title file are the newest word. A forward scan's
    // title isn't until it has read to the end: a newer rename may lie further on.
    // Until then the name is only provisional.
    if (inScope(folder)) {
      const d = await deepTitles(s, { deadline });
      custom = d.custom;
      ai ??= d.ai;
      titleKnown = d.settled;
    } else titleKnown = false;
  }
  let name = custom ?? ai;
  if (!name) {
    const first = await firstMessage(s);
    name = first ? `(untitled) ${first.replace(/\s+/g, " ").slice(0, 60)}` : "(untitled)";
  }
  return { app: "claude", id: s.id, name, folder, updated: s.mtime, titleKnown, folderKnown: !!folder || scannedAll };
}

// ------------------------------------------------------------------ finding

// By title and/or folder, over every session, newest first. A session in scope
// whose title or folder couldn't be settled is reported, whether or not what is
// known of it matches, and so is one the deadline didn't reach: then the search
// isn't complete. A session known to lie outside the folder asked for is out,
// settled or not.
export async function findClaude({ name, folder, add, deadline = Infinity }) {
  const { sessions, problems, cutShort } = await scanSessions({ deadline });
  const want = name ? normalizeName(name) : null;
  let looked = 0;
  for (const s of sessions) {
    if (Date.now() > deadline) break;
    looked++;
    try {
      const { titleKnown, folderKnown, ...chat } = await claudeMeta(s, { deadline, inScope: (f) => !folder || !f || inFolder(f, folder) });
      if (folder && !folderKnown) problems.push(FOLDER_UNSETTLED);
      if (folder && folderKnown && !inFolder(chat.folder, folder)) continue;
      if (want && !titleKnown) problems.push(TITLE_UNSETTLED);
      if (folder && !inFolder(chat.folder, folder)) continue;
      if (want && !normalizeName(chat.name).includes(want)) continue;
      add(chat);
    } catch (e) {
      // deleted meanwhile is gone; anything else might have been a match
      if (!gone(e)) problems.push(UNREADABLE);
    }
  }
  const reached = looked >= sessions.length && !cutShort;
  return {
    complete: reached && !problems.length,
    problems,
    scope: `${looked} of ${sessions.length} sessions${reached ? "" : ", the newest (time limit reached)"}`,
  };
}

// ------------------------------------------------------------------ reading

const short = (s) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_COMMAND ? `${t.slice(0, MAX_COMMAND)}…` : t;
};

const OUTCOME = { done: "done", failed: "failed", unclear: "outcome unclear: its results conflict" };

function toolLine(b, outcome) {
  const i = b.input ?? {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(b.name ?? "");
  const what = mcp
    ? `called ${mcp[1]}.${mcp[2]}`
    : ({
        Bash: () => `ran: ${short(i.command)}`,
        PowerShell: () => `ran: ${short(i.command)}`,
        Edit: () => `edited: ${short(i.file_path)}`,
        MultiEdit: () => `edited: ${short(i.file_path)}`,
        Write: () => `wrote: ${short(i.file_path)}`,
        NotebookEdit: () => `edited: ${short(i.notebook_path)}`,
        Read: () => `read: ${short(i.file_path)}`,
        Grep: () => `searched files for: ${short(i.pattern)}`,
        Glob: () => `listed files: ${short(i.pattern)}`,
        WebSearch: () => `searched the web: ${short(i.query)}`,
        WebFetch: () => `fetched: ${short(i.url)}`,
        Agent: () => `started a subagent: ${short(i.description)}`,
        Task: () => `started a subagent: ${short(i.description)}`,
      }[b.name]?.() ?? `used ${b.name}`);
  return `${what} (${OUTCOME[outcome] ?? "no result seen (an attempt)"})`;
}

const stampOf = (r) => (r.timestamp ? Date.parse(r.timestamp) || null : null);

// A unit's text and tool steps, read by offset, newest record first. Reading stops
// once `budget` is reached (so over it by at most one record, itself bounded by
// MAX_RECORD): what was read is shown, and the unit says the rest wasn't, so one
// message can't hold a page up and a page always moves on.
async function hydrate(unit, view, fh, budget) {
  const out = { kind: unit.kind, at: null, text: "", tools: [], moreTools: 0, midTurn: unit.midTurn, uncertain: unit.uncertain };
  const members = [...unit.members].sort((a, b) => b.o - a.o);
  const uses = [];
  let read = 0;
  for (const rec of members) {
    if (read >= budget) {
      out.spread = true;
      break;
    }
    const buf = Buffer.alloc(rec.n);
    const { bytesRead } = await fh.read(buf, 0, rec.n, rec.o);
    read += bytesRead;
    const r = parse(buf.subarray(0, bytesRead));
    if (!r) {
      out.spread = true;
      continue;
    }
    out.at = stampOf(r) ?? out.at;
    if (unit.kind === "user") {
      if (rec.f & F.QUEUED) out.text = humanQueued(r.attachment) ? humanText(r.attachment.prompt) : "";
      else {
        const c = r.message?.content;
        const images = Array.isArray(c) ? c.filter((b) => b.type === "image").length : 0;
        out.text = [humanText(textOf(c)), ...Array(images).fill("[image]")].filter(Boolean).join("\n");
      }
      continue;
    }
    for (const b of [...(r.message?.content ?? [])].reverse()) {
      if (b.type === "text" && b.text?.trim()) out.text = (out.text ? `${b.text}\n${out.text}` : b.text).slice(0, MAX_MESSAGE + 1); // one over, so the cut is noticed
      else if (b.type === "tool_use") {
        uses.unshift(b);
        if (uses.length > MAX_TOOL_LINES) {
          uses.pop();
          out.moreTools++;
        }
      }
    }
  }
  out.tools = uses.map((b) => toolLine(b, view.outcome(b.id)));
  return { unit: out, read };
}

// A session's units from a place in the branch, newest first, as { unit, pos },
// where pos is { i, c }: the last unit consumed, and the cut: every omitted record
// at or above that offset has been counted. The cut only goes down and travels in
// the cursor, so nothing is counted on two pages. Only what will be shown is read.
export async function* claudeStream(view, fh, { from = 0, top = Infinity, includeTools = true, budget = PAGE_BYTES, unitBudget = PAGE_BYTES } = {}) {
  let cut = top;
  let used = 0;
  const left = function* (low, high, i, uncertain) {
    for (const [reason, list] of Object.entries(view.omitted)) {
      const n = countBetween(list, low, high);
      if (n) yield { unit: { kind: `drop:${reason}`, n, uncertain }, pos: { i, c: low } };
    }
  };
  for (let i = from; i < view.units.length; i++) {
    if (used >= budget) return void (yield { budget: true });
    const u = view.units[i];
    const low = Math.min(cut, u.min);
    yield* left(low, cut, i - 1, u.uncertain);
    cut = low;
    const shown = u.kind === "user" || u.kind === "final" || u.kind === "unfinished" || includeTools;
    if (shown) {
      const { unit, read } = await hydrate(u, view, fh, unitBudget);
      used += read;
      yield { unit, pos: { i, c: cut } };
    } else yield { unit: { kind: u.kind, uncertain: u.uncertain }, pos: { i, c: cut } };
    await pause();
  }
  yield* left(0, cut, view.units.length - 1, view.units.at(-1)?.uncertain ?? false);
}

// Is that position still the same record, whole? A shifted or rewritten file fails
// this; records added at the end don't touch it.
async function boundaryHolds(fh, { o, n, h }) {
  const { size } = await fh.stat();
  if (o + n > size) return false;
  const at = async (offset, length) => {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  };
  if (o > 0 && (await at(o - 1, 1))[0] !== 10) return false;
  if (o + n < size && (await at(o + n, 1))[0] !== 10) return false;
  return sha(await at(o, n)) === h;
}

// One page of a session, older than `resume` when given: { meta, page }, or
// { moved: true } when the history at that place is no longer the one the cursor
// came from, or { status } when the session can't be read yet or at all. A cursor
// is { u, o, n, h, c, d }: the last unit consumed and its record, the cut, and a
// digest of the resolved history up to it.
export async function readClaudePage(s, { resume, limit, includeTools, budget, unitBudget, scanMs, maxChunks, maxBytes, maxMemoBytes }) {
  const opened = await openIndex(s.file, { ...(scanMs !== undefined && { scanMs }), ...(maxChunks !== undefined && { maxChunks }), ...(maxBytes !== undefined && { maxBytes }), ...(maxMemoBytes !== undefined && { maxMemoBytes }) });
  if (opened.status !== "ready") return opened;
  const { view } = opened;
  const fh = await fs.promises.open(s.file, "r");
  try {
    let from = 0;
    let top = Infinity;
    if (resume) {
      const at = view.byKey.get(resume.u);
      if (at === undefined) return { moved: true };
      if (!(await boundaryHolds(fh, resume)) || (await historyDigest(view, view.units[at].bi, resume.c)) !== resume.d) return { moved: true };
      from = at + 1;
      top = resume.c;
    }
    const page = await assemble(claudeStream(view, fh, { from, top, includeTools, ...(budget !== undefined && { budget }), ...(unitBudget !== undefined && { unitBudget }) }), { limit, includeTools });
    if (page.pos && page.pos.i >= 0) {
      const u = view.units[page.pos.i];
      const anchor = u.members[0];
      const buf = Buffer.alloc(anchor.n);
      const { bytesRead } = await fh.read(buf, 0, anchor.n, anchor.o);
      page.pos = { u: u.key, o: anchor.o, n: anchor.n, h: sha(buf.subarray(0, bytesRead)), c: page.pos.c, d: await historyDigest(view, u.bi, page.pos.c) };
    } else page.pos = null;
    return { meta: await claudeMeta(s, { deadline: Date.now() + HEADER_MS }), page };
  } finally {
    await fh.close();
  }
}
