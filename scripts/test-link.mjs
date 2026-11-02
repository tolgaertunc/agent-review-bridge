// End-to-end test of links and hooks against a throwaway data dir: the broker
// runs in this process, src/hook.mjs runs as a real subprocess with hook JSON
// on stdin, Codex delivery is faked (PEER_BRIDGE_FAKE_CODEX).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-link-"));
Object.assign(process.env, { PEER_BRIDGE_DIR: dir, PEER_BRIDGE_PORT: "7498", PEER_BRIDGE_FAKE_CODEX: "1", PEER_BRIDGE_CONFIG_DIR: path.join(dir, "config") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameTo = (a, b) => !!a && a.app === b.app && a.id === b.id;

// 0. a stale owner (older protocol, e.g. a helper left over from before an
// update) steps down when a newer client calls, and the client takes over
const brokerUrl = new URL("../src/broker.mjs", import.meta.url).href;
const stale = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");console.log("owner");setInterval(()=>{},1000);`], {
  env: { ...process.env, PEER_BRIDGE_TEST_PROTOCOL: "1" },
});
await new Promise((r) => stale.stdout.once("data", r));
const { call, inlineText, nextStep } = await import("../src/broker.mjs");
await call("link_create", { primary: { app: "claude", id: "probe" } }); // op the stale owner wouldn't run new code for
await call("link_close", { endpoint: { app: "claude", id: "probe" } });
stale.kill();
assert.ok(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes('"op":"broker-step-down"'));
console.log("0 stale broker owner stepped down, newer client took over");

const hook = path.resolve(import.meta.dirname, "../src/hook.mjs");
const events = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(50);
  }
}

function runHook(app, event, input, { killAfter } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [hook, "--app", app, "--event", event], { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (killAfter) setTimeout(() => p.kill(), killAfter);
    p.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify({ hook_event_name: event, cwd: ".", ...input }));
  });
}

const CLAUDE = { app: "claude", id: "claude-session-1" };
const GPT = { app: "openai", id: "gpt-thread-1" };
const CLAUDE2 = { app: "claude", id: "claude-session-2" };

// 1. unlinked chats: hooks exit at once, nothing queued
let r = await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "hi" });
assert.equal(r.code, 0);
assert.equal(r.out, "");
r = await runHook("claude", "listen", { session_id: CLAUDE.id });
assert.equal(r.code, 0);
assert.equal(fs.readdirSync(path.join(dir, "outbox")).length, 0);
console.log(`1 unlinked: stop/listen exit 0 at once (${r.ms} ms)`);

// 2. Claude primary, GPT advisor: Stop queues a review, GPT gets it via the thread queue
const link = await call("link_create", { primary: CLAUDE, advisor: GPT });
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "Please refactor the parser." });
assert.equal(r.out, "", "no notes yet, so no context output");
r = await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Refactored the parser." });
assert.equal(r.code, 0);
assert.equal(r.out, "", "Stop must not block or print");
assert.ok(r.ms < 1500, `stop hook took ${r.ms} ms`);
const req = await until(() => state().messages.find((m) => m.kind === "review-request"));
assert.deepEqual(req.toEndpoint, GPT);
assert.match(req.text, /Refactored the parser/);
assert.match(req.text, /User's message:\nPlease refactor the parser\./, "review request must carry the user's question");
await until(() => events().find((e) => e.op === "fake-codex-deliver" && e.threadId === GPT.id));
console.log(`2 Claude→GPT review request ${req.id} (question + answer) queued by Stop (${r.ms} ms), delivered to the GPT thread`);

// 3. GPT receives and advises a concern → Claude's listener wakes it (exit 2)
// the thread got the whole request, so there is nothing left to receive
await until(() => state().messages.find((m) => m.id === req.id)?.readAt);
assert.equal((await call("receive", { side: "openai", endpoint: GPT })).messages.length, 0);
const listener = runHook("claude", "listen", { session_id: CLAUDE.id });
await sleep(1500);
const adv = await call("advise", { endpoint: GPT, requestId: req.id, decision: "changes_requested", blocking: [{ title: "Parser drops the last token." }] });
assert.equal(adv.delivered, "now");
r = await listener;
assert.equal(r.code, 2, "listener must exit 2 to wake Claude");
assert.match(r.err, /flagged your last turn[\s\S]*\[CHANGES REQUESTED\][\s\S]*Parser drops the last token\./, "the Claude session is woken with the advice in full");
await until(() => state().messages.find((m) => m.id === adv.id).readAt);
assert.match((await call("receive", { side: "claude", endpoint: CLAUDE, id: adv.id })).messages[0].text, /Parser drops the last token/, "readable again by id");
console.log(`3 concern → Claude listener exited 2 with the advice in full:${r.err.split("\n")[0].slice(0, 90)}…`);

// 4. the fix loop: the turn after an advisory is reviewed again
const before = state().messages.length;
await call("receive", { side: "claude", endpoint: CLAUDE });
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Fixed the last token." });
const again = await until(() => state().messages.length === before + 1 && state().messages.at(-1));
assert.equal(again.kind, "review-request");
assert.match(again.text, /Fixed the last token/);
console.log("4 the turn after an advisory is reviewed again (fix loop)");

// 5. approval with nits: they wait for the next prompt, once; the same nits
// again are dropped
await call("advise", { endpoint: GPT, requestId: again.id, decision: "approved", nits: [{ title: "Name the test after the bug." }] });
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Added tests." });
const third = await until(() => state().messages.length === before + 2 && state().messages.at(-1));
const dup = await call("advise", { endpoint: GPT, requestId: third.id, decision: "approved", nits: [{ title: "Name the test after the bug." }] });
assert.ok(dup.dup);
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "next" });
const ctx = JSON.parse(r.out).hookSpecificOutput;
assert.equal(ctx.hookEventName, "UserPromptSubmit");
assert.match(ctx.additionalContext, /Your advisor approved the fix: the earlier \[CHANGES REQUESTED\] is resolved\.[\s\S]*Name the test after the bug/, "it closed the loop from step 3");
await until(() => state().notes.every((n) => n.deliveredAt));
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "again" });
assert.equal(r.out, "");
console.log("5 nit delivered once with the next prompt, duplicate dropped");

// 6. reverse direction: GPT primary, Claude advisor via join code
await call("link_close", { endpoint: CLAUDE });
const l2 = await call("link_create", { primary: GPT });
assert.ok(l2.joinCode);
await call("link_join", { code: l2.joinCode, endpoint: CLAUDE2 });
const advisorListener = runHook("claude", "listen", { session_id: CLAUDE2.id });
await sleep(1200);
await runHook("openai", "prompt", { session_id: GPT.id, turn_id: "t9", prompt: "Write a reversible migration." });
r = await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t9", last_assistant_message: "Wrote the migration." });
assert.equal(r.out, "");
r = await advisorListener;
assert.equal(r.code, 2);
assert.match(r.err, /Review request[\s\S]*User's message:\nWrite a reversible migration\./, "the Claude advisor is woken with the request in full");
const gptReq = await until(() => state().messages.find((m) => m.kind === "review-request" && m.linkId === l2.id));
assert.match(gptReq.text, /User's message:\nWrite a reversible migration\./);
await call("advise", { endpoint: CLAUDE2, requestId: gptReq.id, decision: "changes_requested", blocking: [{ title: "Migration is not reversible." }] });
await until(() => events().some((e) => e.op === "fake-codex-deliver" && /flagged your last turn/.test(e.text)));
console.log("6 GPT primary → Claude advisor (join code): listener woke Claude (question + answer), changes requested queued back to the GPT thread");

// 6b. a question is only attached to its own turn: other turn id → not
// captured, and it is not reused for the turn after
await call("receive", { side: "claude", endpoint: CLAUDE2 });
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t10", last_assistant_message: "Applied the fix." }); // reviewed again (fix loop)
await runHook("openai", "prompt", { session_id: GPT.id, turn_id: "t11", prompt: "Old question." });
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t12", last_assistant_message: "Answer to t12." });
const t12 = await until(() => state().messages.find((m) => m.kind === "review-request" && /Primary's final message:\nAnswer to t12/.test(m.text)));
assert.match(t12.text, /User's message:\n\(not captured\)/);
const question = (m) => m.text.split("Primary's final message")[0]; // not the diff, which may quote this file
assert.doesNotMatch(question(t12), /Old question/);
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t13", last_assistant_message: "Answer to t13." });
const t13 = await until(() => state().messages.find((m) => m.kind === "review-request" && /Primary's final message:\nAnswer to t13/.test(m.text)));
assert.doesNotMatch(question(t13), /Old question/);
console.log("6b question attached only to its own turn, never reused");

// 7. one listener per session: a newer one supersedes the older
await call("receive", { side: "claude", endpoint: CLAUDE2 });
const older = runHook("claude", "listen", { session_id: CLAUDE2.id });
await sleep(800);
const newer = runHook("claude", "listen", { session_id: CLAUDE2.id }, { killAfter: 3000 });
r = await older;
assert.equal(r.code, 0, "older listener must step aside quietly");
await newer;
console.log("7 newer listener superseded the older one (exit 0, no wake)");

// 8. unlink: listener and hooks go quiet
await call("link_close", { endpoint: GPT });
r = await runHook("claude", "listen", { session_id: CLAUDE2.id });
assert.equal(r.code, 0);
console.log(`8 after unlink the listener exits at once (${r.ms} ms)`);

// 10. a one-off review answer still wakes the requester, although its link
// closes as the answer is posted
{
  const REQ = { app: "claude", id: "claude-requester" };
  const REV = { app: "claude", id: "claude-reviewer" };
  const rl = await call("link_create", { primary: REQ, mode: "review", advisor: REV, request: "Check the parser." });
  const requester = runHook("claude", "listen", { session_id: REQ.id });
  await sleep(1200);
  const got = await call("receive", { side: "claude", endpoint: REV });
  assert.match(got.messages[0].text, /Check the parser/);
  await call("advise", { endpoint: REV, requestId: got.messages[0].id, decision: "approved" });
  r = await requester;
  assert.equal(r.code, 2);
  assert.match(r.err, /The review you asked for/);
  assert.equal(state().links[rl.id].active, false);
  console.log("10 one-off review: answer woke the requester, link closed (also when simply approved)");
}

// 11. Claude advisor not listening → the primary is told with its next prompt
{
  const P = { app: "openai", id: "gpt-primary-offline" };
  const A = { app: "claude", id: "claude-advisor-offline" };
  const l = await call("link_create", { primary: P });
  await call("link_join", { code: l.joinCode, endpoint: A });
  await runHook("openai", "stop", { session_id: P.id, turn_id: "x1", last_assistant_message: "done" });
  await until(() => state().notes.some((n) => n.kind === "bridge" && sameTo(n.to, P)));
  r = await runHook("openai", "prompt", { session_id: P.id, turn_id: "x2", prompt: "next" });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /isn't listening/);
  await call("link_close", { linkId: l.id });
  console.log("11 offline Claude advisor reported to the primary with its next prompt");
}

// 12. no message cap; old state is pruned
{
  const P = { app: "claude", id: "claude-bulk" };
  const A = { app: "claude", id: "claude-bulk-advisor" };
  await call("link_create", { primary: P, advisor: A });
  for (let i = 0; i < 250; i++) await call("turn_end", { endpoint: P, turnId: `b${i}`, lastMessage: `turn ${i}` });
  assert.ok(state().messages.filter((m) => sameTo(m.toEndpoint, A)).length >= 250, "250 review requests, no cap");
  // age everything: read a day+ ago, or older than a week
  const s = state();
  for (const m of s.messages) m.ts = Date.now() - 8 * 24 * 3600_000;
  fs.writeFileSync(path.join(dir, "state.json.aged"), JSON.stringify(s));
  console.log(`12 250 review requests accepted (no cap); pruning checked below`);
}

// 16. one chat reviewing for two links at once: the answer goes to the
// request it names, and without a name it's refused instead of guessed
{
  const RV = { app: "claude", id: "claude-busy-reviewer" };
  const A = { app: "claude", id: "claude-requester-a" };
  const B = { app: "claude", id: "claude-requester-b" };
  const la = await call("link_create", { primary: A, mode: "review", advisor: RV, request: "Review A." });
  const lb = await call("link_create", { primary: B, mode: "review", advisor: RV, request: "Review B." });
  const msgs = (await call("receive", { side: "claude", endpoint: RV })).messages;
  const reqA = msgs.find((m) => /Review A/.test(m.text)).id;
  const reqB = msgs.find((m) => /Review B/.test(m.text)).id;
  await assert.rejects(call("advise", { endpoint: RV, decision: "approved" }), /request_id is required/);
  await call("advise", { endpoint: RV, requestId: reqA, decision: "approved", nits: [{ title: "A is fine." }] });
  const st = state();
  assert.equal(st.links[la.id].active, false, "A's review closed");
  assert.equal(st.links[lb.id].active, true, "B's review still open");
  assert.ok(st.messages.some((m) => m.kind === "review-result" && sameTo(m.toEndpoint, A) && /A is fine/.test(m.text)));
  assert.ok(!st.messages.some((m) => m.kind === "review-result" && sameTo(m.toEndpoint, B)));
  await call("advise", { endpoint: RV, requestId: reqB, decision: "approved" });
  assert.equal(state().links[lb.id].active, false);
  console.log("16 concurrent reviews: answer routed by request id, which is required");
}

// 17. pruning never drops unread messages by count
{
  const P = { app: "claude", id: "claude-flood" };
  const A = { app: "claude", id: "claude-flood-advisor" };
  await call("link_create", { primary: P, advisor: A });
  for (let i = 0; i < 600; i++) await call("turn_end", { endpoint: P, turnId: `f${i}`, lastMessage: `turn ${i}` });
  const unread = state().messages.filter((m) => sameTo(m.toEndpoint, A) && !m.readAt).length;
  assert.equal(unread, 600, `all 600 unread review requests kept (got ${unread})`);
  console.log("17 600 unread messages kept; only read ones are capped");
}

// 14. owner dies while idle: a surviving server's keepOwner ping takes over and
// ingests the hook's request (this process stops owning by exiting the child
// test below, so run it on a fresh port + dir)
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-owner-"));
  const env2 = { ...process.env, PEER_BRIDGE_DIR: dir2, PEER_BRIDGE_PORT: "7497" };
  const proc = (code) => spawn(process.execPath, ["--input-type=module", "-e", code], { env: env2 });
  const ownerA = proc(`const b=await import(${JSON.stringify(brokerUrl)});await b.call("link_create",{primary:{app:"claude",id:"S9"},advisor:{app:"claude",id:"A9"}});console.log("ready");setInterval(()=>{},1000);`);
  await new Promise((r) => ownerA.stdout.once("data", r));
  const serverB = proc(`const b=await import(${JSON.stringify(brokerUrl)});await b.call("ping");b.keepOwner(500);console.log("ready");setInterval(()=>{},1000);`);
  await new Promise((r) => serverB.stdout.once("data", r));
  ownerA.kill();
  await sleep(300);
  const t0 = Date.now();
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [hook, "--app", "claude", "--event", "stop"], { env: env2 });
    p.on("close", resolve);
    p.stdin.end(JSON.stringify({ session_id: "S9", last_assistant_message: "x" }));
  });
  const ev = () => fs.readFileSync(path.join(dir2, "events.jsonl"), "utf8");
  const end = Date.now() + 4000;
  while (!ev().includes('"kind":"review-request"') && Date.now() < end) await sleep(50);
  serverB.kill();
  assert.ok(ev().includes('"kind":"review-request"'), "surviving server must take over and ingest");
  console.log(`14 owner died while idle: surviving server took over, request ingested in ${Date.now() - t0} ms`);
}

// 15. a failed ChatGPT delivery reaches the waiting primary, and an owner
// loading week-old state prunes it (fresh broker so the failing fake applies)
{
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-fail-"));
  fs.copyFileSync(path.join(dir, "state.json.aged"), path.join(dir3, "state.json"));
  const env3 = { ...process.env, PEER_BRIDGE_DIR: dir3, PEER_BRIDGE_PORT: "7495", PEER_BRIDGE_FAKE_CODEX: "fail" };
  const P = { app: "claude", id: "claude-fail" };
  const owner = spawn(process.execPath, ["--input-type=module", "-e",
    `const b=await import(${JSON.stringify(brokerUrl)});await b.call("link_create",{primary:${JSON.stringify(P)},advisor:{app:"openai",id:"gpt-gone"}});console.log("ready");setInterval(()=>{},1000);`], { env: env3 });
  await new Promise((r) => owner.stdout.once("data", r));
  const st3 = () => JSON.parse(fs.readFileSync(path.join(dir3, "state.json"), "utf8"));
  assert.ok(st3().messages.length < 10, `week-old messages pruned (left ${st3().messages.length})`);
  const run3 = (event, input) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [hook, "--app", "claude", "--event", event], { env: env3 });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => resolve(out));
      p.stdin.end(JSON.stringify({ session_id: P.id, cwd: ".", ...input }));
    });
  await run3("stop", { last_assistant_message: "x" });
  const end = Date.now() + 4000;
  while (!st3().notes.some((n) => n.kind === "bridge" && sameTo(n.to, P)) && Date.now() < end) await sleep(50);
  const out = await run3("prompt", { prompt: "next" });
  owner.kill();
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Couldn't hand review-request .* ChatGPT Desktop not reachable/);
  console.log("15 failed delivery shown to the primary with its next prompt; week-old state pruned on load");
}

// 18. a review request handed to a ChatGPT thread counts as read, but stays
// answerable until answered: not pruned after a day, nor by the read cap
{
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-open-"));
  const P = { app: "claude", id: "claude-slow" };
  const G = { app: "openai", id: "gpt-slow" };
  const old = Date.now() - 2 * 24 * 3600_000;
  const msg = (id, extra) => ({ id, from: "claude", to: "openai", toEndpoint: G, linkId: "L1", text: "x", ts: Date.now(), readAt: Date.now(), dispatch: { state: "sent", at: Date.now() }, ...extra });
  const seeded = {
    seq: 700, linkSeq: 1, notes: [],
    links: { L1: { id: "L1", mode: "advisor", active: true, createdAt: old, primary: P, advisor: G, reviews: 1, advisories: [] } },
    messages: [msg("m1", { kind: "review-request", ts: old, readAt: old }), ...Array.from({ length: 600 }, (_, i) => msg(`m${i + 2}`, { kind: "message" }))],
  };
  try {
    fs.writeFileSync(path.join(dir4, "state.json"), JSON.stringify(seeded));
    const env4 = { ...process.env, PEER_BRIDGE_DIR: dir4, PEER_BRIDGE_PORT: "7494" };
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e",
        `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");` +
        `try{console.log(JSON.stringify(await b.call("advise",{endpoint:${JSON.stringify(G)},requestId:"m1",decision:"changes_requested",blocking:[{title:"still answerable"}]})))}catch(e){console.log(JSON.stringify({error:e.message}))}process.exit(0);`], { env: env4 });
      let o = "";
      p.stdout.on("data", (d) => (o += d));
      p.on("close", () => resolve(o));
    });
    const res = JSON.parse(out);
    assert.equal(res.error, undefined, res.error);
    assert.equal(res.delivered, "now");
    const kept = JSON.parse(fs.readFileSync(path.join(dir4, "state.json"), "utf8")).messages.filter((m) => m.kind === "message").length;
    assert.ok(kept <= 500, `read messages still capped (kept ${kept})`);
    console.log("18 a day-old review request already handed to ChatGPT is still answerable; read messages still capped");
  } finally {
    fs.rmSync(dir4, { recursive: true, force: true });
  }
}

// 19. answers: one format, contradictions refused
{
  const RQ = { app: "claude", id: "claude-format" };
  const RV = { app: "claude", id: "claude-format-reviewer" };
  const l = await call("link_create", { primary: RQ, mode: "review", advisor: RV, request: "Check." });
  const id = state().messages.find((m) => m.linkId === l.id).id;
  await assert.rejects(call("advise", { endpoint: RV, requestId: id, decision: "approved", blocking: [{ title: "x" }] }), /an approval can't have must-fix items/);
  await assert.rejects(call("advise", { endpoint: RV, requestId: id, decision: "changes_requested", nits: [{ title: "x" }] }), /needs at least one must-fix item/);
  const a = await call("advise", { endpoint: RV, requestId: id, decision: "changes_requested", note: "Close.", blocking: [{ title: "Off by one", file: "a.js", line: 3, detail: "loop ends early" }], nits: [{ title: "Rename i" }] });
  assert.equal(a.text, "[CHANGES REQUESTED]\n\nClose.\n\nMust fix:\n- Off by one (a.js:3): loop ends early\n\nNits (optional, don't block approval):\n- Rename i");
  console.log("19 answers start with [APPROVED]/[CHANGES REQUESTED], nits apart; contradictions refused");
}

// 20. review rounds: the next round goes to the same reviewer with the same
// kind; one continuation per round; none after approval, for someone else's
// review, or past the cap
{
  process.env.PEER_BRIDGE_MAX_ROUNDS = "3";
  const RQ = { app: "claude", id: "claude-rounds" };
  const RV = { app: "openai", id: "gpt-rounds" };
  const answer = async (linkId, decision) => {
    const id = state().messages.find((m) => m.kind === "review-request" && m.linkId === linkId).id;
    return call("advise", { endpoint: RV, requestId: id, decision, ...(decision === "changes_requested" && { blocking: [{ title: "fix it" }] }) });
  };
  const l1 = await call("link_create", { primary: RQ, mode: "review", advisor: RV, request: "Plan: do it", plan: true });
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "early" }), /still waiting for its answer/);
  await answer(l1.id, "changes_requested");
  const res1 = state().messages.find((m) => m.kind === "review-result" && m.linkId === l1.id);
  assert.match(inlineText(res1), new RegExp(`bridge_review\\(round_of="${l1.id}"\\)`));
  await assert.rejects(call("link_continue", { primary: { app: "claude", id: "someone-else" }, roundOf: l1.id, request: "x" }), /not a review this chat asked for/);
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "x", plan: false }), /was a plan review/);
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "x", threadId: "gpt-other" }), /reviewed in another chat/);
  const l2 = await call("link_continue", { primary: RQ, roundOf: l1.id, request: "Changed X; I disagree on Y because Z." });
  assert.equal(l2.round, 2);
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "again" }), /already continued by/);
  const req2 = state().messages.find((m) => m.kind === "review-request" && m.linkId === l2.id);
  assert.deepEqual(req2.toEndpoint, RV);
  assert.ok(req2.plan, "a plan review stays a plan review");
  assert.match(req2.text, new RegExp(`^Round 2 of review ${l1.id}`));
  await answer(l2.id, "changes_requested");
  const l3 = await call("link_continue", { primary: RQ, roundOf: l2.id, request: "Round 3." });
  await answer(l3.id, "changes_requested");
  const res3 = state().messages.find((m) => m.kind === "review-result" && m.linkId === l3.id);
  assert.match(nextStep(res3), /last round allowed: stop and ask the user/);
  assert.match(nextStep(res3), /wait for the user's explicit approval/, "the plan gate stays");
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l3.id, request: "Round 4." }), /3 rounds without approval: stop and ask the user/);
  const k1 = await call("link_create", { primary: RQ, mode: "review", advisor: RV, request: "Code." });
  await answer(k1.id, "approved");
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: k1.id, request: "more" }), /was approved; there is nothing to re-review/);
  delete process.env.PEER_BRIDGE_MAX_ROUNDS;
  console.log("20 review rounds: same reviewer and kind, round header, one continuation per round, refused after approval, for others, past the cap");
}

// 21. advisor fix loop: a prompt the bridge delivered doesn't reset the count,
// a real user prompt does; at the cap the primary is told once to stop and
// ask the user, and isn't reviewed until the user writes; answers to requests
// from before the user's latest prompt don't steer
{
  process.env.PEER_BRIDGE_MAX_ROUNDS = "2";
  const P = { app: "openai", id: "gpt-loop" };
  const A = { app: "claude", id: "claude-loop-advisor" };
  const l = await call("link_create", { primary: P, advisor: A });
  const openReq = () => until(() => state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id && !m.answeredAt));
  const reject = async () => call("advise", { endpoint: A, requestId: (await openReq()).id, decision: "changes_requested", blocking: [{ title: "still wrong" }] });
  const stopTurn = (t) => runHook("openai", "stop", { session_id: P.id, turn_id: t, last_assistant_message: `turn ${t}` });
  const prompt = (t, text) => runHook("openai", "prompt", { session_id: P.id, turn_id: t, prompt: text });
  await prompt("u1", "Build it.");
  await stopTurn("u1");
  const adv1 = await reject();
  assert.equal(adv1.delivered, "now");
  // the advisory comes back as a queued prompt: the bridge's, not the user's
  const advisory = state().messages.find((m) => m.id === adv1.id);
  await prompt("b1", inlineText(advisory));
  await stopTurn("b1");
  const adv2 = await reject();
  assert.ok(adv2.stopped, "second rejection in a row hits the cap of 2");
  const stopMsg = state().messages.find((m) => m.id === adv2.id);
  assert.equal(stopMsg.kind, "stop");
  assert.match(inlineText(stopMsg), /Stop the fix loop now: tell the user where it stands and ask how to proceed/);
  assert.ok(state().links[l.id].stopped, "kept in state.json, so a broker restart keeps it");
  await prompt("b2", inlineText(stopMsg));
  await stopTurn("b2");
  await until(() => events().some((e) => e.op === "turn_end" && e.link === l.id && e.skipped === "stopped"));
  // a user typing a look-alike header is still the user
  await prompt("u2", "CODEX: Message m99999 (link L99999) please go on");
  await until(() => !state().links[l.id].stopped && state().links[l.id].rounds === 0); // a real user prompt lifts the stop
  await stopTurn("u2");
  const pending = await openReq();
  await prompt("u3", "Actually, do something else.");
  await until(() => state().links[l.id].generation > pending.generation);
  const late = await call("advise", { endpoint: A, requestId: pending.id, decision: "changes_requested", blocking: [{ title: "old" }] });
  assert.ok(late.stale && late.delivered === "next prompt", "an answer from before the user's latest prompt doesn't steer, but isn't lost");
  assert.equal(state().links[l.id].rounds, 0, "nor does it count as a round");
  // it comes once, with the next prompt, marked as about an older turn
  r = await prompt("u4", "Next.");
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /On an earlier turn, before your latest prompt\. For information[^\n]*\n\n\[CHANGES REQUESTED\][\s\S]*- old/);
  await until(() => state().notes.filter((n) => n.linkId === l.id).every((n) => n.deliveredAt));
  r = await prompt("u5", "Again.");
  assert.doesNotMatch(r.out, /On an earlier turn/, "delivered once");
  // the same late answer again isn't noted twice; a late plain approval stays
  // silent unless it closes a fix loop (the user wrote while the fix was
  // being reviewed); one with nits is noted
  const lateAnswer = async (turn, answer) => {
    await stopTurn(turn);
    const req = await openReq();
    await prompt(`${turn}-next`, "Moving on.");
    await until(() => state().links[l.id].generation > req.generation);
    return call("advise", { endpoint: A, requestId: req.id, ...answer });
  };
  const again = await lateAnswer("u6", { decision: "changes_requested", blocking: [{ title: "old" }] });
  assert.ok(again.dup && again.delivered === "none");
  assert.equal((await lateAnswer("u7", { decision: "approved", note: "Fix confirmed." })).delivered, "next prompt", "a late approval of the fix still closes the loop");
  await until(() => state().notes.some((n) => n.linkId === l.id && /Fix confirmed/.test(n.text)));
  r = await prompt("u7-see", "And now?");
  assert.match(
    JSON.parse(r.out).hookSpecificOutput.additionalContext,
    /On an earlier turn, before your latest prompt\.[^\n]*\n\nYour advisor approved the fix: the earlier \[CHANGES REQUESTED\] is resolved\.\n\n\[APPROVED\]\n\nFix confirmed\./,
  );
  assert.equal((await lateAnswer("u7b", { decision: "approved" })).delivered, "none", "a routine late approval stays silent");
  assert.equal((await lateAnswer("u8", { decision: "approved", nits: [{ title: "rename" }] })).delivered, "next prompt");
  delete process.env.PEER_BRIDGE_MAX_ROUNDS;
  console.log("21 advisor loop: bridge prompts don't reset, user prompts do; stop at the cap, no reviews until the user writes; late answers come once as a note");
}

// 22. telling the bridge's prompts from the user's: exact text, once per
// delivery, so the same text again is the user's; a delivery still being sent
// already counts, and "sending" is on disk before the thread can run it. Hook
// events are applied once, even when an owner that died before removing one
// leaves it for the next owner.
{
  const P = { app: "openai", id: "gpt-detect" };
  const A = { app: "claude", id: "claude-detect-advisor" };
  const l = await call("link_create", { primary: P, advisor: A });
  const gen = () => state().links[l.id].generation;
  // a prompt and a Stop without turn ids (as Claude's are), each left in the
  // outbox twice under the same name: applied once
  const replay = async (name, op, args) => {
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(path.join(dir, "outbox", name), JSON.stringify({ op, args }));
      await until(() => !fs.existsSync(path.join(dir, "outbox", name)));
    }
  };
  await replay("0000000000001-1-aaaaaa.json", "turn_start", { endpoint: P, prompt: "Start." });
  assert.equal(gen(), 1, "a user prompt's event applied twice counts once");
  await replay("0000000000002-1-bbbbbb.json", "turn_end", { endpoint: P, lastMessage: "done" });
  assert.equal(state().messages.filter((m) => m.kind === "review-request" && m.linkId === l.id).length, 1, "a replayed Stop is one review, not two rounds");
  assert.ok(events().some((e) => e.op === "outbox-replay-skipped" && e.file === "0000000000002-1-bbbbbb.json"));
  const req = state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id);
  process.env.PEER_BRIDGE_FAKE_CODEX = "slow";
  const adv = await call("advise", { endpoint: A, requestId: req.id, decision: "changes_requested", blocking: [{ title: "no" }] });
  const msg = () => state().messages.find((m) => m.id === adv.id);
  assert.equal(msg().dispatch.state, "sending", "sending is saved before the delivery is handed over");
  const delivered = inlineText(msg());
  assert.ok((await call("turn_start", { endpoint: P, turnId: "b1", prompt: delivered })).fromBridge, "a delivery still being sent already counts as the bridge's");
  assert.equal(gen(), 1);
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u2", prompt: delivered })).fromBridge, "the same text in a later turn is the user's");
  assert.equal(gen(), 2);
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u3", prompt: delivered.split("\n")[0] })).fromBridge, "a header alone is the user's");
  await until(() => msg().dispatch.state === "sent");
  process.env.PEER_BRIDGE_FAKE_CODEX = "1";
  for (const bad of ["oops", "Infinity", "0", "-3", "2.5"]) {
    process.env.PEER_BRIDGE_MAX_ROUNDS = bad;
    const RQ = { app: "claude", id: `claude-cap-${bad}` };
    const prev = await call("link_create", { primary: RQ, mode: "review", advisor: A, request: "x" });
    const id = state().messages.find((m) => m.linkId === prev.id).id;
    await call("advise", { endpoint: A, requestId: id, decision: "changes_requested", blocking: [{ title: "x" }] });
    assert.equal((await call("link_continue", { primary: RQ, roundOf: prev.id, request: "y" })).round, 2, `cap "${bad}" falls back to 20`);
  }
  delete process.env.PEER_BRIDGE_MAX_ROUNDS;
  console.log("22 bridge prompts: exact text, once per delivery, counted while still sending; hook events applied once; a bad cap falls back to 20");
}

// 23. an owner that takes over doesn't resend a delivery whose turn already
// ran: it was stuck in "sending", but its prompt was matched
{
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-resend-"));
  try {
    const P = { app: "openai", id: "gpt-resend" };
    const old = Date.now() - 5 * 60_000;
    const m = (id, extra) => ({ id, from: "claude", to: "openai", toEndpoint: P, kind: "advisory", linkId: "L1", text: "x", ts: old, readAt: null, ...extra });
    fs.writeFileSync(
      path.join(dir5, "state.json"),
      JSON.stringify({
        seq: 3, linkSeq: 1, notes: [],
        links: { L1: { id: "L1", mode: "advisor", active: true, createdAt: old, primary: P, advisor: { app: "claude", id: "c" }, reviews: 1, advisories: [] } },
        messages: [m("m1", { dispatch: { state: "sending", at: old }, promptMatched: old }), m("m2", { dispatch: { state: "sending", at: old } })],
      }),
    );
    const env5 = { ...process.env, PEER_BRIDGE_DIR: dir5, PEER_BRIDGE_PORT: "7493", PEER_BRIDGE_FAKE_CODEX: "1" };
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");setTimeout(()=>process.exit(0),300);`], { env: env5 });
      p.on("close", resolve);
    });
    const st5 = JSON.parse(fs.readFileSync(path.join(dir5, "state.json"), "utf8"));
    const ev5 = fs.readFileSync(path.join(dir5, "events.jsonl"), "utf8");
    assert.equal(st5.messages.find((x) => x.id === "m1").dispatch.state, "sent");
    assert.ok(!/"op":"fake-codex-deliver"[^\n]*"text":"CLAUDE: Your advisor flagged your last turn: m1 /.test(ev5), "a matched delivery isn't sent again");
    assert.match(ev5, /"op":"fake-codex-deliver"[^\n]*m2 \(link L1\)/, "an unmatched stuck one is retried");
    console.log("23 a stuck delivery whose turn already ran isn't resent; an unmatched one is retried");
  } finally {
    fs.rmSync(dir5, { recursive: true, force: true });
  }
}

// 24. the user's rules file reaches every chat working through the bridge
// (linked, or answered after its review link closed) through the prompt hook,
// never inside a peer message, and nothing reaches an unrelated chat
{
  const rules = path.join(process.env.PEER_BRIDGE_CONFIG_DIR, "rules.md");
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, "Always answer in Turkish.\n");
  const ctx = async (endpoint) => {
    const o = (await runHook(endpoint.app, "prompt", { session_id: endpoint.id, prompt: "hello" })).out;
    return o ? JSON.parse(o).hookSpecificOutput.additionalContext : "";
  };
  assert.equal(await ctx({ app: "openai", id: "gpt-unrelated" }), "", "an unrelated chat gets nothing");
  const P = { app: "openai", id: "gpt-rules" };
  await call("link_create", { primary: P, advisor: { app: "claude", id: "claude-rules" } });
  assert.match(await ctx(P), /Your user's own standing rules for work through peer-bridge \(from .*rules\.md\)[\s\S]*Always answer in Turkish\./);
  const RQ = { app: "openai", id: "gpt-rules-requester" };
  const RV = { app: "claude", id: "claude-rules-reviewer" };
  const rl = await call("link_create", { primary: RQ, mode: "review", advisor: RV, request: "Check." });
  await call("advise", { endpoint: RV, requestId: state().messages.find((m) => m.linkId === rl.id).id, decision: "approved" });
  assert.equal(state().links[rl.id].active, false);
  assert.match(await ctx(RQ), /Always answer in Turkish/, "the answer to a closed review still comes with the rules");
  const delivered = await until(() => events().find((e) => e.op === "fake-codex-deliver" && e.threadId === RQ.id));
  assert.doesNotMatch(delivered.text, /Always answer in Turkish/, "rules never travel inside a peer message");
  // an answer written two days ago but handed over just now still counts
  {
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-late-"));
    try {
      const old = Date.now() - 2 * 24 * 3600_000;
      const late = { id: "m1", from: "claude", to: "openai", toEndpoint: RQ, kind: "review-result", linkId: "L1", text: "x", ts: old, readAt: Date.now(), dispatch: { state: "sent", at: Date.now() } };
      fs.writeFileSync(path.join(dir6, "state.json"), JSON.stringify({ seq: 1, linkSeq: 1, notes: [], links: { L1: { id: "L1", mode: "review", active: false, primary: RQ, advisor: RV, createdAt: old, closedAt: old } }, messages: [late] }));
      const out = await new Promise((resolve) => {
        const p = spawn(process.execPath, [hook, "--app", "openai", "--event", "prompt"], { env: { ...process.env, PEER_BRIDGE_DIR: dir6 } });
        let o = "";
        p.stdout.on("data", (d) => (o += d));
        p.on("close", () => resolve(o));
        p.stdin.end(JSON.stringify({ session_id: RQ.id, prompt: "x", cwd: "." }));
      });
      assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Always answer in Turkish/, "counted from when it was handed over, not written");
    } finally {
      fs.rmSync(dir6, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(rules, "x".repeat(9000));
  assert.match(await ctx(P), /\(Cut at 8000 characters; the file is longer\.\)/);
  fs.writeFileSync(rules, "  \n");
  assert.doesNotMatch(await ctx(P), /standing rules/, "an empty file adds nothing");
  fs.rmSync(rules);
  console.log("24 rules file: to linked chats and to answered closed reviews, never in peer messages, capped; unrelated chats get nothing");
}

// 25. only a Claude Desktop session id is kept for opening a session
await assert.rejects(call("host", { endpoint: { app: "claude", id: "c" }, hostId: "last" }), /not a Claude Desktop session id/);
await assert.rejects(call("host", { endpoint: { app: "openai", id: "g" }, hostId: "local_x" }), /not a Claude Desktop session id/);
await call("host", { endpoint: { app: "claude", id: "c" }, hostId: "local_c-1" });
assert.equal((await call("reach", { endpoint: { app: "claude", id: "c" } })).hostId, "local_c-1");
console.log("25 host ids: only Claude Desktop's local_… ids, only for Claude chats");

// 26. bridge_send goes to the link that was checked before sending, even if a
// newer link appears in between; a link closed meanwhile is refused
{
  const S = { app: "claude", id: "claude-sender" };
  const a = await call("link_create", { primary: S, advisor: { app: "openai", id: "gpt-checked" } });
  const checked = await call("send_target", { endpoint: S });
  await call("link_create", { primary: S, mode: "review", advisor: { app: "openai", id: "gpt-newer" }, request: "x" });
  const sent = await call("send", { endpoint: S, text: "hi", linkId: checked.linkId });
  assert.deepEqual(sent.to, { app: "openai", id: "gpt-checked" });
  await call("link_close", { linkId: a.id });
  await assert.rejects(call("send", { endpoint: S, text: "hi", linkId: a.id }), /no longer open for this chat; try again/);
  console.log("26 bridge_send: to the checked link, not a newer one; refused if it closed meanwhile");
}

// 27. a bridge prompt that comes back slightly changed (CRLF line ends, a
// trailing newline) still counts as the bridge's, so the round cap holds; a
// header alone is still the user's
{
  const P = { app: "openai", id: "gpt-crlf" };
  const A = { app: "claude", id: "claude-crlf-advisor" };
  const l = await call("link_create", { primary: P, advisor: A });
  await call("turn_start", { endpoint: P, turnId: "u1", prompt: "Go." });
  await call("turn_end", { endpoint: P, turnId: "u1", lastMessage: "done" });
  const req = state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id);
  const adv = await call("advise", { endpoint: A, requestId: req.id, decision: "changes_requested", blocking: [{ title: "no" }] });
  const delivered = inlineText(state().messages.find((m) => m.id === adv.id));
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u2", prompt: delivered.split("\n")[0] })).fromBridge, "a header alone is the user's");
  assert.ok((await call("turn_start", { endpoint: P, turnId: "b1", prompt: delivered.replace(/\n/g, "\r\n") + "\r\n" })).fromBridge, "changed line ends: still the bridge's");
  await call("link_close", { linkId: l.id });
  console.log("27 a bridge prompt with changed line ends still counts as the bridge's; a header alone doesn't");
}

// 28. a long wake reaches the Claude session whole, down to its final
// instruction line, and only then counts as read
{
  const G = { app: "openai", id: "gpt-long" };
  const C = { app: "claude", id: "claude-long-advisor" };
  const l = await call("link_create", { primary: G, advisor: C });
  const listener = runHook("claude", "listen", { session_id: C.id });
  await sleep(1200);
  await call("turn_end", { endpoint: G, turnId: "big", lastMessage: "a".repeat(9_000), diff: `diff --git a/x b/x\n${"+line of the diff\n".repeat(1_100)}` });
  const req = state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id);
  r = await listener;
  assert.equal(r.code, 2);
  assert.ok(r.err.length > 25_000, `the whole wake arrived (${r.err.length} characters)`);
  assert.ok(r.err.trimEnd().endsWith(`answer once with bridge_advise (request_id ${req.id}).`), "down to its last line");
  await until(() => state().messages.find((m) => m.id === req.id).readAt);
  await call("link_close", { linkId: l.id });
  console.log(`28 a long wake (${r.err.length} characters) arrives whole, then counts as read`);
}

// 29. advisor mode: a plain approval that answers [CHANGES REQUESTED] comes
// with the next prompt (the fix loop is over), without waking anyone; a
// routine plain approval stays silent
{
  const P = { app: "claude", id: "claude-loop-done" };
  const A = { app: "openai", id: "gpt-loop-done" };
  const l = await call("link_create", { primary: P, advisor: A });
  const review = async (turn) => {
    await call("turn_end", { endpoint: P, turnId: turn, lastMessage: `Turn ${turn}.` });
    return state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id && m.text.includes(`Turn ${turn}.`)).id;
  };
  await call("advise", { endpoint: A, requestId: await review("t1"), decision: "changes_requested", blocking: [{ title: "Off by one" }] });
  const woke = state().messages.filter((m) => sameTo(m.toEndpoint, P)).length;
  const done = await call("advise", { endpoint: A, requestId: await review("t2"), decision: "approved", note: "Fixed." });
  assert.equal(done.delivered, "next prompt");
  assert.equal(state().messages.filter((m) => sameTo(m.toEndpoint, P)).length, woke, "nothing wakes the primary");
  r = await runHook("claude", "prompt", { session_id: P.id, prompt: "next" });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /Your advisor approved the fix: the earlier \[CHANGES REQUESTED\] is resolved\.\n\n\[APPROVED\]\n\nFixed\./);
  assert.equal((await call("advise", { endpoint: A, requestId: await review("t3"), decision: "approved" })).delivered, "none", "a routine approval stays silent");
  await call("link_close", { linkId: l.id });
  console.log("29 advisor: the approval that ends a fix loop comes with the next prompt; routine approvals stay silent");
}

// 30. one turn, many prompt hooks: Claude Code runs UserPromptSubmit with the
// running turn's prompt_id for a message typed mid-turn and for its own
// background-task notice (measured). They keep the turn's task and baseline
// and don't start a generation; the user's message is added to the task.
// Only equal, present ids count as one turn.
{
  const { turnFile } = await import("../src/broker.mjs");
  const P = { app: "claude", id: "claude-mid-turn" };
  const l = await call("link_create", { primary: P, advisor: { app: "openai", id: "gpt-mid-turn" } });
  const link = () => state().links[l.id];
  const prompt = async (prompt_id, text) => {
    const n = fs.readdirSync(path.join(dir, "outbox")).length;
    await runHook("claude", "prompt", { session_id: P.id, prompt: text, ...(prompt_id && { prompt_id }) });
    await until(() => fs.readdirSync(path.join(dir, "outbox")).length <= n); // processed
  };
  const base = () => JSON.parse(fs.readFileSync(turnFile(P), "utf8"));
  const review = async (prompt_id, answer) => {
    await runHook("claude", "stop", { session_id: P.id, last_assistant_message: answer, ...(prompt_id && { prompt_id }) });
    return (await until(() => state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id && m.text.includes(answer)))).text;
  };
  const notice = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";

  await prompt("t1", "Build the importer.");
  const g = link().generation;
  const b1 = base();
  assert.equal(b1.turnId, "t1");
  await prompt("t1", notice);
  await prompt("t1", "Be quick.");
  await prompt("t1", notice);
  assert.equal(link().generation, g, "mid-turn messages and notices start no generation");
  assert.deepEqual(base(), b1, "the turn's baseline is kept");
  let text = await review("t1", "Importer built.");
  assert.match(text, /User's message:\nBuild the importer\.\n\nAdded by the user while the turn was running:\nBe quick\.\n\nPrimary's final message/);
  assert.ok(!text.includes("task-notification"), "the app's notices aren't the user's");

  // a turn the app's notice starts (idle session) isn't the user's either
  await prompt("t2", notice);
  assert.equal(link().generation, g, "a notice starts no generation");
  text = await review("t2", "Noted the task.");
  assert.match(text, /User's message:\n\(None: the app started this turn/);

  // an interrupted turn (no Stop) followed by a new task: the new id gets a
  // new baseline and only its own message
  await prompt("t3", "Task A.");
  const b3 = base();
  await prompt("t4", "Task B.");
  assert.equal(base().turnId, "t4");
  assert.ok(base().at >= b3.at);
  assert.equal(link().generation, g + 2);
  text = await review("t4", "Did B.");
  assert.match(text, /User's message:\nTask B\.\n\nPrimary's final message/);

  // without ids every prompt is a new turn, as before
  await prompt(null, "First.");
  const b5 = base();
  await sleep(5);
  await prompt(null, "Second.");
  assert.notDeepEqual(base(), b5, "no id: new baseline");
  assert.equal(link().generation, g + 4);
  text = await review(null, "Did both.");
  assert.match(text, /User's message:\nSecond\.\n\nPrimary's final message/);
  await call("link_close", { linkId: l.id });
  console.log("30 mid-turn: messages typed during a turn join its task, notices are ignored, the baseline holds; new or missing ids start a turn");
}

// 31. auto mode in the broker and the hooks: approvals cover the request's
// content; plan approvals don't approve code; the end-of-turn check stops
// unreviewed changes once, not while a review waits; the reminder counts
// the user's turns only; an own-initiative plan doesn't wait for the user
{
  const { execFileSync } = await import("node:child_process");
  const { fingerprint } = await import("../src/git.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-auto-"));
  try {
    const g = (...a) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    fs.writeFileSync(path.join(work, "a.js"), "1\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const head = g("rev-parse", "HEAD").trim();
    const A = { app: "claude", id: "claude-auto-1" };
    const R = { app: "openai", id: "gpt-auto-1" };
    const fpNow = () => fingerprint(work).hash;
    await call("auto_set", { endpoint: A, on: true, paths: [{ path: work, fp: fpNow(), head }] });
    const stop = async (extra = {}) => {
      const r = await runHook("claude", "stop", { session_id: A.id, cwd: work, ...extra });
      return r.out ? JSON.parse(r.out) : null;
    };
    assert.equal(await stop(), null, "nothing changed: the turn ends");
    fs.writeFileSync(path.join(work, "a.js"), "2\n");
    const blocked = await stop();
    assert.equal(blocked.decision, "block");
    assert.match(blocked.reason, /hasn't approved the current changes in .*peer-bridge-auto-/);
    assert.equal(await stop({ stop_hook_active: true }), null, "stopping again over the same changes goes through");
    // a turn the bridge's own wake started (stop_hook_active set) is still checked
    fs.writeFileSync(path.join(work, "a.js"), "2b\n");
    assert.ok(await stop({ stop_hook_active: true }), "new changes stop a woken turn too");
    fs.writeFileSync(path.join(work, "a.js"), "2\n");
    await stop();
    // a review asked about this content: the check waits, then the approval covers it
    const fpAsked = fpNow();
    const l = await call("link_create", { primary: A, mode: "review", advisor: R, request: "check", reqPaths: [{ path: work, fp: fpAsked, head }] });
    assert.equal(await stop(), null, "a review is waiting: the turn may end");
    fs.writeFileSync(path.join(work, "a.js"), "3\n"); // changed while the review ran
    const reqId = state().messages.find((m) => m.linkId === l.id).id;
    await call("advise", { endpoint: R, requestId: reqId, decision: "approved" });
    assert.equal(state().auto[`claude:${A.id}`].paths[work].approved, fpAsked, "the approval covers what was asked about");
    assert.ok(await stop(), "content changed during the review stays unreviewed");
    fs.writeFileSync(path.join(work, "a.js"), "2\n");
    assert.equal(await stop(), null, "back to the approved content");
    // committing approved content isn't new work
    g("commit", "-qam", "two");
    assert.equal(await stop(), null, "a commit of the approved content keeps it approved");
    // a plan approval doesn't approve code
    fs.writeFileSync(path.join(work, "a.js"), "4\n");
    const pl = await call("link_create", { primary: A, mode: "review", advisor: R, request: "plan", plan: true, noGate: true, reqPaths: [{ path: work, fp: fpNow(), head }] });
    await call("advise", { endpoint: R, requestId: state().messages.find((m) => m.linkId === pl.id).id, decision: "approved" });
    assert.ok(await stop(), "a plan approval doesn't approve the code");
    const planResult = state().messages.find((m) => m.kind === "review-result" && m.linkId === pl.id);
    assert.match(nextStep(planResult), /by your own choice: once it's approved, go on/);
    assert.doesNotMatch(nextStep(planResult), /wait for the user's explicit approval/);
    // the prompt hook: the instruction always, the reminder after five user turns
    const ctx = async (prompt, turn) => {
      const r = await runHook("claude", "prompt", { session_id: A.id, cwd: work, prompt, prompt_id: turn });
      return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : "";
    };
    assert.match(await ctx("go", "u1"), /Auto mode is on/);
    await until(() => state().auto[`claude:${A.id}`].turns === 1);
    await ctx("<task-notification>\n<task-id>x</task-id>\n</task-notification>", "u1b");
    await ctx("faster", "u1");
    for (const t of ["u2", "u3", "u4", "u5"]) await ctx("more", t);
    await until(() => state().auto[`claude:${A.id}`].turns === 5);
    assert.match(await ctx("and more", "u6"), /you haven't consulted the reviewer for a few turns/);
    // a file that can't be reached is said so, not taken as deleted
    fs.mkdirSync(path.join(work, "sub"));
    fs.writeFileSync(path.join(work, "sub", "f.js"), "f\n");
    g("add", ".");
    g("commit", "-qm", "sub");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      fs.chmodSync(path.join(work, "sub"), 0);
      try {
        assert.match((await stop()).reason, /couldn't check .*peer-bridge-auto-.*can't read .*f\.js \(EACCES\)/);
      } finally {
        fs.chmodSync(path.join(work, "sub"), 0o755);
      }
    }
    await call("auto_set", { endpoint: A, on: false });
    assert.equal(await stop(), null, "off: no check");
    console.log("31 auto mode: approvals cover the request, plans don't approve code, the turn check and reminder behave, own-initiative plans go on");
  } finally {
    try {
      fs.chmodSync(path.join(work, "sub"), 0o755);
    } catch {
      // not made
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

console.log("\nhooks log:\n" + fs.readFileSync(path.join(dir, "hooks.jsonl"), "utf8"));
process.exit(0);
