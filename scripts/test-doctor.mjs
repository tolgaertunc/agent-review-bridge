// doctor against throwaway config dirs and broker: it must report what's
// missing, and catch Codex hooks that are installed but not trusted (Codex
// skips those silently).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { findCodexCli } from "../src/platform.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-doctor-"));
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  CODEX_HOME: path.join(root, "codex"),
  PEER_BRIDGE_DIR: path.join(root, "data"),
  PEER_BRIDGE_PORT: "7489",
  PEER_BRIDGE_CONFIG_DIR: path.join(root, "config"),
};
for (const d of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) fs.mkdirSync(d);
fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), 'model = "x"\n');

function doctor() {
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "doctor.mjs"), "--json"], { env, encoding: "utf8", timeout: 180_000 });
  const report = JSON.parse(r.stdout);
  const get = (area, name) => report.results.find((x) => x.area === area && x.name === name);
  return { code: r.status, report, get };
}

// nothing installed
let d = doctor();
assert.equal(d.code, 1);
assert.equal(d.get("Claude Code", "MCP server").status, "fail");
assert.equal(d.get("Claude Code", "Stop hook (stop)").status, "fail");
assert.equal(d.get("ChatGPT Desktop", "MCP server").status, "fail");
assert.equal(d.get("Broker", "owner").status, "warn");
assert.match(d.get("Rules", "rules file").detail, /^none/, "no rules file: reported, not a problem");
assert.match(d.get("Rules", "closed apps").detail, /\(ask\)$/, "asking first is the default");
fs.mkdirSync(env.PEER_BRIDGE_CONFIG_DIR);
fs.writeFileSync(path.join(env.PEER_BRIDGE_CONFIG_DIR, "rules.md"), "x".repeat(9000));
assert.equal(doctor().get("Rules", "rules file").status, "warn", "a file over the cap is flagged");
fs.writeFileSync(path.join(env.PEER_BRIDGE_CONFIG_DIR, "rules.md"), "Answer in Turkish.");
assert.equal(doctor().get("Rules", "rules file").status, "ok");
console.log(`doctor 1 nothing installed: ${d.report.fails} problems reported, exit 1`);

// installed into the throwaway configs: Claude side clean; Codex hooks are
// present but untrusted in this fresh CODEX_HOME, which doctor must flag
execFileSync(process.execPath, [path.resolve(import.meta.dirname, "install.mjs")], { env, stdio: "ignore" });
d = doctor();
for (const n of ["MCP server", "tool permission", "Stop hook (stop)", "Stop hook (listen)", "StopFailure hook (stopfail)", "SessionStart hook (listen)", "UserPromptSubmit hook (prompt)"])
  assert.equal(d.get("Claude Code", n).status, "ok", `Claude Code ${n}: ${d.get("Claude Code", n).detail}`);
assert.equal(d.get("ChatGPT Desktop", "MCP server").status, "ok");
assert.equal(d.get("ChatGPT Desktop", "tool approval").status, "ok");
if (findCodexCli()) {
  const stop = d.get("ChatGPT Desktop", "stop hook");
  assert.equal(stop.status, "fail");
  assert.match(stop.detail, /untrusted|modified/);
  assert.match(stop.fix, /trust/);
  console.log(`doctor 2 installed: Claude side clean; Codex hooks flagged as "${stop.detail}"`);
} else console.log("doctor 2 installed: Claude side clean (no codex here, trust not checked)");

execFileSync(process.execPath, [path.resolve(import.meta.dirname, "install.mjs"), "--uninstall"], { env, stdio: "ignore" });
try {
  // a server the health check started may still hold a file for a moment
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch {
  // leftovers in the temp dir are harmless
}
