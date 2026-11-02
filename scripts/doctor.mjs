// Check that the bridge is installed and working on this machine, and say
// how to fix what isn't. Read-only: changes no config, never becomes the
// broker owner.
//   node scripts/doctor.mjs          (npm run doctor)
//   node scripts/doctor.mjs --json

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { DATA_DIR, OUTBOX_DIR, LISTENERS_DIR, PROTOCOL, readState, activeLinks } from "../src/broker.mjs";
import { readRules, MAX_RULES } from "../src/rules.mjs";
import { readConfig } from "../src/config.mjs";
import { IS_WIN, rulesFile, claudeConfigDir, claudeDesktopConfig, codexHome, findClaudeCli, locateCodexCli } from "../src/platform.mjs";

const asJson = process.argv.includes("--json");
const root = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(root, "src", "server.mjs");
const HOOK = path.join(root, "src", "hook.mjs");
const PORT = Number(process.env.PEER_BRIDGE_PORT || 7457);

const results = [];
const add = (area, name, status, detail, fix) => results.push({ area, name, status, detail, ...(fix && { fix }) });
const ok = (area, name, detail) => add(area, name, "ok", detail);
const warn = (area, name, detail, fix) => add(area, name, "warn", detail, fix);
const fail = (area, name, detail, fix) => add(area, name, "fail", detail, fix);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const REINSTALL = "Run `node scripts/install.mjs` from this checkout, then restart both apps.";

// ------------------------------------------------------------- environment
{
  const A = "Environment";
  const major = Number(process.versions.node.split(".")[0]);
  major >= 22 ? ok(A, "Node.js", process.versions.node) : fail(A, "Node.js", `${process.versions.node} (22+ needed)`, "Install Node.js 22 or newer.");
  try {
    ok(A, "git", execFileSync("git", ["--version"], { encoding: "utf8" }).trim());
  } catch {
    warn(A, "git", "not found", "Install git; without it review requests carry no diffs.");
  }
}

// ------------------------------------------------------------------- rules
{
  const A = "Rules";
  const r = readRules();
  if (!r) ok(A, "rules file", `none (optional: ${rulesFile()})`);
  else if (r.truncated) warn(A, "rules file", `${r.path}, ${r.size} characters`, `Only the first ${MAX_RULES} reach the agents; shorten it.`);
  else ok(A, "rules file", `${r.path}, ${r.size} characters`);
  ok(A, "closed apps", readConfig().openClosedApps === "always" ? "opened without asking (always)" : "the user is asked first (ask)");
}

// ------------------------------------------------------------------ broker
function ping() {
  let token;
  try {
    token = fs.readFileSync(path.join(DATA_DIR, "token"), "utf8").trim();
  } catch {
    return Promise.resolve({ error: "no token yet" });
  }
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/rpc", method: "POST", timeout: 2000, headers: { "x-bridge-token": token, "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ error: `HTTP ${res.statusCode}` });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    // protocol 0: a probe must never make the owner step down
    req.end(JSON.stringify({ op: "ping", args: {}, protocol: 0 }));
  });
}

{
  const A = "Broker";
  try {
    const probe = path.join(DATA_DIR, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    ok(A, "data folder", DATA_DIR);
  } catch (e) {
    fail(A, "data folder", `${DATA_DIR}: ${e.message}`, "Make the folder writable, or set PEER_BRIDGE_DIR.");
  }
  const r = await ping();
  if (r.ok && r.result.protocol === PROTOCOL) ok(A, "owner", `pid ${r.result.pid}, protocol ${r.result.protocol}`);
  else if (r.ok)
    warn(A, "owner", `pid ${r.result.pid} runs protocol ${r.result.protocol ?? "unknown"}, this checkout ${PROTOCOL}`, "Restart both apps so their servers load the current code.");
  else if (r.error === "ECONNREFUSED")
    warn(A, "owner", "none running", "Normal while neither app is open; otherwise open a chat in Claude Code or ChatGPT (their servers keep one alive).");
  else fail(A, "owner", r.error ?? r.error, "Another program may be using the port; set PEER_BRIDGE_PORT for both apps.");
  let stale = [];
  try {
    stale = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith(".json") && Date.now() - fs.statSync(path.join(OUTBOX_DIR, f)).mtimeMs > 10_000);
  } catch {
    // no outbox yet
  }
  stale.length
    ? warn(A, "hook requests", `${stale.length} waiting longer than 10 s`, "No broker owner is processing them: open a chat in either app.")
    : ok(A, "hook requests", "none waiting");
}

// --------------------------------------------------------- hook commands
// Commands must point at this checkout's hook and an existing node
function commandTargets(cmd) {
  const quoted = [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const first = cmd.startsWith('"') || cmd.startsWith('& "') ? quoted[0] : cmd.split(/\s+/)[0];
  return { node: first, hook: quoted.find((q) => q.endsWith("hook.mjs")) };
}

function checkCommand(A, label, cmd) {
  const { node, hook } = commandTargets(cmd);
  if (!hook || path.resolve(hook) !== HOOK) return fail(A, label, `points to ${hook ?? "?"}`, REINSTALL);
  if (node && node !== "node" && !fs.existsSync(node)) return fail(A, label, `node not found at ${node}`, REINSTALL);
  return true;
}

// Runs a hook command line with an empty hook input (no session: exits at once)
function runs(cmd, shell) {
  const r = IS_WIN && shell === "powershell"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `'{}' | ${cmd}; exit $LASTEXITCODE`], { encoding: "utf8", timeout: 15_000 })
    : spawnSync(cmd, { shell: true, input: "{}", encoding: "utf8", timeout: 15_000 });
  return r.status === 0;
}

// ------------------------------------------------------------- Claude Code
{
  const A = "Claude Code";
  const cli = findClaudeCli();
  if (!cli) warn(A, "CLI", "not found; registration can't be checked", "Install Claude Code or set PEER_BRIDGE_CLAUDE_BIN.");
  else {
    let out = "";
    try {
      out = execFileSync(cli, ["mcp", "get", "peer-bridge"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    if (!/Scope: User/i.test(out)) fail(A, "MCP server", "not registered in user scope", REINSTALL);
    else if (!out.includes(SERVER)) fail(A, "MCP server", "registered, but for another checkout", REINSTALL);
    else if (!/Connected/i.test(out)) fail(A, "MCP server", "registered, but doesn't start", "Run `node src/server.mjs --side claude` to see the error.");
    else ok(A, "MCP server", "user scope, connected");
  }
  const file = path.join(claudeConfigDir(), "settings.json");
  let settings = {};
  try {
    settings = readJson(file);
  } catch {
    // missing settings: reported below
  }
  settings.permissions?.allow?.includes("mcp__peer-bridge")
    ? ok(A, "tool permission", "mcp__peer-bridge allowed")
    : warn(A, "tool permission", "bridge tools will ask for approval", "A woken session can't wait for a click. " + REINSTALL);
  const want = [
    ["Stop", "stop", false],
    ["Stop", "listen", true],
    ["StopFailure", "stopfail", false],
    ["SessionStart", "listen", true],
    ["UserPromptSubmit", "prompt", false],
  ];
  for (const [event, kind, rewake] of want) {
    const label = `${event} hook (${kind})`;
    const h = (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).find((x) => x.command?.includes("hook.mjs") && x.command.includes(`--event ${kind}`));
    if (!h) {
      fail(A, label, "missing", REINSTALL);
      continue;
    }
    if (rewake && !h.asyncRewake) {
      fail(A, label, "not asyncRewake, so it can't wake the session", REINSTALL);
      continue;
    }
    if (checkCommand(A, label, h.command) !== true) continue;
    runs(h.command) ? ok(A, label, rewake ? "asyncRewake, runs" : "runs") : fail(A, label, "command fails", REINSTALL);
  }
  try {
    readJson(claudeDesktopConfig()).mcpServers?.["peer-bridge"]
      ? warn(A, "old Claude Desktop entry", "still registered there (no session identity)", REINSTALL)
      : ok(A, "old Claude Desktop entry", "none");
  } catch {
    ok(A, "old Claude Desktop entry", "none");
  }
}

// --------------------------------------------------------- ChatGPT Desktop
{
  const A = "ChatGPT Desktop";
  const codex = locateCodexCli();
  const cli = codex?.path ?? null;
  if (!codex) fail(A, "bundled codex", "not found", "Install ChatGPT Desktop, or set PEER_BRIDGE_CODEX_BIN.");
  else if (codex.source === "app") ok(A, "bundled codex", cli);
  else if (codex.source === "override") ok(A, "bundled codex", `${cli} (set by PEER_BRIDGE_CODEX_BIN)`);
  else warn(A, "bundled codex", `not found, using ${cli} from PATH`, "Its version can differ from the app's; set PEER_BRIDGE_CODEX_BIN to the app's own codex.");
  const cfgFile = path.join(codexHome(), "config.toml");
  const toml = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, "utf8") : "";
  const block = toml.match(/# >>> peer-bridge[\s\S]*?# <<< peer-bridge/)?.[0];
  if (!block) fail(A, "MCP server", `not in ${cfgFile}`, REINSTALL);
  else if (!block.includes(SERVER)) fail(A, "MCP server", "registered for another checkout", REINSTALL);
  else {
    const command = block.match(/command = '([^']+)'/)?.[1];
    command && fs.existsSync(command) ? ok(A, "MCP server", "registered") : fail(A, "MCP server", `node not found at ${command}`, REINSTALL);
    /default_tools_approval_mode = "approve"/.test(block)
      ? ok(A, "tool approval", "approve")
      : warn(A, "tool approval", "bridge tools will ask for approval", "A woken thread can't wait for a click. " + REINSTALL);
  }
  if (cli && block) {
    try {
      execFileSync(cli, ["mcp", "get", "peer_bridge", "--json"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      ok(A, "config", "codex accepts config.toml");
    } catch (e) {
      fail(A, "config", String(e.stderr || e.message).trim().split("\n").slice(-2).join(" "), "Fix the error in config.toml (a backup sits next to it).");
    }
  }

  // hooks: as Codex sees them, including trust (a changed or new hook is
  // skipped until trusted, silently)
  const hooksFile = path.join(codexHome(), "hooks.json");
  const listed = [];
  let api = null;
  if (cli) {
    const { AppServer } = await import("../src/codex.mjs");
    let s;
    try {
      s = await Promise.race([AppServer.open(), new Promise((_, rej) => setTimeout(() => rej(new Error("app-server didn't start in 20 s")), 20_000))]);
      for (const e of (await s.rpc("hooks/list", { cwds: [root] })).data) listed.push(...e.hooks);
      try {
        await s.rpc("thread/queue/list", { threadId: "00000000-0000-0000-0000-000000000000" });
        api = true;
      } catch (e) {
        api = !/method not found|unknown method|unknown variant/i.test(e.message);
      }
    } catch (e) {
      fail(A, "app-server", e.message, "Update ChatGPT Desktop; the bridge needs its bundled app-server.");
    } finally {
      s?.close();
    }
  }
  if (api !== null)
    api
      ? ok(A, "thread queue API", "available (experimental)")
      : fail(A, "thread queue API", "missing in this app version", "This version of ChatGPT Desktop can't be driven; wakes won't work.");
  for (const [event, kind] of [["stop", "stop"], ["userPromptSubmit", "prompt"]]) {
    const label = `${event} hook`;
    const h = listed.find((x) => x.eventName === event && x.command?.includes("hook.mjs") && x.command.includes(`--event ${kind}`));
    if (!h) {
      const inFile = fs.existsSync(hooksFile) && fs.readFileSync(hooksFile, "utf8").includes(`--event ${kind}`);
      cli ? fail(A, label, inFile ? "in hooks.json but not loaded by Codex" : "missing", REINSTALL) : warn(A, label, "can't check without codex", "");
      continue;
    }
    if (checkCommand(A, label, h.command) !== true) continue;
    if (!h.enabled) {
      fail(A, label, "disabled in Codex", "Enable it in ChatGPT's hook settings.");
      continue;
    }
    if (h.trustStatus !== "trusted" && h.trustStatus !== "managed") {
      fail(A, label, `${h.trustStatus}: Codex skips it`, "Open ChatGPT Desktop normally (with a window), review and trust the peer-bridge hooks in its hook settings, then restart it.");
      continue;
    }
    const shells = IS_WIN ? ["cmd", "powershell"].filter((sh) => runs(h.command, sh)) : runs(h.command) ? ["sh"] : [];
    shells.length
      ? ok(A, label, `trusted, runs (${shells.join(", ")})`)
      : fail(A, label, "trusted, but the command fails", REINSTALL);
  }
}

// ------------------------------------------------------------------ links
{
  const A = "Links";
  const state = readState();
  const links = activeLinks(state);
  if (!links.length) ok(A, "active links", "none");
  const listening = (ep) => {
    try {
      const l = readJson(path.join(LISTENERS_DIR, `${ep.app}-${ep.id.replace(/[^\w.-]/g, "_")}.json`));
      return Date.now() - l.beat < 30_000;
    } catch {
      return false;
    }
  };
  for (const l of links) {
    const ends = `${l.primary.app} ${l.primary.id.slice(0, 8)}… → ${l.advisor ? `${l.advisor.app} ${l.advisor.id.slice(0, 8)}…` : "(waiting for join)"}`;
    const problems = [];
    if (l.health && !l.health.ok) problems.push(`last delivery failed: ${l.health.error}`);
    for (const role of ["primary", "advisor"]) if (l[role]?.app === "claude" && !listening(l[role])) problems.push(`Claude ${role} not listening${state?.hosts?.[l[role].id] ? "" : ", and the bridge can't open it (no Claude Desktop id)"}`);
    problems.length
      ? warn(A, `${l.id} (${l.mode})`, `${ends}; ${problems.join("; ")}`, "Open the Claude Code session in Claude Desktop (it re-arms on its next turn or start); check ChatGPT Desktop is installed and signed in.")
      : ok(A, `${l.id} (${l.mode})`, ends);
  }
  const pending = (state?.notes ?? []).filter((n) => !n.deliveredAt).length;
  if (pending) ok(A, "pending notes", `${pending} waiting for the next prompt`);
}

// ------------------------------------------------------------------ report
const fails = results.filter((r) => r.status === "fail").length;
const warns = results.filter((r) => r.status === "warn").length;
if (asJson) console.log(JSON.stringify({ ok: !fails, fails, warns, results }, null, 2));
else {
  const mark = { ok: "✓", warn: "!", fail: "✗" };
  let area;
  for (const r of results) {
    if (r.area !== area) console.log(`\n${(area = r.area)}`);
    console.log(`  ${mark[r.status]} ${r.name}: ${r.detail}`);
    if (r.fix && r.status !== "ok") console.log(`      → ${r.fix}`);
  }
  console.log(`\n${fails ? `${fails} problem(s)` : "No problems"}${warns ? `, ${warns} warning(s)` : ""}.`);
}
process.exit(fails ? 1 : 0);
