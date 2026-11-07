// bridge_read_chat's view of a Claude Code session, checked against an oracle: a
// few dozen lines that load a whole transcript and work out by brute force what
// should be shown, sharing no code with src/chatindex.mjs. Seeded random
// transcripts (forks, rewinds, compactions, parallel calls, repeats, broken links)
// must give exactly the oracle's messages, tool outcomes and counts, read in one
// page or many, for a range of page sizes and read budgets. The oracle states the
// same rules another way, so it can share a mistaken rule with the code: the named
// cases below say the answer outright.
//
//   node scripts/test-chat-graph.mjs [seeds]   (default 300)

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-graph-"));
process.env.CLAUDE_CONFIG_DIR = root;
const { readClaudePage } = await import("../src/chats.mjs");
const { TopFields, MALFORMED, MAX_RECORD, clearIndexMemo, memoStats, openIndex } = await import("../src/chatindex.mjs");
const rc = await import("../src/readchat.mjs");

const dir = path.join(root, "projects", "key");
fs.mkdirSync(dir, { recursive: true });
let seq = 0;
const write = (lines) => {
  const id = `g${++seq}`;
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return { id, file, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs };
};

// ------------------------------------------------------------------ the oracle

const OTHER = "messages on a branch that was rewound or left";
const LABEL = { user: "### User", final: "### Assistant", unfinished: "### Assistant (the turn didn't finish)", interim: "### Assistant (between steps)", tool: "### Tool steps" };

// lines: what's in the file, parsed where it can be. Returns the messages, oldest
// first, with their rendered form, and the totals of what is left out.
function oracle(lines) {
  const left = {};
  const count = (why, n = 1) => n && (left[why] = (left[why] ?? 0) + n);
  // every copy but the newest of a uuid doesn't exist
  const parsed = lines.map((l, at) => (typeof l === "string" ? { bad: true, at } : { ...l, at }));
  count("unreadable records", parsed.filter((r) => r.bad).length);
  const newest = new Map();
  for (const r of parsed) if (r.uuid) newest.set(r.uuid, r);
  const all = [...newest.values()].sort((a, b) => a.at - b.at);
  const subagent = all.filter((r) => r.isSidechain);
  count("subagent records", subagent.length);
  const main = all.filter((r) => !r.isSidechain);
  const get = (u) => main.find((r) => r.uuid === u);
  const back = (r) => {
    if (r.parentUuid === null && r.type === "system" && r.subtype === "compact_boundary") return (typeof r.logicalParentUuid === "string" && get(r.logicalParentUuid)) || "break";
    if (r.parentUuid === null) return null;
    return get(r.parentUuid) ?? "break";
  };
  const isConv = (r) => r.type === "user" || r.type === "assistant";
  const leafOf = (r) => {
    const seen = new Set();
    for (let c = r; c && c !== "break" && !seen.has(c); c = back(c)) {
      seen.add(c);
      if (isConv(c) && !c.isMeta) return c;
    }
    return null;
  };
  const isParent = (r) => main.some((x) => x.parentUuid === r.uuid || (x.parentUuid === null && x.subtype === "compact_boundary" && x.logicalParentUuid === r.uuid));
  const leaves = main.filter((r) => !isParent(r)).map(leafOf).filter(Boolean);
  const leaf = leaves.sort((a, b) => b.at - a.at)[0] ?? null;

  // the straight line
  const line = [];
  let broke = !leaf;
  for (let c = leaf; c; ) {
    line.push(c);
    const b = back(c);
    if (b === "break" || (b && line.includes(b))) {
      broke = true;
      break;
    }
    c = b;
  }
  const lineSet = new Set(line);
  const msgs = new Set(line.filter((r) => r.message?.id && r.type === "assistant").map((r) => r.message.id));
  const queued = (r) => r.type === "attachment" && r.attachment?.type === "queued_command" && r.attachment.origin?.kind === "human" && r.attachment.prompt;
  const ownerOf = new Map();
  for (const r of main) if (r.type === "assistant") for (const b of r.message.content) if (b.type === "tool_use") ownerOf.set(b.id, ownerOf.has(b.id) && ownerOf.get(b.id) !== r.message.id ? null : r.message.id);
  const results = (r) => (r.type === "user" && Array.isArray(r.message?.content) ? r.message.content.filter((b) => b.type === "tool_result") : []);
  // who's on the branch
  const on = new Set(line);
  for (const r of main) {
    if (r.type === "assistant" && msgs.has(r.message.id)) on.add(r);
    if (queued(r) && !lineSet.has(r) && leaf && leafOf(r) === leaf) on.add(r);
    if (results(r).length) {
      const owner = [get(r.parentUuid)?.message?.id, ...results(r).map((b) => ownerOf.get(b.tool_use_id))].some((m) => m && msgs.has(m));
      if (owner) on.add(r);
    }
  }
  const low = line.length ? Math.min(...line.map((r) => r.at)) : Infinity;
  const region = new Set();
  if (broke) for (const r of main) if (r.at < low && !on.has(r) && (isConv(r) || queued(r))) region.add(r);

  // what each shows
  const isHuman = (r) => {
    if (r.type !== "user" || r.isCompactSummary || r.isMeta) return false;
    const c = r.message?.content;
    return typeof c === "string" ? c.trim() !== "" : c.some((b) => b.type === "text" && b.text.trim());
  };
  const isNotice = (r) => r.type === "user" && r.isMeta;
  const hasText = (r) => r.type === "assistant" && r.message.content.some((b) => b.type === "text" && b.text.trim());
  const hasUse = (r) => r.type === "assistant" && r.message.content.some((b) => b.type === "tool_use");
  const thinks = (r) => r.type === "assistant" && r.message.content.some((b) => b.type === "thinking");

  // the order: the line newest first, what the user typed after it first of all
  const trailing = main.filter((r) => queued(r) && on.has(r) && !lineSet.has(r)).reverse();
  const order = [...trailing];
  const placed = new Set();
  for (const r of line) {
    if (r.type === "assistant" && !placed.has(r.message.id)) {
      placed.add(r.message.id);
      order.push({ msg: r.message.id });
    } else if (r.type !== "assistant") order.push(r);
  }
  for (const r of [...region].sort((a, b) => b.at - a.at)) {
    if (r.type === "assistant") {
      if (!placed.has(r.message.id)) {
        placed.add(r.message.id);
        order.push({ msg: r.message.id, region: true });
      }
    } else order.push(Object.assign(Object.create(null), { rec: r, region: true }));
  }

  const unitsNewestFirst = [];
  for (const o of order) {
    const r = o.rec ?? o;
    if (o.msg) {
      const recs = main.filter((x) => x.type === "assistant" && x.message.id === o.msg && (on.has(x) || region.has(x))).sort((a, b) => a.at - b.at);
      if (recs.some(hasText) || recs.some(hasUse)) unitsNewestFirst.push({ recs, region: !!o.region, text: recs.flatMap((x) => x.message.content.filter((b) => b.type === "text" && b.text.trim()).map((b) => b.text)).join("\n"), uses: recs.flatMap((x) => x.message.content.filter((b) => b.type === "tool_use")) });
    } else if (queued(r)) unitsNewestFirst.push({ user: true, mid: true, text: r.attachment.prompt, region: !!o.region });
    else if (isHuman(r)) unitsNewestFirst.push({ user: true, text: typeof r.message.content === "string" ? r.message.content : r.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"), region: !!o.region });
  }

  // kinds
  let textSeen = false;
  let later = false;
  let ranOn = false;
  let any = false;
  for (const u of unitsNewestFirst) {
    if (u.user) {
      ranOn = u.mid ? ranOn || any : false;
      any = textSeen = later = false;
      continue;
    }
    any = true;
    const useHere = u.uses.length > 0;
    if (!u.text) u.kind = "tool";
    else if (textSeen) u.kind = "interim";
    else {
      textSeen = true;
      u.kind = !useHere && !later ? "final" : ranOn ? "interim" : "unfinished";
    }
    if (useHere) later = true;
  }

  // outcomes: a result on the line decides; others only if they agree
  const verdict = (id) => {
    const onLine = line.flatMap((r) => results(r)).filter((b) => b.tool_use_id === id);
    if (onLine.length) return onLine.at(-1).is_error ? "failed" : "done";
    if (ownerOf.get(id) === null) return null;
    const others = new Set(main.filter((r) => !lineSet.has(r)).flatMap((r) => results(r)).filter((b) => b.tool_use_id === id).map((b) => !!b.is_error));
    return others.size === 0 ? null : others.size > 1 ? "unclear" : others.has(true) ? "failed" : "done";
  };
  const say = { done: "done", failed: "failed", unclear: "outcome unclear: its results conflict", null: "no result seen (an attempt)" };
  for (const u of unitsNewestFirst) if (u.uses) u.tools = u.uses.map((b) => `- ran: ${b.input.command} (${say[verdict(b.id)]})`);

  // left out
  const counted = new Set();
  for (const r of main) {
    const isOn = on.has(r) || region.has(r);
    if (isOn) {
      if (thinks(r)) count("thinking");
      else if (isNotice(r)) count("the app's own notices");
      else if (r.type === "user" && r.isCompactSummary) count("compaction summaries");
    } else if (r.type === "assistant" && r.isApiErrorMessage) count("the app's own notices");
    else if (isHuman(r) || queued(r)) count(OTHER);
    else if ((hasText(r) || hasUse(r)) && !counted.has(r.message.id)) {
      counted.add(r.message.id);
      count(OTHER);
    }
  }
  const visible = (u, tools) => u.user || u.kind === "final" || u.kind === "unfinished" || tools;
  const render = (u, tools) => {
    const label = u.user ? LABEL.user + (u.mid ? " (typed while the turn ran)" : "") : LABEL[u.kind];
    const parts = [label];
    if (u.text) parts.push(u.text);
    if (tools && u.tools?.length) parts.push(...u.tools);
    return parts.join("\n");
  };
  return { units: unitsNewestFirst.reverse(), left, visible, render, broke };
}

// ---------------------------------------------------------------- the generator

function rng(seed) {
  let x = seed * 2654435761 + 1;
  return (n) => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x % n;
  };
}

function generate(seed) {
  const r = rng(seed);
  const lines = [];
  let n = 0;
  const uid = () => `u${seed}-${++n}`;
  let tip = null;
  const anchors = [];
  const push = (rec, move = true) => {
    const full = { uuid: uid(), parentUuid: tip, ...rec };
    lines.push(full);
    if (move) tip = full.uuid;
    anchors.push(full.uuid);
    return full;
  };
  const user = (t) => push({ type: "user", message: { role: "user", content: t } });
  let msg = 0;
  const asst = (id, blocks, move = true, extra = {}) => push({ type: "assistant", message: { id, role: "assistant", content: blocks }, ...extra }, move);
  const use = (id) => ({ type: "tool_use", id, name: "Bash", input: { command: `c-${id}` } });
  const resultRec = (id, parent, err) => ({ uuid: uid(), parentUuid: parent, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: err, content: "x" }] } });
  let tool = 0;
  const turns = 2 + r(9);
  user(`q${seed}-0`);
  for (let t = 0; t < turns; t++) {
    switch (r(14)) {
      case 0: // an answer
      case 1:
        asst(`m${seed}-${++msg}`, [{ type: "text", text: `a${seed}-${msg}` }]);
        break;
      case 2: // text, then a tool, then its result, in one message and another
      case 3: {
        const id = `m${seed}-${++msg}`;
        asst(id, [{ type: "text", text: `t${seed}-${msg}` }]);
        const tid = `t${seed}-${++tool}`;
        const a = asst(id, [use(tid)]);
        if (r(5)) {
          const res = resultRec(tid, a.uuid, r(4) === 0);
          lines.push(res);
          anchors.push(res.uuid);
          tip = res.uuid;
        }
        break;
      }
      case 4: // thinking
        asst(`m${seed}-${++msg}`, [{ type: "thinking", thinking: "hm" }]);
        break;
      case 5: {
        // parallel calls: results fan out, the next turn goes on from any of them
        const id = `m${seed}-${++msg}`;
        const k = 2 + r(3);
        const made = [];
        for (let i = 0; i < k; i++) {
          const tid = `t${seed}-${++tool}`;
          made.push([tid, asst(id, [use(tid)])]);
        }
        const res = made.map(([tid, a]) => resultRec(tid, a.uuid, r(5) === 0));
        const shuffled = res.slice().sort(() => r(3) - 1);
        for (const x of shuffled) {
          lines.push(x);
          anchors.push(x.uuid);
        }
        tip = res[r(k)].uuid;
        break;
      }
      case 6: // a new question
      case 7:
        user(`q${seed}-${t + 1}`);
        break;
      case 8: {
        // a rewind: on from somewhere earlier
        if (anchors.length) tip = anchors[r(anchors.length)];
        user(`rewound${seed}-${t}`);
        break;
      }
      case 9: {
        // compaction
        const before = tip;
        const b = { uuid: uid(), parentUuid: null, logicalParentUuid: before, type: "system", subtype: "compact_boundary" };
        if (r(8) === 0) b.logicalParentUuid = [undefined, null, 5, `gone-${seed}`][r(4)];
        lines.push(b);
        tip = b.uuid;
        push({ type: "user", isCompactSummary: true, message: { role: "user", content: "summary" } });
        break;
      }
      case 10: // the app's own, a subagent, a hook's note, a line that can't be read
        switch (r(4)) {
          case 0:
            push({ type: "user", isMeta: true, message: { role: "user", content: "notice" } });
            break;
          case 1:
            lines.push({ uuid: uid(), parentUuid: tip, isSidechain: true, type: "user", message: { role: "user", content: "side" } });
            break;
          case 2:
            push({ type: "system", subtype: "stop_hook_summary" });
            break;
          default:
            lines.push('{"cut off');
        }
        break;
      case 11: {
        // typed while a turn ran
        push({ type: "attachment", attachment: { type: "queued_command", prompt: `typed${seed}-${t}`, origin: { kind: "human" } } });
        break;
      }
      case 12: {
        // a record written again later: a late copy of an earlier one
        const old = lines.filter((l) => typeof l === "object" && l.uuid);
        if (old.length) lines.push(old[r(old.length)]);
        break;
      }
      default: {
        // a rare link that goes nowhere, or an app error beside the line
        if (r(4) === 0) {
          user(`broken${seed}-${t}`);
          lines.at(-1).parentUuid = `missing-${seed}-${t}`;
        } else {
          const a = asst(`e${seed}-${++msg}`, [{ type: "text", text: "API error" }], false, { isApiErrorMessage: true });
          a.parentUuid = tip;
        }
      }
    }
  }
  return lines;
}

// ----------------------------------------------------------------- comparing

const sessionOf = (w) => ({ id: w.id, file: w.file, size: w.size, mtime: w.mtime });

async function readAll(w, opts) {
  const blocks = [];
  const left = {};
  let resume;
  let uncertain = false;
  let pages = 0;
  for (;;) {
    assert.ok(++pages < 2000, "it ends");
    const r = await readClaudePage(sessionOf(w), { resume, ...opts });
    assert.ok(!r.moved, "nothing changed between pages");
    const onPage = r.page.text ? r.page.text.split(/\n\n(?=### )/) : [];
    blocks.unshift(...onPage);
    for (const [k, v] of Object.entries(r.page.dropped)) if (!/include_tools/.test(k)) left[k] = (left[k] ?? 0) + v;
    uncertain ||= r.page.uncertain;
    if (!r.page.more) return { blocks, left, uncertain };
    assert.ok(r.page.pos, "a page with more has somewhere to go on from");
    resume = r.page.pos;
  }
}

const seeds = Number(process.argv[2] ?? 300);
let totals = { units: 0, rewound: 0, broken: 0, parallel: 0 };
for (let seed = 1; seed <= seeds; seed++) {
  const lines = generate(seed);
  const w = write(lines);
  const o = oracle(lines);
  totals.units += o.units.length;
  if (o.left[OTHER]) totals.rewound++;
  if (o.broke) totals.broken++;
  for (const includeTools of [false, true]) {
    const expected = o.units.filter((u) => o.visible(u, includeTools)).map((u) => o.render(u, includeTools));
    for (const opts of [{ limit: 60 }, { limit: 1 }, { limit: 2 }, { limit: 3 }, { limit: 4 }, { limit: 5 }, { limit: 7 }, { limit: 60, budget: 1 }, { limit: 1, budget: 1 }, { limit: 3, budget: 300 }, { limit: 60, budget: 1000 }]) {
      const got = await readAll(w, { ...opts, includeTools });
      assert.deepEqual(got.blocks, expected, `seed ${seed}, tools ${includeTools}, ${JSON.stringify(opts)}`);
      assert.deepEqual(got.left, o.left, `seed ${seed} counts, tools ${includeTools}, ${JSON.stringify(opts)}`);
      assert.equal(!!got.uncertain, o.units.some((u) => u.region), `seed ${seed}: warned exactly when a page holds uncertain history`);
    }
  }
  if (seed % 50 === 0) clearIndexMemo();
}
console.log(`graph ${seeds} random transcripts, ${totals.units} messages, ${totals.rewound} with rewound branches, ${totals.broken} with broken links: each page size and budget tried gives exactly the oracle's messages, outcomes and counts`);

// ------------------------------------------------------------ the named cases

// so the oracle and the code can't share one mistaken rule: these say the answer
const U = (uuid, parentUuid, t, extra = {}) => ({ uuid, parentUuid, type: "user", message: { role: "user", content: t }, ...extra });
const A = (uuid, parentUuid, id, text, extra = {}) => ({ uuid, parentUuid, type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] }, ...extra });
const T = (uuid, parentUuid, id, tid, cmd = tid) => ({ uuid, parentUuid, type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: cmd } }] } });
const Res = (uuid, parentUuid, tid, err = false) => ({ uuid, parentUuid, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, is_error: err, content: "x" }] } });
const Q = (uuid, parentUuid, prompt) => ({ uuid, parentUuid, type: "attachment", attachment: { type: "queued_command", prompt, origin: { kind: "human" } } });
const Sys = (uuid, parentUuid, subtype = "stop_hook_summary") => ({ uuid, parentUuid, type: "system", subtype });
const Boundary = (uuid, logical) => ({ uuid, parentUuid: null, logicalParentUuid: logical, type: "system", subtype: "compact_boundary" });
const read = async (lines, opts = {}) => {
  const w = write(lines);
  return { w, ...(await readAll(w, { limit: 60, includeTools: false, ...opts })) };
};
const texts = (blocks) => blocks.map((b) => b.split("\n")[1]);

{
  // a late copy of an ancestor isn't the leaf
  let r = await read([U("u", null, "first"), A("a", "u", "ma", "second"), U("b", "a", "third"), A("c", "b", "mc", "fourth"), A("a", "u", "ma", "second")]);
  assert.deepEqual(texts(r.blocks), ["first", "second", "third", "fourth"], "the newest record is a copy of an old one; the branch still ends at fourth");
  // a rewind: only what stands now is shown, and what was left is counted
  r = await read([U("u", null, "keep"), A("a", "u", "ma", "kept answer"), U("x", "a", "left question"), A("y", "x", "my", "left answer"), U("z", "a", "new question"), A("w", "z", "mw", "new answer")]);
  assert.deepEqual(texts(r.blocks), ["keep", "kept answer", "new question", "new answer"]);
  assert.equal(r.left[OTHER], 2, "the question and the answer left behind");
  // repeated records: each message once
  r = await read([U("u", null, "q"), A("a", "u", "ma", "ans"), U("u2", "a", "q2"), U("u2", "a", "q2")]);
  assert.deepEqual(texts(r.blocks), ["q", "ans", "q2"]);
  // parallel calls, the next turn going on from the first, the middle, the last
  for (const via of ["r1", "r2", "r3"]) {
    const lines = [U("u", null, "go"), T("a1", "u", "m", "t1", "one"), T("a2", "a1", "m", "t2", "two"), T("a3", "a2", "m", "t3", "three"), Res("r1", "a1", "t1"), Res("r2", "a2", "t2", true), Res("r3", "a3", "t3"), A("f", via, "mf", "done")];
    const w = await read(lines, { includeTools: true });
    const tool = w.blocks.find((b) => /Tool steps/.test(b));
    assert.deepEqual(tool.split("\n").slice(1), ["- ran: one (done)", "- ran: two (failed)", "- ran: three (done)"], `all calls, in order, with outcomes, via ${via}`);
    assert.ok(!w.left[OTHER], "a parallel call isn't a left branch");
  }
  // a sibling on either side of the record the walk reaches
  r = await read([U("u", null, "go"), A("t", "u", "m", "the text"), T("b", "t", "m", "tb", "before"), T("c", "b", "m", "tc", "after"), Res("rb", "b", "tb"), A("f", "rb", "mf", "end")], { includeTools: true });
  assert.match(r.blocks[1], /the text\n- ran: before \(done\)\n- ran: after \(no result seen/);
  // many siblings: nothing lost, nothing called left
  const many = [U("u", null, "go")];
  let tip = "u";
  for (let i = 0; i < 70; i++) {
    many.push(T(`s${i}`, tip, "big", `t${i}`, `c${i}`));
    tip = `s${i}`;
  }
  many.push(Res("r0", "s0", "t0"), A("f", "r0", "mf", "end"));
  r = await read(many, { includeTools: true });
  assert.ok(!r.left[OTHER]);
  assert.equal((r.blocks[1].match(/- ran:/g) ?? []).length + Number(/… and (\d+) more tool steps/.exec(r.blocks[1])?.[1] ?? 0), 70, "shown and counted add up");
  // a repeated sibling is one line
  r = await read([U("u", null, "go"), T("a", "u", "m", "t1"), T("b", "a", "m", "t2"), T("b", "a", "m", "t2"), Res("r", "a", "t1"), A("f", "r", "mf", "end")], { includeTools: true });
  assert.equal((r.blocks[1].match(/- ran:/g) ?? []).length, 2);
  // a result on the branch decides; an abandoned one can't overwrite it
  r = await read([U("u", null, "go"), T("a", "u", "m", "t1"), Res("bad", "a", "t1", true), Res("good", "a", "t1"), A("f", "good", "mf", "end")], { includeTools: true });
  assert.match(r.blocks[1], /\(done\)/);
  r = await read([U("u", null, "go"), T("a", "u", "m", "t1"), T("b", "a", "m", "t2"), Res("g", "b", "t2"), Res("x", "a", "t1", true), Res("y", "a", "t1"), A("f", "g", "mf", "end")], { includeTools: true });
  assert.match(r.blocks[1], /ran: t1 \(outcome unclear: its results conflict\)\n- ran: t2 \(done\)/, "two recovered results that disagree");
  // several compactions, with a rewind on either side
  r = await read([
    U("u", null, "one"),
    A("a", "u", "ma", "two"),
    U("left", "a", "left one"),
    Boundary("b1", "a"),
    U("s1", "b1", "summary", { isCompactSummary: true }),
    U("v", "s1", "three"),
    A("c", "v", "mc", "four"),
    U("left2", "c", "left two"),
    Boundary("b2", "c"),
    U("s2", "b2", "summary", { isCompactSummary: true }),
    A("d", "s2", "md", "five"),
  ], { includeTools: true });
  assert.deepEqual(texts(r.blocks), ["one", "two", "three", "four", "five"], "the history before a compaction is read back");
  assert.equal(r.left["compaction summaries"], 2);
  assert.equal(r.left[OTHER], 2);
  // a boundary with no way back: what's before it isn't known to be gone
  for (const [what, logical] of [["missing", undefined], ["null", null], ["a number", 5], ["gone", "no-such-record"]]) {
    r = await read([U("u", null, "older"), A("a", "u", "ma", "reply"), { uuid: "b", parentUuid: null, ...(logical !== undefined && { logicalParentUuid: logical }), type: "system", subtype: "compact_boundary" }, U("v", "b", "newer")]);
    assert.deepEqual(texts(r.blocks), ["older", "reply", "newer"], `logical parent ${what}: all shown`);
    assert.ok(r.uncertain, `logical parent ${what}: with the warning`);
    assert.ok(!r.left[OTHER], `logical parent ${what}: none called left`);
  }
  // logicalParentUuid only at a boundary with no parent
  r = await read([U("u", null, "root"), A("x", "u", "mx", "off"), U("v", null, "second root", { logicalParentUuid: "x" }), A("w", "v", "mw", "end")]);
  assert.deepEqual(texts(r.blocks), ["second root", "end"], "a record that isn't a boundary doesn't follow it");
  assert.ok(!r.uncertain, "that's a true root");
  // what the user typed last, with no answer yet, and a tie with another ending
  r = await read([U("u", null, "q"), A("a", "u", "ma", "ans"), Q("t", "a", "typed last")]);
  assert.deepEqual(texts(r.blocks), ["q", "ans", "typed last"]);
  r = await read([U("u", null, "q"), A("a", "u", "ma", "ans"), Q("t", "a", "typed last"), Sys("p", "a")]);
  assert.deepEqual(texts(r.blocks), ["q", "ans", "typed last"], "another record ending at the same message doesn't lose it");
  // a parent later in the file isn't missing
  r = await read([U("v", "a", "after"), U("u", null, "before"), A("a", "u", "ma", "middle")]);
  assert.deepEqual(texts(r.blocks), ["before", "middle", "after"]);
  assert.ok(!r.uncertain);
  // a cycle, and no ending at all: everything shown, labelled, none called left
  r = await read([U("p", "q", "one"), U("q", "p", "two")]);
  assert.deepEqual(texts(r.blocks).sort(), ["one", "two"]);
  assert.ok(r.uncertain);
  assert.ok(!r.left[OTHER]);
  // a missing parent with two older rooted stretches behind it
  r = await read([U("u1", null, "older one"), A("a1", "u1", "m1", "reply one"), U("u2", null, "older two"), A("a2", "u2", "m2", "reply two"), U("t", "gone", "newest")]);
  assert.deepEqual(texts(r.blocks), ["older one", "reply one", "older two", "reply two", "newest"], "all of it, in file order");
  assert.ok(r.uncertain, "with the warning");
  assert.ok(!r.left[OTHER], "and none of it called left");
  for (const limit of [1, 2]) {
    const w = write([U("u1", null, "older one"), U("u1", null, "older one"), A("a1", "u1", "m1", "reply one"), U("t", "gone", "newest")]);
    const paged = await readAll(w, { limit, includeTools: false });
    assert.deepEqual(texts(paged.blocks), ["older one", "reply one", "newest"], `no repeats behind a break, limit ${limit}`);
  }
  // the warning is said on the page that needs it, and not before
  {
    const w = write([U("u1", null, "older"), U("t", "gone", "newest"), A("f", "t", "mf", "answer")]);
    const p1 = await readClaudePage(sessionOf(w), { limit: 2, includeTools: false });
    assert.ok(!p1.page.uncertain, "what follows from the newest is certain");
    assert.doesNotMatch(rc.pageText(p1.meta, p1.page, { cursor: "c", first: true }), /broken link/);
    const p2 = await readClaudePage(sessionOf(w), { limit: 2, includeTools: false, resume: p1.page.pos });
    assert.ok(p2.page.uncertain);
    assert.match(rc.pageText(p2.meta, p2.page, { first: false }), /broken link[\s\S]*Tell the user/);
    const mixed = await readClaudePage(sessionOf(w), { limit: 60, includeTools: false });
    assert.match(rc.pageText(mixed.meta, mixed.page, { first: true }), /broken link/, "a page with both carries it");
  }
  // every record left out
  r = await read([U("m", null, "n", { isMeta: true }), { uuid: "s", parentUuid: "m", isSidechain: true, type: "user", message: { content: "x" } }]);
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(r.left, { "the app's own notices": 1, "subagent records": 1 });
  assert.ok(!r.uncertain, "nothing shown, nothing to warn about");
  // a session of nothing but a subagent's records has no conversation to be broken
  r = await read([{ uuid: "s1", parentUuid: null, isSidechain: true, type: "user", message: { content: "x" } }, { uuid: "s2", parentUuid: "s1", isSidechain: true, type: "assistant", message: { id: "m", content: [{ type: "text", text: "y" }] } }]);
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(r.left, { "subagent records": 2 });
  assert.ok(!r.uncertain, "and no warning, as on real data: 12 such sessions were told their history was broken");
  // a break at the very first record, with something left out below nothing
  r = await read([{ uuid: "s0", parentUuid: null, isSidechain: true, type: "user", message: { content: "x" } }, U("u", "gone", "only one")]);
  assert.deepEqual(texts(r.blocks), ["only one"]);
  assert.ok(!r.uncertain, "nothing older was shown, so nothing is in doubt");
  // an already non-monotonic file, a page at a time: the cut never rises
  {
    const w = write([U("v", "a", "after"), U("u", null, "before"), A("a", "u", "ma", "middle"), U("o1", "a", "other"), U("x", "v", "last")]);
    let resume;
    let last = Infinity;
    for (let i = 0; i < 10; i++) {
      const p = await readClaudePage(sessionOf(w), { limit: 1, includeTools: false, resume });
      if (p.page.pos) {
        assert.ok(p.page.pos.c <= last, "the cut only goes down");
        last = p.page.pos.c;
      }
      if (!p.page.more) break;
      resume = p.page.pos;
    }
  }
  console.log("graph named: late copies, rewinds, repeats, parallel calls and their results, compactions, trailing messages, broken links and cycles");
}

// the kinds of a turn
{
  const kinds = (blocks) => blocks.map((b) => b.split("\n")[0]);
  // text + a tool call + nothing: shown, marked
  let r = await read([U("u", null, "go"), { uuid: "a", parentUuid: "u", type: "assistant", message: { id: "m", content: [{ type: "text", text: "starting" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "x" } }] } }]);
  assert.deepEqual(kinds(r.blocks), ["### User", "### Assistant (the turn didn't finish)"]);
  // tool only at the end, with text before it
  r = await read([U("u", null, "go"), A("a", "u", "m1", "working on it"), T("b", "a", "m2", "t1")]);
  assert.deepEqual(kinds(r.blocks), ["### User", "### Assistant (the turn didn't finish)"]);
  // a normal turn: one answer, what came before it hidden
  r = await read([U("u", null, "go"), A("a", "u", "m1", "working"), T("b", "a", "m1", "t1"), Res("c", "b", "t1"), A("d", "c", "m2", "the answer")]);
  assert.deepEqual(kinds(r.blocks), ["### User", "### Assistant"]);
  assert.deepEqual(texts(r.blocks), ["go", "the answer"]);
  // and over a page boundary, a page at a time
  r = await read([U("u", null, "go"), A("a", "u", "m1", "working"), T("b", "a", "m1", "t1"), Res("c", "b", "t1"), A("d", "c", "m2", "the answer")], { limit: 1, includeTools: true });
  assert.deepEqual(kinds(r.blocks), ["### User", "### Assistant (between steps)", "### Assistant"]);
  // an answer before a typed message stays an answer: it may have been taken up only
  // after that turn ended
  r = await read([U("u", null, "go"), A("a", "u", "m1", "first answer"), Q("q", "a", "and this"), A("d", "q", "m2", "second answer")]);
  assert.deepEqual(kinds(r.blocks), ["### User", "### Assistant", "### User (typed while the turn ran)", "### Assistant"]);
  // text before a message typed mid-turn, when the turn went on after it
  r = await read([U("u", null, "go"), T("a", "u", "m1", "t1"), Q("q", "a", "faster"), A("d", "q", "m2", "done")], { includeTools: true });
  assert.deepEqual(kinds(r.blocks), ["### User", "### Tool steps", "### User (typed while the turn ran)", "### Assistant"]);
  // the IDE's blocks aren't the user's words
  r = await read([U("u", null, "<ide_opened_file>a.js</ide_opened_file>\nfix this"), A("a", "u", "m", "ok"), U("v", "a", "<ide_selection>x</ide_selection>")]);
  assert.deepEqual(texts(r.blocks), ["fix this", "ok"]);
  assert.equal(r.left["the app's own notices"], 1, "with nothing else it's the app's own");
  console.log("graph kinds: an unfinished turn says so and shows its last text; a normal one has one answer; the IDE's blocks are left out");
}

// between pages
{
  const base = [U("a", null, "one"), A("b", "a", "m1", "two"), U("c", "b", "three"), A("d", "c", "m2", "four")];
  const again = (w, resume, opts = {}) => readClaudePage(sessionOf(w), { limit: 2, includeTools: false, resume, ...opts });
  // a new turn: older pages hold
  let w = write(base);
  let p = await again(w);
  fs.appendFileSync(w.file, `${JSON.stringify(U("e", "d", "five"))}\n`);
  let q = await again(w, p.page.pos);
  assert.ok(!q.moved);
  assert.deepEqual(texts(q.page.text.split(/\n\n(?=### )/)), ["one", "two"]);
  // a rewind to before the cursor: stops
  w = write(base);
  p = await again(w);
  fs.appendFileSync(w.file, `${JSON.stringify(U("r", "b", "instead"))}\n`);
  assert.ok((await again(w, p.page.pos)).moved, "the unit the cursor is at is no longer on the branch");
  w = write([...base, U("e", "d", "five"), A("f", "e", "m3", "six")]);
  p = await readClaudePage(sessionOf(w), { limit: 3, includeTools: false });
  fs.appendFileSync(w.file, `${JSON.stringify(U("r", "a", "instead"))}\n`);
  assert.ok((await again(w, p.page.pos)).moved);
  // a late copy of what the cursor is at, or below it: stops, nothing counted twice
  w = write(base);
  p = await again(w);
  fs.appendFileSync(w.file, `${JSON.stringify(base[2])}\n`);
  assert.ok((await again(w, p.page.pos)).moved, "a copy of the cursor's own unit");
  // the case that would count an omission twice: C@30, an omitted one at 40, then C again at 50
  w = write([U("a", null, "one"), U("c", "a", "three"), { uuid: "s", parentUuid: "c", isSidechain: true, type: "user", message: { content: "x" } }, A("d", "c", "m", "four")]);
  p = await readClaudePage(sessionOf(w), { limit: 2, includeTools: false });
  fs.appendFileSync(w.file, `${JSON.stringify(U("c", "a", "three"))}\n`);
  q = await readClaudePage(sessionOf(w), { limit: 2, includeTools: false, resume: p.page.pos });
  assert.ok(q.moved || !q.page.dropped["subagent records"], "never counted a second time");
  // another block of a message below the cursor: stops
  w = write([U("a", null, "one"), T("b", "a", "m", "t1"), Res("r", "b", "t1"), A("c", "r", "n", "two"), U("d", "c", "three"), A("e", "d", "o", "four")]);
  p = await readClaudePage(sessionOf(w), { limit: 2, includeTools: true });
  fs.appendFileSync(w.file, `${JSON.stringify(T("late", "b", "m", "t9"))}\n`);
  q = await readClaudePage(sessionOf(w), { limit: 2, includeTools: true, resume: p.page.pos });
  assert.ok(q.moved, "a sibling added below the cursor changes what it read past");
  // a cursor for no such unit
  assert.ok((await again(w, { ...p.page.pos, u: "nothing" })).moved);
  console.log("graph between pages: new turns are fine; a rewind, a late copy or an added block at or below the cursor stops the read");
}

// the tokenizer
{
  const run = (s, pieces = 1) => {
    const t = new TopFields();
    const buf = Buffer.from(s);
    const step = Math.max(1, Math.ceil(buf.length / pieces));
    for (let i = 0; i < buf.length; i += step) t.feed(buf.subarray(i, i + step));
    return t.finish();
  };
  const obj = { message: { uuid: "nested", content: ['"uuid":"in-a-string"'] }, uuid: "the-one", parentUuid: null, type: "user", subtype: "x", n: 1, logicalParentUuid: "l", isSidechain: false, isMeta: true, teamName: "t" };
  for (const pieces of [1, 2, 7, 50, 1000]) {
    const f = run(JSON.stringify(obj), pieces);
    assert.equal(f.uuid, "the-one", `nested and quoted lookalikes aren't taken, split in ${pieces}`);
    assert.equal(f.parentUuid, null, "null is null");
    assert.equal(f.logicalParentUuid, "l");
    assert.equal(f.isMeta, true);
    assert.equal(f.isSidechain, false);
    assert.equal(f.subtype, "x");
  }
  assert.equal(run('{"type":"user"}').parentUuid, undefined, "absent is undefined");
  assert.equal(run('{"parentUuid":5}').parentUuid, MALFORMED);
  assert.equal(run('{"parentUuid":{"uuid":"x"}}').parentUuid, MALFORMED);
  assert.equal(run('{"uuid":"a\\"b","parentUuid":"c\\u0064"}').uuid, 'a"b', "escapes");
  assert.equal(run('{"uuid":"a\\"b","parentUuid":"c\\u0064"}').parentUuid, "cd");
  assert.equal(run('{"uu\\u0069d":"sneaky"}').uuid, "sneaky", "as JSON.parse reads it");
  assert.equal(run(`{"uuid":"${"x".repeat(1000)}"}`).uuid, MALFORMED, "too long to be one");
  assert.equal(run(' { "uuid" : "spaced" , "type" : "user" } ').uuid, "spaced");
  assert.equal(run('{"uuid":"first","uuid":"last"}').uuid, "last", "a repeated key, as JSON.parse reads it");
  assert.equal(run('{"parentUuid":"first","parentUuid":null}').parentUuid, null);
  for (const bad of ['{"uuid":"a"', '{"uuid":', '{"uuid"', "[1,2]", '{"a":1}x', "", '{"a" 1}', '{"a":1,}'])
    assert.equal(run(bad), null, `not one whole object: ${bad}`);
  // whatever it gives must be what JSON.parse gives for these fields
  for (let seed = 1; seed < 200; seed++) {
    const r = rng(seed);
    const rec = { [`k${r(3)}`]: { uuid: `n${r(9)}`, deep: [{ parentUuid: "x" }, `"uuid":"y${r(9)}"`] }, uuid: `u${r(99)}`, type: r(2) ? "user" : "system" };
    if (r(2)) rec.parentUuid = r(2) ? null : `p${r(9)}`;
    if (r(2)) rec.isSidechain = !!r(2);
    const f = run(JSON.stringify(rec), 1 + r(20));
    for (const k of ["uuid", "type", "parentUuid", "isSidechain"]) assert.equal(f[k], rec[k], `${k}, seed ${seed}`);
  }
  // huge records in a real file: on the branch, with a nested lookalike
  const pad = "h".repeat(MAX_RECORD + 500_000);
  const hugeUser = { parentUuid: "a", isSidechain: false, type: "user", message: { role: "user", content: pad, meta: { uuid: "lookalike", parentUuid: "lookalike-2" } }, uuid: "big" };
  let r = await read([U("u", null, "first"), A("a", "u", "m", "second"), hugeUser, U("v", "big", "third")]);
  assert.deepEqual(texts(r.blocks), ["first", "second", "third"], "the walk goes through it");
  assert.equal(r.left["records too large to read"], 1);
  assert.ok(!r.uncertain);
  // one with no readable identity: a visible break, nothing lost
  const noId = { type: "user", message: { role: "user", content: pad } };
  r = await read([U("u", null, "first"), noId, U("v", "gone", "third")]);
  assert.deepEqual(texts(r.blocks), ["first", "third"]);
  assert.ok(r.uncertain);
  // a giant compaction boundary is still one
  const bigBoundary = { uuid: "bb", parentUuid: null, logicalParentUuid: "a", type: "system", subtype: "compact_boundary", pad };
  r = await read([U("u", null, "first"), A("a", "u", "m", "second"), bigBoundary, A("c", "bb", "n", "third")], { includeTools: true });
  assert.deepEqual(texts(r.blocks), ["first", "second", "third"]);
  assert.ok(!r.uncertain);
  // one with no way back, read by the tokenizer too
  for (const logical of [{}, { logicalParentUuid: null }, { logicalParentUuid: 5 }, { logicalParentUuid: "gone" }]) {
    r = await read([U("u", null, "first"), { uuid: "bb", parentUuid: null, ...logical, type: "system", subtype: "compact_boundary", pad }, U("c", "bb", "third")]);
    assert.deepEqual(texts(r.blocks), ["first", "third"], JSON.stringify(logical));
    assert.ok(r.uncertain);
    assert.ok(!r.left[OTHER]);
  }
  // a broken one
  r = await read([U("u", null, "first"), `{"uuid":"z","type":"user","pad":"${pad}`, U("v", null, "second")]);
  assert.deepEqual(texts(r.blocks), ["second"]);
  assert.equal(r.left["records too large to read"], 1);
  console.log("graph tokenizer: only top-level fields, split anywhere, as JSON.parse reads them; huge records keep the branch whole");
}

// resources, apart from any typical store
{
  // one message spread over more than the budget: says so, and the page moves on
  const lines = [U("u", null, "go")];
  let tip = "u";
  for (let i = 0; i < 65; i++) {
    lines.push({ uuid: `b${i}`, parentUuid: tip, type: "assistant", message: { id: "wide", content: [{ type: "text", text: `${i}` }, { type: "text", text: " " }, { type: "image", source: "s".repeat(1024 * 1024) }] } });
    tip = `b${i}`;
  }
  lines.push(U("v", tip, "after"));
  const w = write(lines);
  let p = await readClaudePage(sessionOf(w), { limit: 2, includeTools: false, unitBudget: 8 * 1024 * 1024 });
  assert.equal(p.page.spread, 1, "it completes and says what it left out");
  assert.match(p.page.text, /\(Part of this message couldn't be read: it was spread too far\.\)/);
  assert.match(rc.pageText(p.meta, p.page, { cursor: "c", first: true }), /only partly here[\s\S]*Tell the user/);
  const all = await readAll(w, { limit: 1, includeTools: false, unitBudget: 8 * 1024 * 1024 });
  assert.equal(all.blocks.length, 3, "and every page moves on");
  // a page stops starting messages past its budget
  const big = [U("u", null, "go")];
  tip = "u";
  for (let i = 0; i < 6; i++) {
    big.push(U(`q${i}`, tip, `${i}${"x".repeat(1024 * 1024)}`));
    tip = `q${i}`;
  }
  const bw = write(big);
  p = await readClaudePage(sessionOf(bw), { limit: 60, includeTools: false, budget: 2 * 1024 * 1024 });
  assert.ok(p.page.more && p.page.count < 7, "it ended early");
  assert.equal((await readAll(bw, { limit: 60, includeTools: false, budget: 2 * 1024 * 1024 })).blocks.length, 7);
  // a stop anywhere, even inside one very long record, goes on and progresses
  clearIndexMemo();
  const huge = write([U("u", null, "first"), { uuid: "h", parentUuid: "u", type: "user", message: { content: "h".repeat(MAX_RECORD + 2_000_000) } }, U("v", "h", "last")]);
  let scanned = 0;
  let calls = 0;
  for (;;) {
    const r = await readClaudePage(sessionOf(huge), { limit: 60, includeTools: false, maxChunks: 3 });
    if (r.status !== "scanning") {
      assert.deepEqual(texts(r.page.text.split(/\n\n(?=### )/)), ["first", "last"]);
      break;
    }
    assert.ok(r.scanned > scanned, "each call goes further");
    scanned = r.scanned;
    assert.ok(++calls < 100);
    assert.match(rc.STILL_READING(r.scanned, r.total), /Call this again with the same arguments/);
  }
  assert.ok(calls > 5, "it took several");
  // an interrupted scan can't be read from
  clearIndexMemo();
  assert.equal((await readClaudePage(sessionOf(huge), { limit: 1, includeTools: false, maxChunks: 1 })).status, "scanning");
  // over the budget: refused, and said; not read in part
  clearIndexMemo();
  const many = [U("u0", null, "q")];
  for (let i = 1; i < 2000; i++) many.push(U(`u${i}`, `u${i - 1}`, `q${i}`));
  const mw = write(many);
  assert.equal((await readClaudePage(sessionOf(mw), { limit: 1, includeTools: false, maxBytes: 50_000 })).status, "tooLarge");
  assert.match(rc.TOO_LARGE, /too large to read here/);
  clearIndexMemo();
  assert.ok((await readClaudePage(sessionOf(mw), { limit: 1, includeTools: false })).page, "with room, it's read");
  // two sessions are kept, not three; the shared budget evicts the other first
  clearIndexMemo();
  const s1 = write(many);
  const s2 = write(many);
  const s3 = write(many);
  for (const s of [s1, s2, s3]) await openIndex(s.file);
  assert.equal(memoStats().sessions, 2);
  clearIndexMemo();
  await openIndex(s1.file);
  const one = memoStats().bytes;
  await openIndex(s2.file, { maxMemoBytes: one + 10 });
  assert.equal(memoStats().sessions, 1, "the other one made way");
  // the limits hold for scans still under way too, and for a mix of any state
  clearIndexMemo();
  const bulk = Array.from({ length: 6 }, () => write(Array.from({ length: 1500 }, (_, i) => U(`b${i}`, i ? `b${i - 1}` : null, "p".repeat(500)))));
  for (const s of bulk) assert.equal((await openIndex(s.file, { maxChunks: 1 })).status, "scanning");
  assert.equal(memoStats().sessions, 2, "paused scans are kept no more than others");
  clearIndexMemo();
  await openIndex(bulk[0].file, { maxChunks: 1 });
  const onePaused = memoStats().bytes;
  for (const s of bulk) {
    await openIndex(s.file, { maxChunks: 1, maxMemoBytes: onePaused + 100 });
    assert.ok(memoStats().bytes <= onePaused + 100 || memoStats().sessions === 1, "nor over the shared budget");
  }
  clearIndexMemo();
  assert.equal((await openIndex(bulk[0].file, { maxBytes: 1000 })).status, "tooLarge");
  await openIndex(bulk[1].file, { maxChunks: 1 });
  await openIndex(bulk[2].file);
  await openIndex(bulk[3].file, { maxBytes: 1000 });
  assert.ok(memoStats().sessions <= 2, "refused, paused and ready together");
  assert.equal((await openIndex(bulk[0].file, { maxBytes: 1000 })).status, "tooLarge", "and a refused one is refused again, evicted or not");
  // a paused scan evicted by others starts again, and still gets there
  clearIndexMemo();
  const again = bulk[4];
  await openIndex(again.file, { maxChunks: 1 });
  await openIndex(bulk[0].file);
  await openIndex(bulk[1].file);
  assert.equal((await openIndex(again.file)).status, "ready");
  // a file that can't be opened leaves nothing behind
  clearIndexMemo();
  for (let i = 0; i < 6; i++) await assert.rejects(openIndex(path.join(dir, `nothing-${i}.jsonl`)), { code: "ENOENT" });
  assert.equal(memoStats().sessions, 0);
  // the same file only
  clearIndexMemo();
  const sw = write([U("a", null, "AAAA"), A("b", "a", "m", "x".repeat(10_000)), U("c", "b", "tail")]);
  let got = await readAll(sw, { limit: 60, includeTools: false });
  assert.equal(texts(got.blocks)[0], "AAAA");
  const bytes = fs.readFileSync(sw.file);
  const at = bytes.indexOf("BBBB") === -1 ? bytes.indexOf("AAAA") : -1;
  // the middle only, with both sampled ends unchanged
  const midLines = [U("a", null, "keep"), ...Array.from({ length: 3 }, (_, i) => U(`p${i}`, i ? `p${i - 1}` : "a", "p".repeat(6_000))), U("mid", "p2", "AAAA"), ...Array.from({ length: 3 }, (_, i) => U(`z${i}`, i ? `z${i - 1}` : "mid", "z".repeat(6_000)))];
  const mid = write(midLines);
  got = await readAll(mid, { limit: 60, includeTools: false });
  assert.ok(got.blocks.some((b) => b.includes("AAAA")));
  const edited = fs.readFileSync(mid.file);
  edited.write("BBBB", edited.indexOf("AAAA"));
  fs.writeFileSync(mid.file, edited);
  fs.utimesSync(mid.file, new Date(), new Date(Date.now() + 5_000));
  got = await readAll(mid, { limit: 60, includeTools: false });
  assert.ok(got.blocks.some((b) => b.includes("BBBB")), "a same-size edit in the middle is seen, by its time");
  assert.ok(at >= 0);
  fs.writeFileSync(sw.file, `${JSON.stringify(U("n", null, "cut short"))}\n`);
  got = await readAll(sw, { limit: 60, includeTools: false });
  assert.deepEqual(texts(got.blocks), ["cut short"], "cut short");
  fs.writeFileSync(sw.file, [U("n2", null, "grown again"), A("m2", "n2", "x", "y".repeat(20_000))].map((l) => JSON.stringify(l)).join("\n") + "\n");
  got = await readAll(sw, { limit: 60, includeTools: false });
  assert.equal(texts(got.blocks)[0], "grown again", "cut and grown again: a new read");
  // a last line still being written isn't read yet, and is once it's whole
  const growing = write([U("a", null, "first")]);
  fs.appendFileSync(growing.file, '{"uuid":"b","parentUuid":"a","type":"user","message":{"content":"sec');
  got = await readAll(growing, { limit: 60, includeTools: false });
  assert.deepEqual(texts(got.blocks), ["first"]);
  assert.deepEqual(got.left, {}, "nothing to report about it yet");
  fs.appendFileSync(growing.file, 'ond"}}\n');
  got = await readAll(growing, { limit: 60, includeTools: false });
  assert.deepEqual(texts(got.blocks), ["first", "second"]);
  console.log("graph resources: a wide message completes and says so, pages progress, a scan goes on from any byte, the budgets hold, a memo is for the same file");
}

// a long chain of records with nothing to show, near what a budget allows: resolving
// walks it once, without holding the event loop for long
{
  clearIndexMemo();
  const n = 150_000;
  const file = path.join(dir, `g${++seq}.jsonl`);
  const out = [JSON.stringify(U("u0", null, "start"))];
  for (let i = 1; i < n; i++) out.push(JSON.stringify(Sys(`u${i}`, `u${i - 1}`)));
  out.push(JSON.stringify(U("end", `u${n - 1}`, "finish")));
  fs.writeFileSync(file, out.join("\n") + "\n");
  out.length = 0;
  const st = fs.statSync(file);
  let worst = 0;
  let last = Date.now();
  const beat = setInterval(() => {
    worst = Math.max(worst, Date.now() - last);
    last = Date.now();
  }, 5);
  const p = await readClaudePage({ id: "chain", file, size: st.size, mtime: st.mtimeMs }, { limit: 5, includeTools: false });
  clearInterval(beat);
  assert.deepEqual(texts(p.page.text.split(/\n\n(?=### )/)), ["start", "finish"]);
  assert.ok(!p.page.uncertain);
  assert.ok(worst < 500, `a long chain: worst gap ${worst} ms`);
  console.log(`graph a chain of ${n} metadata records: worst event-loop gap ${worst} ms`);
}

// what the index really holds, against what it says, and how the event loop fares
{
  clearIndexMemo();
  const n = 60_000;
  const parts = [];
  let parent = null;
  for (let i = 0; i < n; i++) {
    const uuid = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    const rec = i % 2 ? { parentUuid: parent, type: "assistant", uuid, sourceToolAssistantUUID: parent, message: { id: `msg_${String(i).padStart(24, "0")}`, content: [{ type: "tool_use", id: `toolu_${String(i).padStart(24, "0")}`, name: "Bash", input: { command: "x" } }] } } : { parentUuid: parent, type: "user", uuid, message: { content: [{ type: "tool_result", tool_use_id: `toolu_${String(i - 1).padStart(24, "0")}`, content: "y".repeat(300) }] } };
    parts.push(JSON.stringify(rec));
    parent = uuid;
  }
  const w = (() => {
    const id = `g${++seq}`;
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, parts.join("\n") + "\n");
    return { id, file, size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs };
  })();
  parts.length = 0;
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  let worst = 0;
  let last = Date.now();
  const beat = setInterval(() => {
    worst = Math.max(worst, Date.now() - last);
    last = Date.now();
  }, 5);
  const p = await readClaudePage(sessionOf(w), { limit: 5, includeTools: true });
  clearInterval(beat);
  assert.ok(p.page.count > 0);
  global.gc?.();
  const real = process.memoryUsage().heapUsed - before;
  const said = memoStats().bytes;
  assert.ok(worst < 500, `the event loop stayed responsive while scanning and resolving (worst gap ${worst} ms)`);
  if (global.gc) assert.ok(said >= real * 0.6, `the accounting isn't far under the real heap: said ${said}, real ${real}`);
  console.log(`graph costs: ${n} records, index says ${Math.round(said / 1024 / 1024)} MiB (${Math.round(said / n)} bytes a record)${global.gc ? `, real heap ${Math.round(real / 1024 / 1024)} MiB` : " (run with --expose-gc to compare with the real heap)"}, event loop worst gap ${worst} ms`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("graph: all passed");
