// Auto mode: the same reviews, but the working agent asks for them itself
// at the moments that matter, in one reviewer chat, with a few checks on top.
// These are the bridge's fixed words, shared by the server and the hooks.

// After this many turns without consulting, a gentle reminder
export const REMIND_AFTER = 5;

export const autoKey = (endpoint) => `${endpoint.app}:${endpoint.id}`;
export const autoFor = (state, endpoint) => (endpoint && state?.auto?.[autoKey(endpoint)]?.on ? state.auto[autoKey(endpoint)] : null);

// The chat in the other app an auto mode keeps as its reviewer, if it has one
// yet (state from before this was a ChatGPT thread id: `thread`)
export const reviewerOf = (entry) => entry?.reviewer ?? (entry?.thread ? { app: "openai", id: entry.thread } : null);

// Is this chat the reviewer of an auto mode that is on? It stays one between
// reviews: it keeps listening for the next one, and doesn't read other chats.
export const standingReviewer = (state, endpoint) =>
  !!endpoint &&
  Object.values(state?.auto ?? {}).some((e) => {
    const r = e?.on && reviewerOf(e);
    return !!r && r.app === endpoint.app && r.id === endpoint.id;
  });

// To the working agent in full when auto mode is turned on and whenever its
// session starts again (a compaction may have summarised them away)
export const AUTO_RULES =
  "[AGENT-REVIEW-BRIDGE] Auto mode is on: you work with a second model as your reviewer (bridge_review; it reuses the same reviewer chat). " +
  "Get its approval at the moments that matter, not at every small step, and never move past one of these without it:\n" +
  "- before settling a direction: when the work needs a plan or you must choose between approaches;\n" +
  "- when the direction changes: a different approach, a larger change than expected, a dropped or added requirement;\n" +
  "- when a coherent step of work is done (would you commit it on its own? then it's a step), and before you commit it;\n" +
  "- when you hit an uncertainty that a short look into the code or docs doesn't resolve;\n" +
  "- before anything hard to undo (push, deleting data, migrations); the reviewer's approval doesn't replace the user's permission for these;\n" +
  "- before telling the user the work is done.\n" +
  "After a long job of several steps, once the user says it's done, ask them once whether they want one review of the whole work (all its commits); " +
  "do it only if they say yes, and don't offer it again. It doesn't replace the reviews above.\n" +
  "Small edits, reading and questions don't need a review on their own; they go into the next one.\n" +
  "In each request say what the goal is, what this step does, and anything that deviated from what was agreed. Name every folder or file you changed for this work in `paths`; " +
  "if you committed work in a path before its first review, say which commits. Don't argue for your solution; if the reviewer asks for changes and you disagree, give your reasons in the next round. " +
  "While a review runs, don't change the files under its paths. For a plan you consult on by your own choice, pass own_initiative=true and go on once it's approved; " +
  "if the user asked for the plan review, or you're not sure, leave it out: then you show the user the plan and wait for their approval.";

// With each prompt in between: short, but complete on its own
export const AUTO_RULES_SHORT =
  "[AGENT-REVIEW-BRIDGE] Auto mode is on: get the reviewer's approval (bridge_review) before settling or changing a direction, when a step is done and before committing it, " +
  "on an uncertainty a short look doesn't resolve, before push, deleting data or migrations (the user's permission is still needed), and before saying the work is done. " +
  "Name every path you changed in `paths`. Pass own_initiative=true only for a plan you chose to consult on; not if the user asked for that review or you're not sure.";

// The same, when auto mode reviews every turn on its own (the setting
// "autoReviews": "every-turn", or bridge_auto's every_turn): the agent doesn't
// ask for code reviews; the bridge sends each turn
export const AUTO_RULES_EVERY =
  "[AGENT-REVIEW-BRIDGE] Auto mode is on, reviewing every turn: when one of your turns ends, the bridge sends it to your reviewer chat on its own " +
  "(what the user asked, your final message, the turn's changes). Don't ask for code reviews yourself. " +
  "A review that requests changes comes back as a new turn: fix what holds up; if a finding is wrong, say why instead of complying. Your next turn is reviewed again. " +
  "Approvals come with your next prompt, in one line or in full with minor points, and so do notes from the bridge. " +
  "Before settling a direction you may still ask for a plan review (bridge_review with kind plan). " +
  "The reviewer's approval doesn't replace the user's permission for anything hard to undo (push, deleting data, migrations).";

export const AUTO_RULES_EVERY_SHORT =
  "[AGENT-REVIEW-BRIDGE] Auto mode is on, reviewing every turn: each of your turns goes to your reviewer on its own, so don't ask for code reviews yourself; " +
  "a plan review before settling a direction is still yours to ask for. The user's permission is still needed before push, deleting data or migrations.";

// What a reviewer is told with every turn auto mode sends it
export const EVERY_TURN_ROLE =
  "This is auto mode's review of one turn: each turn of that chat comes here as a request of its own, sent by the bridge, not asked for by the agent. " +
  "Answer each once. An approval covers the content listed under \"Where the changes are\", as it was when this request was made.";

// Added to review requests while the requester is in auto mode
export const AUTO_REVIEWER =
  "Auto mode: judge the work against its goal and what was agreed, and say if the direction, plan or scope looks wrong or goes beyond it. " +
  "Don't ask for a plan the work doesn't need. If this adapts work approved in another path, check it's consistent.";

export const AUTO_REMINDER =
  "[AGENT-REVIEW-BRIDGE] For your information: you haven't consulted the reviewer for a few turns. If a decision or a change since then calls for it, ask now; if not, carry on.";

// How the Stop check's words begin. ChatGPT goes on with a turn a Stop hook
// stopped by giving it those words as a new prompt: that prompt isn't the user's.
export const GUARD_HEAD = "[AGENT-REVIEW-BRIDGE] Auto mode";

// From the Stop check while auto mode's first review waits for a chat to
// join with its code: asking again would only make another code
export const autoJoinWait = (linkId, code) =>
  `${GUARD_HEAD}: review ${linkId} is waiting for a chat in the other app to join with its code ${code}. ` +
  "Remind the user to paste it there (\"join the agent-review-bridge link with code " + code + "\"), and don't ask for another review. " +
  "If you are waiting for the user's answer or have to stop for another reason, you can stop now.";

// From the Stop check, once for the same unreviewed changes in auto mode
export const autoGuard = (unreviewed, unchecked = []) =>
  [
    unreviewed.length && `${GUARD_HEAD}: the reviewer hasn't approved the current changes in ${unreviewed.join(", ")}.`,
    unchecked.length && `${GUARD_HEAD} couldn't check ${unchecked.join("; ")}: tell the user, since unreviewed changes there can't be caught.`,
    unreviewed.length &&
      "Ask for a review (bridge_review) before you finish, or tell the user why not; telling them doesn't count as approval, the changes stay unreviewed.",
    "If you are waiting for the user's answer or have to stop for another reason, you can stop now.",
  ]
    .filter(Boolean)
    .join(" ");
