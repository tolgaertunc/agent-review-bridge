// Install / reinstall / uninstall against throwaway config dirs. The env is
// built here and passed explicitly, so a failed setup step can never fall
// through to the real ~/.claude and ~/.codex.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-install-"));
const claudeDir = path.join(root, "claude");
const codexDir = path.join(root, "codex");
for (const d of [claudeDir, codexDir]) fs.mkdirSync(d);
const realHome = os.homedir();
assert.ok(!claudeDir.startsWith(path.join(realHome, ".claude")) && !codexDir.startsWith(path.join(realHome, ".codex")));

const otherClaudeHook = { type: "command", command: "echo other" };
const otherCodexHook = { type: "command", command: "echo keep" };
const legacyCodexHook = { type: "command", command: "node C:\\x\\codex-stop-hook.mjs", timeout: 330 };
fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [otherClaudeHook] }] } }));
fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [legacyCodexHook] }], PreToolUse: [{ matcher: "Bash", hooks: [otherCodexHook] }] } }));
fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "x"\n');

const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
const install = (...a) => execFileSync(process.execPath, [path.resolve(import.meta.dirname, "install.mjs"), ...a], { env, encoding: "utf8" });
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const ours = (h) => h.command.includes("hook.mjs");
const flat = (cfg) => Object.fromEntries(Object.entries(cfg.hooks ?? {}).map(([e, gs]) => [e, gs.flatMap((g) => g.hooks)]));

install();
install(); // idempotent
let claude = flat(read(path.join(claudeDir, "settings.json")));
let codex = flat(read(path.join(codexDir, "hooks.json")));
assert.deepEqual(read(path.join(claudeDir, "settings.json")).permissions.allow, ["Bash(ls:*)", "mcp__peer-bridge"]);
assert.equal(claude.Stop.filter(ours).length, 2);
assert.ok(claude.Stop.some((h) => h.command === "echo other"));
assert.ok(claude.Stop.find((h) => h.command.includes("--event listen")).asyncRewake);
assert.equal(claude.SessionStart.filter(ours).length, 1);
assert.ok(claude.StopFailure.filter(ours).length === 1 && claude.StopFailure[0].command.includes("--event stopfail"));
assert.equal(claude.UserPromptSubmit.filter(ours).length, 1);
assert.equal(codex.Stop.length, 1, "legacy blocking hook replaced");
assert.ok(codex.Stop[0].command.includes("--event stop"));
assert.ok(!codex.Stop[0].asyncRewake && codex.Stop[0].timeout === 10);
if (process.platform === "win32") {
  // PowerShell can't start a command line with a quoted path
  const w = codex.Stop[0].commandWindows;
  assert.ok(w && !w.startsWith('"'), `commandWindows must not start with a quote: ${w}`);
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `'{}' | ${w}; exit $LASTEXITCODE`], { env: { ...env, PEER_BRIDGE_DIR: root } });
}
assert.equal(codex.PreToolUse[0].command, "echo keep");
const toml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
assert.equal(toml.match(/>>> peer-bridge/g).length, 1);
assert.match(toml, /default_tools_approval_mode = "approve"/);
console.log("install ×2: one copy of each hook, other hooks kept, legacy Codex hook replaced, approvals set");

install("--uninstall");
claude = read(path.join(claudeDir, "settings.json"));
codex = read(path.join(codexDir, "hooks.json"));
assert.deepEqual(claude, { permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [otherClaudeHook] }] } });
assert.deepEqual(codex, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [otherCodexHook] }] } });
assert.equal(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8").trim(), 'model = "x"');
console.log("uninstall: only our entries removed");

// Windows volume without 8.3 names: the PowerShell call-operator form is
// written instead, and it runs the hook
if (process.platform === "win32") {
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, "install.mjs")], { env: { ...env, PEER_BRIDGE_NO_SHORT_NAMES: "1" }, encoding: "utf8" });
  const w = flat(read(path.join(codexDir, "hooks.json"))).Stop[0].commandWindows;
  assert.ok(w.startsWith('& "') && w.includes(process.execPath), `fallback form expected, got: ${w}`);
  const dataDir = path.join(root, "data");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `'{"session_id":"fallback-probe"}' | ${w}; exit $LASTEXITCODE`], {
    env: { ...env, PEER_BRIDGE_DIR: dataDir },
  });
  fs.writeFileSync(path.join(dataDir, "debug-hooks"), "");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `'{"session_id":"fallback-probe"}' | ${w}; exit $LASTEXITCODE`], {
    env: { ...env, PEER_BRIDGE_DIR: dataDir },
  });
  assert.match(fs.readFileSync(path.join(dataDir, "hooks.jsonl"), "utf8"), /"session_id":"fallback-probe"/, "fallback command must reach the hook");
  install("--uninstall");
  console.log("no 8.3 names: PowerShell call-operator fallback written and runs the hook");
}

fs.rmSync(root, { recursive: true, force: true });
