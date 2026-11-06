// Where the bridge finds the apps' bundled CLIs, against fake app layouts in
// a throwaway dir (the real apps, if installed, are never used).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { codexInMacApps } from "../src/platform.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-platform-"));
const touch = (...parts) => {
  const f = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "");
  return f;
};
const resources = (dir, app) => path.join(dir, app, "Contents", "Resources");

try {
  // 1 macOS ChatGPT.app: current layout (codex-cli + manifest) beats the old one
  {
    const r = resources("apps1", "ChatGPT.app");
    touch(r, "codex");
    const current = touch(r, "codex-cli", "bin", "codex");
    touch(r, "codex-cli", "codex-package.json");
    fs.writeFileSync(path.join(root, r, "codex-cli", "codex-package.json"), JSON.stringify({ entrypoint: "bin/codex" }));
    assert.equal(codexInMacApps([path.join(root, "apps1")]), current);
    console.log("platform 1 macOS current layout: codex-cli/bin/codex");
  }

  // 2 the manifest's entrypoint is followed; without one, bin/codex
  {
    const r = resources("apps2", "ChatGPT.app");
    const moved = touch(r, "codex-cli", "libexec", "codex");
    fs.writeFileSync(path.join(root, r, "codex-cli", "codex-package.json"), JSON.stringify({ entrypoint: "libexec/codex" }));
    assert.equal(codexInMacApps([path.join(root, "apps2")]), moved);
    const r3 = resources("apps3", "ChatGPT.app");
    const plain = touch(r3, "codex-cli", "bin", "codex");
    assert.equal(codexInMacApps([path.join(root, "apps3")]), plain);
    console.log("platform 2 macOS manifest entrypoint followed, bin/codex without one");
  }

  // 3 older builds (Resources/codex); ChatGPT.app wins over Codex.app; nothing
  {
    const old = touch(resources("apps4", "Codex.app"), "codex");
    assert.equal(codexInMacApps([path.join(root, "apps4")]), old);
    const chatgpt = touch(resources("apps4", "ChatGPT.app"), "codex");
    assert.equal(codexInMacApps([path.join(root, "apps4")]), chatgpt);
    assert.equal(codexInMacApps([path.join(root, "none")]), null);
    console.log("platform 3 macOS old layout, ChatGPT.app first, none found");
  }

  // 4 source labels and Claude Desktop's bundled Claude Code, in a child with a
  // fake home and an empty PATH (platform.mjs reads them at import)
  {
    const home = path.join(root, "home");
    // Windows env names are case-insensitive (Path vs PATH): drop them all first
    const drop = /^(path|home|userprofile|appdata|agent_review_bridge_codex_bin|agent_review_bridge_claude_bin|claude_code_execpath)$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.test(k)));
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), PATH: "" });
    const versionDir = process.platform === "win32" ? path.join(env.APPDATA, "Claude", "claude-code", "2.1.0", "abc") : path.join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.0", "abc");
    const claude = process.platform === "win32" ? path.join(versionDir, "claude.exe") : path.join(versionDir, "claude.app", "Contents", "MacOS", "claude");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "");
    const probe = (extra) => {
      // a file URL: import() doesn't take a Windows drive path
      const url = JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/platform.mjs")).href);
      const code = `import(${url}).then((m) => console.log(JSON.stringify({ codex: m.locateCodexCli(), claude: m.findClaudeCli() })))`;
      const r = spawnSync(process.execPath, ["-e", code], { env: { ...env, ...extra }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    assert.deepEqual(probe({ AGENT_REVIEW_BRIDGE_CODEX_BIN: "/x/codex" }).codex, { path: "/x/codex", source: "override" });
    if (process.platform === "win32" || process.platform === "darwin") {
      assert.equal(probe({}).claude, claude);
      console.log("platform 4 override labelled; Claude Desktop's bundled Claude Code found");
    } else console.log("platform 4 override labelled (no bundled Claude Code on this OS)");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
