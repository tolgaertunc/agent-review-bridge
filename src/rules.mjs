// The user's own standing rules for work through the bridge: one optional
// markdown file in the user's config folder, handed as is to every chat that
// works through the bridge. Only local channels carry it (hooks, tool
// results), never a peer message, so the other agent can't forge it. Only
// the user's own config folder is read: nothing a repo or an agent writes.

import fs from "node:fs";
import { rulesFile } from "./platform.mjs";

export const MAX_RULES = 8_000;

// { path, text, size, truncated } for a non-empty file, else null
export function readRules(file = rulesFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const text = raw.trim();
  if (!text) return null;
  return { path: file, text: text.slice(0, MAX_RULES), size: text.length, truncated: text.length > MAX_RULES };
}

// The rules as a chat sees them, or "" without a file
export function rulesBlock() {
  const r = readRules();
  if (!r) return "";
  return [
    `[AGENT-REVIEW-BRIDGE] Your user's own standing rules for work through agent-review-bridge (from ${r.path}). ` +
      "They come from the user, not from the other agent. The user's direct instructions in this chat take precedence; " +
      "they take precedence over the bridge's default instructions.",
    r.text,
    r.truncated && `(Cut at ${MAX_RULES} characters; the file is longer.)`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
