// Everything that differs between Windows, macOS and Linux lives here: where
// the apps keep their config, where their bundled CLIs are, and how to open a
// deep link. macOS locations were checked on a Mac (ChatGPT 26.1027, Claude
// Code 2.1.309 bundled with Claude Desktop). Each lookup has an env override
// for odd installs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

const home = os.homedir();
const winAppData = () => process.env.APPDATA || path.join(home, "AppData", "Roaming");
const winLocalAppData = () => process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const macAppSupport = path.join(home, "Library", "Application Support");

// Broker state shared by both apps' servers (one per user, not per checkout)
export function dataDir() {
  if (process.env.AGENT_REVIEW_BRIDGE_DIR) return process.env.AGENT_REVIEW_BRIDGE_DIR;
  if (IS_WIN) return path.join(winLocalAppData(), "agent-review-bridge");
  if (IS_MAC) return path.join(macAppSupport, "agent-review-bridge");
  return path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "agent-review-bridge");
}

// The user's own settings for the bridge (rules.md), apart from its state
export function configDir() {
  if (process.env.AGENT_REVIEW_BRIDGE_CONFIG_DIR) return process.env.AGENT_REVIEW_BRIDGE_CONFIG_DIR;
  if (IS_WIN) return path.join(winAppData(), "agent-review-bridge");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "agent-review-bridge");
}
export const rulesFile = () => path.join(configDir(), "rules.md");

export const codexHome = () => process.env.CODEX_HOME || path.join(home, ".codex");
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");

// Legacy: Claude Desktop's own MCP config (servers there are proxied into the
// Code tab without request _meta, so the bridge no longer registers there)
export function claudeDesktopConfig() {
  if (IS_WIN) return path.join(winAppData(), "Claude", "claude_desktop_config.json");
  if (IS_MAC) return path.join(macAppSupport, "Claude", "claude_desktop_config.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

const exe = (name) => (IS_WIN ? `${name}.exe` : name);

function onPath(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

// <root>/<version>/<hash>/<file> layouts: newest file wins
function newestIn(root, depth, file) {
  let dirs = [root];
  for (let i = 0; i < depth; i++) {
    dirs = dirs.flatMap((d) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
      } catch {
        return [];
      }
    });
  }
  return (
    dirs
      .map((d) => path.join(d, file))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
  );
}

const firstExisting = (paths) => paths.find((p) => p && fs.existsSync(p)) ?? null;

// Claude Code CLI: a standalone install, or the copy bundled with Claude
// Desktop (<version>/<hash>/claude.exe on Windows, .../claude.app on macOS)
export function findClaudeCli() {
  if (process.env.AGENT_REVIEW_BRIDGE_CLAUDE_BIN) return process.env.AGENT_REVIEW_BRIDGE_CLAUDE_BIN;
  const bundled = IS_WIN ? path.join(winAppData(), "Claude", "claude-code") : IS_MAC ? path.join(macAppSupport, "Claude", "claude-code") : null;
  const file = IS_MAC ? path.join("claude.app", "Contents", "MacOS", "claude") : exe("claude");
  return onPath("claude") ?? (bundled && newestIn(bundled, 2, file)) ?? process.env.CLAUDE_CODE_EXECPATH ?? null;
}

// Codex CLI bundled with ChatGPT Desktop (the app server API we drive), and
// where it came from: "override" (AGENT_REVIEW_BRIDGE_CODEX_BIN), "app", or "path". A
// codex on PATH is a separate install whose version can differ from the app's.
export function locateCodexCli() {
  if (process.env.AGENT_REVIEW_BRIDGE_CODEX_BIN) return { path: process.env.AGENT_REVIEW_BRIDGE_CODEX_BIN, source: "override" };
  const app = IS_WIN
    ? newestIn(path.join(winLocalAppData(), "OpenAI", "Codex", "bin"), 1, "codex.exe")
    : IS_MAC
      ? codexInMacApps(["/Applications", path.join(home, "Applications")])
      : null;
  if (app) return { path: app, source: "app" };
  const found = onPath("codex");
  return found ? { path: found, source: "path" } : null;
}

export const findCodexCli = () => locateCodexCli()?.path ?? null;

// ChatGPT.app first: the queue we drive is ChatGPT Desktop's. Current builds
// ship the CLI in Resources/codex-cli, described by codex-package.json; older
// ones as Resources/codex.
export function codexInMacApps(dirs) {
  const resources = ["ChatGPT.app", "Codex.app"].flatMap((app) => dirs.map((d) => path.join(d, app, "Contents", "Resources")));
  return firstExisting(resources.flatMap((r) => [codexEntrypoint(path.join(r, "codex-cli")), path.join(r, "codex")]));
}

function codexEntrypoint(dir) {
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(dir, "codex-package.json"), "utf8")).entrypoint;
    if (typeof entry === "string" && entry) return path.join(dir, entry);
  } catch {
    // no manifest: fall back to the layout it describes today
  }
  return path.join(dir, "bin", "codex");
}

// Whether ChatGPT Desktop is running: true, false, or null when the check
// itself failed (callers treat that as closed). The app is recognised by its
// executable, not by name alone: the bundled codex CLI and app-server don't
// count.
export function chatgptRunning() {
  const fake = process.env.AGENT_REVIEW_BRIDGE_FAKE_CHATGPT_RUNNING;
  if (fake !== undefined) return fake === "1" ? true : fake === "0" ? false : null;
  try {
    if (IS_WIN) {
      // a background (window-less) app counts; the bundled CLI doesn't
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "@(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { $_.Path -notmatch '\\\\OpenAI\\\\Codex\\\\bin\\\\' }).Count"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      return Number(out.trim()) > 0;
    }
    if (IS_MAC) {
      const out = execFileSync("ps", ["-axo", "command="], { encoding: "utf8", timeout: 10_000 });
      return /\/(ChatGPT|Codex)\.app\/Contents\/MacOS\/(ChatGPT|Codex)(\s|$)/m.test(out);
    }
    return null; // not detected on Linux
  } catch {
    return null;
  }
}

// Start ChatGPT Desktop in the background (its own delivery then wakes the
// thread). Throws if the OS can't.
export function openChatgpt() {
  if (fakeOpen()) return;
  if (IS_MAC) execFileSync("open", ["-g", "-b", "com.openai.codex"], { stdio: "ignore" });
  else openUrl("codex://");
}

// Tests: AGENT_REVIEW_BRIDGE_FAKE_OPEN=1 opens nothing, =fail fails
function fakeOpen() {
  const fake = process.env.AGENT_REVIEW_BRIDGE_FAKE_OPEN;
  if (fake === "fail") throw new Error("can't open (test)");
  return fake === "1";
}

// Hand a URL (codex://…) to the OS protocol handler
export function openUrl(url) {
  if (fakeOpen()) return;
  // empty title arg so `start` doesn't take the URL as the window title
  if (IS_WIN) execFileSync("cmd.exe", ["/d", "/c", "start", "", url], { stdio: "ignore" });
  else if (IS_MAC) execFileSync("open", ["-g", url], { stdio: "ignore" }); // -g: don't bring the app to the front
  else execFileSync("xdg-open", [url], { stdio: "ignore" });
}
