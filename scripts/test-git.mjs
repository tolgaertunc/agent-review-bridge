// Turn diffs (src/git.mjs) against throwaway repos: secrets stay out (files
// and whole directories, content and names), repos without commits work,
// edits to already-untracked files show up, and the size cap covers it all.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { baseline, turnDiff, pathInfo, reviewSummary, fingerprint, usableBase } from "../src/git.mjs";

// the fingerprint keeps a small cache in the bridge's data folder: a throwaway one here
process.env.PEER_BRIDGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-gitdata-"));

function repo({ commit = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-git-"));
  const git = (...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q");
  if (commit) {
    fs.writeFileSync(path.join(d, "a.js"), "1\n");
    git("add", ".");
    git("commit", "-qm", "init");
  }
  return { d, git, write: (f, c) => (fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), c)) };
}

// secrets: files and directories, never content nor name
{
  const r = repo();
  const base = baseline(r.d);
  for (const f of ["secrets/config.json", ".envrc", ".env.local", "my-credentials/x.txt", "deploy/server.pem", ".ssh/id_ed25519", "config/app_secret.yml"]) r.write(f, "TOPSECRET\n");
  r.write("a.js", "2\n");
  const d = turnDiff(r.d, base, 20000);
  assert.match(d, /a\.js/);
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
  const d = turnDiff(r.d, base, 20000);
  assert.match(d, /New untracked files:\ny\.js/);
  assert.match(d, /Edited untracked files[^\n]*:\nx\.js/);
  assert.ok(turnDiff(r.d, null, 20000), "no-baseline diff works without HEAD too");
  console.log("git 2 repo without commits: new and edited untracked files reported");
}

// edits to a file that was already untracked at turn start
{
  const r = repo();
  r.write("notes.md", "v1\n");
  const base = baseline(r.d);
  assert.equal(turnDiff(r.d, base, 20000), "(no changes)");
  r.write("notes.md", "v2\n");
  assert.match(turnDiff(r.d, base, 20000), /Edited untracked files[^\n]*:\nnotes\.md/);
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
  const d = turnDiff(r.d, base, 3000);
  assert.ok(d.length <= 3000, `capped at 3000 (got ${d.length})`);
  assert.match(d, /more files/);
  assert.match(d, /… 70 more/);
  console.log(`git 4 size cap holds for stat, lists and patch (${d.length} chars)`);
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
  const shown = execFileSync("sh", ["-c", reviewSummary(file, file.head).command], { encoding: "utf8" });
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
  fs.chmodSync(path.join(r.d, "c.js"), 0o755);
  const f4 = fp();
  assert.notEqual(f4, f3, "the executable bit changes it");
  fs.symlinkSync("a.js", path.join(r.d, "link"));
  const f5 = fp();
  fs.rmSync(path.join(r.d, "link"));
  fs.symlinkSync("b.js", path.join(r.d, "link"));
  assert.notEqual(fp(), f5, "a symlink's target changes it");
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
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-plain-"));
  fs.writeFileSync(path.join(plain, "x.txt"), "1");
  const p1 = fingerprint(plain).hash;
  fs.writeFileSync(path.join(plain, ".env"), "TOPSECRET");
  assert.equal(fingerprint(plain).hash, p1, "secrets don't count outside git either");
  fs.writeFileSync(path.join(plain, "x.txt"), "2");
  assert.notEqual(fingerprint(plain).hash, p1, "an edit outside git counts");
  // a path named through a link to a folder is that folder, in git or not
  const links = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-links-"));
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
  console.log("git 6 fingerprint: content-based, committed deletes and secrets don't count, index flags can't hide edits, unreadable files fail visibly, plain folders and folder links too");
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
