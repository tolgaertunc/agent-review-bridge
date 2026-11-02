// When the other side can't answer: a ChatGPT turn that fails (a usage limit),
// a Claude turn ended by an API error (StopFailure), and the limits check.
// Throwaway data dir, ChatGPT faked through <data dir>/fake-codex.json, and the
// watch's timing scaled down (first checks after ~20 ms, deadline ~4 s).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-failure-"));
Object.assign(process.env, {
  PEER_BRIDGE_DIR: dir,
  PEER_BRIDGE_PORT: "7487",
  PEER_BRIDGE_FAKE_CODEX: "1",
  PEER_BRIDGE_TEST_WATCH_SCALE: "0.0002",
  PEER_BRIDGE_CONFIG_DIR: path.join(dir, "config"),
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
    const bins = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-fakebin-"));
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
    delete process.env.PEER_BRIDGE_FAKE_CODEX;
    try {
      process.env.PEER_BRIDGE_CODEX_BIN = replies;
      assert.deepEqual(await turnOf("t", "mine"), { state: "failed", error: { message: "limit", codexErrorInfo: "usageLimitExceeded" }, completedAt: 4 });
      assert.deepEqual(await turnOf("t", "queued-one"), { state: "queued" });
      assert.deepEqual(await turnOf("t", "nope"), { state: "unknown" });
      process.env.PEER_BRIDGE_CODEX_BIN = silent;
      let t0 = Date.now();
      await assert.rejects(readLimits({ timeoutMs: 300 }), /didn't answer initialize|no answer/);
      assert.ok(Date.now() - t0 < 2000, "an initialize that never answers is given up on");
      process.env.PEER_BRIDGE_CODEX_BIN = dies;
      t0 = Date.now();
      await assert.rejects(turnOf("t", "c", { timeoutMs: 2000 }), /exited/);
      assert.ok(Date.now() - t0 < 1500, "a server that dies mid-read fails the read at once");
    } finally {
      delete process.env.PEER_BRIDGE_CODEX_BIN;
      process.env.PEER_BRIDGE_FAKE_CODEX = "1";
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
  { env: { ...process.env, PEER_BRIDGE_TEST_PROTOCOL: "13" } },
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
  assert.match(inlineText(n), /^PEER-BRIDGE: No answer is coming to m\d+/);
  assert.match(inlineText(n), /Tell the user, and don't wait for that answer/);
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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-failure-work-"));
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

fs.rmSync(dir, { recursive: true, force: true });
console.log("\nfailure tests passed");
process.exit(0);
