/**
 * Context selection is only useful if it is measurable, so these tests are
 * mostly about the receipt rather than about the prompt.
 *
 * The invariants worth defending: an instruction is never silently truncated,
 * a better-ranked item never loses to a worse one, the same inputs always
 * produce the same bytes, and the receipt's arithmetic describes the text that
 * was actually emitted -- not an estimate of it. A receipt that can drift from
 * the emitted text is worse than no receipt, because it is trusted.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  type ContextItem,
  type ContextReceipt,
  type ContextReceiptEntry,
  compile,
  SEPARATOR,
  scoreFiles,
  tokenize,
} from "../src/context.js";

/** Text of an exact length whose content identifies the item it belongs to. */
function block(label: string, chars: number): string {
  return label.repeat(Math.ceil(chars / label.length)).slice(0, chars);
}

function optional(id: string, score: number, chars: number): ContextItem {
  return {
    id,
    kind: "file",
    path: `src/${id}.ts`,
    text: block(id, chars),
    mandatory: false,
    score,
    reason: `test fixture, score ${score}`,
  };
}

function entryOf(receipt: ContextReceipt, id: string): ContextReceiptEntry {
  const found = receipt.items.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`receipt has no entry for ${id}`);
  return found;
}

async function withRepo<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "context-"));
  try {
    // Realpath it: on macOS the OS temp dir is `/var/...` symlinked to
    // `/private/var/...`, so a test comparing raw paths fails for the wrong
    // reason.
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("mandatory items are never sacrificed to the budget", () => {
  test("an instruction larger than the entire budget is still emitted whole", () => {
    const instruction: ContextItem = {
      id: "system",
      kind: "instruction",
      text: block("I", 50),
      mandatory: true,
      score: 0,
      reason: "system prompt",
    };
    const { text, receipt } = compile([instruction, optional("a", 99, 10)], 20);

    // Whole, not clipped to 20: half an instruction changes the rules the
    // model is following without anyone being able to see that it happened.
    expect(text).toBe(block("I", 50));
    expect(entryOf(receipt, "system").included).toBe(true);
    expect(receipt.includedChars).toBe(50);
    // The overrun is visible instead of hidden, which is what makes it a
    // configuration error the caller can act on.
    expect(receipt.includedChars).toBeGreaterThan(receipt.budgetChars);
  });

  test("a top-scoring optional item still loses to a budget already spent", () => {
    const instruction: ContextItem = {
      id: "system",
      kind: "instruction",
      text: block("I", 50),
      mandatory: true,
      score: 0,
      reason: "system prompt",
    };
    const { text, receipt } = compile([instruction, optional("a", 99, 10)], 20);

    expect(entryOf(receipt, "a").included).toBe(false);
    expect(text).not.toContain(block("a", 10));
    expect(receipt.droppedChars).toBe(10);
  });

  test("mandatory items keep the order they were given, whatever their scores", () => {
    const first: ContextItem = {
      id: "second-alphabetically",
      kind: "instruction",
      text: "FIRST",
      mandatory: true,
      score: 0,
      reason: "given first",
    };
    const second: ContextItem = {
      id: "first-alphabetically",
      kind: "instruction",
      text: "SECOND",
      mandatory: true,
      score: 100,
      reason: "given second",
    };
    const { text, receipt } = compile([first, second], 1000);

    expect(text).toBe(`FIRST${SEPARATOR}SECOND`);
    expect(receipt.items.map((entry) => entry.id)).toEqual([
      "second-alphabetically",
      "first-alphabetically",
    ]);
  });
});

describe("under pressure the higher score wins", () => {
  test("the two best of three equal-sized candidates are kept", () => {
    const items = [optional("a", 1, 10), optional("b", 5, 10), optional("c", 3, 10)];
    // Room for exactly two blocks and the separator between them.
    const { text, receipt } = compile(items, 10 + SEPARATOR.length + 10);

    expect(text).toBe(`${block("b", 10)}${SEPARATOR}${block("c", 10)}`);
    expect(entryOf(receipt, "b").included).toBe(true);
    expect(entryOf(receipt, "c").included).toBe(true);
    expect(entryOf(receipt, "a").included).toBe(false);
    expect(receipt.droppedChars).toBe(10);
  });

  test("one oversized candidate does not evict the rest of the ranking", () => {
    const items = [optional("big", 9, 100), optional("m", 5, 10), optional("n", 4, 10)];
    const { text, receipt } = compile(items, 30);

    expect(entryOf(receipt, "big").included).toBe(false);
    expect(entryOf(receipt, "m").included).toBe(true);
    expect(entryOf(receipt, "n").included).toBe(true);
    expect(text).toBe(`${block("m", 10)}${SEPARATOR}${block("n", 10)}`);
  });

  test("the receipt lists optional items by rank, so the near-miss is the first exclusion", () => {
    const items = [optional("a", 1, 10), optional("b", 5, 10), optional("c", 3, 10)];
    const { receipt } = compile(items, 10);

    expect(receipt.items.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(receipt.items.map((entry) => entry.included)).toEqual([true, false, false]);
  });
});

describe("the same inputs always compile to the same bytes", () => {
  test("equal scores break by id, not by argument order", () => {
    const items = [optional("c", 4, 10), optional("a", 4, 10), optional("b", 4, 10)];
    const { text } = compile(items, 10 + SEPARATOR.length + 10);

    expect(text).toBe(`${block("a", 10)}${SEPARATOR}${block("b", 10)}`);
  });

  test("shuffling the input changes nothing about the output or the receipt", () => {
    const items = [optional("c", 4, 10), optional("a", 4, 10), optional("b", 4, 10)];
    const forwards = compile(items, 25);
    const backwards = compile([...items].reverse(), 25);

    expect(backwards.text).toBe(forwards.text);
    expect(JSON.stringify(backwards.receipt)).toBe(JSON.stringify(forwards.receipt));
  });

  test("compiling does not reorder the caller's array", () => {
    const items = [optional("c", 4, 10), optional("a", 4, 10), optional("b", 4, 10)];
    compile(items, 25);

    expect(items.map((item) => item.id)).toEqual(["c", "a", "b"]);
  });
});

describe("the receipt describes the text that was actually emitted", () => {
  const items: ContextItem[] = [
    {
      id: "system",
      kind: "instruction",
      text: block("I", 12),
      mandatory: true,
      score: 0,
      reason: "system prompt",
    },
    optional("w", 7, 20),
    optional("x", 5, 20),
    optional("y", 3, 20),
    optional("z", 1, 20),
  ];
  const budget = 60;

  test("every candidate appears exactly once, included or not", () => {
    const { receipt } = compile(items, budget);

    expect(receipt.items).toHaveLength(items.length);
    expect(new Set(receipt.items.map((entry) => entry.id)).size).toBe(items.length);
    expect([...receipt.items.map((entry) => entry.id)].sort()).toEqual(
      [...items.map((item) => item.id)].sort(),
    );
  });

  test("includedChars is the real length of the emitted text, separators included", () => {
    const { text, receipt } = compile(items, budget);

    expect(receipt.includedChars).toBe(text.length);
    // Not merely the sum of the parts: the separators are real characters the
    // model pays for, and a receipt that ignored them would understate the
    // prompt every time.
    const sumOfIncluded = receipt.items
      .filter((entry) => entry.included)
      .reduce((total, entry) => total + entry.chars, 0);
    expect(receipt.includedChars).toBeGreaterThan(sumOfIncluded);
  });

  test("droppedChars is the size of what was evicted, and evicted text is absent", () => {
    const { text, receipt } = compile(items, budget);
    const dropped = receipt.items.filter((entry) => !entry.included);

    expect(dropped.length).toBeGreaterThan(0);
    expect(receipt.droppedChars).toBe(dropped.reduce((total, entry) => total + entry.chars, 0));
    for (const entry of dropped) {
      expect(text).not.toContain(block(entry.id, 20));
    }
    // The mirror assertion, because "absent" is only meaningful next to
    // "present": an emitter that dropped everything would satisfy the first
    // loop on its own.
    for (const entry of receipt.items) {
      if (!entry.included || entry.kind !== "file") continue;
      expect(text).toContain(block(entry.id, 20));
    }
  });

  test("with nothing mandatory the emitted text never exceeds the budget", () => {
    const { text, receipt } = compile(
      items.filter((item) => !item.mandatory),
      budget,
    );

    expect(text.length).toBeLessThanOrEqual(budget);
    expect(receipt.includedChars).toBeLessThanOrEqual(receipt.budgetChars);
  });

  test("an empty candidate list produces empty text and an empty receipt", () => {
    const { text, receipt } = compile([], 100);

    expect(text).toBe("");
    expect(receipt.items).toEqual([]);
    expect(receipt.includedChars).toBe(0);
    expect(receipt.droppedChars).toBe(0);
  });

  test("entries carry the item's path only when it had one", () => {
    const { receipt } = compile(items, budget);

    expect(entryOf(receipt, "w").path).toBe("src/w.ts");
    expect("path" in entryOf(receipt, "system")).toBe(false);
  });
});

describe("lexical file ranking is explainable", () => {
  test("an exact basename match outranks a partial one", () => {
    const ranked = scoreFiles(
      ["src/contextual-helper.ts", "src/context.ts", "docs/context-notes.md", "src/workspace.ts"],
      "context budget",
    );

    expect(ranked.map((item) => item.id)).toEqual([
      "src/context.ts",
      "docs/context-notes.md",
      "src/contextual-helper.ts",
      "src/workspace.ts",
    ]);
    const exact = ranked[0];
    const partial = ranked[1];
    if (exact === undefined || partial === undefined) throw new Error("expected four results");
    expect(exact.score).toBeGreaterThan(partial.score);
  });

  test("the three match tiers are strictly ordered: basename, substring, directory", () => {
    const ranked = scoreFiles(["auth/handler.ts", "src/auth-helpers.ts", "src/auth.ts"], "auth");
    const scores = ranked.map((item) => item.score);

    expect(ranked.map((item) => item.id)).toEqual([
      "src/auth.ts",
      "src/auth-helpers.ts",
      "auth/handler.ts",
    ]);
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? 0);
  });

  test("the reason names which tokens matched and how", () => {
    const ranked = scoreFiles(["src/context.ts", "src/contextual-helper.ts"], "context");
    const exact = ranked[0];
    const partial = ranked[1];
    if (exact === undefined || partial === undefined) throw new Error("expected two results");

    expect(exact.reason).toContain("context");
    expect(exact.reason).toContain("exact basename");
    expect(partial.reason).toContain("context");
    expect(partial.reason).toContain("partial basename");
  });

  test("a path no token touches is still reported, with score zero and a stated reason", () => {
    const ranked = scoreFiles(["src/workspace.ts"], "context budget");
    const only = ranked[0];
    if (only === undefined) throw new Error("expected one result");

    expect(ranked).toHaveLength(1);
    expect(only.score).toBe(0);
    expect(only.reason).toBe("no query token matched");
  });

  test("a repeated query word is one piece of evidence, not two", () => {
    expect(tokenize("context Context CONTEXT")).toEqual(["context"]);
  });

  test("a single character is not evidence", () => {
    expect(tokenize("a b context")).toEqual(["context"]);
    const ranked = scoreFiles(["src/a.ts", "src/zebra.ts"], "a");
    expect(ranked.map((item) => item.score)).toEqual([0, 0]);
  });

  test("ranked items are optional, so a query alone can never overrun the budget", () => {
    const ranked = scoreFiles(["src/context.ts"], "context");

    expect(ranked.every((item) => item.mandatory)).toBe(false);
  });
});

describe("ranking and compilation compose over a real directory", () => {
  test("the top-ranked file's real contents reach the prompt and are accounted for", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src"), { recursive: true });
      mkdirSync(path.join(root, "docs"), { recursive: true });
      writeFileSync(path.join(root, "src", "context.ts"), "export const budget = 8000;\n");
      writeFileSync(path.join(root, "src", "workspace.ts"), "export const root = '.';\n");
      writeFileSync(path.join(root, "docs", "notes.md"), "# notes\n");

      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      const paths = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
        .map((relative) => relative.split(path.sep).join("/"));

      const ranked = scoreFiles(paths, "context budget");
      const best = ranked[0];
      if (best === undefined) throw new Error("expected at least one candidate");
      expect(best.id).toBe("src/context.ts");

      const contents = readFileSync(path.join(root, best.id), "utf8");
      const instruction: ContextItem = {
        id: "system",
        kind: "instruction",
        text: "You are a coding agent.",
        mandatory: true,
        score: 0,
        reason: "system prompt",
      };
      const withContents: ContextItem = { ...best, text: contents };
      const { text, receipt } = compile([instruction, withContents, ...ranked.slice(1)], 200);

      expect(text).toContain(contents);
      expect(receipt.includedChars).toBe(text.length);
      expect(entryOf(receipt, "src/context.ts").chars).toBe(contents.length);
      expect(entryOf(receipt, "src/context.ts").path).toBe("src/context.ts");
    });
  });
});
