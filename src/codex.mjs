// Drive ChatGPT Desktop threads through the app's own queue (experimental,
// undocumented; see docs/notes/lab-notebook.tr.md, Q1/Q2). A private
// `codex app-server` started from the app's bundled CLI shares the app's
// state (threads, queue). Prompts are
// queued from that process and the desktop app runs them:
// - a thread the app has loaded picks its queue up by itself (~2 s);
// - an unloaded one needs codex://threads/wake/<id> (harmless when empty).
// Never queue onto a thread the private server has loaded and idle: it would
// run the turn itself, headless. So: create in one session, queue in another.

import { spawn } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findCodexCli, openUrl, dataDir } from "./platform.mjs";

// No call waits for ever: an app-server that doesn't answer is given up on
const RPC_MS = 60_000;

export class AppServer {
  static async open({ debug = false, timeoutMs = RPC_MS } = {}) {
    const bin = findCodexCli();
    if (!bin) throw new Error("ChatGPT Desktop's codex CLI not found (set PEER_BRIDGE_CODEX_BIN)");
    const s = new AppServer(bin, debug);
    try {
      await s.rpc("initialize", { clientInfo: { name: "peer-bridge", version: "0.1.0" }, capabilities: { experimentalApi: true } }, { timeoutMs });
      s.notify("initialized");
      return s;
    } catch (e) {
      s.close();
      throw e;
    }
  }

  constructor(bin, debug) {
    this.bin = bin;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    // without our own MCP server: one spawned here would grab the broker and
    // die with this short-lived process
    this.proc = spawn(bin, ["-c", "mcp_servers.peer_bridge.enabled=false", "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => debug && process.stderr.write(d));
    // a process that dies or can't start fails every call still waiting
    const gone = (why) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error(`codex app-server ${why}`));
      this.pending.clear();
    };
    this.proc.on("exit", (code, signal) => gone(`exited (${signal ?? code})`));
    this.proc.on("error", (e) => gone(`failed (${e.message})`));
    this.proc.stdin.on("error", () => {}); // writing to a dead process
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(Object.assign(new Error(`${m.error.message ?? JSON.stringify(m.error)}`), { code: m.error.code })) : resolve(m.result);
      } else if (m.method) for (const l of this.listeners) l(m);
    });
  }

  rpc(method, params, { timeoutMs = RPC_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("codex app-server is closed"));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server didn't answer ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ method, ...(params && { params }) }) + "\n");
  }

  onNotification(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try {
      this.proc.stdin.end();
    } catch {
      // already gone
    }
    this.proc.kill();
  }
}

// Fresh session per call, so the private server never holds the thread loaded.
// With deadlineMs, starting the server and the work each get that long; past
// it the call fails and the server is killed.
async function withServer(fn, { deadlineMs, ...opts } = {}) {
  const s = await AppServer.open({ ...opts, ...(deadlineMs && { timeoutMs: deadlineMs }) });
  let timer;
  try {
    const work = fn(s);
    if (!deadlineMs) return await work;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer from ChatGPT Desktop within ${deadlineMs / 1000} s`)), deadlineMs);
    });
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
    s.close();
  }
}

export class ModelChoiceError extends Error {}

// What an app-server without the method answers (measured: -32600 "unknown
// variant `model/list`"; -32601 is JSON-RPC's own "method not found")
const unsupported = (e) => e.code === -32601 || /unknown variant `model\/list`|method not found|unknown method/i.test(e.message);

// The models this account can use, in the app's own order (hidden ones too, so
// a name typed exactly still works); null only when this app version has no
// model list. Any other failure stops the thread from being made: unchecked,
// a wrong name would make a thread that can't run.
async function listModels(s) {
  const models = [];
  let cursor = null;
  try {
    do {
      const r = await s.rpc("model/list", { includeHidden: true, ...(cursor && { cursor }) });
      if (!Array.isArray(r?.data)) throw new Error("unexpected answer");
      models.push(...r.data);
      cursor = r.nextCursor;
    } while (cursor);
  } catch (e) {
    if (!models.length && !cursor && unsupported(e)) return null;
    throw new ModelChoiceError(`Nothing was created: ChatGPT's model list couldn't be read (${e.message}). Try again, or leave out the model to use ChatGPT's default.`);
  }
  return models;
}

const sameName = (a, b) => typeof a === "string" && a.trim().toLowerCase().replace(/\s+/g, "-") === b.trim().toLowerCase().replace(/\s+/g, "-");

// The app's id for a chosen model (its id, or its display name as shown in the
// picker), checked before a thread is made: thread/start takes any name, and
// the thread then only says "This model isn't available". An effort the model
// doesn't offer is refused the same way.
export function pickModel(models, model, effort) {
  if (!models || !model) return model;
  const m = models.find((x) => [x.id, x.model, x.displayName].some((n) => sameName(n, model)));
  if (!m) {
    const names = models.filter((x) => !x.hidden).map((x) => `${x.model} (${x.displayName})`);
    throw new ModelChoiceError(
      `Nothing was created: ChatGPT has no model "${model}". Its models: ${names.join(", ")}. ` +
        "Call again with one of these; if the user's choice isn't clearly one of them, ask the user.",
    );
  }
  const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  if (effort && efforts.length && !efforts.includes(effort))
    throw new ModelChoiceError(`Nothing was created: ${m.model} has no effort "${effort}". Its efforts: ${efforts.join(", ")}.`);
  return m.model;
}

// New named thread with a chosen model, without running a model turn
// (`inject_items` is what makes a turn-less thread persist)
// (`effort` is set both as a config override and as a thread setting, so it
// holds whichever the desktop app picks up when it resumes the thread)
export function createThread(args, opts) {
  return withServer((s) => createThreadOn(s, args), opts);
}

// (on a given app-server session, so tests can stand one in)
export async function createThreadOn(s, { model, effort, cwd, name, seed, sandbox }) {
  if (model) model = pickModel(await listModels(s), model, effort);
  const r = await s.rpc("thread/start", {
    model: model ?? null,
    cwd: cwd ?? process.cwd(),
    sandbox: sandbox ?? null,
    ...(effort && { config: { model_reasoning_effort: effort } }),
  });
  const threadId = r.thread.id;
  if (effort) await s.rpc("thread/settings/update", { threadId, effort });
  const text = seed ?? "This thread is driven by peer-bridge.";
  await s.rpc("thread/inject_items", { threadId, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }] });
  if (name) await s.rpc("thread/name/set", { threadId, name });
  return { threadId, model: r.model };
}

// Queue a prompt for the desktop app and make sure it picks it up. clientId
// comes back on the turn's user message, so the turn can be found later.
export async function sendToThread(threadId, prompt, { wake = true, clientId = crypto.randomUUID(), ...opts } = {}) {
  const queued = await withServer(async (s) => {
    const r = await s.rpc("thread/queue/add", { threadId, input: [{ type: "text", text: prompt }], clientUserMessageId: clientId });
    return r.queuedSubmission.id;
  }, opts);
  if (wake) openUrl(`codex://threads/wake/${threadId}`);
  return { queued, clientId };
}

// Tests stand in for ChatGPT with <data dir>/fake-codex.json:
// { limits: <account/rateLimits/read answer>, turns: { <clientId>: {state, error} }, hang: true }
function fake() {
  if (!process.env.PEER_BRIDGE_FAKE_CODEX) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), "fake-codex.json"), "utf8"));
  } catch {
    return {};
  }
}
const hang = () => new Promise(() => {});

// ChatGPT's usage limits, read with a short deadline. blocked: ordinary use
// isn't allowed and there are no credits; resetsAt (ms) is when the window
// that is full opens again.
export async function readLimits({ timeoutMs = 8000, ...opts } = {}) {
  const f = fake();
  let r;
  if (f) {
    if (f.hang) await Promise.race([hang(), new Promise((_, rej) => setTimeout(() => rej(new Error("fake hang")), timeoutMs))]);
    r = f.limits ?? {};
  } else r = await withServer((s) => s.rpc("account/rateLimits/read", null, { timeoutMs }), { deadlineMs: timeoutMs, ...opts });
  return summarizeLimits(r);
}

export function summarizeLimits(r) {
  const snap = r?.rateLimitsByLimitId?.codex ?? r?.rateLimits ?? null;
  const credits = !!(snap?.credits?.hasCredits || snap?.credits?.unlimited);
  const win = (w) => w && { usedPercent: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null };
  const windows = [snap?.primary, snap?.secondary].filter(Boolean);
  const full = windows.filter((w) => w.usedPercent >= 100 && w.resetsAt);
  return {
    blocked: r?.ordinaryUsageAllowed === false && !credits,
    resetsAt: full.length ? Math.max(...full.map((w) => w.resetsAt)) * 1000 : null,
    primary: win(snap?.primary),
    secondary: win(snap?.secondary),
    credits,
  };
}

// What became of a queued prompt: the turn whose user message carries its
// clientId (completed, failed, interrupted, inProgress, with completedAt once
// it is over), still "queued", or "unknown" (not among the latest turns, nor
// in the queue). Only the latest 100 turns are searched, so "unknown" means
// "not seen there", not proof that it never arrived.
export async function turnOf(threadId, clientId, { timeoutMs = 15_000, ...opts } = {}) {
  const f = fake();
  if (f) {
    if (f.hang) return Promise.race([hang(), new Promise((_, rej) => setTimeout(() => rej(new Error("fake hang")), timeoutMs))]);
    return f.turns?.[clientId] ?? { state: "unknown" };
  }
  return withServer(
    async (s) => {
      const t = await s.rpc("thread/turns/list", { threadId, limit: 100, itemsView: "summary" }, { timeoutMs });
      const turn = (t?.data ?? []).find((x) => (x.items ?? []).some((i) => i.type === "userMessage" && i.clientId === clientId));
      if (turn) return { state: turn.status, error: turn.error ?? null, completedAt: turn.completedAt ?? null };
      const q = await s.rpc("thread/queue/list", { threadId }, { timeoutMs });
      return { state: (q?.data ?? []).some((x) => x.clientUserMessageId === clientId) ? "queued" : "unknown" };
    },
    { deadlineMs: timeoutMs, ...opts },
  );
}

export function listQueue(threadId, opts) {
  return withServer(async (s) => (await s.rpc("thread/queue/list", { threadId })).data, opts);
}

export function clearQueue(threadId, opts) {
  return withServer(async (s) => {
    const items = (await s.rpc("thread/queue/list", { threadId })).data;
    for (const item of items) await s.rpc("thread/queue/delete", { threadId, queuedSubmissionId: item.id });
    return items.length;
  }, opts);
}
