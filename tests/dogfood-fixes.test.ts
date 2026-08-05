/**
 * Failures observed driving Forge through a real multi-session build.
 *
 * A 14B model was asked to add `formatCents` to `src/money.js`. It issued
 * `MKDIR src/money.js`, Forge created a *directory* with that name, and from
 * there the run could not recover: CREATE answered "already exists; edit it
 * instead of creating it" -- advice that cannot work on a directory -- and every
 * subsequent EDIT hit the repetition guard, which repeats that an action failed
 * without ever repeating *why*. The model burned six turns and the run died.
 *
 * Separately, a run that committed nothing at all exited 0 with `ok: true`,
 * because the pre-existing suite was green and a green suite was taken as
 * evidence of work. The model's own final message said it could not proceed.
 *
 * Each test here is one of those observations.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { classifyVerificationRun } from "../src/recovery.js";
import { Run } from "../src/runtime.js";
import type { VerificationRun } from "../src/verify.js";
import { Workspace, WorkspaceError } from "../src/workspace.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function repository(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-dogfood-")));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  return root;
}

describe("a directory where a file was meant", () => {
  test("CREATE against a directory says it is a directory, not that it can be edited", async () => {
    const root = await repository();
    mkdirSync(path.join(root, "money.js"));
    const workspace = new Workspace(root);

    expect(() =>
      workspace.preview({
        kind: "edit",
        path: "money.js",
        create: true,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "", replace: "x", expectedMatches: 1 }],
      }),
    ).toThrow(WorkspaceError);
    try {
      workspace.preview({
        kind: "edit",
        path: "money.js",
        create: true,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "", replace: "x", expectedMatches: 1 }],
      });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("is a directory");
      // The advice that sent the observed run into a loop.
      expect(message).not.toContain("edit it instead");
      // A way out, named.
      expect(message).toContain("DELETE");
    }
  });

  test("EDIT against a directory says the same thing", async () => {
    const root = await repository();
    mkdirSync(path.join(root, "money.js"));
    const workspace = new Workspace(root);

    try {
      workspace.preview({
        kind: "edit",
        path: "money.js",
        create: false,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "a", replace: "b", expectedMatches: 1 }],
      });
      expect.unreachable("editing a directory must fail");
    } catch (error) {
      expect((error as Error).message).toContain("is a directory");
    }
  });

  test("MKDIR refuses a path that names a source file", async () => {
    const root = await repository();
    const workspace = new Workspace(root);

    expect(() => workspace.previewMkdir("src/money.js")).toThrow(/looks like a file/i);
    expect(() => workspace.previewMkdir("src/components")).not.toThrow();
  });
});

describe("the repetition guard", () => {
  test("repeats why the action failed, not merely that it did", async () => {
    const root = await repository();
    writeFileSync(path.join(root, "note.txt"), "hello\n");
    const run = new Run({
      workspace: new Workspace(root),
      runTool: async () => ({ ok: true, output: "" }),
    });
    run.start("edit the note");

    const proposal = {
      kind: "edit" as const,
      path: "note.txt",
      create: false,
      rewrite: false,
      baseRevision: null,
      operations: [{ search: "nowhere to be found", replace: "x", expectedMatches: 1 }],
    };
    const first = await run.submit({ text: "t", proposals: [proposal], final: null });
    const firstOutput = first.results[0]?.output ?? "";
    expect(firstOutput).toContain("search text was not found");

    const second = await run.submit({ text: "t", proposals: [proposal], final: null });
    const secondOutput = second.results[0]?.output ?? "";
    // The reason must survive the repeat, so the model can act on it.
    expect(secondOutput).toContain("search text was not found");
    expect(secondOutput).toContain("already failed");
  });
});

describe("the read-again deadlock", () => {
  /**
   * Observed twice in one session, and the single largest consumer of turns.
   *
   * The model reads a file and proposes an edit in the same reply. The edit is
   * refused -- correctly, it was composed before the content arrived. So on the
   * next turn it re-reads the same range to comply, and *that* is refused too,
   * because the range has not changed. Neither guard is wrong alone; together
   * they leave no legal move, and the model spends the rest of the run
   * alternating between the two refusals.
   */
  test("a re-read is allowed when the edit it was meant to inform was refused", async () => {
    const root = await repository();
    writeFileSync(path.join(root, "note.txt"), "hello\n");
    const run = new Run(
      {
        workspace: new Workspace(root),
        runTool: async () => ({ ok: true, output: "hello" }),
      },
      true,
    );
    run.start("edit the note");

    const read = { kind: "call" as const, tool: "read", arguments: { path: "note.txt" } };
    // One reply carrying both, which is what the model actually sends.
    const together = await run.submit({
      text: "t",
      proposals: [
        read,
        {
          kind: "edit" as const,
          path: "note.txt",
          create: false,
          rewrite: false,
          baseRevision: null,
          operations: [{ search: "hello", replace: "goodbye", expectedMatches: 1 }],
        },
      ],
      final: null,
    });
    expect(together.results[0]?.ok).toBe(true);
    expect(together.results[1]?.output).toContain("same reply as a read");

    // Complying with that refusal must be a legal move.
    const again = await run.submit({ text: "t", proposals: [read], final: null });
    expect(again.results[0]?.ok).toBe(true);
    expect(again.results[0]?.output).not.toContain("has not changed");
  });

  test("the allowance is spent once, not standing", async () => {
    const root = await repository();
    writeFileSync(path.join(root, "note.txt"), "hello\n");
    const run = new Run(
      {
        workspace: new Workspace(root),
        runTool: async () => ({ ok: true, output: "hello" }),
      },
      true,
    );
    run.start("edit the note");

    const read = { kind: "call" as const, tool: "read", arguments: { path: "note.txt" } };
    await run.submit({
      text: "t",
      proposals: [
        read,
        {
          kind: "edit" as const,
          path: "note.txt",
          create: false,
          rewrite: false,
          baseRevision: null,
          operations: [{ search: "hello", replace: "goodbye", expectedMatches: 1 }],
        },
      ],
      final: null,
    });
    await run.submit({ text: "t", proposals: [read], final: null });
    const third = await run.submit({ text: "t", proposals: [read], final: null });

    expect(third.results[0]?.ok).toBe(false);
    expect(third.results[0]?.output).toContain("has not changed");
  });

  test("a pointless re-read with no failed edit behind it is still refused", async () => {
    const root = await repository();
    writeFileSync(path.join(root, "note.txt"), "hello\n");
    const run = new Run({
      workspace: new Workspace(root),
      runTool: async () => ({ ok: true, output: "contents" }),
    });
    run.start("look at the note");

    const read = { kind: "call" as const, tool: "read", arguments: { path: "note.txt" } };
    await run.submit({ text: "t", proposals: [read], final: null });
    const second = await run.submit({ text: "t", proposals: [read], final: null });

    expect(second.results[0]?.ok).toBe(false);
    expect(second.results[0]?.output).toContain("has not changed");
  });
});

describe("module resolution failures", () => {
  function run(output: string): VerificationRun {
    return { command: ["npm", "test"], code: 1, output, seconds: 1, timedOut: false };
  }

  test("a missing repository file is a code failure, not a broken toolchain", () => {
    // Observed: a test importing a module the model had not written yet.
    const absolute = classifyVerificationRun(
      run("Error: Cannot find module '/repo/project/src/money.js'\n  code: 'MODULE_NOT_FOUND'"),
    );
    expect(absolute.class).not.toBe("toolchain");

    const relative = classifyVerificationRun(
      run("Error: Cannot find module '../src/money.js' imported from tests/money.test.js"),
    );
    expect(relative.class).not.toBe("toolchain");
  });

  test("a missing installed package is still a toolchain failure", () => {
    expect(classifyVerificationRun(run("Error: Cannot find module 'express'")).class).toBe(
      "toolchain",
    );
    expect(
      classifyVerificationRun(run("ModuleNotFoundError: No module named 'pytest'")).class,
    ).toBe("toolchain");
  });

  test("a missing executable is still a toolchain failure", () => {
    expect(classifyVerificationRun(run("sh: cargo: command not found")).class).toBe("toolchain");
    expect(classifyVerificationRun(run("spawn npm ENOENT")).class).toBe("toolchain");
  });
});

describe("a mis-quoted anchor", () => {
  /**
   * Observed live: a 14B re-sent the identical failing SEARCH against
   * `src/account.js` five times. "Quote it exactly" is advice it believes it
   * already followed, so the refusal has to carry the real text.
   */
  test("names the closest real lines instead of only refusing", async () => {
    const root = await repository();
    writeFileSync(
      path.join(root, "account.js"),
      [
        "export class Account {",
        "  constructor(name) {",
        "    this.name = name;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const workspace = new Workspace(root);

    try {
      workspace.preview({
        kind: "edit",
        path: "account.js",
        create: false,
        rewrite: false,
        baseRevision: null,
        // Plausible, and not what the file says.
        operations: [
          {
            search: "  constructor(name, balance) {",
            replace: "  constructor(n) {",
            expectedMatches: 1,
          },
        ],
      });
      expect.unreachable("a missing anchor must fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("closest text actually in the file");
      expect(message).toContain("constructor(name) {");
      // Numbered, so the model can ask for that exact range.
      expect(message).toMatch(/\d+: /);
    }
  });

  test("stays silent when nothing in the file resembles the anchor", async () => {
    const root = await repository();
    writeFileSync(path.join(root, "notes.txt"), "alpha beta gamma\n");
    const workspace = new Workspace(root);

    try {
      workspace.preview({
        kind: "edit",
        path: "notes.txt",
        create: false,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "zzz qqq wwww", replace: "x", expectedMatches: 1 }],
      });
      expect.unreachable("a missing anchor must fail");
    } catch (error) {
      expect((error as Error).message).not.toContain("closest text");
    }
  });
});
