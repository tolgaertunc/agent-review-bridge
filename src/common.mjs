// What the broker, the hooks and the review request builder share, with no
// side effects of their own: the request builder also runs in a child
// process (src/turnjob.mjs), which must not set up the broker's folders or
// token.

export const MAX_TEXT = 40_000;
export const MAX_DIFF = 20_000;

// The reviewer's role in short, with every one-off review request and when a
// Claude reviewer's session starts again: either side may have compacted its
// context and lost the brief it got once
export const REVIEWER_ROLE =
  "As the reviewer: read-only, don't change the project. Answer once with bridge_advise: approved, or changes_requested with each must-fix item in blocking; " +
  "minor points go in nits and never block. If the requester disagrees with a finding, accept or hold it and say why; in a later round, judge against your earlier findings " +
  "and don't add new blocking points on parts you accepted unless serious. If you can't see your earlier findings or the request, say so instead of guessing. " +
  "Then write the text bridge_advise returns as your reply.";
