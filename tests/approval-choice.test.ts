/**
 * The approval prompt advertised an option it did not implement.
 *
 * It printed `[a]pply  [s]kip  [A]lways`, and the reply was lowercased before
 * being compared -- so `A`, the one key offered for "always", collapsed onto
 * `a` and approved exactly once. A user following the prompt would grant a
 * single action, believe the session was unattended, and keep being asked. The
 * string that did work, the full word `always`, appeared nowhere on screen.
 *
 * The parse was inline in the interactive loop and had no test, which is how it
 * shipped. It now lives beside the prompt text it must agree with, and the last
 * test here reads the options *out of the prompt* and asserts each one does what
 * it says -- so the two cannot drift apart again.
 */

import { describe, expect, test } from "vitest";
import { APPROVAL_PROMPT, approvalChoice } from "../src/render.js";

describe("an approval reply", () => {
  test("capital A means always, as the prompt has always claimed", () => {
    expect(approvalChoice("A")).toBe("always");
  });

  test("lowercase a still means once", () => {
    // The distinction is the whole point: [a]pply and [A]lways are different
    // keys, so case has to survive as far as the comparison.
    expect(approvalChoice("a")).toBe("once");
  });

  test("the spelled-out word works in any case", () => {
    expect(approvalChoice("always")).toBe("always");
    expect(approvalChoice("ALWAYS")).toBe("always");
    expect(approvalChoice("  Always  ")).toBe("always");
  });

  test("apply, yes, and a bare newline approve once", () => {
    expect(approvalChoice("a")).toBe("once");
    expect(approvalChoice("y")).toBe("once");
    expect(approvalChoice("")).toBe("once");
    expect(approvalChoice("   ")).toBe("once");
  });

  test("typing the word the prompt shows does what the prompt shows", () => {
    // "apply" used to fall through to deny -- the same defect as [A]lways, in
    // the other direction: the screen says a word, typing it does the opposite.
    expect(approvalChoice("apply")).toBe("once");
    expect(approvalChoice("Apply")).toBe("once");
    expect(approvalChoice("yes")).toBe("once");
    expect(approvalChoice("skip")).toBe("deny");
  });

  test("skip and anything unrecognised deny", () => {
    // Denial is the default for input nobody planned for: a typo must not
    // approve a mutation.
    for (const reply of ["s", "S", "n", "no", "q", "!", "yes please", "app"]) {
      expect(approvalChoice(reply)).toBe("deny");
    }
  });

  test("every option the prompt offers does what the prompt says", () => {
    // Reads `[a]pply  [s]kip  [A]lways` and checks each bracketed key.
    const offered = [...APPROVAL_PROMPT.matchAll(/\[([A-Za-z])\]([a-z]+)/g)].map((match) => ({
      key: match[1] as string,
      word: `${match[1]}${match[2]}`,
    }));
    expect(offered.length).toBeGreaterThan(0);

    const expected: Record<string, string> = { apply: "once", skip: "deny", Always: "always" };
    for (const option of offered) {
      const want = expected[option.word];
      expect(want, `prompt offers [${option.key}]${option.word} with no expectation`).toBeDefined();
      expect(approvalChoice(option.key), `key ${option.key} from the prompt`).toBe(want);
    }
  });
});
