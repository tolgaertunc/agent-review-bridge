// Auto mode: the same reviews, but the working agent asks for them itself
// at the moments that matter, in one reviewer chat, with a few checks on top.
// These are the bridge's fixed words, shared by the server and the hooks.

// After this many turns without consulting, a gentle reminder
export const REMIND_AFTER = 5;

export const autoKey = (endpoint) => `${endpoint.app}:${endpoint.id}`;
export const autoFor = (state, endpoint) => (endpoint && state?.auto?.[autoKey(endpoint)]?.on ? state.auto[autoKey(endpoint)] : null);

// To the working agent, with each prompt while auto mode is on
export const AUTO_RULES =
  "[PEER-BRIDGE] Auto mode is on: you work with a second model as your reviewer (bridge_review; it reuses the same reviewer chat). " +
  "Get its approval at the moments that matter, not at every small step, and never move past one of these without it:\n" +
  "- before settling a direction: when the work needs a plan or you must choose between approaches;\n" +
  "- when the direction changes: a different approach, a larger change than expected, a dropped or added requirement;\n" +
  "- when a coherent step of work is done (would you commit it on its own? then it's a step), and before you commit it;\n" +
  "- when you hit an uncertainty that a short look into the code or docs doesn't resolve;\n" +
  "- before anything hard to undo (push, deleting data, migrations); the reviewer's approval doesn't replace the user's permission for these;\n" +
  "- before telling the user the work is done.\n" +
  "Small edits, reading and questions don't need a review on their own; they go into the next one.\n" +
  "In each request say what the goal is, what this step does, and anything that deviated from what was agreed. Name every folder or file you changed for this work in `paths`; " +
  "if you committed work in a path before its first review, say which commits. Don't argue for your solution; if the reviewer asks for changes and you disagree, give your reasons in the next round. " +
  "While a review runs, don't change the files under its paths. For a plan you consult on by your own choice, pass own_initiative=true and go on once it's approved; " +
  "if the user asked for the plan review, or you're not sure, leave it out: then you show the user the plan and wait for their approval.";

// Added to review requests while the requester is in auto mode
export const AUTO_REVIEWER =
  "Auto mode: review the work against its goal and anything agreed so far. Besides the code, say so if the direction, the plan or the scope looks wrong, " +
  "or if the change goes beyond what was agreed. Don't ask for a plan when the work doesn't need one. If this adapts work already approved in another path, check that it is consistent with it.";

export const AUTO_REMINDER =
  "[PEER-BRIDGE] For your information: you haven't consulted the reviewer for a few turns. If a decision or a change since then calls for it, ask now; if not, carry on.";

// From the Stop check, once for the same unreviewed changes in auto mode
export const autoGuard = (unreviewed, unchecked = []) =>
  [
    unreviewed.length && `[PEER-BRIDGE] Auto mode: the reviewer hasn't approved the current changes in ${unreviewed.join(", ")}.`,
    unchecked.length && `[PEER-BRIDGE] Auto mode couldn't check ${unchecked.join("; ")}: tell the user, since unreviewed changes there can't be caught.`,
    unreviewed.length &&
      "Ask for a review (bridge_review) before you finish, or tell the user why not; telling them doesn't count as approval, the changes stay unreviewed.",
    "If you are waiting for the user's answer or have to stop for another reason, you can stop now.",
  ]
    .filter(Boolean)
    .join(" ");
