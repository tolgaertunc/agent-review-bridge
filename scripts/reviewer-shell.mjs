// Runs a command from a review request the way a reviewer would: the POSIX
// form through bash (Git Bash on Windows, where cmd.exe, execSync's shell,
// doesn't understand single quotes), the PowerShell form through pwsh or
// Windows PowerShell where one is installed. Shared by the tests that run
// those commands.

import { execFileSync } from "node:child_process";

export const runPosix = (cmd) => execFileSync("bash", ["-c", cmd], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

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
