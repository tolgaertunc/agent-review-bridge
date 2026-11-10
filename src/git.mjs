// What changed in the working tree during a turn, for review requests.
// Read-only for the user's repository: `git stash create` writes commit
// objects for the current tree, and runs on a copy of the index (it would
// refresh and lock the real one), so no ref, index or work tree file is
// touched. Paths that tend to hold secrets never leave the machine, neither
// content nor name (the diff goes to the other vendor's chat).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { dataDir } from "./platform.mjs";

// file names, and directories whose whole content is excluded
const SECRET_FILES = [".env*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "id_rsa*", "id_ed25519*", "id_ecdsa*", "*secret*", "*credential*", ".netrc", ".npmrc", ".pypirc"];
const SECRET_DIRS = ["secrets", "*secret*", "*credential*", ".ssh", ".aws", ".gnupg", ".azure", ".kube"];
export const EXCLUDES = [...SECRET_FILES.map((p) => `:(glob,exclude)**/${p}`), ...SECRET_DIRS.map((d) => `:(glob,exclude)**/${d}/**`)];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_LIST = 50;

function git(cwd, args, input, { env, ownIndex = false } = {}) {
  // --no-optional-locks: status and diff don't refresh (write) the index;
  // left out only for a command run on the bridge's own copy of it
  return execFileSync("git", [...(ownIndex ? [] : ["--no-optional-locks"]), "-C", cwd, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    input,
    timeout: 3000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    windowsHide: true,
    ...(env && { env: { ...process.env, ...env } }),
  });
}

// `git stash create` refreshes the index it reads (writes a stat-dirty one
// back) under its lock, and fails (exit 1, nothing said) when a file's stat
// changed but not its content: run on a copy (the work tree's own, linked
// worktrees included), refreshed first, so .git/index is never written,
// another git holding its lock doesn't stop it, and a touched file is no
// change. A split index's shared part is still read from the git dir; the
// copy is written whole. No index file: no snapshot, not a guess.
function stashCreate(cwd) {
  const index = path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index"]).trim());
  const dir = path.join(dataDir(), "tmp");
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, `index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const own = { env: { GIT_INDEX_FILE: copy }, ownIndex: true };
  try {
    fs.copyFileSync(index, copy);
    // the copy keeps the index's own time: git tells a file changed within
    // the same second as the index was written ("racily clean") by it
    const st = fs.statSync(index);
    fs.utimesSync(copy, st.atime, st.mtime);
    git(cwd, ["-c", "core.splitIndex=false", "update-index", "-q", "--refresh"], undefined, own);
    return git(cwd, ["-c", "core.splitIndex=false", "stash", "create"], undefined, own).trim();
  } finally {
    // the copy, its lock, and what git writes beside it (stash create's own
    // temporary index, left if a time limit killed git)
    const name = path.basename(copy);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(name)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function inWorkTree(cwd) {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function headOrEmpty(cwd) {
  try {
    return git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || EMPTY_TREE;
  } catch {
    return EMPTY_TREE; // repo without commits
  }
}

const untracked = (cwd) => git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDES]).split("\n").filter(Boolean);

// content hashes, so edits to files that were already untracked show up
function hashes(cwd, files) {
  if (!files.length) return {};
  const out = git(cwd, ["hash-object", "--stdin-paths"], files.join("\n") + "\n").trim().split("\n");
  return Object.fromEntries(files.map((f, i) => [f, out[i]]));
}

// Snapshot of the work tree (a turn's start or end), or null when cwd isn't
// a git work tree or git can't take one: a git failure (a merge with
// conflicts, a timeout) is no snapshot, never a guess
export function baseline(cwd) {
  if (!inWorkTree(cwd)) return null;
  try {
    const head = commitOf(cwd);
    // a commit of the tracked changes, empty when there are none (HEAD is
    // the snapshot then); before the first commit there's nothing to stash
    const ref = head === EMPTY_TREE ? head : stashCreate(cwd) || head;
    const files = untracked(cwd).slice(0, 500);
    // before the first commit, the staged files too (by their content now),
    // or a turn that only staged a file would show no change
    const staged = head === EMPTY_TREE ? cached(cwd).filter((f) => fs.existsSync(path.join(cwd, f))).slice(0, 500) : [];
    return { cwd, ref, untracked: hashes(cwd, files), ...(staged.length && { staged: hashes(cwd, staged) }) };
  } catch {
    return null;
  }
}

const cached = (cwd) => git(cwd, ["ls-files", "--cached", "--", ".", ...EXCLUDES]).split("\n").filter(Boolean);

// HEAD's commit, or the empty tree before the first commit (git says HEAD
// doesn't resolve: exit 1); throws when git can't tell
function commitOf(cwd) {
  try {
    return git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
  } catch (e) {
    if (e.status === 1) return EMPTY_TREE;
    throw e;
  }
}

const capList = (title, items) =>
  items.length ? `${title}:\n${items.slice(0, MAX_LIST).join("\n")}${items.length > MAX_LIST ? `\n… ${items.length - MAX_LIST} more` : ""}` : null;

// A turn's own changes between two snapshots (baseline() at its start and at
// its end), as a summary: the stat (a long one cut to its first lines plus the
// summary line) and the untracked files that are new or edited, compared by
// the hashes each snapshot kept. The command below shows the changes
// themselves. "" when nothing changed; null when a snapshot is missing or
// can't be read (git may have pruned it).
export function snapshotSummary(cwd, base, snap) {
  if (!base?.ref || !snap?.ref || !inWorkTree(cwd)) return null;
  try {
    // files compared by the hashes each snapshot kept: new, and edited
    const changes = (key) => {
      const before = base[key] ?? {};
      const after = snap[key] ?? {};
      return [Object.keys(after).filter((f) => !(f in before)), Object.keys(after).filter((f) => f in before && after[f] !== before[f])];
    };
    const [added, edited] = changes("untracked");
    const [newStaged, editedStaged] = changes("staged");
    const statLines = git(cwd, ["diff", "--stat", base.ref, snap.ref, "--", ".", ...EXCLUDES]).trimEnd().split("\n").filter(Boolean);
    const stat = statLines.length > MAX_LIST + 1 ? [...statLines.slice(0, MAX_LIST), `… ${statLines.length - MAX_LIST - 1} more files`, statLines.at(-1)] : statLines;
    // the repository's first commit came in this turn: its diff is that whole
    // commit, files staged in earlier turns included
    const first = base.ref === EMPTY_TREE && snap.ref !== EMPTY_TREE;
    return [
      stat.join("\n"),
      first && "This turn made the repository's first commit: the command shows that whole commit, including what was staged before the turn.",
      first && capList("Staged before this turn (so in that commit too)", Object.keys(base.staged ?? {})),
      capList("New untracked files", added),
      capList("Edited untracked files (content not tracked by git)", edited),
      capList("New staged files (no commit yet)", newStaged),
      capList("Edited staged files (no commit yet)", editedStaged),
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return null;
  }
}

// ------------------------------------------------- commands for the reviewer
// The reviewer runs the commands a request gives in its own shell. On
// Windows that is Git Bash for Claude Code and PowerShell for ChatGPT, and
// the request doesn't know which app will answer (a join code's reviewer):
// every command is given for both. Elsewhere, one POSIX shell.
export const REVIEW_SHELLS = process.platform === "win32" ? ["posix", "powershell"] : ["posix"];

// One value quoted for that shell: POSIX ('…', ' as '\'') or PowerShell
// ('…', each single quote doubled, the Unicode ones too, which PowerShell
// takes as quotes; $ and ` stay literal inside)
export function shellArg(a, shell = "posix") {
  if (shell === "powershell") return `'${String(a).replace(/['‘’‚‛]/g, (c) => c + c)}'`;
  return `'${String(a).replace(/'/g, `'\\''`)}'`;
}

// A command from fixed words (as they are) and values ({ q }: quoted). In
// PowerShell `--` is quoted too, so it reaches git as it is in any version.
function shellCommand(parts, shell) {
  return parts.map((p) => (typeof p !== "string" ? shellArg(p.q, shell) : shell === "powershell" && p === "--" ? "'--'" : p)).join(" ");
}

// The command that shows a turn's own changes between its two snapshots
// (secret paths left out)
export function snapshotCommand(cwd, base, snap, shell = "posix") {
  return shellCommand(["git", "-C", { q: cwd }, "diff", "--no-ext-diff", "--no-textconv", base.ref, snap.ref, "--", ".", ...EXCLUDES.map((q) => ({ q }))], shell);
}

// ------------------------------------------------------- paths for review
// A path named for review: a folder or a single file, in a git work tree or
// not. `root` is what is read: the path itself, or for a link to a folder,
// that folder (links inside it stay links). For git: the work tree's top, the
// path relative to it (pathspec) and the HEAD commit.
export function pathInfo(p) {
  const abs = path.resolve(p);
  let st = null;
  let root = abs;
  try {
    st = fs.lstatSync(abs);
    if (st.isSymbolicLink() && isFolder(abs)) {
      root = fs.realpathSync(abs);
      st = fs.lstatSync(root);
    }
  } catch (e) {
    // deleted or never there; no access is an error, not an absence
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw new Error(`can't read ${abs} (${e.code ?? e.message})`);
  }
  const dir = st?.isDirectory() ? root : path.dirname(abs);
  if (!fs.existsSync(dir)) return { path: abs, root, exists: false, git: false };
  if (!inWorkTree(dir)) return { path: abs, root, exists: !!st, git: false, dir };
  const top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  // git reports the real path (macOS: /var is /private/var): compare like with like
  const realDir = fs.realpathSync(dir);
  const real = st?.isDirectory() ? realDir : path.join(realDir, path.basename(abs));
  const spec = path.relative(fs.realpathSync(top), real).split(path.sep).join("/") || ".";
  const head = headOrEmpty(top);
  return { path: abs, root, exists: !!st, git: true, dir, top, spec, head };
}

// a broken link is not a folder; no access to the target is an error
function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "ELOOP") return false;
    throw e;
  }
}

// Is `ref` still a usable starting point for HEAD: present, and on HEAD's
// history (a switched branch or rewritten history makes it misleading)
export function usableBase(info, ref) {
  if (!ref || ref === info.head) return !!ref;
  try {
    git(info.top, ["merge-base", "--is-ancestor", ref, info.head]);
    return true;
  } catch {
    return false;
  }
}

// What a reviewer needs to find the changes under one git path itself: the
// short status and stat (secret paths left out) and the command to show them
export function reviewSummary(info, base) {
  const spec = [info.spec, ...EXCLUDES];
  // long lists are cut; the command below always shows everything
  const cap = (out, what) => {
    const lines = out.trimEnd().split("\n").filter(Boolean);
    return lines.length > MAX_LIST ? [...lines.slice(0, MAX_LIST), `… ${lines.length - MAX_LIST} more ${what}`].join("\n") : lines.join("\n");
  };
  const status = cap(git(info.top, ["status", "--short", "--untracked-files=all", "--", ...spec]), "changed or new files");
  const stat = cap(git(info.top, ["diff", "--stat", base, "--", ...spec]), "lines of the stat");
  return { status, stat, command: pathCommand(info, base) };
}

// The command that shows the changes under one git path, for that shell
export function pathCommand(info, base, shell = "posix") {
  return shellCommand(["git", "-C", { q: info.top }, "diff", "--no-ext-diff", "--no-textconv", base, "--", ...[info.spec, ...EXCLUDES].map((q) => ({ q }))], shell);
}

// The changes under one git path as text, for a reviewer that can't read
// the folder itself (secret paths left out, capped)
export function pathDiff(info, base, maxChars) {
  const patch = git(info.top, ["diff", "--no-ext-diff", "--no-textconv", base, "--", info.spec, ...EXCLUDES]);
  return patch.length > maxChars ? patch.slice(0, maxChars) + "\n… (diff truncated)" : patch;
}

// One hash for the content under a path: every file present (tracked or
// untracked, not ignored, secret paths left out) with its kind, executable
// bit and content. Committing doesn't change it, nor does committing a
// delete; editing, adding or deleting a file does. git only lists the files
// (ls-files reads the index, writes nothing, runs no filters); each file is
// read and hashed here the way git hashes a blob, so neither filters nor
// index flags like assume-unchanged can hide a change. A small cache of file
// stats per path keeps repeated checks cheap.
// Returns { hash }, or { error } when part of it can't be read.
// `fresh` reads every file again (for what a review request records); the
// end-of-turn check may use the cache.
export function fingerprint(p, { fresh = false } = {}) {
  try {
    const info = pathInfo(p);
    const files = info.git ? gitFiles(info) : plainFiles(info);
    return { hash: hashFiles(info.path, files, fresh) };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

const MAX_PLAIN_FILES = 5000;

// the same secret patterns, for folders outside git
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
const SECRET_FILE_RE = SECRET_FILES.map(globRe);
const SECRET_DIR_RE = SECRET_DIRS.map(globRe);
export function isSecretPath(rel) {
  const parts = rel.split(/[\\/]/);
  return SECRET_FILE_RE.some((r) => r.test(parts.at(-1))) || parts.slice(0, -1).some((d) => SECRET_DIR_RE.some((r) => r.test(d)));
}

// [relative name, absolute path] of every file under a git path
function gitFiles(info) {
  return git(info.top, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate", "--", info.spec, ...EXCLUDES])
    .split("\0")
    .filter(Boolean)
    .map((f) => [f, path.join(info.top, f)]);
}

function plainFiles(info) {
  if (!info.exists) return [];
  if (!fs.lstatSync(info.root).isDirectory()) return isSecretPath(path.basename(info.path)) ? [] : [[path.basename(info.path), info.path]];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(info.root, full);
      if (isSecretPath(rel)) continue;
      if (e.isDirectory()) walk(full);
      else out.push([rel, full]);
      if (out.length > MAX_PLAIN_FILES) throw new Error(`more than ${MAX_PLAIN_FILES} files under ${info.path}`);
    }
  };
  walk(info.root);
  return out;
}

// a blob id the way git computes it (without filters)
const blobId = (content) =>
  crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

const cacheFile = (root) => path.join(dataDir(), "fpcache", `${crypto.createHash("sha1").update(root).digest("hex")}.json`);

function hashFiles(root, files, fresh) {
  let cache = {};
  try {
    if (!fresh) cache = JSON.parse(fs.readFileSync(cacheFile(root), "utf8"));
  } catch {
    // first check of this path
  }
  const next = {};
  const lines = [];
  for (const [rel, full] of files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (e) {
      // deleted: absent, the same as after the delete is committed; any other
      // error (no access) means the check can't be made
      if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
      throw new Error(`can't read ${full} (${e.code ?? e.message})`);
    }
    // ctime changes with any content or metadata change and can't be set
    // back, unlike mtime
    const stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.mode}`;
    let entry = cache[rel]?.[0] === stamp ? cache[rel][1] : null;
    if (!entry) {
      if (st.isSymbolicLink()) entry = `link:${blobId(Buffer.from(fs.readlinkSync(full)))}`;
      else if (st.isDirectory()) entry = "dir"; // a nested repository
      else {
        try {
          entry = `${st.mode & 0o111 ? "x" : "f"}:${blobId(fs.readFileSync(full))}`;
        } catch (e) {
          throw new Error(`can't read ${full} (${e.code ?? e.message})`);
        }
      }
    }
    next[rel] = [stamp, entry];
    lines.push(`${rel}\0${entry}`);
  }
  try {
    const f = cacheFile(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(next));
    fs.renameSync(`${f}.${process.pid}.tmp`, f);
  } catch {
    // the cache is only a speed-up
  }
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}
