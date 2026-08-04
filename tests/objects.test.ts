/**
 * The blob store, and the no-op edit rule that shares its motivation.
 *
 * Both exist because an edit has to be reversible and has to be real. A change
 * you cannot put back is one the user has to think twice before approving, and
 * a change that changes nothing is progress the harness will happily count.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { hashOf, load, store } from "../src/objects.js";
import { Workspace, WorkspaceError } from "../src/workspace.js";

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "objects-"));
  try {
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("the object store", () => {
  test("content round trips through its own hash", async () => {
    await withDir(async (dir) => {
      const hash = store(dir, "hello\nworld\n");

      expect(hash).toBe(hashOf("hello\nworld\n"));
      expect(load(dir, hash)).toBe("hello\nworld\n");
    });
  });

  test("storing the same bytes twice stores them once", async () => {
    // The property that makes keeping an undo history cheap: the unchanged
    // bulk of a file costs nothing however many times it is edited around.
    await withDir(async (dir) => {
      const first = store(dir, "same");
      const second = store(dir, "same");

      expect(second).toBe(first);
      expect(load(dir, first)).toBe("same");
    });
  });

  test("an unknown hash is null, not an exception", async () => {
    // A missing blob means undo cannot restore one file. That is worth
    // reporting precisely; it is not worth abandoning the rest of the undo.
    await withDir(async (dir) => {
      expect(load(dir, "0".repeat(64))).toBeNull();
    });
  });

  test("a hash-shaped path traversal cannot escape the store", async () => {
    // The hash reaches this function from a journal file, which is on disk and
    // therefore editable. It is validated as a hash, not trusted as a name.
    await withDir(async (dir) => {
      writeFileSync(path.join(dir, "secret"), "sensitive");

      expect(load(dir, "../../secret")).toBeNull();
      expect(load(dir, "..")).toBeNull();
      expect(load(dir, "not-a-hash")).toBeNull();
    });
  });

  test("empty content is storable and distinguishable from absent", async () => {
    // Undoing the creation of content *into* an empty file has to restore the
    // empty file, not treat it as nothing to do.
    await withDir(async (dir) => {
      const hash = store(dir, "");

      expect(load(dir, hash)).toBe("");
      expect(existsSync(path.join(dir, ".forge", "objects", hash.slice(0, 2), hash.slice(2)))).toBe(
        true,
      );
    });
  });
});

describe("a no-op edit is refused", () => {
  test("an edit whose result equals the original is rejected", async () => {
    // Observed in a real session as `committed src/math.js +0 -0`. Counting it
    // as progress is worse than refusing it: it lets a model satisfy the
    // "something committed" check without changing anything, which is exactly
    // the false-success shape everything else here exists to catch.
    await withDir(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "value = 1;\n");
      const workspace = new Workspace(dir);

      expect(() =>
        workspace.preview({
          kind: "edit",
          path: "a.ts",
          create: false,
          rewrite: false,
          baseRevision: null,
          operations: [{ search: "value = 1;", replace: "value = 1;", expectedMatches: 1 }],
        }),
      ).toThrow(WorkspaceError);
      expect(readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("value = 1;\n");
    });
  });

  test("a real change is still allowed", async () => {
    await withDir(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "value = 1;\n");
      const workspace = new Workspace(dir);

      const preview = workspace.preview({
        kind: "edit",
        path: "a.ts",
        create: false,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "value = 1;", replace: "value = 2;", expectedMatches: 1 }],
      });

      expect(preview.after).toBe("value = 2;\n");
    });
  });
});
