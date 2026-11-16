// Runs a command from a review request the way a reviewer would: the POSIX
// form through bash (Git Bash on Windows, where cmd.exe, execSync's shell,
// doesn't understand single quotes), the PowerShell form through pwsh or
// Windows PowerShell where one is installed. Shared by the tests that run
// those commands.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Git's own bash. On Windows, `bash` from PATH can be WSL's (from PowerShell,
// for one), so it is looked for next to git: `git --exec-path` is
// ...\Git\mingw64\libexec\git-core, bash is in ...\Git\bin or ...\Git\usr\bin.
// Elsewhere, bash.
export function gitBash({ platform = process.platform, execPath = () => execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), exists = fs.existsSync } = {}) {
  if (platform !== "win32") return "bash";
  try {
    const base = execPath();
    for (const rel of ["../../../bin/bash.exe", "../../../usr/bin/bash.exe"]) {
      const p = path.win32.resolve(base, rel);
      if (exists(p)) return p;
    }
  } catch {
    // no git to ask: PATH's bash
  }
  return "bash";
}

const BASH = gitBash();
export const runPosix = (cmd) => execFileSync(BASH, ["-c", cmd], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

// the PowerShell there is, if any
export const powershell =
  ["pwsh", "powershell"].find((exe) => {
    try {
      execFileSync(exe, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }) ?? null;

export const runPowershell = (cmd) => execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
