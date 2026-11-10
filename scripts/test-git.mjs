// Turn diffs (src/git.mjs) against throwaway repos: secrets stay out (files
// and whole directories, content and names), repos without commits work,
// edits to already-untracked files show up, and the size cap covers it all.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { baseline, snapshotSummary, snapshotCommand, pathInfo, reviewSummary, pathCommand, shellArg, fingerprint, usableBase } from "../src/git.mjs";
import { commandBlocks } from "../src/request.mjs";
import { runPosix, powershell, runPowershell } from "./reviewer-shell.mjs";

// the fingerprint keeps a small cache in the bridge's data folder: a throwaway one here
process.env.AGENT_REVIEW_BRIDGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-gitdata-"));

function repo({ commit = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-git-"));
  const git = (...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q");
  if (commit) {
    fs.writeFileSync(path.join(d, "a.js"), "1\n");
    git("add", ".");
    git("commit", "-qm", "init");
  }
  return { d, git, write: (f, c) => (fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), c)) };
}

// a turn's own changes, from a snapshot at its start to one taken now (its
// end): the summary the request carries, and what its command prints
const turnSummary = (d, base) => snapshotSummary(d, base, baseline(d));
const shown = (d, base, end) => runPosix(snapshotCommand(d, base, end));

// secrets: files and directories, never content nor name
{
  const r = repo();
  const base = baseline(r.d);
  for (const f of ["secrets/config.json", ".envrc", ".env.local", "my-credentials/x.txt", "deploy/server.pem", ".ssh/id_ed25519", "config/app_secret.yml"]) r.write(f, "TOPSECRET\n");
  r.write("a.js", "2\n");
  const end = baseline(r.d);
  const d = snapshotSummary(r.d, base, end) + shown(r.d, base, end);
  assert.match(d, /a\.js[\s\S]*-1\n\+2/);
  assert.doesNotMatch(d, /TOPSECRET|secrets|envrc|\.env|credentials|\.pem|\.ssh|app_secret/);
  console.log("git 1 secret files and directories excluded (content and names)");
}

// repo without commits: baseline and diff still work
{
  const r = repo({ commit: false });
  r.write("x.js", "old\n");
  const base = baseline(r.d);
  assert.ok(base, "baseline in a repo without commits");
  r.write("x.js", "changed\n");
  r.write("y.js", "new\n");
  const d = turnSummary(r.d, base);
  assert.match(d, /New untracked files:\ny\.js/);
  assert.match(d, /Edited untracked files[^\n]*:\nx\.js/);
  assert.equal(turnSummary(r.d, null), null, "no snapshot at the start: nothing");
  console.log("git 2 repo without commits: new and edited untracked files reported");
}

// edits to a file that was already untracked at turn start
{
  const r = repo();
  r.write("notes.md", "v1\n");
  const base = baseline(r.d);
  assert.equal(turnSummary(r.d, base), "", "nothing changed");
  r.write("notes.md", "v2\n");
  assert.match(turnSummary(r.d, base), /Edited untracked files[^\n]*:\nnotes\.md/);
  console.log("git 3 edited pre-existing untracked file reported");
}

// the cap covers summary and file lists, not just the patch
{
  const r = repo();
  for (let i = 0; i < 300; i++) r.write(`f${i}.txt`, "a\n");
  r.git("add", ".");
  r.git("commit", "-qm", "many");
  const base = baseline(r.d);
  for (let i = 0; i < 300; i++) r.write(`f${i}.txt`, "b".repeat(500) + "\n");
  for (let i = 0; i < 120; i++) r.write(`new${i}.txt`, "n\n");
  const d = turnSummary(r.d, base);
  assert.ok(d.length < 6000, `a long turn's summary stays short (${d.length} chars)`);
  assert.match(d, /more files/);
  assert.match(d, /… 70 more/);
  console.log(`git 4 a long turn's summary is cut: stat and lists (${d.length} chars)`);
}

// review paths: the summary and the reviewer's command leave secrets out and
// work for a single file in a subfolder
{
  const r = repo();
  r.write("src/app.js", "1\n");
  r.git("add", ".");
  r.git("commit", "-qm", "app");
  const indexBefore = fs.statSync(path.join(r.d, ".git", "index")).mtimeMs;
  r.write("src/app.js", "2\n");
  r.write("src/new.js", "n\n");
  r.write(".env", "TOPSECRET\n");
  r.write("src/.env.local", "TOPSECRET\n");
  const info = pathInfo(r.d);
  const sum = reviewSummary(info, info.head);
  assert.match(sum.status, /src\/app\.js/);
  assert.match(sum.status, /\?\? src\/new\.js/);
  assert.doesNotMatch(sum.status + sum.stat, /\.env/);
  assert.match(sum.command, /--no-ext-diff --no-textconv/);
  assert.match(sum.command, /':\(glob,exclude\)\*\*\/\.env\*'/);
  const file = pathInfo(path.join(r.d, "src", "app.js"));
  assert.equal(file.spec, "src/app.js");
  assert.equal(fs.realpathSync(file.top), fs.realpathSync(r.d));
  const shown = runPosix(reviewSummary(file, file.head).command);
  assert.match(shown, /^\+2$/m);
  assert.doesNotMatch(shown, /new\.js|TOPSECRET/);
  assert.equal(fs.statSync(path.join(r.d, ".git", "index")).mtimeMs, indexBefore, "the summary doesn't rewrite the index");
  for (let i = 0; i < 120; i++) r.write(`many/f${i}.js`, "x\n");
  const big = reviewSummary(pathInfo(r.d), pathInfo(r.d).head);
  assert.match(big.status, /… \d+ more changed or new files$/, "a long list is cut");
  assert.ok(big.status.split("\n").length <= 51);
  console.log("git 5 review summary and command: secrets left out, a single file in a subfolder works, long lists cut, the index untouched");
}

// fingerprint: commits don't change it, edits, new files, deletes, the
// executable bit and symlink targets do, secret files don't; nothing is
// written to the repository
{
  const r = repo();
  r.write("b.js", "b\n");
  const loose = () => execFileSync("git", ["-C", r.d, "count-objects"], { encoding: "utf8" });
  const objects = loose();
  const fp = () => fingerprint(r.d).hash;
  const f1 = fp();
  assert.equal(loose(), objects, "fingerprinting writes no git objects");
  r.git("add", ".");
  r.git("commit", "-qm", "b");
  assert.equal(fp(), f1, "committing the same content keeps the fingerprint");
  r.write(".env", "x\n");
  assert.equal(fp(), f1, "secret files don't count");
  r.write("b.js", "b2\n");
  const f2 = fp();
  assert.notEqual(f2, f1, "an edit changes it");
  // same length, old mtime put back: the cache must not hide it
  const { mtime } = fs.statSync(path.join(r.d, "b.js"));
  r.write("b.js", "b9\n");
  fs.utimesSync(path.join(r.d, "b.js"), mtime, mtime);
  assert.notEqual(fp(), f2, "an edit with the old mtime put back still counts");
  r.write("b.js", "b2\n");
  r.write("c.js", "c\n");
  const f3 = fp();
  assert.notEqual(f3, f2, "a new file changes it");
  // Windows files have no executable bit (chmod only sets read-only)
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(r.d, "c.js"), 0o755);
    assert.notEqual(fp(), f3, "the executable bit changes it");
  }
  // a file symlink needs Developer Mode or admin rights on Windows
  let symlinks = true;
  try {
    fs.symlinkSync("a.js", path.join(r.d, "link"));
  } catch (e) {
    if (process.platform !== "win32" || e.code !== "EPERM") throw e;
    symlinks = false;
  }
  if (symlinks) {
    const toA = fp();
    fs.rmSync(path.join(r.d, "link"));
    fs.symlinkSync("b.js", path.join(r.d, "link"));
    assert.notEqual(fp(), toA, "a symlink's target changes it");
  }
  const f5 = fp();
  r.git("add", ".");
  r.git("commit", "-qm", "all");
  fs.rmSync(path.join(r.d, "a.js"));
  const f6 = fp();
  assert.notEqual(f6, f5, "a delete changes it");
  r.git("commit", "-qam", "rm");
  assert.equal(fp(), f6, "committing the delete doesn't");
  // an index flag can't hide an edit
  r.git("update-index", "--assume-unchanged", "b.js");
  r.write("b.js", "hidden from git status\n");
  assert.notEqual(fp(), f6, "an assume-unchanged file's edit still counts");
  // a file that can't be read makes the check fail visibly
  r.write("locked.txt", "x\n");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    fs.chmodSync(path.join(r.d, "locked.txt"), 0);
    try {
      assert.match(fingerprint(r.d).error, /can't read .*locked\.txt/);
    } finally {
      fs.chmodSync(path.join(r.d, "locked.txt"), 0o644);
    }
    fs.mkdirSync(path.join(r.d, "closed"));
    r.write("closed/in.txt", "x\n");
    r.git("add", ".");
    r.git("commit", "-qm", "closed");
    fs.chmodSync(path.join(r.d, "closed"), 0);
    try {
      assert.match(fingerprint(r.d).error ?? "", /can't read .*in\.txt \(EACCES\)/, "no access isn't taken for a delete");
      assert.match(fingerprint(path.join(r.d, "closed", "in.txt"), { fresh: true }).error ?? "", /can't read .*in\.txt \(EACCES\)/, "nor when the file itself is asked for");
    } finally {
      fs.chmodSync(path.join(r.d, "closed"), 0o755);
    }
  }
  // folders outside git, with the same secret rule
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-plain-"));
  fs.writeFileSync(path.join(plain, "x.txt"), "1");
  const p1 = fingerprint(plain).hash;
  fs.writeFileSync(path.join(plain, ".env"), "TOPSECRET");
  assert.equal(fingerprint(plain).hash, p1, "secrets don't count outside git either");
  fs.writeFileSync(path.join(plain, "x.txt"), "2");
  assert.notEqual(fingerprint(plain).hash, p1, "an edit outside git counts");
  // a path named through a link to a folder is that folder, in git or not
  const links = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-links-"));
  const kind = process.platform === "win32" ? "junction" : "dir";
  try {
    const toRepo = path.join(links, "repo-link");
    fs.symlinkSync(r.d, toRepo, kind);
    const viaLink = pathInfo(toRepo);
    assert.equal(viaLink.git, true, "a link to a repository is reviewed in that repository");
    assert.equal(viaLink.spec, ".");
    const l1 = fingerprint(toRepo).hash;
    r.write("b.js", "edited through the link\n");
    assert.notEqual(fingerprint(toRepo).hash, l1, "an edit behind a folder link counts");
    const toPlain = path.join(links, "plain-link");
    fs.symlinkSync(plain, toPlain, kind);
    const l2 = fingerprint(toPlain).hash;
    fs.writeFileSync(path.join(plain, "x.txt"), "3");
    assert.notEqual(fingerprint(toPlain).hash, l2, "an edit behind a link to a plain folder counts");
  } finally {
    fs.rmSync(links, { recursive: true, force: true });
  }
  console.log(
    "git 6 fingerprint: content-based, committed deletes and secrets don't count, index flags can't hide edits, unreadable files fail visibly, plain folders and folder links too" +
      (process.platform === "win32" ? " (Windows: no executable bit to check)" : "") +
      (symlinks ? "" : " (file symlinks not allowed here: their check skipped)"),
  );
}

// a base that left HEAD's history isn't used
{
  const r = repo();
  const first = pathInfo(r.d).head;
  r.write("a.js", "2\n");
  r.git("commit", "-qam", "two");
  assert.ok(usableBase(pathInfo(r.d), first), "an ancestor is usable");
  r.git("checkout", "-q", "--orphan", "other");
  r.git("commit", "-qm", "orphan");
  assert.ok(!usableBase(pathInfo(r.d), first), "a commit off this branch isn't");
  console.log("git 7 a base off the current history isn't used");
}

// 8. a turn's own changes between two snapshots: a turn that commits (with a
// new staged file) still shows them, a clean tree's snapshot is HEAD, a repo
// without commits works, untracked files compare by hash, what came after the
// end isn't in it, and secret files stay out
{
  const r = repo();
  r.write("a.js", "2\n");
  r.write("notes.txt", "kept\n");
  const base = baseline(r.d);
  r.write("a.js", "3\n");
  r.write("b.js", "new\n");
  r.write("notes.txt", "edited\n");
  r.write(".env", "SECRET=1\n");
  r.git("add", "a.js", "b.js");
  r.git("commit", "-qm", "in the turn");
  const end = baseline(r.d); // a.js and b.js committed: HEAD moved
  r.write("a.js", "4\n"); // after the turn ended
  const d = snapshotSummary(r.d, base, end);
  const patch = shown(r.d, base, end);
  assert.match(patch, /-2\n\+3/, "the committed change is the turn's, as its command shows");
  assert.match(d + patch, /b\.js/, "a new staged file too");
  assert.match(d, /Edited untracked files \(content not tracked by git\):\nnotes\.txt/);
  assert.doesNotMatch(d + patch, /\+4|SECRET|\.env/, "nothing after the end, no secrets");
  assert.match(snapshotCommand(r.d, base, end), new RegExp(`diff --no-ext-diff --no-textconv ${base.ref} ${end.ref} -- \\. ':\\(glob,exclude\\)\\*\\*/\\.env\\*'`));
  // a clean tree: stash create makes nothing, HEAD stands in
  const clean = repo();
  assert.equal(snapshotSummary(clean.d, baseline(clean.d), baseline(clean.d)), "");
  // a repo without commits
  const empty = repo({ commit: false });
  const b0 = baseline(empty.d);
  empty.write("x.js", "x\n");
  assert.match(snapshotSummary(empty.d, b0, baseline(empty.d)), /New untracked files:\nx\.js/);
  assert.equal(snapshotSummary(r.d, base, null), null, "no end snapshot: nothing");
  // a merge with conflicts: git can't save the work tree, so there is no
  // snapshot (HEAD would misstate the turn)
  const m = repo();
  m.git("checkout", "-q", "-b", "other");
  m.write("a.js", "other\n");
  m.git("commit", "-qam", "other");
  m.git("checkout", "-q", "-");
  m.write("a.js", "mine\n");
  m.git("commit", "-qam", "mine");
  assert.throws(() => m.git("merge", "-q", "other"), "the merge conflicts");
  assert.equal(baseline(m.d), null, "a conflicted merge: no snapshot");
  // git can't say what HEAD is (a timeout, an error): no snapshot either, not
  // the empty tree of a repo without commits
  if (process.platform !== "win32") {
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-fakegit-"));
    fs.writeFileSync(path.join(fake, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--verify" ] && exit 2; done\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${fake}${path.delimiter}${PATH}`;
    try {
      assert.equal(baseline(clean.d), null, "HEAD unknown: no snapshot");
    } finally {
      process.env.PATH = PATH;
      fs.rmSync(fake, { recursive: true, force: true });
    }
  }
  for (const x of [r, clean, empty, m]) fs.rmSync(x.d, { recursive: true, force: true });
  console.log("git 8 a turn's own changes between snapshots: its command shows commits and staged files in it, untracked by hash, nothing after its end, no secrets, clean and commit-less repos; no snapshot in a conflicted merge or when git can't say what HEAD is");
}

// the reviewer's shell: every command quoted for the shell that runs it, a
// repo path with a space, an apostrophe, $ or a backtick included; POSIX run
// through bash, PowerShell checked by its text and run where it's installed
{
  assert.equal(shellArg("a b'c"), `'a b'\\''c'`);
  assert.equal(shellArg("a b'c", "powershell"), "'a b''c'");
  assert.equal(shellArg("O’Brien", "powershell"), "'O’’Brien'", "PowerShell takes the curly quote as a quote");
  assert.equal(shellArg("O’Brien"), "'O’Brien'");
  assert.equal(shellArg("$HOME `date`", "powershell"), "'$HOME `date`'", "$ and ` stay literal in single quotes");
  assert.equal(commandBlocks((sh) => `cmd-${sh}`, ["posix"]), "```sh\ncmd-posix\n```");
  assert.equal(
    commandBlocks((sh) => `cmd-${sh}`, ["posix", "powershell"]),
    "In bash (Claude Code on Windows runs Git Bash):\n```sh\ncmd-posix\n```\nIn PowerShell (ChatGPT on Windows runs PowerShell):\n```powershell\ncmd-powershell\n```",
    "on Windows both, labeled",
  );
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-quotes-"));
  for (const name of ["with space and O'Brien", "O'Brien $HOME", "O'Brien `date`", "O’Brien"]) {
    const d = path.join(parent, name);
    fs.mkdirSync(d);
    const g = (...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
    g("init", "-q");
    fs.writeFileSync(path.join(d, "a.js"), "1\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const base = baseline(d);
    fs.writeFileSync(path.join(d, "a.js"), "2\n");
    const end = baseline(d);
    const info = pathInfo(d);
    for (const [what, cmd] of [
      ["the folder's command", (sh) => pathCommand(info, info.head, sh)],
      ["the turn's command", (sh) => snapshotCommand(d, base, end, sh)],
    ]) {
      assert.match(runPosix(cmd("posix")), /^-1\n\+2$/m, `${name}: ${what} in bash`);
      const ps = cmd("powershell");
      assert.ok(ps.includes(shellArg(what === "the turn's command" ? d : info.top, "powershell")), `${name}: ${what}, the path quoted for PowerShell`);
      assert.match(ps, / '--' /, "-- quoted for PowerShell");
      if (powershell) assert.match(runPowershell(ps), /^-1\n\+2$/m, `${name}: ${what} in PowerShell`);
    }
  }
  fs.rmSync(parent, { recursive: true, force: true });
  console.log(`git 9 commands quoted per shell (space, apostrophe, $, backtick, curly apostrophe): bash runs them${powershell ? `, and ${powershell} too` : "; no PowerShell here, its form checked by text only"}; on Windows both forms, labeled`);
}

// git stash create runs on a copy of the index: a stat-dirty index isn't
// written back, another git's index.lock doesn't stop the snapshot, a linked
// worktree's own index is the one copied, and no copy is left behind
{
  const r = repo();
  const index = path.join(r.d, ".git", "index");
  const before = fs.readFileSync(index);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(r.d, "a.js"), later, later); // stat-dirty, same content
  assert.ok(baseline(r.d), "a snapshot");
  r.write("a.js", "2\n");
  const dirty = baseline(r.d);
  assert.ok(dirty?.ref, "with changes too");
  assert.ok(fs.readFileSync(index).equals(before), ".git/index never written");
  fs.writeFileSync(`${index}.lock`, "");
  try {
    const locked = baseline(r.d);
    const tree = (ref) => execFileSync("git", ["-C", r.d, "rev-parse", `${ref}^{tree}`], { encoding: "utf8" }).trim();
    assert.ok(locked?.ref, "another git's lock doesn't stop it");
    assert.equal(tree(locked.ref), tree(dirty.ref), "the same content (a new stash commit each time)");
    assert.ok(fs.existsSync(`${index}.lock`), "nor is that lock touched");
  } finally {
    fs.rmSync(`${index}.lock`, { force: true });
  }
  const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-bridge-wt-"));
  const wt = path.join(wtParent, "side");
  r.git("worktree", "add", "-q", "-b", "side", wt);
  const wtIndex = execFileSync("git", ["-C", wt, "rev-parse", "--git-path", "index"], { encoding: "utf8" }).trim();
  const wtBefore = fs.readFileSync(path.resolve(wt, wtIndex));
  fs.writeFileSync(path.join(wt, "a.js"), "side\n");
  const side = baseline(wt);
  assert.ok(side?.ref && side.ref !== dirty.ref, "a linked worktree's own changes");
  assert.match(runPosix(snapshotCommand(wt, { ref: pathInfo(wt).head }, side)), /^\+side$/m);
  assert.ok(fs.readFileSync(path.resolve(wt, wtIndex)).equals(wtBefore), "its index never written either");
  assert.deepEqual(fs.readdirSync(path.join(process.env.AGENT_REVIEW_BRIDGE_DIR, "tmp")), [], "no copy left behind");
  r.git("worktree", "remove", "--force", wt);
  fs.rmSync(r.d, { recursive: true, force: true });
  fs.rmSync(wtParent, { recursive: true, force: true });
  console.log("git 10 stash create on a copy of the index: the real one (a linked worktree's too) never written, another git's lock no obstacle, nothing left behind");
}

// before the first commit: staged files count as the turn's changes, and a
// turn that makes the first commit says its diff includes what was staged before
{
  const r = repo({ commit: false });
  r.write("x.js", "1\n");
  const base = baseline(r.d);
  r.write("s.js", "staged\n");
  r.git("add", "s.js");
  assert.match(turnSummary(r.d, base), /New staged files \(no commit yet\):\ns\.js/, "a turn that only staged a file isn't 'none'");
  const before = baseline(r.d);
  r.write("s.js", "staged, then edited\n");
  assert.match(turnSummary(r.d, before), /Edited staged files \(no commit yet\):\ns\.js/);
  const start = baseline(r.d);
  r.git("add", ".");
  r.git("commit", "-qm", "first");
  const first = turnSummary(r.d, start);
  assert.match(first, /This turn made the repository's first commit: the command shows that whole commit, including what was staged before the turn\./);
  assert.match(first, /Staged before this turn \(so in that commit too\):\ns\.js/);
  fs.rmSync(r.d, { recursive: true, force: true });
  console.log("git 11 before the first commit: staged files are a turn's changes (new and edited); the first commit's turn says its diff includes what was staged before");
}

// a split index: the copy's shared part is read where it is, and neither the
// index nor its shared part is written
{
  const r = repo();
  r.git("config", "core.splitIndex", "true");
  r.git("update-index", "--split-index");
  const gitDir = path.join(r.d, ".git");
  const files = () => Object.fromEntries(fs.readdirSync(gitDir).filter((f) => f === "index" || f.startsWith("sharedindex.")).map((f) => [f, fs.readFileSync(path.join(gitDir, f)).toString("base64")]));
  const before = files();
  assert.ok(Object.keys(before).some((f) => f.startsWith("sharedindex.")), "the index is split");
  r.write("a.js", "2\n");
  const snap = baseline(r.d);
  assert.ok(snap?.ref, "a snapshot");
  assert.match(runPosix(snapshotCommand(r.d, { ref: pathInfo(r.d).head }, snap)), /^\+2$/m);
  assert.deepEqual(files(), before, "neither the index nor its shared part written");
  assert.deepEqual(fs.readdirSync(path.join(process.env.AGENT_REVIEW_BRIDGE_DIR, "tmp")), [], "no copy left behind");
  fs.rmSync(r.d, { recursive: true, force: true });
  console.log("git 12 a split index: the snapshot reads it, writes neither part, leaves no copy");
}

// a file changed in the same second the index was written, with the same
// size ("racily clean" in git's terms): still a change in the snapshot
{
  const r = repo();
  const base = baseline(r.d);
  r.write("a.js", "2\n"); // right after the commit, same size as "1\n"
  // the snapshot a second or more later: a copy of the index with a time of
  // its own would make git trust the file's unchanged-looking stat
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const end = baseline(r.d);
  assert.notEqual(end.ref, base.ref, "the change is in the snapshot");
  assert.match(runPosix(snapshotCommand(r.d, base, end)), /^-1\n\+2$/m);
  fs.rmSync(r.d, { recursive: true, force: true });
  console.log("git 13 a change in the same second as the index, same size: in the snapshot");
}

// a tracked secret file changed in a turn: neither its name nor its content
// in the snapshot's summary or in what its command shows
{
  const r = repo();
  r.write("config/app_secret.yml", "token: OLD\n");
  r.write(".env", "KEY=OLD\n");
  r.git("add", "-f", ".");
  r.git("commit", "-qm", "tracked secrets");
  const base = baseline(r.d);
  r.write("config/app_secret.yml", "token: TOPSECRET\n");
  r.write(".env", "KEY=TOPSECRET\n");
  r.write("a.js", "2\n");
  const end = baseline(r.d);
  const all = snapshotSummary(r.d, base, end) + runPosix(snapshotCommand(r.d, base, end));
  assert.match(all, /a\.js/);
  assert.doesNotMatch(all, /app_secret|\.env|TOPSECRET|OLD/);
  fs.rmSync(r.d, { recursive: true, force: true });
  console.log("git 14 tracked secret files changed in a turn: kept out of its summary and command");
}
