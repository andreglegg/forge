import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  captureIsolatedPatch,
  createIsolatedWorktree,
  promoteIsolatedPatch,
  readCapturedPatch,
  removeIsolatedWorktree,
} from "../src/isolation.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function withRepository<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-isolation-test-")));
  git(root, "init");
  git(root, "config", "user.email", "forge-tests@example.invalid");
  git(root, "config", "user.name", "Forge Tests");
  writeFileSync(path.join(root, ".gitignore"), ".forge/\n");
  writeFileSync(path.join(root, "app.txt"), "original\n");
  git(root, "add", ".gitignore", "app.txt");
  git(root, "commit", "-m", "initial");
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("isolated Git worktrees", () => {
  test("captures tracked edits and new files without touching the original", async () => {
    await withRepository(async (root) => {
      const worktree = await createIsolatedWorktree(root, "capture");
      try {
        writeFileSync(path.join(worktree.root, "app.txt"), "changed\n");
        writeFileSync(path.join(worktree.root, "new.txt"), "new file\n");

        const patch = await captureIsolatedPatch(worktree);

        expect(patch.changed).toBe(true);
        expect(readCapturedPatch(patch)).toContain("diff --git a/app.txt b/app.txt");
        expect(readCapturedPatch(patch)).toContain("diff --git a/new.txt b/new.txt");
        expect(readFileSync(path.join(root, "app.txt"), "utf8")).toBe("original\n");
        expect(existsSync(path.join(root, "new.txt"))).toBe(false);
      } finally {
        await removeIsolatedWorktree(worktree);
      }
    });
  });

  test("promotes only after the patch passes Git conflict checks", async () => {
    await withRepository(async (root) => {
      const worktree = await createIsolatedWorktree(root, "promote");
      try {
        writeFileSync(path.join(worktree.root, "app.txt"), "promoted\n");
        writeFileSync(path.join(worktree.root, "added.txt"), "added\n");
        const patch = await captureIsolatedPatch(worktree);

        await promoteIsolatedPatch(worktree, patch);

        expect(readFileSync(path.join(root, "app.txt"), "utf8")).toBe("promoted\n");
        expect(readFileSync(path.join(root, "added.txt"), "utf8")).toBe("added\n");
      } finally {
        await removeIsolatedWorktree(worktree);
      }
    });
  });

  test("refuses to start when tracked work would be omitted", async () => {
    await withRepository(async (root) => {
      writeFileSync(path.join(root, "app.txt"), "user work\n");

      await expect(createIsolatedWorktree(root, "dirty")).rejects.toThrow(/clean working tree/i);
    });
  });

  test("refuses to start when an untracked source file would be omitted", async () => {
    await withRepository(async (root) => {
      writeFileSync(path.join(root, "untracked.ts"), "export const value = 1;\n");

      await expect(createIsolatedWorktree(root, "untracked")).rejects.toThrow(
        /clean working tree/i,
      );
    });
  });

  test("retains the patch when the original changes during the run", async () => {
    await withRepository(async (root) => {
      const worktree = await createIsolatedWorktree(root, "conflict");
      try {
        writeFileSync(path.join(worktree.root, "app.txt"), "agent work\n");
        const patch = await captureIsolatedPatch(worktree);
        writeFileSync(path.join(root, "app.txt"), "user work\n");

        await expect(promoteIsolatedPatch(worktree, patch)).rejects.toThrow(
          /working tree changed/i,
        );
        expect(existsSync(patch.file)).toBe(true);
        expect(readFileSync(path.join(root, "app.txt"), "utf8")).toBe("user work\n");
      } finally {
        await removeIsolatedWorktree(worktree);
      }
    });
  });
});
