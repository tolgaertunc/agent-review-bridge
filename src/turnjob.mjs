// Puts together the review of one turn that auto mode reviews on its own,
// away from the broker's loop: the broker owner runs it as a child process,
// with the job as JSON on stdin, and reads { text, reqPaths } or { error }
// as JSON on stdout. It reads the work tree (git, and the files for the
// fingerprints) and writes nothing but the fingerprints' cache.

import { turnRequest } from "./request.mjs";
import { snapshotSummary, snapshotCommand } from "./git.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let result;
try {
  // tests: a build that fails or takes too long
  if (process.env.AGENT_REVIEW_BRIDGE_TEST_TURNJOB === "fail") throw new Error("a test failure");
  if (process.env.AGENT_REVIEW_BRIDGE_TEST_TURNJOB === "slow") await new Promise((r) => setTimeout(r, 60_000));
  const delay = /^delay:(\d+)$/.exec(process.env.AGENT_REVIEW_BRIDGE_TEST_TURNJOB ?? "");
  if (delay) await new Promise((r) => setTimeout(r, Number(delay[1])));
  const job = JSON.parse(raw);
  // the turn's own changes, from its start to its end, however long ago that
  // was: what changed, and the command that shows it
  const snapshots = !!(job.cwd && job.base && job.snap);
  const summary = snapshots ? snapshotSummary(job.cwd, job.base, job.snap) : null;
  const command = summary ? (shell) => snapshotCommand(job.cwd, job.base, job.snap, shell) : null;
  // snapshots that can't be read any more (git may have pruned them after a long wait)
  result = turnRequest({ ...job, summary, command, gone: snapshots && summary == null, folder: job.cwd });
} catch (e) {
  result = { error: String(e.message || e) };
}
await new Promise((resolve) => process.stdout.write(JSON.stringify(result), resolve));
