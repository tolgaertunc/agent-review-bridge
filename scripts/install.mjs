// Register the bridge server with both apps (Windows, macOS, Linux). Config
// files are backed up next to themselves before they are changed.
//   node scripts/install.mjs            install
//   node scripts/install.mjs --uninstall
//
// - Claude: Claude Code user scope (`claude mcp add-json -s user`), so each
//   Code session spawns its own server with its own environment.
//   Its tools are allowed in ~/.claude/settings.json (no permission prompt).
// - ChatGPT Desktop: ~/.codex/config.toml → [mcp_servers.agent_review_bridge] with
//   default_tools_approval_mode = "approve".
// - Hooks in both apps (src/hook.mjs): a Stop hook that queues each turn of a
//   linked primary for review without blocking, a UserPromptSubmit hook that
//   hands over the advisor's nits, and on Claude a background listener that
//   wakes the session when something arrives for it, and a StopFailure hook
//   that tells whoever waits when an API error (a usage limit) ends a turn.
//   In both, a SessionStart hook gives auto mode's rules again after a
//   compaction or a resumed session.
// - Cleans up the blocking Codex Stop hook that older versions registered.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { IS_WIN, claudeConfigDir, codexHome, findClaudeCli } from "../src/platform.mjs";

const uninstall = process.argv.includes("--uninstall");
const server = path.resolve(import.meta.dirname, "../src/server.mjs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const NAME = "agent-review-bridge";

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${stamp}`);
}

// Hooks (same JSON shape in Claude Code settings.json and Codex hooks.json).
// Ours are recognised by the hook script path; other hooks are left alone.
const hookScript = path.resolve(import.meta.dirname, "../src/hook.mjs");
const hookCmd = (app, event) => `"${process.execPath}" "${hookScript}" --app ${app} --event ${event}`;
// any of this bridge's hooks, wherever its checkout was when they were
// installed: a moved folder or a second checkout replaces them, never adds to
// them (each hook would run twice)
const isOurs = (h) => /[\\/]src[\\/]hook\.mjs"?\s+--app\s+(claude|openai)\s+--event\s/.test(h.command ?? "") || h.command?.includes("codex-stop-hook.mjs");

function setHooks(cfg, wanted) {
  cfg.hooks ??= {};
  for (const event of Object.keys(cfg.hooks)) {
    cfg.hooks[event] = cfg.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!cfg.hooks[event].length) delete cfg.hooks[event];
  }
  // a list of hooks, or a group with its matcher
  if (!uninstall) for (const [event, want] of Object.entries(wanted)) (cfg.hooks[event] ??= []).push(Array.isArray(want) ? { hooks: want } : want);
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return cfg;
}

// Codex on Windows doesn't run hook commands through a POSIX shell, and a
// command line that starts with a quoted path is a parse error in PowerShell.
// Use node's space-free 8.3 path there (valid in PowerShell and cmd), or the
// PowerShell call operator when short names are disabled on the volume.
function codexWindowsCmd(event) {
  let node = process.execPath;
  // AGENT_REVIEW_BRIDGE_NO_SHORT_NAMES: act as on a volume without 8.3 names (tests)
  if (!process.env.AGENT_REVIEW_BRIDGE_NO_SHORT_NAMES)
    try {
      // verbatim: Node's own quoting would mangle the quotes cmd needs here
      const short = execFileSync("cmd.exe", [`/d /c for %I in ("${process.execPath}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).trim();
      if (short && fs.existsSync(short)) node = short;
    } catch {
      // keep the long path
    }
  const rest = `"${hookScript}" --app openai --event ${event}`;
  return /\s/.test(node) ? `& "${node}" ${rest}` : `${node} ${rest}`;
}

const quick = (app, event) => ({
  type: "command",
  command: hookCmd(app, event),
  ...(app === "openai" && IS_WIN && { commandWindows: codexWindowsCmd(event) }),
  timeout: 10,
});
// Claude's listener: background, wakes the session (exit 2) when a message
// for it arrives; re-armed on every Stop and SessionStart
const claudeListener = { type: "command", command: hookCmd("claude", "listen"), asyncRewake: true, timeout: 12 * 3600 };
const CLAUDE_HOOKS = {
  Stop: [quick("claude", "stop"), claudeListener],
  // an API error (a usage limit) ended the turn: whoever waits is told
  StopFailure: [quick("claude", "stopfail")],
  // the auto mode rules again after a compaction or a resumed session
  SessionStart: [claudeListener, quick("claude", "start")],
  UserPromptSubmit: [quick("claude", "prompt")],
  // a chat working for another waits on the user to approve a tool: whoever
  // waits on it is told (only when the prompt is really shown and unanswered)
  Notification: { matcher: "permission_prompt", hooks: [quick("claude", "permission")] },
};
const CODEX_HOOKS = {
  Stop: [quick("openai", "stop")],
  UserPromptSubmit: [quick("openai", "prompt")],
  // the auto mode rules again after a compaction or a resumed chat
  SessionStart: [quick("openai", "start")],
};

// Claude Code: user scope via its own CLI (it owns ~/.claude.json)
{
  const claude = findClaudeCli();
  const spec = {
    type: "stdio",
    command: process.execPath,
    // the session's own environment (CLAUDE_CODE_SESSION_ID) is inherited;
    // `${VAR}` in user-scope env is not expanded, so nothing to pass here
    args: [server, "--side", "claude"],
  };
  if (!claude) {
    console.log("Claude Code CLI not found (set AGENT_REVIEW_BRIDGE_CLAUDE_BIN). Run this yourself:");
    console.log(uninstall ? `  claude mcp remove ${NAME} -s user` : `  claude mcp add-json ${NAME} '${JSON.stringify(spec)}' -s user`);
  } else {
    const run = (...args) => execFileSync(claude, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      run("mcp", "remove", NAME, "-s", "user");
    } catch {
      // not registered yet
    }
    if (!uninstall) run("mcp", "add-json", NAME, JSON.stringify(spec), "-s", "user");
    console.log(`${uninstall ? "removed from" : "added to"} Claude Code user scope (${claude})`);
  }
}

// Claude Code permissions: allow the bridge's tools without a prompt, the
// Claude-side counterpart of default_tools_approval_mode below (Claude can be
// the agent that gets called, and a woken session can't wait for a click)
{
  const file = path.join(claudeConfigDir(), "settings.json");
  const rule = `mcp__${NAME}`;
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const allow = cfg.permissions?.allow ?? [];
  backup(file);
  cfg.permissions ??= {};
  cfg.permissions.allow = uninstall ? allow.filter((r) => r !== rule) : allow.includes(rule) ? allow : [...allow, rule];
  if (!cfg.permissions.allow.length) delete cfg.permissions.allow;
  if (!Object.keys(cfg.permissions).length) delete cfg.permissions;
  setHooks(cfg, CLAUDE_HOOKS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`${uninstall ? "removed" : "set"} ${rule} permission and hooks in ${file}`);
}

// ChatGPT Desktop (Codex-based): config.toml → [mcp_servers.agent_review_bridge]
{
  const file = path.join(codexHome(), "config.toml");
  const begin = "# >>> agent-review-bridge (managed by agent-review-bridge/scripts/install.mjs)";
  const end = "# <<< agent-review-bridge";
  const toml = (s) => `'${s}'`; // literal strings: no escaping of backslashes
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  backup(file);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  text = text.replace(new RegExp(`\\n*${esc(begin)}[\\s\\S]*?${esc(end)}\\n?`, "g"), "\n");
  if (!uninstall) {
    text =
      text.trimEnd() +
      `\n\n${begin}\n[mcp_servers.agent_review_bridge]\ncommand = ${toml(process.execPath)}\nargs = [${toml(server)}, "--side", "openai"]\n` +
      // a looping advisor can't stop for an approval click on every call
      `default_tools_approval_mode = "approve"\n${end}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`${uninstall ? "removed from" : "added to"} ${file}`);
}

// Codex hooks: the non-blocking review trigger and the nits injector (the
// blocking Stop hook of experiment H1 is removed by setHooks as well)
{
  const file = path.join(codexHome(), "hooks.json");
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  backup(file);
  setHooks(cfg, CODEX_HOOKS);
  if (Object.keys(cfg).length) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  else fs.rmSync(file, { force: true });
  console.log(`${uninstall ? "removed hooks from" : "set hooks in"} ${file}`);
}

console.log("Restart both apps for the change to take effect.");
// ChatGPT skips a new or changed hook until the user trusts it
if (!uninstall) console.log("ChatGPT Desktop: open it normally, with its window, and trust the agent-review-bridge hooks it asks you to review; `npm run doctor` shows any it still skips.");
