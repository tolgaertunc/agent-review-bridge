// The user's settings for the bridge: <config dir>/config.json, next to
// rules.md. Unknown or invalid values fall back to the defaults.

import fs from "node:fs";
import path from "node:path";
import { configDir } from "./platform.mjs";

const OPEN = ["ask", "always"];
// auto mode: the agent asks at the moments that matter, or every turn is
// reviewed on its own, as advisor mode does
const AUTO_REVIEWS = ["key-moments", "every-turn"];
const DEFAULTS = { openClosedApps: "ask", autoReviews: "key-moments" };

export const configFile = () => path.join(configDir(), "config.json");

export function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    // no file, or not JSON: defaults
  }
  return {
    ...raw,
    openClosedApps: OPEN.includes(raw?.openClosedApps) ? raw.openClosedApps : DEFAULTS.openClosedApps,
    autoReviews: AUTO_REVIEWS.includes(raw?.autoReviews) ? raw.autoReviews : DEFAULTS.autoReviews,
  };
}

// Keeps whatever else the user put in the file
export function writeConfig(patch) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    // start a new file
  }
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ ...raw, ...patch }, null, 2) + "\n");
}
