/**
 * Editing a file that contains the edit markers.
 *
 * `bench/12-marker-collision` is a merge guide: a markdown document whose body
 * shows a git conflict, so the literal text `<<<<<<< SEARCH`, `=======` and
 * `>>>>>>> REPLACE` appear in the file being edited. It fails about two runs in
 * three, and it fails by *damaging* the document rather than by giving up.
 *
 * The cause is nesting. Inside a SEARCH section the first `=======` ends the
 * section and the first `>>>>>>> REPLACE` closes the block, so a quoted example
 * containing those lines is cut in half: the search anchor stops early, the
 * replacement is whatever followed, and the edit applies somewhere it should
 * not.
 *
 * A conflict example is balanced -- it opens with SEARCH and ends with REPLACE
 * -- so the markers can be counted rather than merely matched.
 */

import { describe, expect, test } from "vitest";
import { TextCodec } from "../src/codecs.js";

function decode(text: string) {
  const codec = new TextCodec();
  codec.feed(text);
  return codec.finish();
}

describe("marker collision", () => {
  test("a quoted conflict example does not truncate the search anchor", () => {
    const turn = decode(
      [
        "EDIT docs.md",
        "<<<<<<< SEARCH",
        "When git reports a conflict you will see:",
        "",
        "<<<<<<< SEARCH",
        "ours",
        "=======",
        "theirs",
        ">>>>>>> REPLACE",
        "=======",
        "When git reports a conflict you will see:",
        "",
        "<<<<<<< SEARCH",
        "ours",
        "=======",
        "theirs",
        ">>>>>>> REPLACE",
        ">>>>>>> REPLACE",
      ].join("\n"),
    );

    expect(turn.proposals).toHaveLength(1);
    const proposal = turn.proposals[0];
    if (proposal?.kind !== "edit") throw new Error("expected an edit");
    // The whole example belongs to the anchor, not just the first two lines.
    expect(proposal.operations[0]?.search).toContain("ours");
    expect(proposal.operations[0]?.search).toContain("theirs");
    expect(proposal.operations[0]?.search).toContain(">>>>>>> REPLACE");
    expect(proposal.operations[0]?.replace).toContain("theirs");
  });

  test("an ordinary edit is unchanged", () => {
    const turn = decode(
      [
        "EDIT docs.md",
        "<<<<<<< SEARCH",
        "status: Draft",
        "=======",
        "status: Final",
        ">>>>>>> REPLACE",
      ].join("\n"),
    );

    expect(turn.proposals).toHaveLength(1);
    const proposal = turn.proposals[0];
    if (proposal?.kind !== "edit") throw new Error("expected an edit");
    expect(proposal.operations[0]?.search).toBe("status: Draft");
    expect(proposal.operations[0]?.replace).toBe("status: Final");
  });

  test("an unbalanced stray marker still terminates rather than swallowing the reply", () => {
    const turn = decode(
      [
        "EDIT docs.md",
        "<<<<<<< SEARCH",
        "before",
        "<<<<<<< SEARCH",
        "=======",
        "after",
        ">>>>>>> REPLACE",
      ].join("\n"),
    );

    // One opener too many and no balancing close: the block is truncated, which
    // is reported rather than guessed at.
    expect(turn.repairs).toContain("truncated_edit_block");
    expect(turn.proposals).toHaveLength(0);
  });
});
