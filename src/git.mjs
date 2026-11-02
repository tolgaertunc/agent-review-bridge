// What changed in the working tree during a turn, for review requests.
// Read-only: `git stash create` writes a commit object for the current tree
// but touches no ref, index or file. Paths that tend to hold secrets never
// leave the machine, neither content nor name (the diff goes to the other
// vendor's chat).

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

function git(cwd, args, input) {
  // --no-optional-locks: status and diff don't refresh (write) the index
  return execFileSync("git", ["--no-optional-locks", "-C", cwd, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    input,
    timeout: 3000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    windowsHide: true,
  });
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

// Snapshot at turn start, or null when cwd isn't a git work tree
export function baseline(cwd) {
  if (!inWorkTree(cwd)) return null;
  try {
    let ref = "";
    try {
      ref = git(cwd, ["stash", "create"]).trim();
    } catch {
      // fails in a repo without commits
    }
    const files = untracked(cwd).slice(0, 500);
    return { cwd, ref: ref || headOrEmpty(cwd), untracked: hashes(cwd, files) };
  } catch {
    return null;
  }
}

const capList = (title, items) =>
  items.length ? `${title}:\n${items.slice(0, MAX_LIST).join("\n")}${items.length > MAX_LIST ? `\n… ${items.length - MAX_LIST} more` : ""}` : null;

// Diff of the working tree against a baseline (or HEAD without one); the
// whole result, summary included, stays within maxChars
export function turnDiff(cwd, base, maxChars) {
  if (!inWorkTree(cwd)) return null;
  try {
    const ref = base?.ref ?? headOrEmpty(cwd);
    const statLines = git(cwd, ["diff", "--stat", ref, "--", ".", ...EXCLUDES]).trimEnd().split("\n").filter(Boolean);
    const before = base?.untracked ?? {};
    const now = untracked(cwd);
    const added = now.filter((f) => !(f in before));
    const known = now.filter((f) => f in before);
    const nowHashes = hashes(cwd, known);
    const edited = known.filter((f) => nowHashes[f] !== before[f]);
    if (!statLines.length && !added.length && !edited.length) return base ? "(no changes)" : null;
    // a long stat is cut to its first lines plus the summary line
    const stat = statLines.length > MAX_LIST + 1 ? [...statLines.slice(0, MAX_LIST), `… ${statLines.length - MAX_LIST - 1} more files`, statLines.at(-1)] : statLines;
    const head = [
      base ? null : "(no turn baseline: uncommitted changes against HEAD)",
      stat.join("\n"),
      capList("New untracked files", added),
      capList("Edited untracked files (content not tracked by git)", edited),
    ]
      .filter(Boolean)
      .join("\n\n");
    let patch = git(cwd, ["diff", ref, "--", ".", ...EXCLUDES]);
    const room = maxChars - head.length - 40;
    if (patch.length > room) patch = room > 0 ? patch.slice(0, room) + "\n… (diff truncated)" : "";
    return `${head}\n\n${patch}`.trim().slice(0, maxChars);
  } catch {
    return null;
  }
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
  const q = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
  const command = ["git", "-C", q(info.top), "diff", "--no-ext-diff", "--no-textconv", base, "--", ...spec.map(q)].join(" ");
  return { status, stat, command };
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
