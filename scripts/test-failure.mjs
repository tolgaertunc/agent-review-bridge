// When the other side can't answer: a ChatGPT turn that fails (a usage limit),
// a Claude turn ended by an API error (StopFailure), and the limits check.
// Throwaway data dir, ChatGPT faked through <data dir>/fake-codex.json, and the
// watch's timing scaled down (first checks after ~20 ms, deadline ~4 s).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-failure-"));
Object.assign(process.env, {
  AGENT_REVIEW_BRIDGE_DIR: dir,
  AGENT_REVIEW_BRIDGE_PORT: "7487",
  AGENT_REVIEW_BRIDGE_FAKE_CODEX: "1",
  AGENT_REVIEW_BRIDGE_TEST_WATCH_SCALE: "0.0002",
  AGENT_REVIEW_BRIDGE_CONFIG_DIR: path.join(dir, "config"),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const fakeFile = path.join(dir, "fake-codex.json");
const fake = (obj) => fs.writeFileSync(fakeFile, JSON.stringify(obj));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(25);
  }
}
const hook = path.resolve(import.meta.dirname, "../src/hook.mjs");
function runHook(app, event, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [hook, "--app", app, "--event", event], { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify({ hook_event_name: event, cwd: ".", ...input }));
  });
}

const CLAUDE = { app: "claude", id: "claude-fail-1" };
const CLAUDE2 = { app: "claude", id: "claude-fail-2" };
const GPT = { app: "openai", id: "gpt-fail-thread" };

// 1. app-server calls never wait for ever: a server that doesn't answer
// initialize, or that dies during a read, fails the call in time
{
  const { readLimits, turnOf, summarizeLimits } = await import("../src/codex.mjs");
  if (process.platform !== "win32") {
    const bins = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-fakebin-"));
    const script = (name, body) => {
      const f = path.join(bins, name);
      fs.writeFileSync(f, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
      return f;
    };
    const silent = script("silent", "process.stdin.resume();");
    const dies = script(
      "dies",
      `require("readline").createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l);
       if (m.method === "initialize") process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n"); else if (m.id) process.exit(3); });`,
    );
    // answers the way the app-server does (shapes measured on a real thread)
    const replies = script(
      "replies",
      `const turns = { data: [
         { id: "t2", status: "completed", completedAt: 5, items: [{ type: "userMessage", id: "u2", clientId: "other", content: [] }] },
         { id: "t1", status: "failed", completedAt: 4, error: { message: "limit", codexErrorInfo: "usageLimitExceeded" },
           items: [{ type: "userMessage", id: "u1", clientId: "mine", content: [] }, { type: "agentMessage", id: "a1", text: "" }] } ], nextCursor: null };
       const queue = { data: [{ id: "q1", clientUserMessageId: "queued-one", input: [] }] };
       require("readline").createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); if (!m.id) return;
         const result = m.method === "thread/turns/list" ? turns : m.method === "thread/queue/list" ? queue : {};
         process.stdout.write(JSON.stringify({ id: m.id, result }) + "\\n"); });`,
    );
    delete process.env.AGENT_REVIEW_BRIDGE_FAKE_CODEX;
    try {
      process.env.AGENT_REVIEW_BRIDGE_CODEX_BIN = replies;
      assert.deepEqual(await turnOf("t", "mine"), { state: "failed", error: { message: "limit", codexErrorInfo: "usageLimitExceeded" }, completedAt: 4 });
      assert.deepEqual(await turnOf("t", "queued-one"), { state: "queued" });
      assert.deepEqual(await turnOf("t", "nope"), { state: "unknown" });
      process.env.AGENT_REVIEW_BRIDGE_CODEX_BIN = silent;
      let t0 = Date.now();
      await assert.rejects(readLimits({ timeoutMs: 300 }), /didn't answer initialize|no answer/);
      assert.ok(Date.now() - t0 < 2000, "an initialize that never answers is given up on");
      process.env.AGENT_REVIEW_BRIDGE_CODEX_BIN = dies;
      t0 = Date.now();
      await assert.rejects(turnOf("t", "c", { timeoutMs: 2000 }), /exited/);
      assert.ok(Date.now() - t0 < 1500, "a server that dies mid-read fails the read at once");
    } finally {
      delete process.env.AGENT_REVIEW_BRIDGE_CODEX_BIN;
      process.env.AGENT_REVIEW_BRIDGE_FAKE_CODEX = "1";
      fs.rmSync(bins, { recursive: true, force: true });
    }
  }
  // the limits as the bridge reads them
  const full = { ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 40, resetsAt: 2_100_000_000 }, credits: { hasCredits: false } } };
  assert.deepEqual(summarizeLimits(full).blocked, true);
  assert.equal(summarizeLimits(full).resetsAt, 2_000_000_000_000, "the full window's reset");
  assert.equal(summarizeLimits({ ...full, rateLimits: { ...full.rateLimits, credits: { hasCredits: true } } }).blocked, false, "credits still allow use");
  assert.equal(summarizeLimits({}).blocked, false, "nothing known: not blocked");
  fake({ hang: true });
  await assert.rejects(readLimits({ timeoutMs: 100 }), /hang/, "a read that hangs fails in time");
  fake({});
  console.log("1 a turn is found by its prompt's id in app-server answers; calls are time-limited (silent initialize, death mid-read); limits read as blocked only without credits");
}

// 2. a watch record survives a broker takeover: an owner in another process
// queues the request and dies; this process takes over and follows it
const brokerUrl = new URL("../src/broker.mjs", import.meta.url).href;
const first = spawn(
  process.execPath,
  ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});const r=await b.call("link_create",{primary:${JSON.stringify(CLAUDE)},advisor:${JSON.stringify(GPT)},mode:"review",request:"Review before takeover."});console.log(r.id);setInterval(()=>{},1000);`],
  { env: process.env },
);
const takeoverLink = (await new Promise((r) => first.stdout.once("data", r))).toString().trim();
const reqOf = (linkId) => state().messages.find((m) => m.linkId === linkId && m.kind === "review-request");
await until(() => reqOf(takeoverLink)?.watch?.clientId);
first.kill();
await sleep(100);
// a second owner runs older code (protocol 13), queues a request whose send
// fails late, and steps down when this newer process calls: its late error
// must not touch the state the new owner keeps
fake({ deliverRejectAfter: 1500 });
const second = spawn(
  process.execPath,
  ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});const r=await b.call("link_create",{primary:${JSON.stringify(CLAUDE)},advisor:${JSON.stringify(GPT)},mode:"review",request:"Review by an older owner."});console.log(r.id);setInterval(()=>{},1000);`],
  { env: { ...process.env, AGENT_REVIEW_BRIDGE_TEST_PROTOCOL: "13" } },
);
const olderLink = (await new Promise((r) => second.stdout.once("data", r))).toString().trim();
const olderReq = await until(() => reqOf(olderLink)?.dispatch?.clientId && reqOf(olderLink));
fake({ deliverRejectAfter: 1500, turns: { [olderReq.dispatch.clientId]: { state: "queued" } } });
const { call } = await import("../src/broker.mjs");
await call("status"); // takes over: the older owner steps down
await sleep(50);
await call("status"); // the stuck send is checked against the thread
await until(() => reqOf(olderLink).dispatch.state === "sent");
await sleep(1800); // the older owner's send fails now
assert.equal(reqOf(olderLink).dispatch.state, "sent", "a stepped-down owner's late error is dropped");
assert.equal(state().links[olderLink].active, true);
second.kill();
await call("link_close", { linkId: olderLink });
fake({});
const failedFor = (id) => state().messages.filter((m) => m.kind === "failed" && m.about === id);
{
  const m = reqOf(takeoverLink);
  fake({ turns: { [m.watch.clientId]: { state: "failed", completedAt: 1, error: { message: "You've hit your usage limit. Try again at 3:55 AM.", codexErrorInfo: "usageLimitExceeded" } } } });
  const n = await until(() => failedFor(m.id)[0]);
  assert.deepEqual(n.toEndpoint, CLAUDE);
  assert.equal(n.from, "bridge");
  assert.match(n.text, /The ChatGPT chat gpt-fail-thread can't answer m\d+: its turn failed: You've hit your usage limit\. Try again at 3:55 AM\. \(usageLimitExceeded\)\. No review result was received\./);
  const link = state().links[takeoverLink];
  assert.equal(link.active, false);
  assert.equal(link.decision, "failed");
  await sleep(300);
  assert.equal(failedFor(m.id).length, 1, "one notice, however many checks run");
  assert.equal(state().messages.find((x) => x.id === n.id).watch, undefined, "a notice is never watched itself");
  const { inlineText } = await import("../src/broker.mjs");
  assert.match(inlineText(n), /^AGENT-REVIEW-BRIDGE: No answer is coming to m\d+/);
  assert.match(inlineText(n), /Tell the user, in their language, and don't wait for that answer/);
  console.log("2 a failed ChatGPT turn (usage limit) reaches the requester once, after a broker takeover too; the review closes; a stepped-down owner's late send error changes nothing");
}

// 3. only the turn that carries the request's own id counts; a turn still
// queued or running keeps the watch going past the early checks
{
  const { id } = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Second review." });
  const m = await until(() => reqOf(id)?.watch?.clientId && reqOf(id));
  fake({ turns: { "someone-else": { state: "failed", completedAt: 1, error: { message: "other" } }, [m.watch.clientId]: { state: "queued" } } });
  await until(() => reqOf(id).watch.checks >= 4);
  fake({ turns: { [m.watch.clientId]: { state: "inProgress" } } });
  await until(() => reqOf(id).watch.checks >= 6);
  // a turn still running in the desktop app reads as "interrupted", without an end time
  fake({ turns: { [m.watch.clientId]: { state: "interrupted", completedAt: null } } });
  await until(() => reqOf(id).watch.checks >= 8);
  assert.equal(failedFor(m.id).length, 0, "an unrelated failed turn, a queued, running or still-open one: no notice");
  fake({ turns: { [m.watch.clientId]: { state: "completed", completedAt: 1 } } });
  const n = await until(() => failedFor(m.id)[0]);
  assert.match(n.text, /the reviewer's turn ended without an answer/);
  console.log("3 unrelated turns ignored; queued, running and still-open (interrupted without an end) ones followed; a turn that ends without an answer is told");
}

// 4. an answer that arrived is never undone by a later failure
{
  const { id } = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Third review." });
  const m = await until(() => reqOf(id)?.watch?.clientId && reqOf(id));
  await call("advise", { endpoint: GPT, requestId: m.id, decision: "approved" });
  fake({ turns: { [m.watch.clientId]: { state: "failed", completedAt: 1, error: { message: "crashed while writing" } } } });
  await sleep(300);
  assert.equal(failedFor(m.id).length, 0);
  assert.equal(state().links[id].decision, "approved");
  console.log("4 a review answered before its turn failed stays answered");
}

// 5. the deadline: no answer confirmed, even while every read hangs
{
  const { id } = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Fourth review." });
  const m = await until(() => reqOf(id)?.watch?.clientId && reqOf(id));
  fake({ hang: true });
  const n = await until(() => failedFor(m.id)[0], 8000);
  assert.match(n.text, /no answer was confirmed within \d+ hours/);
  fake({});
  console.log("5 past the deadline the requester hears that no answer was confirmed, though the reads hang");
}

// 6. Claude as the reviewer: an API error ends the woken turn (StopFailure)
const gptPrimary = { app: "openai", id: "gpt-asker" };
{
  const { id } = await call("link_create", { primary: gptPrimary, advisor: CLAUDE2, mode: "review", request: "Review this, Claude." });
  const m = reqOf(id);
  const woke = await runHook("claude", "listen", { session_id: CLAUDE2.id });
  assert.equal(woke.code, 2, "the listener wakes the session");
  await until(() => state().messages.find((x) => x.id === m.id).wokenAt);
  await runHook("claude", "stopfail", { session_id: CLAUDE2.id, error: "rate_limit", error_details: "You've hit your limit · resets 4am" });
  const n = await until(() => failedFor(m.id)[0]);
  assert.deepEqual(n.toEndpoint, gptPrimary);
  assert.match(n.text, /The Claude Code session claude-fail-2 can't answer m\d+: an error ended its turn \(rate_limit: You've hit your limit · resets 4am\)\. No review result was received\./);
  await until(() => state().messages.find((x) => x.id === n.id).dispatch, 2000); // handed to the ChatGPT thread
  const st = await call("status", { endpoint: gptPrimary });
  assert.equal(state().endpoints["claude:claude-fail-2"].lastFailure.error, "rate_limit");
  assert.equal(st.lastFailures["claude:claude-fail-2"], undefined, "the review link closed, so it isn't linked any more");
  // a repeated hook doesn't tell twice
  await runHook("claude", "stopfail", { session_id: CLAUDE2.id, error: "rate_limit" });
  await sleep(200);
  assert.equal(failedFor(m.id).length, 1);
  console.log("6 Claude's StopFailure tells the ChatGPT requester once; its failure is recorded");
}

// 7. plain messages to Claude: one handled by a turn that ended normally is
// settled; one whose turn failed gets a notice, and its link stays open
{
  const { id } = await call("link_create", { primary: gptPrimary, advisor: CLAUDE2, mode: "review", request: "Another review." });
  await runHook("claude", "listen", { session_id: CLAUDE2.id });
  await runHook("claude", "stop", { session_id: CLAUDE2.id });
  await until(() => state().messages.find((x) => x.id === reqOf(id).id).settledAt);
  assert.equal(state().endpoints["claude:claude-fail-2"].lastFailure, undefined, "a normal end clears the failure");
  const sent = await call("send", { endpoint: gptPrimary, text: "Any thoughts on the cache?", linkId: id });
  await runHook("claude", "listen", { session_id: CLAUDE2.id });
  await until(() => state().messages.find((x) => x.id === sent.id).wokenAt);
  await runHook("claude", "stopfail", { session_id: CLAUDE2.id, error: "overloaded" });
  const n = await until(() => failedFor(sent.id)[0]);
  assert.match(n.text, /No reply was received/);
  assert.equal(failedFor(reqOf(id).id).length, 0, "the settled review request isn't failed");
  assert.equal(state().links[id].active, true, "a plain message's failure leaves the link alone");
  // a sender is warned about a chat last seen failing
  const again = await call("send", { endpoint: gptPrimary, text: "Still there?", linkId: id });
  assert.equal(again.lastFailure.error, "overloaded");
  assert.equal((await call("status", { endpoint: gptPrimary })).lastFailures["claude:claude-fail-2"].error, "overloaded");
  await call("link_close", { linkId: id });
  console.log("7 a Claude plain message whose turn failed is told, a handled one isn't; the link stays; senders are warned");
}

// 8. event times decide, not arrival order: a late success doesn't clear a
// newer failure, a late duplicate failure doesn't come back after a success
{
  const E = { app: "claude", id: "claude-fail-times" };
  const t = Date.now();
  await call("turn_failed", { endpoint: E, at: t + 200, error: "rate_limit" });
  await call("turn_ok", { endpoint: E, at: t + 100 });
  assert.equal(state().endpoints["claude:claude-fail-times"].lastFailure.at, t + 200, "an older success doesn't clear a newer failure");
  await call("turn_ok", { endpoint: E, at: t + 300 });
  await call("turn_failed", { endpoint: E, at: t + 200, error: "rate_limit" });
  assert.equal(state().endpoints["claude:claude-fail-times"].lastFailure, undefined, "a late duplicate failure doesn't come back");
  console.log("8 Claude turn events are applied by their own times");
}

// 9. a ChatGPT plain message whose turn failed tells its sender; one already
// replied to doesn't
{
  const { id } = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Keep this open." });
  const replied = await call("send", { endpoint: CLAUDE, text: "One question.", linkId: id });
  const plain = await call("send", { endpoint: CLAUDE, text: "Another one.", linkId: id });
  const msg = (mid) => state().messages.find((x) => x.id === mid);
  await until(() => msg(replied.id).watch?.clientId && msg(plain.id).watch?.clientId);
  await call("send", { endpoint: GPT, text: "Answer.", replyTo: replied.id });
  const err = { state: "failed", completedAt: 1, error: { message: "server overloaded", codexErrorInfo: "serverOverloaded" } };
  fake({ turns: { [msg(replied.id).watch.clientId]: err, [msg(plain.id).watch.clientId]: err } });
  const n = await until(() => failedFor(plain.id)[0]);
  assert.match(n.text, /server overloaded \(serverOverloaded\)\. No reply was received/);
  await sleep(200);
  assert.equal(failedFor(replied.id).length, 0, "replied to: no notice");
  await call("link_close", { linkId: id });
  console.log("9 a failed ChatGPT turn for a plain message tells its sender, unless it was replied to");
}

// 10. a send that never reported back is checked against the thread before
// it is sent again, and keeps its id either way
{
  const delivered = (cid) => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"fake-codex-deliver"') && l.includes(cid)).length;
  fake({ deliverHang: true });
  const a = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Stuck send A." });
  const ma = await until(() => reqOf(a.id)?.dispatch?.clientId && reqOf(a.id));
  const cid = ma.dispatch.clientId;
  fake({ deliverHang: true, turns: { [cid]: { state: "queued" } } });
  await sleep(50);
  await call("status"); // any op runs dispatch: the stuck send is checked
  await until(() => reqOf(a.id).dispatch.state === "sent");
  assert.equal(delivered(cid), 1, "the thread had it: not sent twice");
  const b = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Stuck send B." });
  const mb = await until(() => reqOf(b.id)?.dispatch?.clientId && reqOf(b.id));
  fake({});
  await sleep(50);
  await call("status");
  await until(() => reqOf(b.id).dispatch.state === "sent");
  assert.equal(delivered(mb.dispatch.clientId), 2, "no trace of it: sent again");
  assert.equal(reqOf(b.id).dispatch.clientId, mb.dispatch.clientId, "with the same id");
  assert.equal(reqOf(b.id).watch.clientId, mb.dispatch.clientId);
  await call("link_close", { linkId: a.id });
  await call("link_close", { linkId: b.id });
  // a late error from the first attempt doesn't undo a send the thread confirmed
  fake({ deliverRejectAfter: 400 });
  const c = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Late error." });
  const mc = await until(() => reqOf(c.id)?.dispatch?.clientId && reqOf(c.id));
  fake({ deliverRejectAfter: 400, turns: { [mc.dispatch.clientId]: { state: "queued" } } });
  await sleep(50);
  await call("status");
  await until(() => reqOf(c.id).dispatch.state === "sent");
  await sleep(600);
  assert.equal(reqOf(c.id).dispatch.state, "sent", "the late error is dropped");
  assert.equal(state().links[c.id].active, true);
  assert.equal(failedFor(mc.id).length, 0);
  await call("link_close", { linkId: c.id });
  // a send that fails: queued after all → sent; no trace → the requester is told
  fake({ deliverRejectAfter: 150 });
  const d = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Error but queued." });
  const md = await until(() => reqOf(d.id)?.dispatch?.clientId && reqOf(d.id));
  fake({ deliverRejectAfter: 150, turns: { [md.dispatch.clientId]: { state: "queued" } } });
  await until(() => reqOf(d.id).dispatch.state === "sent");
  assert.equal(failedFor(md.id).length, 0, "the thread had it: no notice");
  await call("link_close", { linkId: d.id });
  const e = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Error, not queued." });
  const me = await until(() => reqOf(e.id)?.dispatch?.clientId && reqOf(e.id));
  const n = await until(() => failedFor(me.id)[0]);
  assert.match(n.text, /it couldn't be handed to ChatGPT Desktop \(no answer from ChatGPT Desktop within 60 s \(test\)\)/);
  // a failed send while the thread can't be read either: nothing is decided;
  // the watch confirms it later, or finds no trace and tells
  fake({ deliverRejectAfter: 150, hang: true });
  const g = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Unconfirmed, then queued." });
  const mg = await until(() => reqOf(g.id)?.dispatch?.state === "unconfirmed" && reqOf(g.id));
  assert.equal(state().links[g.id].active, true, "an unreadable thread doesn't close the review");
  fake({ turns: { [mg.dispatch.clientId]: { state: "queued" } } });
  await until(() => reqOf(g.id).dispatch.state === "sent");
  await sleep(200);
  assert.equal(failedFor(mg.id).length, 0);
  assert.equal(state().links[g.id].active, true);
  await call("link_close", { linkId: g.id });
  fake({ deliverRejectAfter: 150, hang: true });
  const h = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Unconfirmed, then no trace." });
  const mh = await until(() => reqOf(h.id)?.dispatch?.state === "unconfirmed" && reqOf(h.id));
  fake({});
  const nh = await until(() => failedFor(mh.id)[0]);
  assert.match(nh.text, /it couldn't be handed to ChatGPT Desktop/);
  console.log("10 a send that never reported back is checked first: not sent twice, resent with the same id; a late error can't undo a confirmed send; a failed send is told only when the thread shows no trace; unreadable, it stays unconfirmed for the watch");
}

// 11. a review Claude takes with bridge_receive (after joining) is covered
// too; a Stop that the auto mode check blocks isn't a finished turn
{
  const { id, joinCode } = await call("link_create", { primary: gptPrimary, mode: "review", request: "Joined review." });
  const J = { app: "claude", id: "claude-fail-join" };
  await call("link_join", { code: joinCode, endpoint: J });
  const m = reqOf(id);
  await call("receive", { side: "claude", endpoint: J });
  assert.ok(state().messages.find((x) => x.id === m.id).wokenAt, "handed over by bridge_receive");
  // auto mode with a change nobody approved: the first Stop is blocked
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-failure-work-"));
  fs.writeFileSync(path.join(work, "a.txt"), "x");
  await call("auto_set", { endpoint: J, on: true, paths: [{ path: work, fp: "not-this", head: null }] });
  const blocked = await runHook("claude", "stop", { session_id: J.id });
  assert.match(blocked.out, /"decision":"block"/, "the auto mode check stops the turn");
  await sleep(700);
  assert.equal(state().endpoints?.["claude:claude-fail-join"]?.lastOkAt, undefined, "a blocked Stop doesn't settle anything");
  await runHook("claude", "stopfail", { session_id: J.id, error: "rate_limit" });
  const n = await until(() => failedFor(m.id)[0]);
  assert.deepEqual(n.toEndpoint, gptPrimary);
  await call("auto_set", { endpoint: J, on: false });
  fs.rmSync(work, { recursive: true, force: true });
  console.log("11 a review taken with bridge_receive is covered by StopFailure; a Stop blocked by auto mode doesn't settle it");
}

// 12. auto mode turned on again starts fresh, and a late approval from the
// earlier session leaves the new one's paths alone
{
  const A = { app: "claude", id: "claude-fail-auto" };
  await call("auto_set", { endpoint: A, on: true, thread: "old-thread", paths: [{ path: "/x", fp: "f1", head: "h1" }] });
  const { id } = await call("link_create", { primary: A, advisor: GPT, mode: "review", request: "Old session.", reqPaths: [{ path: "/x", fp: "f2", head: "h2" }] });
  await call("auto_set", { endpoint: A, on: false });
  await sleep(5);
  const fresh = await call("auto_set", { endpoint: A, on: true });
  assert.equal(fresh.thread, null, "a new reviewer chat");
  assert.deepEqual(fresh.paths, {}, "paths as they are now");
  await call("advise", { endpoint: GPT, requestId: reqOf(id).id, decision: "approved" });
  assert.deepEqual(state().auto["claude:claude-fail-auto"].paths, {}, "the old session's approval doesn't land here");
  const kept = await call("auto_set", { endpoint: A, on: true, thread: "t2" });
  assert.equal((await call("auto_set", { endpoint: A, on: true })).thread, "t2", "turning it on while on keeps the chat");
  assert.equal(kept.since, fresh.since);
  console.log("12 auto mode on again starts fresh; a late approval from before doesn't touch it");
}

// 13. a review that got no answer can be asked again with round_of: same
// reviewer, same round number, with the reviewer's last real findings; the
// notice says how; a retry is continued once only and keeps the plan gate
{
  const { nextStep } = await import("../src/broker.mjs");
  const r1 = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Retry round one.", plan: true, noGate: true });
  await call("advise", { endpoint: GPT, requestId: reqOf(r1.id).id, decision: "changes_requested", blocking: [{ title: "Order the steps." }] });
  const info = await call("round_info", { primary: CLAUDE, roundOf: r1.id });
  assert.equal(info.round, 2);
  assert.match(info.previous.text, /Order the steps\./);
  const r2 = await call("link_continue", { primary: CLAUDE, roundOf: r1.id, request: "Round two." });
  const m2 = await until(() => reqOf(r2.id)?.watch?.clientId && reqOf(r2.id));
  fake({ turns: { [m2.watch.clientId]: { state: "completed", completedAt: 1 } } });
  const n = await until(() => failedFor(m2.id)[0]);
  assert.match(nextStep(state().messages.find((x) => x.id === n.id)), new RegExp(`use bridge_review\\(round_of="${r2.id}"\\)`), "the notice says how to ask again");
  fake({});
  const again = await call("round_info", { primary: CLAUDE, roundOf: r2.id });
  assert.equal(again.retry, true);
  assert.equal(again.round, 2, "a retry keeps its round");
  assert.equal(again.previous.linkId, r1.id, "the last real answer, from round one");
  const r3 = await call("link_continue", { primary: CLAUDE, roundOf: r2.id, request: "Round two, again." });
  assert.equal(r3.round, 2);
  assert.equal(r3.retry, true);
  assert.deepEqual(r3.advisor, GPT, "the same reviewer");
  assert.match(reqOf(r3.id).text, new RegExp(`^Retry of round 2 of review ${r1.id}: the previous attempt \\(${r2.id}\\) got no answer\\.`));
  assert.equal(reqOf(r3.id).plan, true);
  assert.equal(state().links[r3.id].noGate, true, "the plan gate stays with the retry");
  await assert.rejects(call("link_continue", { primary: CLAUDE, roundOf: r2.id, request: "twice" }), /already continued/);
  await call("advise", { endpoint: GPT, requestId: reqOf(r3.id).id, decision: "approved" });
  // a retry of a first round has no earlier answer
  const f1 = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Lost first round." });
  const mf = await until(() => reqOf(f1.id)?.watch?.clientId && reqOf(f1.id));
  fake({ turns: { [mf.watch.clientId]: { state: "failed", completedAt: 1, error: { message: "limit" } } } });
  await until(() => failedFor(mf.id)[0]);
  fake({});
  const first = await call("round_info", { primary: CLAUDE, roundOf: f1.id });
  assert.deepEqual([first.round, first.retry, first.previous], [1, true, { none: true }]);
  // at the round cap a retry is still allowed, a further round isn't
  process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS = "2";
  try {
    const c1 = await call("link_create", { primary: CLAUDE, advisor: GPT, mode: "review", request: "Cap one." });
    await call("advise", { endpoint: GPT, requestId: reqOf(c1.id).id, decision: "changes_requested", blocking: [{ title: "a" }] });
    const c2 = await call("link_continue", { primary: CLAUDE, roundOf: c1.id, request: "Cap two." });
    const mc = await until(() => reqOf(c2.id)?.watch?.clientId && reqOf(c2.id));
    fake({ turns: { [mc.watch.clientId]: { state: "interrupted", completedAt: 1 } } });
    await until(() => failedFor(mc.id)[0]);
    fake({});
    const c3 = await call("link_continue", { primary: CLAUDE, roundOf: c2.id, request: "Cap two, again." });
    assert.equal(c3.round, 2, "a retry at the cap");
    await call("advise", { endpoint: GPT, requestId: reqOf(c3.id).id, decision: "changes_requested", blocking: [{ title: "b" }] });
    await assert.rejects(call("link_continue", { primary: CLAUDE, roundOf: c3.id, request: "Cap three." }), /rounds without approval/);
  } finally {
    delete process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS;
  }
  console.log("13 a review that got no answer is asked again with round_of: same reviewer and round, the last real findings, the plan gate kept, once only, allowed at the cap");
}

// 14. in auto mode a review that got no answer may be retried once by the
// agent itself; the retry's own failure gives no new retry
{
  const { nextStep } = await import("../src/broker.mjs");
  const A = { app: "claude", id: "claude-fail-auto" };
  await call("auto_set", { endpoint: A, on: true });
  const fail = async (linkId, turn) => {
    const m = await until(() => reqOf(linkId)?.watch?.clientId && reqOf(linkId));
    fake({ turns: { [m.watch.clientId]: turn } });
    await until(() => failedFor(m.id)[0]);
    fake({});
    const got = (await call("receive", { side: "claude", endpoint: A })).messages.find((x) => x.kind === "failed" && x.linkId === linkId);
    assert.ok(got, "the notice is received with its fields");
    return got;
  };
  const r1 = await call("link_create", { primary: A, advisor: GPT, mode: "review", request: "Auto review." });
  const n1 = await fail(r1.id, { state: "interrupted", completedAt: 1 });
  assert.deepEqual([n1.auto, n1.retried], [true, undefined]);
  assert.match(n1.text, /its turn was interrupted \(someone may have stopped it in the app\)/);
  assert.match(nextStep(n1), new RegExp(`Auto mode: .* once more yourself with bridge_review\\(round_of="${r1.id}"\\); if that fails too, tell the user and don't retry again\\.`));
  const r2 = await call("link_continue", { primary: A, roundOf: r1.id, request: "Auto review, again." });
  assert.equal(state().links[r2.id].retry, true, "the retry is kept on its link");
  const n2 = await fail(r2.id, { state: "failed", completedAt: 1, error: { message: "limit" } });
  assert.deepEqual([n2.auto, n2.retried], [true, true]);
  assert.doesNotMatch(nextStep(n2), /Auto mode/, "a failed retry gives no new one");
  assert.match(nextStep(n2), /Ask again only if the user wants to/);
  await call("auto_set", { endpoint: A, on: false });
  console.log("14 auto mode: a failed review may be retried once by the agent; the retry's failure is told to the user");
}

// 15. a Claude chat working for another waits on the user to approve a tool
// (Notification, permission_prompt): whoever waits on it is told, once per
// message; nothing for advisor mode, answered, closed or ended work, or a chat
// working for nobody; a notice not yet read is dropped once the answer is in
{
  const { call, nextStep, inlineText } = await import("../src/broker.mjs");
  const C = { app: "claude", id: "claude-approver" };
  const P = { app: "openai", id: "gpt-asks-claude" };
  const A = { app: "openai", id: "gpt-advised" };
  const waiting = (about) => state().messages.filter((x) => x.kind === "waiting" && x.about === about);
  const prompt = (message = "Claude needs your permission to use Bash") =>
    runHook("claude", "permission", { session_id: C.id, hook_event_name: "Notification", notification_type: "permission_prompt", message });
  const handOver = async (id) => call("receive", { side: "claude", endpoint: C, id });
  const reviewOn = async (request) => {
    const l = await call("link_create", { primary: P, advisor: C, mode: "review", request });
    return { link: l, req: await until(() => state().messages.find((x) => x.linkId === l.id && x.kind === "review-request")) };
  };
  const quiet = async (id, why) => {
    await prompt();
    await sleep(300);
    assert.equal(waiting(id).length, 0, why);
  };
  // a one-off review: the requester is told, with the tool
  const { link: review, req } = await reviewOn("Check the parser.");
  await handOver(req.id);
  const out = await prompt();
  assert.deepEqual([out.code, out.out], [0, ""], "the hook prints nothing");
  const n = await until(() => waiting(req.id)[0]);
  assert.deepEqual(n.toEndpoint, P);
  assert.equal(n.from, "bridge");
  assert.match(n.text, new RegExp(`The Claude Code session ${C.id} is waiting for the user to approve a tool in Claude Desktop \\(Bash\\)\\. Its answer to ${req.id} comes after that\\.`));
  assert.match(inlineText(n), new RegExp(`The answer to ${req.id} waits for the user's approval`));
  assert.match(nextStep(n), /Tell the user, in their language, that the other chat is waiting for their approval there/);
  assert.equal(n.watch, undefined, "a notice is never watched");
  // a second prompt in the same work adds nothing
  await prompt("Claude needs your permission to use Read");
  await sleep(300);
  assert.equal(waiting(req.id).length, 1, "told once");
  // a message on the same link: its sender is told too
  const sent = await call("send", { endpoint: P, text: "Also look at the tests." });
  await handOver(sent.id);
  await prompt("Claude needs your permission to use Read");
  assert.match((await until(() => waiting(sent.id)[0])).text, /\(Read\)/);
  // the answer arrives before a Claude requester read the notice: it's dropped
  const Q = { app: "claude", id: "claude-asker" };
  const stale = await call("link_create", { primary: Q, advisor: C, mode: "review", request: "Stale check." });
  const sreq = await until(() => state().messages.find((x) => x.linkId === stale.id && x.kind === "review-request"));
  await handOver(sreq.id);
  await prompt();
  const sn = await until(() => waiting(sreq.id)[0]);
  assert.deepEqual([sn.toEndpoint, sn.readAt], [Q, null], "waiting for the requester to read it");
  await call("advise", { endpoint: C, requestId: sreq.id, decision: "approved" });
  assert.ok(state().messages.find((x) => x.id === sn.id).readAt, "dropped once the answer is in");
  assert.ok(!(await call("receive", { side: "claude", endpoint: Q })).messages.some((x) => x.kind === "waiting"), "not handed to the requester");
  // the same for a message answered with a reply
  const open2 = await call("link_create", { primary: Q, advisor: C, mode: "review", request: "Reply check." });
  const asked = await call("send", { endpoint: Q, text: "Which test covers it?" });
  await handOver(asked.id);
  await prompt();
  const an = await until(() => waiting(asked.id)[0]);
  assert.equal(an.readAt, null);
  await call("send", { endpoint: C, text: "test-link 30.", replyTo: asked.id });
  assert.ok(state().messages.find((x) => x.id === an.id).readAt, "dropped once the reply is in");
  await call("link_close", { linkId: open2.id });
  await call("link_close", { linkId: review.id });
  // advisor mode: nothing (it would start the primary's turn, and a new review)
  const adv = await call("link_create", { primary: A, advisor: C });
  await runHook("openai", "stop", { session_id: A.id, last_assistant_message: "Done with step one." });
  const areq = await until(() => state().messages.find((x) => x.linkId === adv.id && x.kind === "review-request"));
  await handOver(areq.id);
  await quiet(areq.id, "advisor mode");
  await call("link_close", { linkId: adv.id });
  // nothing for work that is already over, each told nothing before its first prompt
  const { link: r2, req: req2 } = await reviewOn("Second look.");
  await handOver(req2.id);
  await call("advise", { endpoint: C, requestId: req2.id, decision: "approved" });
  await quiet(req2.id, "an answered review");
  const { link: r3 } = await reviewOn("Third look.");
  const msg3 = await call("send", { endpoint: P, text: "One more thing." });
  await handOver(msg3.id);
  await call("link_close", { linkId: r3.id });
  await quiet(msg3.id, "a message on a closed link");
  const { link: r4, req: req4 } = await reviewOn("Fourth look.");
  await handOver(req4.id);
  await runHook("claude", "stop", { session_id: C.id, last_assistant_message: "Done." }); // its turn ended: settled
  await until(() => state().messages.find((x) => x.id === req4.id).settledAt);
  await quiet(req4.id, "a request from a turn that ended");
  for (const l of [r2, r4]) await call("link_close", { linkId: l.id }).catch(() => {});
  // a chat working for nobody: nothing at all
  const total = state().messages.filter((x) => x.kind === "waiting").length;
  await runHook("claude", "permission", { session_id: "claude-alone", hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  await sleep(300);
  assert.equal(state().messages.filter((x) => x.kind === "waiting").length, total);
  console.log("15 a tool approval waiting: told once (review, message), dropped once answered; not for advisor mode, answered, closed or ended work, or an idle chat");
}

// 16. a ChatGPT reviewer asked to run a command outside its sandbox and has no
// result yet: whoever waits hears it may be waiting on an approval, once. Read
// from the thread's rollout, which records the request but never the decision.
{
  const { call, nextStep, inlineText } = await import("../src/broker.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-codexhome-"));
  process.env.CODEX_HOME = home;
  const R = { app: "claude", id: "claude-waits-on-gpt" };
  let seq = 0;
  // a UUIDv7-shaped thread id made now, as ChatGPT's are
  const newThread = () => {
    const hex = Date.now().toString(16).padStart(12, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${String(++seq).padStart(12, "0")}`;
  };
  const fileOf = (id) => {
    const d = new Date(parseInt(id.replace(/-/g, "").slice(0, 12), 16));
    const p = (n) => String(n).padStart(2, "0");
    const folder = path.join(home, "sessions", String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
    fs.mkdirSync(folder, { recursive: true });
    return path.join(folder, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  };
  const write = (id, records, tail = "") => fs.writeFileSync(fileOf(id), records.map((r) => JSON.stringify(r)).join("\n") + "\n" + tail);
  const stamp = (at) => new Date(at).toISOString();
  const custom = (callId, at) => ({ timestamp: stamp(at), type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec", input: 'text(await tools.exec_command({cmd:"git diff",sandbox_permissions:"require_escalated",justification:"May I run git diff outside the sandbox?"}))' } });
  const fn = (callId, at) => ({ timestamp: stamp(at), type: "response_item", payload: { type: "function_call", call_id: callId, name: "shell", arguments: JSON.stringify({ command: ["git", "diff"], sandbox_permissions: "require_escalated", justification: "Run the diff, please." }) } });
  const output = (callId, at) => ({ timestamp: stamp(at), type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: "Script completed\nWall time 1.0 seconds\nOutput:" }, { type: "input_text", text: "ok" }] } });
  const plain = (at) => ({ timestamp: stamp(at), type: "response_item", payload: { type: "custom_tool_call", call_id: `plain-${at}`, name: "exec", input: "text(await tools.exec_command({cmd:\"ls\"}))" } });
  const turns = {};
  const waiting = (about) => state().messages.filter((x) => x.kind === "waiting" && x.about === about);
  const review = async (request, running = true) => {
    const thread = newThread();
    const link = await call("link_create", { primary: R, advisor: { app: "openai", id: thread }, mode: "review", request });
    const m = await until(() => {
      const x = state().messages.find((y) => y.linkId === link.id && y.kind === "review-request");
      return x?.watch?.clientId && x;
    });
    if (running) turns[m.watch.clientId] = { state: "inProgress" };
    fake({ turns });
    return { thread, link, m };
  };
  const quiet = async (id, why) => {
    await sleep(400);
    assert.equal(waiting(id).length, 0, why);
  };
  // unanswered for longer than the threshold: told once, as a possibility
  const a = await review("Check A.");
  write(a.thread, [plain(Date.now()), custom("call-a", Date.now())]);
  const n = await until(() => waiting(a.m.id)[0]);
  assert.deepEqual(n.toEndpoint, R);
  assert.equal(n.maybe, true);
  assert.match(n.text, new RegExp(`The ChatGPT chat ${a.thread} asked to run a command outside its sandbox more than a minute ago and has no result yet \\(May I run git diff outside the sandbox\\?\\): it may be waiting for the user's approval in ChatGPT Desktop, or the command may still be running\\.`));
  assert.match(inlineText(n), new RegExp(`The answer to ${a.m.id} may wait for the user's approval`));
  assert.match(nextStep(n), /may be waiting for their approval in ChatGPT Desktop, and to check it/);
  assert.doesNotMatch(nextStep(n), /the answer arrives once it's approved/, "nothing firmer than 'may'");
  await sleep(400);
  assert.equal(waiting(a.m.id).length, 1, "told once");
  // answered: nothing
  const b = await review("Check B.");
  write(b.thread, [custom("call-b", Date.now()), output("call-b", Date.now())]);
  await quiet(b.m.id, "an answered request");
  // asked just now (younger than the threshold; with the watch scaled down for
  // tests, a stamp in the future stands for "just now"): nothing yet
  const c = await review("Check C.");
  write(c.thread, [custom("call-c", Date.now() + 60_000)]);
  await quiet(c.m.id, "not a minute old");
  // asked before this request was sent: not this turn's
  const d = await review("Check D.");
  write(d.thread, [custom("call-d", d.m.watch.since - 5_000)]);
  await quiet(d.m.id, "from before the request");
  // the last line not fully written yet: nothing decided on it
  const e = await review("Check E.");
  write(e.thread, [custom("call-e", Date.now())], '{"timestamp":"2026-01-01T00:00:00.000Z","type":"response_item","payload":{"type":"custom_tool_c');
  await quiet(e.m.id, "a line still being written");
  // the other call shape, while the turn can't be read (unknown)
  const f = await review("Check F.", false);
  write(f.thread, [fn("call-f", Date.now())]);
  assert.match((await until(() => waiting(f.m.id)[0])).text, /\(Run the diff, please\.\)/);
  // a rollout over 512 KB: only its end is read
  const g = await review("Check G.");
  const padded = (k) => ({ ...plain(Date.now() - 1000), pad: "p".repeat(1_000), k });
  write(g.thread, [...Array.from({ length: 700 }, (_, k) => padded(k)), custom("call-g", Date.now())]);
  assert.ok(fs.statSync(fileOf(g.thread)).size > 512 * 1024);
  await until(() => waiting(g.m.id)[0]);
  // one asked before more than 512 KB of later records: past the end that's read
  const g2 = await review("Check G2.");
  write(g2.thread, [custom("call-g2", Date.now()), ...Array.from({ length: 700 }, (_, k) => padded(k))]);
  await quiet(g2.m.id, "only the end of the rollout is read");
  // the word in a command or in text isn't the parameter
  const k = await review("Check K.");
  write(k.thread, [{ timestamp: stamp(Date.now()), type: "response_item", payload: { type: "custom_tool_call", call_id: "call-k", name: "exec", input: 'text(await tools.exec_command({cmd:"grep -rn require_escalated src"}))' } }]);
  await quiet(k.m.id, "a grep for the word");
  // no rollout at all: nothing, and no error
  const h = await review("Check H.");
  await quiet(h.m.id, "no rollout");
  // a rollout that shows up only after the first checks: still found
  const h2 = await review("Check H2.");
  await sleep(400);
  write(h2.thread, [custom("call-h2", Date.now())]);
  await until(() => waiting(h2.m.id)[0]);
  // a long command hands back an interim output and goes on in the background;
  // a later wait / write_stdin reports on it. Not its result until one of those
  // reports isn't another interim output.
  const rec = (type, extra) => ({ timestamp: stamp(Date.now()), type: "response_item", payload: { type, ...extra } });
  const yielded = (callId, cell) => rec("custom_tool_call_output", { call_id: callId, output: [{ type: "input_text", text: `Script running with cell ID ${cell}\nWall time 31.0 seconds\nOutput:` }] });
  const waitOn = (callId, cell) => rec("function_call", { call_id: callId, name: "wait", arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 30000 }) });
  const shell = (callId) => rec("function_call", { call_id: callId, name: "exec_command", arguments: JSON.stringify({ cmd: "npm test", sandbox_permissions: "require_escalated", justification: "Run the tests?" }) });
  const proc = (callId, how) => rec("function_call_output", { call_id: callId, output: `Chunk ID: 1a2b\nWall time: 30.0 seconds\n${how}\nOriginal token count: 3\nOutput:\n` });
  const stdin = (callId, session) => rec("function_call", { call_id: callId, name: "write_stdin", arguments: JSON.stringify({ session_id: session, chars: "" }) });
  // exec: yielded, and the wait on its cell has no result yet: told
  const y1 = await review("Check Y1.");
  write(y1.thread, [custom("call-y1", Date.now()), yielded("call-y1", "g6:11"), waitOn("wait-y1", "g6:11")]);
  await until(() => waiting(y1.m.id)[0]);
  // exec: yielded, then the wait on it completed: nothing
  const y2 = await review("Check Y2.");
  write(y2.thread, [custom("call-y2", Date.now()), yielded("call-y2", "g7:2"), waitOn("wait-y2", "g7:2"), rec("function_call_output", { call_id: "wait-y2", output: [{ type: "input_text", text: "Script completed\nWall time 2.0 seconds\nOutput:" }] })]);
  await quiet(y2.m.id, "a yielded cell whose wait completed");
  // exec_command: still running after a write_stdin: told
  const y3 = await review("Check Y3.");
  write(y3.thread, [shell("call-y3"), proc("call-y3", "Process running with session ID 7"), stdin("stdin-y3", 7), proc("stdin-y3", "Process running with session ID 7")]);
  assert.match((await until(() => waiting(y3.m.id)[0])).text, /\(Run the tests\?\)/);
  // exec_command: exited after a write_stdin: nothing
  const y4 = await review("Check Y4.");
  write(y4.thread, [shell("call-y4"), proc("call-y4", "Process running with session ID 8"), stdin("stdin-y4", 8), proc("stdin-y4", "Process exited with code 0")]);
  await quiet(y4.m.id, "a session that exited");
  // notify() adds outputs to an exec call while it runs: they don't end it,
  // before or after a yield
  const note = (callId, text) => rec("custom_tool_call_output", { call_id: callId, output: text });
  const y5 = await review("Check Y5.");
  write(y5.thread, [custom("call-y5", Date.now()), note("call-y5", "Checking"), yielded("call-y5", "g8:1"), waitOn("wait-y5", "g8:1")]);
  await until(() => waiting(y5.m.id)[0]);
  const y6 = await review("Check Y6.");
  write(y6.thread, [custom("call-y6", Date.now()), yielded("call-y6", "g9:1"), note("call-y6", "Halfway"), waitOn("wait-y6", "g9:1")]);
  await until(() => waiting(y6.m.id)[0]);
  // notify(), then the result: nothing
  const y7 = await review("Check Y7.");
  write(y7.thread, [custom("call-y7", Date.now()), note("call-y7", "Checking"), output("call-y7", Date.now())]);
  await quiet(y7.m.id, "notify, then completed");
  // an exec that reports on a running session calls notify() first, then
  // finishes: the request ends with it
  const reportExec = (callId, session) => rec("custom_tool_call", { call_id: callId, name: "exec", input: `notify("Checking tests"); text(await tools.write_stdin({session_id:${session},chars:""}))` });
  const y10 = await review("Check Y10.");
  write(y10.thread, [shell("call-y10"), proc("call-y10", "Process running with session ID 9"), reportExec("rep-y10", 9), note("rep-y10", "Checking tests"), output("rep-y10", Date.now())]);
  await quiet(y10.m.id, "a report that notified, then finished");
  // a finished command whose own output prints a running line: finished
  const y8 = await review("Check Y8.");
  write(y8.thread, [custom("call-y8", Date.now()), rec("custom_tool_call_output", { call_id: "call-y8", output: "Script completed\nWall time 1.0 seconds\nOutput:\nScript running with cell ID example" })]);
  await quiet(y8.m.id, "the running line is in the command's output");
  const y9 = await review("Check Y9.");
  write(y9.thread, [shell("call-y9"), rec("function_call_output", { call_id: "call-y9", output: "Chunk ID: 1a2b\nWall time: 1.0 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nProcess running with session ID 7\n" })]);
  await quiet(y9.m.id, "the running line is in the process's output");
  // a message to a ChatGPT chat: its sender is told
  const i = await review("Check I.", false);
  write(i.thread, []);
  const sent = await call("send", { endpoint: R, text: "Also check the README.", linkId: i.link.id });
  const sm = await until(() => {
    const x = state().messages.find((y) => y.id === sent.id);
    return x?.watch?.clientId && x;
  });
  turns[sm.watch.clientId] = { state: "inProgress" };
  fake({ turns });
  write(i.thread, [custom("call-i", Date.now())]);
  assert.deepEqual((await until(() => waiting(sent.id)[0])).toEndpoint, R);
  // the turn can't be read at all (the read fails): still checked
  const j = await review("Check J.", false);
  write(j.thread, [custom("call-j", Date.now())]);
  fake({ turns, hang: true });
  await until(() => waiting(j.m.id)[0], 8000);
  fake({ turns });
  // advisor mode: the review of a primary's turn is never watched, never told
  const advThread = newThread();
  const adv = await call("link_create", { primary: R, advisor: { app: "openai", id: advThread } });
  await runHook("claude", "stop", { session_id: R.id, last_assistant_message: "Step one done." });
  const areq = await until(() => state().messages.find((x) => x.linkId === adv.id && x.kind === "review-request"));
  write(advThread, [custom("call-adv", Date.now())]);
  await sleep(400);
  assert.equal(state().messages.find((x) => x.id === areq.id).watch, undefined, "not watched");
  assert.equal(waiting(areq.id).length, 0, "advisor mode");
  for (const l of [a, b, c, d, e, f, g, g2, h, h2, i, j, k, y1, y2, y3, y4, y5, y6, y7, y8, y9, y10]) await call("link_close", { linkId: l.link.id }).catch(() => {});
  await call("link_close", { linkId: adv.id });
  fake({});
  delete process.env.CODEX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  console.log("16 a ChatGPT reviewer with an unanswered sandbox escalation: told once as a possibility (both call shapes, turn unknown or unreadable, only the end of a large rollout, a rollout that shows up late, a yielded command still running, notify() outputs before or after a yield); nothing when answered (also through a later wait or write_stdin, one that notified first, or with a running line in the command's own output), too new, from before, half written, without a rollout, or for the word in a command; advisor mode out");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("\nfailure tests passed");
process.exit(0);
