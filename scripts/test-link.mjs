// End-to-end test of links and hooks against a throwaway data dir: the broker
// runs in this process, src/hook.mjs runs as a real subprocess with hook JSON
// on stdin, Codex delivery is faked (AGENT_REVIEW_BRIDGE_FAKE_CODEX).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-link-"));
Object.assign(process.env, { AGENT_REVIEW_BRIDGE_DIR: dir, AGENT_REVIEW_BRIDGE_PORT: "7498", AGENT_REVIEW_BRIDGE_FAKE_CODEX: "1", AGENT_REVIEW_BRIDGE_CONFIG_DIR: path.join(dir, "config") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameTo = (a, b) => !!a && a.app === b.app && a.id === b.id;

// 0. a stale owner (older protocol, e.g. a helper left over from before an
// update) steps down when a newer client calls, and the client takes over.
// It runs the version before this one, as after a real update.
const brokerUrl = new URL("../src/broker.mjs", import.meta.url).href;
const stale = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");console.log("owner");setInterval(()=>{},1000);`], {
  env: { ...process.env, AGENT_REVIEW_BRIDGE_TEST_PROTOCOL: "20" },
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

// 2. auto mode reviewing every turn (in full in 38 and 39): a question goes
// only with its own turn, never with a later one; a delivery the bridge made
// is the bridge's once, through the hook too, so the same text pasted again
// is the user's; a user typing a look-alike of the bridge's header is still
// the user
{
  const P = { app: "openai", id: "gpt-question" };
  const R = { app: "claude", id: "claude-question-reviewer" };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-question-"));
  await call("auto_set", { endpoint: P, on: true, everyTurn: true, reviewer: R });
  const reviewOf = (last) => until(() => state().messages.find((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && m.text.includes(`Agent's final message:\n${last}`)), 15000);
  const asked = (m) => m.text.split("Agent's final message")[0];
  await runHook("openai", "prompt", { session_id: P.id, cwd: work, turn_id: "t11", prompt: "Old question." });
  await runHook("openai", "stop", { session_id: P.id, cwd: work, turn_id: "t12", last_assistant_message: "Answer to t12." });
  const t12 = await reviewOf("Answer to t12.");
  assert.match(asked(t12), /User's message:\n\(None: the app or a bridge message started this turn, not the user\.\)/, "another turn's question isn't this one's");
  assert.doesNotMatch(asked(t12), /Old question/);
  await runHook("openai", "stop", { session_id: P.id, cwd: work, turn_id: "t13", last_assistant_message: "Answer to t13." });
  const t13 = await reviewOf("Answer to t13.");
  assert.doesNotMatch(asked(t13), /Old question/, "nor a later one's");
  const gen = () => state().auto[`openai:${P.id}`].generation;
  // the prompt hook's own request applied (not just any outbox file gone)
  const outbox = () => new Set(fs.readdirSync(path.join(dir, "outbox")));
  const promptHook = async (turn_id, text) => {
    const before = outbox();
    await runHook("openai", "prompt", { session_id: P.id, cwd: work, turn_id, prompt: text });
    const mine = [...outbox()].filter((f) => !before.has(f));
    await until(() => {
      const now = outbox();
      return mine.every((f) => !now.has(f));
    });
  };
  const fix = await call("advise", { endpoint: R, requestId: t13.id, decision: "changes_requested", blocking: [{ title: "Handle errors." }] });
  const delivered = inlineText(await until(() => state().messages.find((m) => m.id === fix.id && m.dispatch)));
  const g1 = gen();
  await promptHook("b1", delivered);
  assert.equal(gen(), g1, "the delivery running as a prompt isn't the user's");
  await promptHook("u6", delivered);
  assert.equal(gen(), g1 + 1, "the same text pasted again later is the user's");
  const g = gen();
  await call("turn_start", { endpoint: P, turnId: "t14", prompt: "CODEX: Message m99999 (link L99999) please go on" });
  assert.equal(gen(), g + 1, "a look-alike header typed by the user is the user's");
  await call("auto_set", { endpoint: P, on: false });
  fs.rmSync(work, { recursive: true, force: true });
  console.log("2 every turn: a question goes only with its own turn; a delivery is the bridge's once, through the hook too, so a later paste of it is the user's; a look-alike header is the user's");
}

// 7. one listener per session: a newer one supersedes the older (CLAUDE2
// reviews for GPT, its review open)
await call("link_create", { primary: GPT, advisor: CLAUDE2, request: "Review the migration." });
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
  const rl = await call("link_create", { primary: REQ, advisor: REV, request: "Check the parser." });
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

// 12. no message cap; old state is pruned
{
  const P = { app: "claude", id: "claude-bulk" };
  const A = { app: "claude", id: "claude-bulk-reviewer" };
  for (let i = 0; i < 250; i++) await call("link_create", { primary: P, advisor: A, request: `review ${i}` });
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
  const la = await call("link_create", { primary: A, advisor: RV, request: "Review A." });
  const lb = await call("link_create", { primary: B, advisor: RV, request: "Review B." });
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
  const A = { app: "claude", id: "claude-flood-reviewer" };
  for (let i = 0; i < 600; i++) await call("link_create", { primary: P, advisor: A, request: `review ${i}` });
  const unread = state().messages.filter((m) => sameTo(m.toEndpoint, A) && !m.readAt).length;
  assert.equal(unread, 600, `all 600 unread review requests kept (got ${unread})`);
  console.log("17 600 unread messages kept; only read ones are capped");
}

// 14. owner dies while idle: a surviving server's keepOwner ping takes over and
// ingests the hook's request (this process stops owning by exiting the child
// test below, so run it on a fresh port + dir)
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-owner-"));
  const env2 = { ...process.env, AGENT_REVIEW_BRIDGE_DIR: dir2, AGENT_REVIEW_BRIDGE_PORT: "7497" };
  const proc = (code) => spawn(process.execPath, ["--input-type=module", "-e", code], { env: env2 });
  const ownerA = proc(`const b=await import(${JSON.stringify(brokerUrl)});await b.call("auto_set",{endpoint:{app:"claude",id:"S9"},on:true,everyTurn:true,reviewer:{app:"claude",id:"A9"}});console.log("ready");setInterval(()=>{},1000);`);
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
  while (!ev().includes('"op":"turn_queued"') && Date.now() < end) await sleep(50);
  serverB.kill();
  assert.ok(ev().includes('"op":"turn_queued"'), "surviving server must take over and ingest");
  console.log(`14 owner died while idle: surviving server took over, request ingested in ${Date.now() - t0} ms`);
}

// 15. a failed ChatGPT delivery (a review's answer) reaches the chat on the
// other end with its next prompt, and an owner loading week-old state prunes
// it (fresh broker so the failing fake applies)
{
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-fail-"));
  fs.copyFileSync(path.join(dir, "state.json.aged"), path.join(dir3, "state.json"));
  const env3 = { ...process.env, AGENT_REVIEW_BRIDGE_DIR: dir3, AGENT_REVIEW_BRIDGE_PORT: "7495", AGENT_REVIEW_BRIDGE_FAKE_CODEX: "fail" };
  const P = { app: "claude", id: "claude-fail" };
  const owner = spawn(process.execPath, ["--input-type=module", "-e",
    `const b=await import(${JSON.stringify(brokerUrl)});const P=${JSON.stringify(P)};await b.call("link_create",{primary:{app:"openai",id:"gpt-gone"},advisor:P,request:"x"});` +
    `const id=(await b.call("receive",{side:"claude",endpoint:P})).messages[0].id;await b.call("advise",{endpoint:P,requestId:id,decision:"approved"});console.log("ready");setInterval(()=>{},1000);`], { env: env3 });
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
  const end = Date.now() + 4000;
  while (!st3().notes.some((n) => n.kind === "bridge" && sameTo(n.to, P)) && Date.now() < end) await sleep(50);
  const out = await run3("prompt", { prompt: "next" });
  owner.kill();
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Couldn't hand review-result .* ChatGPT Desktop not reachable/);
  console.log("15 failed delivery shown to the chat on the other end with its next prompt; week-old state pruned on load");
}

// 18. a review request handed to a ChatGPT thread counts as read, but stays
// answerable until answered: not pruned after a day, nor by the read cap
{
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-open-"));
  const P = { app: "claude", id: "claude-slow" };
  const G = { app: "openai", id: "gpt-slow" };
  const old = Date.now() - 2 * 24 * 3600_000;
  const msg = (id, extra) => ({ id, from: "claude", to: "openai", toEndpoint: G, linkId: "L1", text: "x", ts: Date.now(), readAt: Date.now(), dispatch: { state: "sent", at: Date.now() }, ...extra });
  const seeded = {
    seq: 700, linkSeq: 1, notes: [],
    links: { L1: { id: "L1", mode: "review", active: true, createdAt: old, primary: P, advisor: G, advisories: [], round: 1 } },
    messages: [msg("m1", { kind: "review-request", ts: old, readAt: old }), ...Array.from({ length: 600 }, (_, i) => msg(`m${i + 2}`, { kind: "message" }))],
  };
  try {
    fs.writeFileSync(path.join(dir4, "state.json"), JSON.stringify(seeded));
    const env4 = { ...process.env, AGENT_REVIEW_BRIDGE_DIR: dir4, AGENT_REVIEW_BRIDGE_PORT: "7494" };
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
  const l = await call("link_create", { primary: RQ, advisor: RV, request: "Check." });
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
  process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS = "3";
  const RQ = { app: "claude", id: "claude-rounds" };
  const RV = { app: "openai", id: "gpt-rounds" };
  const answer = async (linkId, decision) => {
    const id = state().messages.find((m) => m.kind === "review-request" && m.linkId === linkId).id;
    return call("advise", { endpoint: RV, requestId: id, decision, ...(decision === "changes_requested" && { blocking: [{ title: "fix it" }] }) });
  };
  const l1 = await call("link_create", { primary: RQ, advisor: RV, request: "Plan: do it", plan: true });
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
  const k1 = await call("link_create", { primary: RQ, advisor: RV, request: "Code." });
  await answer(k1.id, "approved");
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: k1.id, request: "more" }), /was approved; there is nothing to re-review/);
  delete process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS;
  console.log("20 review rounds: same reviewer and kind, round header, one continuation per round, refused after approval, for others, past the cap");
}

// 22. telling the bridge's prompts from the user's: exact text, once per
// delivery, so the same text again is the user's; a delivery still being sent
// already counts, and "sending" is on disk before the thread can run it. Hook
// events are applied once, even when an owner that died before removing one
// leaves it for the next owner.
{
  const P = { app: "openai", id: "gpt-detect" };
  const A = { app: "claude", id: "claude-detect-reviewer" };
  await call("auto_set", { endpoint: P, on: true, everyTurn: true, reviewer: A });
  const gen = () => state().auto[`openai:${P.id}`].generation;
  const g0 = gen();
  // a prompt and a Stop without turn ids (as Claude's are), each left in the
  // outbox twice under the same name: applied once
  const replay = async (name, op, args) => {
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(path.join(dir, "outbox", name), JSON.stringify({ op, args }));
      await until(() => !fs.existsSync(path.join(dir, "outbox", name)));
    }
  };
  await replay("0000000000001-1-aaaaaa.json", "turn_start", { endpoint: P, prompt: "Start." });
  assert.equal(gen(), g0 + 1, "a user prompt's event applied twice counts once");
  await replay("0000000000002-1-bbbbbb.json", "turn_end", { endpoint: P, lastMessage: "done" });
  const reqs = () => state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, A));
  const req = await until(() => reqs()[0], 15000);
  await sleep(300);
  assert.equal(reqs().length, 1, "a replayed Stop is one review, not two");
  assert.ok(!state().auto[`openai:${P.id}`].jobs?.length, "and nothing left to send");
  assert.ok(events().some((e) => e.op === "outbox-replay-skipped" && e.file === "0000000000002-1-bbbbbb.json"));
  process.env.AGENT_REVIEW_BRIDGE_FAKE_CODEX = "slow";
  const adv = await call("advise", { endpoint: A, requestId: req.id, decision: "changes_requested", blocking: [{ title: "no" }] });
  const msg = () => state().messages.find((m) => m.id === adv.id);
  assert.equal(msg().dispatch.state, "sending", "sending is saved before the delivery is handed over");
  const delivered = inlineText(msg());
  assert.ok((await call("turn_start", { endpoint: P, turnId: "b1", prompt: delivered })).fromBridge, "a delivery still being sent already counts as the bridge's");
  assert.equal(gen(), g0 + 1);
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u2", prompt: delivered })).fromBridge, "the same text in a later turn is the user's");
  assert.equal(gen(), g0 + 2);
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u3", prompt: delivered.split("\n")[0] })).fromBridge, "a header alone is the user's");
  await until(() => msg().dispatch.state === "sent");
  process.env.AGENT_REVIEW_BRIDGE_FAKE_CODEX = "1";
  await call("auto_set", { endpoint: P, on: false });
  for (const bad of ["oops", "Infinity", "0", "-3", "2.5"]) {
    process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS = bad;
    const RQ = { app: "claude", id: `claude-cap-${bad}` };
    const prev = await call("link_create", { primary: RQ, advisor: A, request: "x" });
    const id = state().messages.find((m) => m.linkId === prev.id).id;
    await call("advise", { endpoint: A, requestId: id, decision: "changes_requested", blocking: [{ title: "x" }] });
    assert.equal((await call("link_continue", { primary: RQ, roundOf: prev.id, request: "y" })).round, 2, `cap "${bad}" falls back to 20`);
  }
  delete process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS;
  console.log("22 bridge prompts: exact text, once per delivery, counted while still sending; hook events applied once; a bad cap falls back to 20");
}

// 23. an owner that takes over doesn't resend a delivery whose turn already
// ran: it was stuck in "sending", but its prompt was matched
{
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-resend-"));
  try {
    const P = { app: "openai", id: "gpt-resend" };
    const old = Date.now() - 5 * 60_000;
    const m = (id, extra) => ({ id, from: "claude", to: "openai", toEndpoint: P, kind: "review-result", linkId: "L1", text: "x", ts: old, readAt: null, ...extra });
    fs.writeFileSync(
      path.join(dir5, "state.json"),
      JSON.stringify({
        seq: 3, linkSeq: 1, notes: [],
        links: { L1: { id: "L1", mode: "review", active: false, createdAt: old, closedAt: old, primary: P, advisor: { app: "claude", id: "c" }, advisories: [], round: 1, decision: "approved" } },
        messages: [m("m1", { dispatch: { state: "sending", at: old }, promptMatched: old }), m("m2", { dispatch: { state: "sending", at: old } })],
      }),
    );
    const env5 = { ...process.env, AGENT_REVIEW_BRIDGE_DIR: dir5, AGENT_REVIEW_BRIDGE_PORT: "7493", AGENT_REVIEW_BRIDGE_FAKE_CODEX: "1" };
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");setTimeout(()=>process.exit(0),300);`], { env: env5 });
      p.on("close", resolve);
    });
    const st5 = JSON.parse(fs.readFileSync(path.join(dir5, "state.json"), "utf8"));
    const ev5 = fs.readFileSync(path.join(dir5, "events.jsonl"), "utf8");
    assert.equal(st5.messages.find((x) => x.id === "m1").dispatch.state, "sent");
    assert.ok(!/"op":"fake-codex-deliver"[^\n]*"text":"CLAUDE: The review you asked for: m1 /.test(ev5), "a matched delivery isn't sent again");
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
  const rules = path.join(process.env.AGENT_REVIEW_BRIDGE_CONFIG_DIR, "rules.md");
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, "Always answer in Turkish.\n");
  const ctx = async (endpoint) => {
    const o = (await runHook(endpoint.app, "prompt", { session_id: endpoint.id, prompt: "hello" })).out;
    return o ? JSON.parse(o).hookSpecificOutput.additionalContext : "";
  };
  assert.equal(await ctx({ app: "openai", id: "gpt-unrelated" }), "", "an unrelated chat gets nothing");
  const P = { app: "openai", id: "gpt-rules" };
  const open = await call("link_create", { primary: P, advisor: { app: "claude", id: "claude-rules" }, request: "Open while the rules are checked." });
  assert.match(await ctx(P), /Your user's own standing rules for work through agent-review-bridge \(from .*rules\.md\)[\s\S]*Always answer in Turkish\./);
  const RQ = { app: "openai", id: "gpt-rules-requester" };
  const RV = { app: "claude", id: "claude-rules-reviewer" };
  const rl = await call("link_create", { primary: RQ, advisor: RV, request: "Check." });
  await call("advise", { endpoint: RV, requestId: state().messages.find((m) => m.linkId === rl.id).id, decision: "approved" });
  assert.equal(state().links[rl.id].active, false);
  assert.match(await ctx(RQ), /Always answer in Turkish/, "the answer to a closed review still comes with the rules");
  const delivered = await until(() => events().find((e) => e.op === "fake-codex-deliver" && e.threadId === RQ.id));
  assert.doesNotMatch(delivered.text, /Always answer in Turkish/, "rules never travel inside a peer message");
  // an answer written two days ago but handed over just now still counts
  {
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-late-"));
    try {
      const old = Date.now() - 2 * 24 * 3600_000;
      const late = { id: "m1", from: "claude", to: "openai", toEndpoint: RQ, kind: "review-result", linkId: "L1", text: "x", ts: old, readAt: Date.now(), dispatch: { state: "sent", at: Date.now() } };
      fs.writeFileSync(path.join(dir6, "state.json"), JSON.stringify({ seq: 1, linkSeq: 1, notes: [], links: { L1: { id: "L1", mode: "review", active: false, primary: RQ, advisor: RV, createdAt: old, closedAt: old } }, messages: [late] }));
      const out = await new Promise((resolve) => {
        const p = spawn(process.execPath, [hook, "--app", "openai", "--event", "prompt"], { env: { ...process.env, AGENT_REVIEW_BRIDGE_DIR: dir6 } });
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
  await call("link_close", { linkId: open.id });
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
  const a = await call("link_create", { primary: S, advisor: { app: "openai", id: "gpt-checked" }, request: "x" });
  const checked = await call("send_target", { endpoint: S });
  await call("link_create", { primary: S, advisor: { app: "openai", id: "gpt-newer" }, request: "x" });
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
  const A = { app: "claude", id: "claude-crlf-reviewer" };
  await call("auto_set", { endpoint: P, on: true, everyTurn: true });
  const l = await call("link_create", { primary: P, advisor: A, request: "x" });
  const req = state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id);
  const adv = await call("advise", { endpoint: A, requestId: req.id, decision: "changes_requested", blocking: [{ title: "no" }] });
  const delivered = inlineText(state().messages.find((m) => m.id === adv.id));
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u2", prompt: delivered.split("\n")[0] })).fromBridge, "a header alone is the user's");
  assert.ok((await call("turn_start", { endpoint: P, turnId: "b1", prompt: delivered.replace(/\n/g, "\r\n") + "\r\n" })).fromBridge, "changed line ends: still the bridge's");
  await call("auto_set", { endpoint: P, on: false });
  console.log("27 a bridge prompt with changed line ends still counts as the bridge's; a header alone doesn't");
}

// 28. a long wake reaches the Claude session whole, down to its final
// instruction line, and only then counts as read
{
  const G = { app: "openai", id: "gpt-long" };
  const C = { app: "claude", id: "claude-long-reviewer" };
  const l = await call("link_create", { primary: G, advisor: C, request: `${"a".repeat(9_000)}\ndiff --git a/x b/x\n${"+line of the diff\n".repeat(1_100)}` });
  const req = state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id);
  r = await runHook("claude", "listen", { session_id: C.id });
  assert.equal(r.code, 2);
  assert.ok(r.err.length > 25_000, `the whole wake arrived (${r.err.length} characters)`);
  assert.ok(r.err.trimEnd().endsWith(`answer once with bridge_advise (request_id ${req.id}).`), "down to its last line");
  await until(() => state().messages.find((m) => m.id === req.id).readAt);
  await call("link_close", { linkId: l.id });
  console.log(`28 a long wake (${r.err.length} characters) arrives whole, then counts as read`);
}

// 30. one turn, many prompt hooks: Claude Code runs UserPromptSubmit with the
// running turn's prompt_id for a message typed mid-turn and for its own
// background-task notice (measured). They keep the turn's task and baseline
// and don't start a generation; the user's message is added to the task.
// Only equal, present ids count as one turn.
{
  const { turnFile } = await import("../src/broker.mjs");
  const { execFileSync } = await import("node:child_process");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-mid-"));
  execFileSync("git", ["-C", work, "init", "-q"]);
  fs.writeFileSync(path.join(work, "c.js"), "1\n");
  const P = { app: "claude", id: "claude-mid-turn" };
  const G = { app: "openai", id: "gpt-mid-turn" };
  await call("auto_set", { endpoint: P, on: true, everyTurn: true, reviewer: G });
  const link = () => state().auto[`claude:${P.id}`];
  // wait for this hook's own request to be applied, not for the outbox to
  // shrink (files left from an earlier step would end the wait too early)
  const outbox = () => new Set(fs.readdirSync(path.join(dir, "outbox")));
  const prompt = async (prompt_id, text) => {
    const before = outbox();
    await runHook("claude", "prompt", { session_id: P.id, cwd: work, prompt: text, ...(prompt_id && { prompt_id }) });
    const mine = [...outbox()].filter((f) => !before.has(f));
    await until(() => {
      const now = outbox();
      return mine.every((f) => !now.has(f));
    });
  };
  const base = () => JSON.parse(fs.readFileSync(turnFile(P), "utf8"));
  const review = async (prompt_id, answer) => {
    await runHook("claude", "stop", { session_id: P.id, cwd: work, last_assistant_message: answer, ...(prompt_id && { prompt_id }) });
    return (await until(() => state().messages.find((m) => m.kind === "review-request" && sameTo(m.toEndpoint, G) && m.text.includes(`Agent's final message:\n${answer}`)), 15000)).text;
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
  assert.match(text, /User's message:\nBuild the importer\.\n\nAdded by the user while the turn was running:\nBe quick\.\n\nAgent's final message/);
  assert.ok(!text.includes("task-notification"), "the app's notices aren't the user's");

  // a turn the app's notice starts (idle session) isn't the user's either
  await prompt("t2", notice);
  assert.equal(link().generation, g, "a notice starts no generation");
  text = await review("t2", "Noted the task.");
  assert.match(text, /User's message:\n\(None: the app or a bridge message started this turn/);

  // an interrupted turn (no Stop) followed by a new task: the new id gets a
  // new baseline and only its own message
  await prompt("t3", "Task A.");
  const b3 = base();
  await prompt("t4", "Task B.");
  assert.equal(base().turnId, "t4");
  assert.ok(base().at >= b3.at);
  assert.equal(link().generation, g + 2);
  text = await review("t4", "Did B.");
  assert.match(text, /User's message:\nTask B\.\n\nAgent's final message/);

  // without ids every prompt is a new turn, as before
  await prompt(null, "First.");
  const b5 = base();
  await sleep(5);
  await prompt(null, "Second.");
  assert.notDeepEqual(base(), b5, "no id: new baseline");
  assert.equal(link().generation, g + 4);
  text = await review(null, "Did both.");
  assert.match(text, /User's message:\nSecond\.\n\nAgent's final message/);
  await call("auto_set", { endpoint: P, on: false });
  fs.rmSync(work, { recursive: true, force: true });
  console.log("30 mid-turn: messages typed during a turn join its task, notices are ignored, the baseline holds; new or missing ids start a turn");
}

// 31. auto mode in the broker and the hooks: approvals cover the request's
// content; plan approvals don't approve code; the end-of-turn check stops
// unreviewed changes once, not while a review waits; the reminder counts
// the user's turns only; an own-initiative plan doesn't wait for the user
{
  const { execFileSync } = await import("node:child_process");
  const { fingerprint } = await import("../src/git.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-auto-"));
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
    assert.match(blocked.reason, /hasn't approved the current changes in .*agent-review-bridge-auto-/);
    assert.equal(await stop({ stop_hook_active: true }), null, "stopping again over the same changes goes through");
    // a turn the bridge's own wake started (stop_hook_active set) is still checked
    fs.writeFileSync(path.join(work, "a.js"), "2b\n");
    assert.ok(await stop({ stop_hook_active: true }), "new changes stop a woken turn too");
    fs.writeFileSync(path.join(work, "a.js"), "2\n");
    await stop();
    // a review asked about this content: the check waits, then the approval covers it
    const fpAsked = fpNow();
    const l = await call("link_create", { primary: A, advisor: R, request: "check", reqPaths: [{ path: work, fp: fpAsked, head }] });
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
    const pl = await call("link_create", { primary: A, advisor: R, request: "plan", plan: true, noGate: true, reqPaths: [{ path: work, fp: fpNow(), head }] });
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
        assert.match((await stop()).reason, /couldn't check .*agent-review-bridge-auto-.*can't read .*f\.js \(EACCES\)/);
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

// 32. status lists open links and the few closed in the last hour; older
// ones are only counted, and internal fields stay out
{
  const S = { app: "claude", id: "claude-status" };
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const { id } = await call("link_create", { primary: S, request: `r${i}`, reqPaths: [{ path: "/x", fp: "f", head: "h" }] });
    ids.push(id);
  }
  for (const id of ids.slice(0, 7)) await call("link_close", { linkId: id });
  const st = await call("status", { endpoint: S });
  assert.equal(st.links.filter((l) => l.active).length, 1, "the open one");
  assert.equal(st.links.filter((l) => !l.active).length, 5, "at most 5 recently closed");
  assert.equal(st.olderLinks, 2, "the rest counted");
  assert.ok(st.links.every((l) => !("reqPaths" in l) && !("request" in l)));
  await call("link_close", { linkId: ids[7] });
  console.log("32 status: open links and at most 5 closed in the last hour; older ones counted");
}

// 33. auto mode's rules: in full when a session starts again (a compaction may
// have lost them), short but complete with each prompt; a deleted tracked
// folder is named as gone, and its approved deletion ends the check
{
  const { fingerprint } = await import("../src/git.mjs");
  const B = { app: "claude", id: "claude-rules" };
  const R = { app: "openai", id: "gpt-rules" };
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-gone-"));
  fs.writeFileSync(path.join(gone, "f.txt"), "x");
  await call("auto_set", { endpoint: B, on: true, paths: [{ path: gone, fp: fingerprint(gone).hash, head: null }] });
  const start = await runHook("claude", "start", { session_id: B.id, source: "compact" });
  const ctx = JSON.parse(start.out).hookSpecificOutput;
  assert.equal(ctx.hookEventName, "SessionStart");
  assert.match(ctx.additionalContext, /Get its approval at the moments that matter, not at every small step/, "the full rules");
  const prompt = await runHook("claude", "prompt", { session_id: B.id, prompt: "next step" });
  const pctx = JSON.parse(prompt.out).hookSpecificOutput.additionalContext;
  assert.match(pctx, /Auto mode is on: get the reviewer's approval \(bridge_review\) before settling or changing a direction/);
  assert.match(pctx, /Pass own_initiative=true only for a plan you chose to consult on/);
  assert.doesNotMatch(pctx, /not at every small step/, "not the full rules with every prompt");
  // a deleted tracked folder
  fs.rmSync(gone, { recursive: true, force: true });
  const blocked = JSON.parse((await runHook("claude", "stop", { session_id: B.id })).out);
  assert.match(blocked.reason, /agent-review-bridge-gone-\w+ \(no longer there\)/);
  const l = await call("link_create", { primary: B, advisor: R, request: "deleted it", reqPaths: [{ path: gone, fp: fingerprint(gone).hash, head: null }] });
  await call("advise", { endpoint: R, requestId: state().messages.find((m) => m.linkId === l.id).id, decision: "approved" });
  assert.equal((await runHook("claude", "stop", { session_id: B.id })).out, "", "the approved deletion ends the check");
  await call("auto_set", { endpoint: B, on: false });
  assert.equal((await runHook("claude", "start", { session_id: B.id, source: "resume" })).out, "", "auto mode off: nothing at session start");
  console.log("33 auto mode rules: in full at session start, short with each prompt; a deleted folder named as gone until its deletion is approved");
}

// 34. a Claude chat reviewing for others gets, when its session starts again,
// the reviews still waiting for its answer and its role; with auto mode on,
// its full rules too; with nothing open, nothing
{
  const C = { app: "claude", id: "claude-reviewing" };
  const asker = { app: "openai", id: "gpt-asker-34" };
  const a = await call("link_create", { primary: asker, advisor: C, request: "first" });
  const b = await call("link_create", { primary: asker, advisor: C, request: "second" });
  const idOf = (linkId) => state().messages.find((m) => m.linkId === linkId && m.kind === "review-request").id;
  await call("auto_set", { endpoint: C, on: true });
  const out = JSON.parse((await runHook("claude", "start", { session_id: C.id, source: "compact" })).out).hookSpecificOutput.additionalContext;
  assert.match(out, /not at every small step/, "auto mode's full rules");
  assert.match(out, new RegExp(`Reviews waiting for your answer: ${idOf(a.id)} from openai chat gpt-asker-34 \\(link ${a.id}\\); ${idOf(b.id)} from openai chat gpt-asker-34 \\(link ${b.id}\\)`));
  assert.match(out, /read it again with bridge_receive and its id\. As the reviewer: read-only/);
  await call("auto_set", { endpoint: C, on: false });
  await call("advise", { endpoint: C, requestId: idOf(a.id), decision: "approved" });
  await call("advise", { endpoint: C, requestId: idOf(b.id), decision: "approved" });
  assert.equal((await runHook("claude", "start", { session_id: C.id, source: "resume" })).out, "", "nothing waiting, auto mode off: nothing");
  console.log("34 a Claude reviewer's session start lists the reviews waiting for it with its role, plus auto mode's rules when on");
}

// bridge_read_chat's gate: a chat the bridge created to review stays
// refused after its link closes; one that joined only while its link is open
{
  const made = { app: "openai", id: "gpt-made-reviewer" };
  const joined = { app: "openai", id: "gpt-joined-reviewer" };
  const P = { app: "claude", id: "claude-gate" };
  assert.ok((await call("read_chat_allowed", { endpoint: P })).allowed, "an ordinary chat may read");
  await call("reviewer_chat", { endpoint: made });
  const a = await call("link_create", { primary: P, advisor: made, request: "x" });
  const b = await call("link_create", { primary: P, advisor: joined, request: "x" });
  assert.ok(!(await call("read_chat_allowed", { endpoint: made })).allowed);
  assert.ok(!(await call("read_chat_allowed", { endpoint: joined })).allowed, "an open link's reviewer may not");
  await call("link_close", { linkId: a.id });
  await call("link_close", { linkId: b.id });
  assert.ok(!(await call("read_chat_allowed", { endpoint: made })).allowed, "closing the link grants nothing to a chat the bridge made");
  assert.ok((await call("read_chat_allowed", { endpoint: joined })).allowed, "the user's own chat is theirs again");
  assert.ok((await call("read_chat_allowed", { endpoint: P })).allowed, "the requester was never a reviewer");
  console.log("36 read_chat gate: bridge-made reviewers stay refused; a joined chat only while its link is open");
}

// 35. paths that would stay unreviewed for good: a plan review's paths aren't
// tracked, and a path never approved that is gone drops out of the check;
// ChatGPT's memory citations don't reach the requester
{
  const D = { app: "claude", id: "claude-stuck" };
  const R = { app: "openai", id: "gpt-stuck" };
  const key = `claude:${D.id}`;
  const plan = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-plan-"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-temp-"));
  fs.writeFileSync(path.join(temp, "f.txt"), "x");
  await call("auto_set", { endpoint: D, on: true });
  const answer = async (linkId, decision, note) =>
    call("advise", { endpoint: R, requestId: state().messages.find((m) => m.linkId === linkId && m.kind === "review-request").id, decision, note, ...(decision === "changes_requested" && { blocking: [{ title: "x" }] }) });
  const pl = await call("link_create", { primary: D, advisor: R, request: "plan", plan: true, reqPaths: [{ path: plan, fp: "f", head: null }] });
  assert.ok(!(plan in state().auto[key].paths), "a plan review's paths aren't tracked");
  await answer(pl.id, "changes_requested");
  const pl2 = await call("link_continue", { primary: D, roundOf: pl.id, request: "again", reqPaths: [{ path: plan, fp: "f", head: null }] });
  assert.ok(!(plan in state().auto[key].paths), "nor its next round's");
  await answer(pl2.id, "approved");
  const code = await call("link_create", { primary: D, advisor: R, request: "code", reqPaths: [{ path: temp, fp: "f", head: null }] });
  assert.equal(state().auto[key].paths[temp].approved, null, "a code review's path is tracked");
  await answer(code.id, "changes_requested", "Fix it.\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n</oai-mem-citation>");
  const result = state().messages.find((m) => m.linkId === code.id && m.kind === "review-result");
  assert.match(result.text, /Fix it\./);
  assert.doesNotMatch(result.text, /oai-mem-citation|citation_entries/, "the citation block is taken out");
  const stopOut = async () => (await runHook("claude", "stop", { session_id: D.id })).out;
  assert.match(JSON.parse(await stopOut()).reason, /agent-review-bridge-temp-\w+/, "still there and unreviewed: named");
  fs.rmSync(temp, { recursive: true, force: true });
  await runHook("claude", "prompt", { session_id: D.id, prompt: "next" }); // a new prompt clears what was told
  assert.equal(await stopOut(), "", "never approved and gone: nothing left to review");
  await call("auto_set", { endpoint: D, on: false });
  fs.rmSync(plan, { recursive: true, force: true });
  // a failed review: a retry of its own only in auto mode, and only once
  const failed = { kind: "failed", retry: "L9" };
  assert.match(nextStep(failed), /Tell the user, in their language.*Ask again only if the user wants to \(after the reset time, if one is given\): to ask the same reviewer, use bridge_review\(round_of="L9"\)\./);
  assert.match(nextStep({ ...failed, auto: true }), /Auto mode: if a reset time is given, it's less than an hour away and you're still working then, ask the same reviewer once more yourself with bridge_review\(round_of="L9"\); if that fails too, tell the user and don't retry again\./);
  assert.doesNotMatch(nextStep({ ...failed, auto: true, retried: true }), /Auto mode/, "a failed retry gives no new one");
  assert.doesNotMatch(nextStep({ kind: "failed", auto: true }), /Auto mode/, "not a review: nothing to retry");
  console.log("35 plan paths aren't tracked, a never-approved path that is gone drops out, citations are taken out, a failed review's retry rule");
}

// 37. auto mode from ChatGPT, its hooks: the end-of-turn check stops once per
// set of changes, a turn ChatGPT already continued included; the bridge's own
// deliveries and the check's own words, which ChatGPT runs as prompts, aren't
// the user's; the rules again at session start; and the Claude chat that is
// its reviewer keeps listening between reviews, until auto mode is off
{
  const { execFileSync } = await import("node:child_process");
  const { fingerprint } = await import("../src/git.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-gptauto-"));
  try {
    const g = (...a) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    fs.writeFileSync(path.join(work, "a.js"), "1\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const head = g("rev-parse", "HEAD").trim();
    const W = { app: "openai", id: "gpt-auto-37" };
    const R = { app: "claude", id: "claude-reviewer-37" };
    const key = `openai:${W.id}`;
    await call("auto_set", { endpoint: W, on: true, paths: [{ path: work, fp: fingerprint(work).hash, head }] });
    const stop = async (extra = {}) => {
      const r = await runHook("openai", "stop", { session_id: W.id, cwd: work, ...extra });
      return r.out ? JSON.parse(r.out) : null;
    };
    const prompt = (p, turn) => runHook("openai", "prompt", { session_id: W.id, cwd: work, prompt: p, turn_id: turn });
    fs.writeFileSync(path.join(work, "a.js"), "2\n");
    const first = await stop({ stop_hook_active: true });
    assert.equal(first?.decision, "block", "a turn ChatGPT already continued is checked too");
    assert.equal(await stop({ stop_hook_active: true }), null, "the same changes: once");
    fs.writeFileSync(path.join(work, "a.js"), "3\n");
    const again = await stop({ stop_hook_active: true });
    assert.equal(again?.decision, "block", "new changes: checked again");
    // ChatGPT goes on with the check's words as a new prompt: not the user's,
    // nor wrapped in other words
    await prompt(again.reason, "c1");
    assert.equal(await stop(), null, "the check's own words don't make it stop the same changes again");
    await prompt(`Continue. ${again.reason}`, "c1b");
    assert.equal(await stop(), null, "nor wrapped in other words");
    // even if such a prompt were taken for the user's (the record cleared), the
    // same changes don't stop the turn ChatGPT goes on with; new changes do
    fs.writeFileSync(path.join(work, "a.js"), "4\n");
    assert.equal((await stop())?.decision, "block");
    fs.rmSync(path.join(dir, "turns", "openai-gpt-auto-37.auto-guard.json"));
    assert.equal(await stop({ stop_hook_active: true }), null, "the turn it went on with isn't stopped again for the same changes");
    fs.writeFileSync(path.join(work, "a.js"), "5\n");
    assert.equal((await stop({ stop_hook_active: true }))?.decision, "block", "new changes in it are");
    // a review result the bridge delivered, run as a prompt: not the user's either
    const r = await call("link_create", { primary: W, advisor: R, request: "check 3", reqPaths: [{ path: work, fp: fingerprint(work).hash, head }] });
    await call("receive", { side: "claude", endpoint: R }); // the reviewer reads it, as a woken session does
    await call("advise", { endpoint: R, requestId: state().messages.find((m) => m.linkId === r.id && m.kind === "review-request").id, decision: "changes_requested", blocking: [{ title: "x" }] });
    const result = await until(() => state().messages.find((m) => m.linkId === r.id && m.kind === "review-result" && m.dispatch?.state === "sent"));
    await prompt(inlineText(result), "c2");
    assert.equal(await stop(), null, "a delivery doesn't make it stop the same changes again");
    await sleep(300);
    assert.equal(state().auto[key].turns, 0, "neither counts as a user turn");
    // the user's own prompt: a new start
    await prompt("go on", "u1");
    await until(() => state().auto[key].turns === 1);
    assert.equal((await stop())?.decision, "block", "after the user's prompt the same changes stop the turn again");
    // a review waiting for someone to join with its code doesn't hold the check back
    const unjoined = await call("link_create", { primary: W, request: "waiting for a code" });
    fs.writeFileSync(path.join(work, "a.js"), "6\n");
    assert.equal((await stop())?.decision, "block", "an unjoined review doesn't count as waiting");
    await call("link_close", { linkId: unjoined.id });
    // the rules again when the chat starts again
    const start = JSON.parse((await runHook("openai", "start", { session_id: W.id, source: "compact" })).out).hookSpecificOutput;
    assert.equal(start.hookEventName, "SessionStart");
    assert.match(start.additionalContext, /Get its approval at the moments that matter, not at every small step/);
    // its Claude reviewer keeps listening between reviews (the review's link is closed)
    await call("auto_set", { endpoint: W, on: true, reviewer: R });
    assert.equal(state().links[r.id].active, false);
    const file = path.join(dir, "listeners", "claude-claude-reviewer-37.json");
    const listener = runHook("claude", "listen", { session_id: R.id }, { killAfter: 9000 });
    await until(() => fs.existsSync(file));
    await sleep(1500);
    assert.ok(fs.existsSync(file), "still listening between reviews");
    await call("auto_set", { endpoint: W, on: false });
    const done = await listener;
    assert.equal(done.code, 0, "auto mode off: it stops listening on its own");
    assert.equal((await runHook("openai", "start", { session_id: W.id, source: "resume" })).out, "", "auto mode off: nothing at session start");
    console.log("37 auto mode from ChatGPT: the turn check once per set of changes (continued turns too, bounded even if its words were taken for the user's), deliveries and the check's own words aren't user prompts, an unjoined review doesn't hold it back, rules at session start, its Claude reviewer listens until auto mode is off");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 38. auto mode reviewing every turn, Claude working with a ChatGPT reviewer:
// every turn that ends is reviewed on its own (a user turn, a fix turn, a turn
// the app's own notice started), put together later by the broker from what
// the Stop hook wrote down; the Stop check doesn't stop the turn; only a
// review that requests changes wakes the chat, the rest comes with the next
// prompt; a fix turn's review is the next round; the cap stops the loop until
// the user writes; the agent's own review of exactly the turn's end counts,
// a plan review doesn't; the chat keeps listening between reviews
{
  const { execFileSync } = await import("node:child_process");
  const { fingerprint } = await import("../src/git.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-every-"));
  try {
    const g = (...a) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    fs.writeFileSync(path.join(work, "a.js"), "1\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const head = g("rev-parse", "HEAD").trim();
    const C = { app: "claude", id: "claude-every-38" };
    const G = { app: "openai", id: "gpt-every-38" };
    const key = `claude:${C.id}`;
    const entry = () => state().auto[key];
    await call("auto_set", { endpoint: C, on: true, everyTurn: true, reviewer: G, paths: [{ path: work, fp: fingerprint(work).hash, head }] });
    let turn = 0;
    const prompt = (p) => runHook("claude", "prompt", { session_id: C.id, cwd: work, prompt: p, prompt_id: `t${++turn}` });
    const stop = (last) => runHook("claude", "stop", { session_id: C.id, cwd: work, prompt_id: `t${turn}`, last_assistant_message: last });
    const reviewOf = (n) => until(() => state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, G) && state().links[m.linkId]?.everyTurn)[n], 15000);
    const answer = (m, decision, extra = {}) => call("advise", { endpoint: G, requestId: m.id, decision, ...(decision === "changes_requested" && { blocking: [{ title: "Handle the empty case." }] }), ...extra });
    const toC = (kind) => state().messages.filter((m) => sameTo(m.toEndpoint, C) && m.kind === kind);
    const notesFor = () => state().notes.filter((n) => sameTo(n.to, C) && !n.deliveredAt);
    // a user turn: reviewed on its own, the Stop hook doesn't stop it
    await prompt("Make a.js print 2.");
    fs.writeFileSync(path.join(work, "a.js"), "2\n");
    fs.writeFileSync(path.join(work, "new.txt"), "x\n");
    const s1 = await stop("a.js prints 2 now.");
    assert.equal(s1.out, "", "every turn reviewed on its own: the Stop check doesn't stop it");
    const r1 = await reviewOf(0);
    assert.match(r1.text, /^Automatic review of a turn of Claude Code session claude-every-38 \(turn t1\), sent by the bridge/);
    assert.match(r1.text, /User's message:\nMake a\.js print 2\./);
    assert.match(r1.text, /Agent's final message:\na\.js prints 2 now\./);
    assert.match(r1.text, /The turn's own changes, from its start to its end:\n```diff\na\.js \| 2 \+-[\s\S]*New untracked files:\nnew\.txt[\s\S]*-1\n\+2/);
    assert.match(r1.text, /This is auto mode's review of one turn/);
    assert.match(r1.text, /Where the changes are/);
    // the turn's own changes stay what they were at its end
    fs.writeFileSync(path.join(work, "a.js"), "2\n");
    // approved: silent, and the content recorded
    await answer(r1, "approved");
    assert.equal(toC("review-result").length, 0, "an approval wakes no one");
    assert.equal(entry().paths[work].approved, state().links[r1.linkId].reqPaths[0].fp, "the approval covers what was sent");
    // the chat keeps listening between reviews
    const file = path.join(dir, "listeners", `claude-${C.id}.json`);
    const listener = runHook("claude", "listen", { session_id: C.id }, { killAfter: 2500 });
    await until(() => fs.existsSync(file));
    // changes requested: the chat is woken, told its next turn is reviewed on its own
    await prompt("Handle empty input too.");
    fs.writeFileSync(path.join(work, "a.js"), "3\n");
    await stop("Done.");
    const r2 = await reviewOf(1);
    await answer(r2, "changes_requested");
    const woke = await listener;
    assert.equal(woke.code, 2, "a review that requests changes wakes the chat");
    assert.match(woke.err, /The review of your last turn: m\d+[\s\S]*Your next turn is reviewed on its own: don't ask for a review yourself/);
    // the fix turn (started by that wake, not by the user): the next round,
    // with the reviewer's last answer
    const genBefore = entry().generation;
    await prompt("<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>\n</task-notification>");
    fs.writeFileSync(path.join(work, "a.js"), "4\n");
    await stop("Handled the empty case.");
    const r3 = await reviewOf(2);
    assert.equal(entry().generation, genBefore, "a notice isn't the user's prompt");
    assert.match(r3.text, new RegExp(`Round 2 of review ${r2.linkId}: this turn answers your changes requested in ${r2.linkId}`));
    assert.match(r3.text, /Your answer to the previous round[\s\S]*Handle the empty case\./);
    assert.match(r3.text, /User's message:\n\(None: this turn answers your previous review's changes requested\.\)/);
    assert.equal(state().links[r3.linkId].roundOf, r2.linkId);
    // the approval that ends the loop comes with the next prompt, no wake
    await answer(r3, "approved", { nits: [{ title: "Name it better." }] });
    assert.equal(toC("review-result").length, 1, "still only the one wake");
    const ctx = JSON.parse((await prompt("Next: tidy up.")).out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /From your reviewer, about earlier turns[\s\S]*approved the fix[\s\S]*Name it better\./);
    assert.match(ctx, /Auto mode is on, reviewing every turn/);
    assert.doesNotMatch(ctx, /you haven't consulted the reviewer/, "no reminder in every-turn mode");
    // a late answer (the user wrote again meanwhile) is a note, no wake
    fs.writeFileSync(path.join(work, "a.js"), "5\n");
    await stop("Tidied.");
    const r4 = await reviewOf(3);
    const gen = entry().generation;
    await prompt("And one more thing.");
    await until(() => entry().generation === gen + 1); // the broker has the prompt
    await answer(r4, "changes_requested");
    assert.equal(toC("review-result").length, 1, "a late answer wakes no one");
    assert.ok(notesFor().some((n) => n.kind === "review" && /On an earlier turn, before your latest prompt/.test(n.text)));
    // a turn the app's own notice started is reviewed too
    await stop("Answered.");
    await reviewOf(4);
    await prompt("<task-notification>\n<task-id>build-1</task-id>\n<status>completed</status>\n</task-notification>");
    fs.writeFileSync(path.join(work, "a.js"), "6\n");
    await stop("Fixed the build.");
    const r6 = await reviewOf(5);
    assert.match(r6.text, /User's message:\n\(None: the app or a bridge message started this turn, not the user\.\)/);
    for (const m of state().messages.filter((x) => x.kind === "review-request" && sameTo(x.toEndpoint, G) && !x.answeredAt && state().links[x.linkId]?.active)) await answer(m, "approved");
    // the agent's own code review of exactly the turn's end: no second review;
    // after a plan review the turn is reviewed
    await prompt("Rename it.");
    fs.writeFileSync(path.join(work, "a.js"), "7\n");
    const own = await call("link_create", { primary: C, advisor: G, request: "my own", reqPaths: [{ path: work, fp: fingerprint(work).hash, head }] });
    const before = state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, G)).length;
    await stop("Renamed.");
    await until(() => events().some((e) => e.op === "turn_covered"), 15000);
    assert.equal(state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, G)).length, before, "covered by the agent's own review");
    await answer(state().messages.find((m) => m.linkId === own.id && m.kind === "review-request"), "approved");
    await prompt("Plan the next part.");
    await call("link_create", { primary: C, advisor: G, request: "a plan", plan: true, reqPaths: [{ path: work, fp: fingerprint(work).hash, head }] });
    fs.writeFileSync(path.join(work, "a.js"), "8\n");
    await stop("Planned and started.");
    const r8 = await reviewOf(6);
    assert.match(r8.text, /User's message:\nPlan the next part\./, "a plan review doesn't count for the code");
    // the cap: rounds in a row without approval stop the loop until the user writes
    process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS = "2";
    try {
      await answer(state().messages.find((m) => m.kind === "review-request" && m.linkId !== r8.linkId && !m.answeredAt && sameTo(m.toEndpoint, G) && state().links[m.linkId]?.active) ?? r8, "approved").catch(() => {});
      await prompt("Try the hard part.");
      fs.writeFileSync(path.join(work, "a.js"), "9\n");
      await stop("Tried.");
      const c1 = await reviewOf(7);
      await answer(c1, "changes_requested");
      await prompt("<task-notification>\n<task-id>w2</task-id>\n</task-notification>");
      fs.writeFileSync(path.join(work, "a.js"), "10\n");
      await stop("Fixed once.");
      const c2 = await reviewOf(8);
      await answer(c2, "changes_requested");
      assert.equal(toC("stop").length, 1, "the cap stops the loop");
      assert.equal(entry().stopped, true);
      const n = state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, G)).length;
      await stop("Stopped, asking the user.");
      await sleep(1500);
      assert.equal(state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, G)).length, n, "not reviewed while stopped");
      await prompt("Go on, differently.");
      await until(() => entry().stopped === false); // the user's prompt lifts the stop
      // a turn the bridge's wake starts with no prompt hook in between starts
      // where the last one ended: its own changes are still there
      fs.writeFileSync(path.join(work, "a.js"), "11\n");
      await stop("Went on.");
      await reviewOf(9);
      fs.writeFileSync(path.join(work, "a.js"), "12\n");
      await stop("Woken, no prompt hook.");
      const woken = await reviewOf(10);
      assert.match(woken.text, /The turn's own changes, from its start to its end:[\s\S]*-11\n\+12/);
      assert.doesNotMatch(woken.text, /-10\n/, "only this turn's own change");
    } finally {
      delete process.env.AGENT_REVIEW_BRIDGE_MAX_ROUNDS;
    }
    await call("auto_set", { endpoint: C, on: false });
    console.log("38 every turn, Claude working: turns reviewed on their own (user, fix, app notice), no Stop check, silent approvals, a woken fix loop with rounds, late answers and loop ends as notes, the agent's own exact review counts and a plan review doesn't, the cap, listening between reviews");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 39. auto mode reviewing every turn, ChatGPT working with a Claude reviewer:
// turns wait until a Claude chat joins with auto mode's code, then go to it;
// the chat's own folder is used when none is tracked; the bridge's deliveries
// run as prompts and aren't the user's, so a fix turn is the next round; the
// Stop hook doesn't stop the turn; a Claude reviewer's failure or approval
// wait reaches the working chat as a note, not a wake
{
  const { execFileSync } = await import("node:child_process");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-every-gpt-"));
  try {
    const g = (...a) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    g("init", "-q");
    fs.writeFileSync(path.join(work, "b.js"), "1\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const W = { app: "openai", id: "gpt-every-39" };
    const R = { app: "claude", id: "claude-reviewer-39" };
    const key = `openai:${W.id}`;
    const entry = () => state().auto[key];
    await call("auto_set", { endpoint: W, on: true, everyTurn: true }); // no folder known yet
    let turn = 0;
    const prompt = (p) => runHook("openai", "prompt", { session_id: W.id, cwd: work, prompt: p, turn_id: `u${++turn}` });
    const stop = (last) => runHook("openai", "stop", { session_id: W.id, cwd: work, turn_id: `u${turn}`, last_assistant_message: last });
    const reviewOf = (n) => until(() => state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && state().links[m.linkId]?.everyTurn && !state().links[m.linkId].request)[n], 15000);
    const notesFor = () => state().notes.filter((n) => sameTo(n.to, W) && !n.deliveredAt);
    // no reviewer yet: the turn waits, and the chat hears why with its next prompt
    await prompt("Make b.js print 2.");
    fs.writeFileSync(path.join(work, "b.js"), "2\n");
    assert.equal((await stop("b.js prints 2.")).out, "", "the Stop hook doesn't stop the turn");
    await until(() => notesFor().some((n) => /has no reviewer yet, so the reviews of your turns wait/.test(n.text)), 8000);
    assert.equal(entry().jobs.length, 1, "the turn waits for a reviewer");
    // a Claude chat joins with auto mode's code: it becomes the reviewer, and the turn goes to it
    const bind = await call("link_create", { primary: W, request: "Bind me.", autoReviewer: true, everyTurn: true });
    assert.equal((await call("link_join", { code: bind.joinCode, endpoint: R })).autoReviewer, true);
    const bindReq = state().messages.find((m) => m.linkId === bind.id && m.kind === "review-request");
    await call("receive", { side: "claude", endpoint: R });
    // whatever the reviewer answers to the request that only binds it
    await call("advise", { endpoint: R, requestId: bindReq.id, decision: "changes_requested", blocking: [{ title: "Nothing to bind?" }] });
    const r1 = await until(() => state().messages.find((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && m.linkId !== bind.id), 15000);
    assert.match(r1.text, /^Automatic review of a turn of ChatGPT chat gpt-every-39 \(turn u1\)/);
    assert.match(r1.text, /User's message:\nMake b\.js print 2\./);
    assert.ok(work in entry().paths || fs.realpathSync(work) in entry().paths, "the chat's own folder is used and tracked");
    assert.equal(state().messages.filter((m) => sameTo(m.toEndpoint, W) && m.kind === "review-result").length, 0, "the binding review's answer wakes no one");
    assert.equal(entry().chain ?? null, null, "nor starts a fix loop");
    // changes requested: delivered to the ChatGPT chat as a prompt, which isn't
    // the user's, so the turn it starts is the fix turn
    await call("receive", { side: "claude", endpoint: R });
    await call("advise", { endpoint: R, requestId: r1.id, decision: "changes_requested", blocking: [{ title: "Print 3." }] });
    const result = await until(() => state().messages.find((m) => sameTo(m.toEndpoint, W) && m.kind === "review-result" && m.dispatch?.state === "sent"));
    const gen = entry().generation;
    await prompt(inlineText(result));
    fs.writeFileSync(path.join(work, "b.js"), "3\n");
    await stop("Prints 3.");
    const r2 = await until(() => state().messages.find((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && state().links[m.linkId]?.roundOf === r1.linkId), 15000);
    assert.equal(entry().generation, gen, "a delivery isn't the user's prompt");
    assert.match(r2.text, new RegExp(`Round 2 of review ${r1.linkId}`));
    // the reviewer fails (an API error ends its turn): a note, not a wake
    process.env.AGENT_REVIEW_BRIDGE_TEST_RETRY_MS = "200"; // a short wait before it's sent again
    await call("wake_ack", { ids: [r2.id], at: Date.now() });
    await runHook("claude", "stopfail", { session_id: R.id, error: "rate_limit" });
    await until(() => notesFor().some((n) => /can't answer .*rate_limit[\s\S]*it is sent again once the reviewer can answer/.test(n.text)));
    assert.equal(state().messages.filter((m) => sameTo(m.toEndpoint, W) && m.kind === "failed").length, 0, "no failure wake");
    // sent again to the same reviewer, which gets it once it listens again
    const retry = await until(() => state().messages.find((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && state().links[m.linkId]?.retry), 15000);
    assert.match(retry.text, new RegExp(`Retry of round 2 of review ${r1.linkId}: the previous attempt \\(${r2.linkId}\\) got no answer`));
    await call("receive", { side: "claude", endpoint: R });
    await call("advise", { endpoint: R, requestId: retry.id, decision: "approved" });
    // a tool approval the reviewer waits on: a note too
    await prompt("Go on.");
    fs.writeFileSync(path.join(work, "b.js"), "4\n");
    await stop("Went on.");
    const r3 = await until(() => state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && state().links[m.linkId]?.everyTurn && state().links[m.linkId].active).at(-1), 15000);
    await call("wake_ack", { ids: [r3.id], at: Date.now() });
    await runHook("claude", "permission", { session_id: R.id, message: "Claude needs your permission to use Bash" });
    await until(() => notesFor().some((n) => /waiting for the user to approve a tool/.test(n.text)));
    assert.equal(state().messages.filter((m) => sameTo(m.toEndpoint, W) && m.kind === "waiting").length, 0, "no waiting wake");
    // the reviewer has every-turn auto mode too, reviewed by this chat: the
    // turn it spends answering a review isn't reviewed, so they don't go round
    await call("auto_set", { endpoint: R, on: true, everyTurn: true, reviewer: W });
    await sleep(20);
    await call("receive", { side: "claude", endpoint: R });
    await call("advise", { endpoint: R, requestId: r3.id, decision: "approved" });
    assert.ok(!notesFor().some((n) => /waiting for the user to approve a tool/.test(n.text)), "the waiting note goes once the answer is in");
    await runHook("claude", "stop", { session_id: R.id, cwd: work, last_assistant_message: "Reviewed it." });
    await until(() => events().some((e) => e.op === "turn_not_reviewed" && e.endpoint?.id === R.id && e.why === "answered a review"));
    assert.equal((state().auto[`claude:${R.id}`].jobs ?? []).length, 0);
    await call("auto_set", { endpoint: R, on: false });
    // a plain message on an open review's link that gets no answer: a note,
    // and the review isn't sent a second time
    await prompt("One more.");
    fs.writeFileSync(path.join(work, "b.js"), "5\n");
    await stop("One more done.");
    const r4 = await until(() => state().messages.find((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && /One more done\./.test(m.text)), 15000);
    const msg = await call("send", { endpoint: W, text: "Also check b.js.", linkId: r4.linkId });
    await call("wake_ack", { ids: [msg.id], at: Date.now() });
    const retries = () => state().messages.filter((m) => m.kind === "review-request" && sameTo(m.toEndpoint, R) && state().links[m.linkId]?.retry).length;
    const before = retries();
    await runHook("claude", "stopfail", { session_id: R.id, error: "rate_limit" });
    await until(() => notesFor().some((n) => new RegExp(`can't answer ${msg.id}`).test(n.text)));
    await sleep(500);
    assert.equal(retries(), before, "no second review for a message that failed");
    assert.equal(state().links[r4.linkId].active, true, "the review stays open");
    assert.ok(!notesFor().some((n) => new RegExp(`can't answer ${msg.id}[\\s\\S]*one of your turns`).test(n.text)), "told as a message, not a turn");
    await call("receive", { side: "claude", endpoint: R });
    await call("advise", { endpoint: R, requestId: r4.id, decision: "approved" });
    await call("auto_set", { endpoint: W, on: false });
    console.log("39 every turn, ChatGPT working: turns wait for the joined Claude reviewer, then go to it; the chat's folder used; deliveries aren't user prompts, so a fix turn is the next round; no Stop check; the reviewer's failure and approval wait come as notes");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 40. auto mode at key moments, from ChatGPT: while its first review waits
// for a chat to join with the code, the Stop check says to remind the user of
// that code instead of asking for another review (once per code); the user's
// prompt clears what the check stopped a continued turn for
{
  const { fingerprint } = await import("../src/git.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-joinwait-"));
  try {
    fs.writeFileSync(path.join(work, "c.txt"), "1");
    const W = { app: "openai", id: "gpt-joinwait-40" };
    await call("auto_set", { endpoint: W, on: true, paths: [{ path: work, fp: fingerprint(work).hash, head: null }] });
    const first = await call("link_create", { primary: W, request: "first", autoReviewer: true });
    fs.writeFileSync(path.join(work, "c.txt"), "2");
    const stop = async (extra = {}) => {
      const r = await runHook("openai", "stop", { session_id: W.id, cwd: work, ...extra });
      return r.out ? JSON.parse(r.out) : null;
    };
    const b = await stop();
    assert.match(b?.reason ?? "", new RegExp(`review ${first.id} is waiting for a chat in the other app to join with its code ${first.joinCode}\\. Remind the user to paste it there`));
    assert.doesNotMatch(b.reason, /Ask for a review \(bridge_review\)/);
    assert.equal(await stop({ stop_hook_active: true }), null, "once per code");
    // the user's prompt clears the record of the continued turn too
    const chain = path.join(dir, "turns", `openai-${W.id}.auto-chain.json`);
    assert.ok(fs.existsSync(chain));
    await runHook("openai", "prompt", { session_id: W.id, cwd: work, prompt: "ok, I pasted it", turn_id: "j1" });
    assert.ok(!fs.existsSync(chain), "a user prompt clears it");
    await call("link_close", { linkId: first.id });
    await call("auto_set", { endpoint: W, on: false });
    console.log("40 key moments from ChatGPT: a waiting join code is recalled once instead of asking again; a user prompt clears the continued turn's record");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 41. state from before advisor mode was removed: when an owner loads it,
// the advisor links close, each primary is told once, and what of theirs
// hasn't reached its chat is never sent nor woken (either direction, at any
// delivery stage); plain messages, one-off and every-turn reviews go as
// before; one already handed over can't be taken back, and its answer is
// refused; loaded again, nothing more happens
{
  const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-retire-"));
  try {
    const C1 = { app: "claude", id: "claude-advised" };
    const G1 = { app: "openai", id: "gpt-advisor" };
    const G2 = { app: "openai", id: "gpt-advised" };
    const C2 = { app: "claude", id: "claude-advisor" };
    const G3 = { app: "openai", id: "gpt-one-off" };
    const C3 = { app: "claude", id: "claude-every" };
    const G4 = { app: "openai", id: "gpt-every" };
    const old = Date.now() - 10 * 60_000;
    let n = 0;
    const msg = (to, kind, linkId, extra) => ({ id: `m${++n}`, from: to.app === "openai" ? "claude" : "openai", to: to.app, toEndpoint: to, kind, linkId, text: `${kind} ${n}`, ts: old, readAt: null, ...extra });
    const messages = [
      // C1's advisor G1: turns' reviews at every delivery stage
      msg(G1, "review-request", "L1"), // m1: not sent yet
      msg(G1, "review-request", "L1", { dispatch: { state: "sending", at: old } }),
      msg(G1, "review-request", "L1", { dispatch: { state: "checking", at: old, clientId: "c-3" } }),
      msg(G1, "review-request", "L1", { dispatch: { state: "resend", at: old, clientId: "c-4" } }),
      msg(G1, "review-request", "L1", { dispatch: { state: "unconfirmed", at: old, clientId: "c-5", error: "x" } }),
      msg(G1, "review-request", "L1", { dispatch: { state: "error", at: old, error: "x" } }),
      msg(G1, "review-request", "L1", { dispatch: { state: "sent", at: old }, readAt: old }), // m7: already in the thread
      msg(C1, "advisory", "L1"),
      msg(C1, "stop", "L1"),
      msg(G1, "message", "L1", { fromEndpoint: C1 }), // m10: a plain message
      // G2's advisor C2
      msg(C2, "review-request", "L2"),
      msg(G2, "advisory", "L2"),
      msg(G2, "stop", "L2", { dispatch: { state: "sending", at: old } }),
      // a one-off review and an every-turn one
      msg(G3, "review-request", "L3"), // m14
      msg(G4, "review-request", "L4"), // m15
    ];
    fs.writeFileSync(
      path.join(dir7, "state.json"),
      JSON.stringify({
        seq: 100, linkSeq: 4, auto: {}, messages,
        notes: [
          { id: "n1", linkId: "L1", to: C1, kind: "bridge", key: "L1:advisor-offline", text: "Your advisor isn't listening.", at: old, deliveredAt: null },
          { id: "n2", linkId: "L1", to: C1, kind: "advice", text: "Rename the helper.", at: old, deliveredAt: null },
          { id: "n3", linkId: "L3", to: C1, kind: "bridge", key: "L3:delivery:review-request", text: "A one-off review's note.", at: old, deliveredAt: null },
        ],
        links: {
          L1: { id: "L1", mode: "advisor", active: true, createdAt: old, primary: C1, advisor: G1, reviews: 7, advisories: [], generation: 3, lastPrompt: { turnId: "t", text: "x", at: old } },
          L2: { id: "L2", mode: "advisor", active: true, createdAt: old, primary: G2, advisor: C2, reviews: 1, advisories: [], generation: 1 },
          L3: { id: "L3", mode: "review", active: true, createdAt: old, primary: C1, advisor: G3, advisories: [], round: 1 },
          L4: { id: "L4", mode: "review", everyTurn: true, active: true, createdAt: old, primary: C3, advisor: G4, advisories: [], round: 1, generation: 0 },
        },
      }),
    );
    const env7 = { ...process.env, AGENT_REVIEW_BRIDGE_DIR: dir7, AGENT_REVIEW_BRIDGE_PORT: "7492", AGENT_REVIEW_BRIDGE_FAKE_CODEX: "1" };
    const st7 = () => JSON.parse(fs.readFileSync(path.join(dir7, "state.json"), "utf8"));
    const ev7 = () => fs.readFileSync(path.join(dir7, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const delivered = () => ev7().filter((e) => e.op === "fake-codex-deliver");
    const hook7 = (app, event, input, killAfter) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [hook, "--app", app, "--event", event], { env: env7 });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        if (killAfter) setTimeout(() => p.kill(), killAfter);
        p.on("close", (code) => resolve({ code, out }));
        p.stdin.end(JSON.stringify({ hook_event_name: event, cwd: dir7, ...input }));
      });
    // before any owner has taken the state: the hooks pass over what advisor
    // mode left (no wake with it, no stale status note)
    for (const C of [C1, C2]) assert.notEqual((await hook7("claude", "listen", { session_id: C.id }, 1500)).code, 2, `${C.id} isn't woken with an advisor leftover`);
    const before = JSON.parse((await hook7("claude", "prompt", { session_id: C1.id, prompt: "hi" })).out).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(before, /Your advisor isn't listening/, "an advisor link's status note isn't shown");
    assert.match(before, /Rename the helper/, "the advisor's own note is");
    // an owner takes the state, sends what it sends, runs `script`, and goes
    const load = (script = "") =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");${script}await new Promise((r)=>setTimeout(r,1500));process.exit(0);`], { env: env7 });
        let o = "";
        p.stdout.on("data", (d) => (o += d));
        p.on("close", () => resolve(o));
      });
    const out = await load(`try{await b.call("advise",{endpoint:${JSON.stringify(G1)},requestId:"m7",decision:"approved"});console.log("answered")}catch(e){console.log(e.message)}`);
    const s1 = st7();
    assert.equal(s1.links.L1.active, false, "an advisor link is closed");
    assert.equal(s1.links.L2.active, false);
    assert.equal(s1.links.L1.lastPrompt, undefined, "and keeps no question");
    assert.equal(s1.links.L3.active, true, "a one-off review isn't");
    assert.equal(s1.links.L4.active, true, "nor an every-turn one");
    const told = (e) => s1.notes.filter((x) => sameTo(x.to, e) && /advisor link L\d was closed: advisor mode has been removed/.test(x.text));
    assert.equal(told(C1).length, 1, "the primary is told once");
    assert.equal(told(G2).length, 1);
    assert.match(told(C1)[0].text, /bridge_auto with on and every_turn/);
    assert.ok(!s1.notes.some((x) => x.id === "n1"), "an advisor link's status note no longer holds");
    assert.ok(s1.notes.some((x) => x.id === "n2"), "the advisor's own note stays (shown above)");
    assert.ok(s1.notes.some((x) => x.id === "n3"), "a one-off review's note stays");
    const byId = Object.fromEntries(s1.messages.map((m) => [m.id, m]));
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6", "m8", "m9", "m11", "m12", "m13"]) {
      assert.equal(byId[id].dropped, "advisor mode removed", `${id} taken out of delivery`);
      assert.ok(byId[id].readAt, `${id} counts as read: no wake`);
    }
    assert.equal(byId.m7.dropped, undefined, "one already in the thread can't be taken back");
    assert.match(out, /review request m7 belongs to a closed link/, "and its answer is refused");
    const sentTo = (who) => delivered().filter((e) => e.threadId === who.id).map((e) => e.text);
    assert.equal(sentTo(G1).length, 1, "the advisor thread gets only the plain message");
    assert.match(sentTo(G1)[0], /Message m10 \(link L1\)/);
    assert.equal(sentTo(G2).length, 0, "the advised ChatGPT chat gets nothing");
    assert.equal(sentTo(G3).length, 1, "a one-off review goes as before");
    assert.equal(sentTo(G4).length, 1, "and an every-turn one");
    const { pendingFor } = await import("../src/broker.mjs");
    assert.deepEqual(pendingFor(s1, C1), [], "nothing wakes the advised Claude chat");
    assert.deepEqual(pendingFor(s1, C2), [], "nor the Claude advisor");
    // loaded again: nothing more
    const notes = s1.notes.length;
    const sends = delivered().length;
    await load();
    assert.equal(st7().notes.length, notes, "no second note");
    assert.equal(delivered().length, sends, "nothing sent again");
    assert.equal(ev7().filter((e) => e.op === "advisor-retired").length, 1, "retired once");
    console.log("41 advisor mode's old state: links closed, each primary told once, nothing of theirs that hadn't reached its chat sent or woken (either direction, any delivery stage); plain messages, one-off and every-turn reviews go on; a handed-over one's answer refused; a second load changes nothing");
  } finally {
    fs.rmSync(dir7, { recursive: true, force: true });
  }
}

console.log("\nhooks log:\n" + fs.readFileSync(path.join(dir, "hooks.jsonl"), "utf8"));
process.exit(0);
