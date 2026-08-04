import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import { store } from "../src/objects.js";
import { Journal } from "../src/runtime.js";
import { SessionStore } from "../src/session.js";
import { revisionOfContent } from "../src/workspace.js";

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "undo-")));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function saveSession(
  root: string,
  mutations: Array<{
    path: string;
    beforeRevision: string | null;
    afterRevision?: string | null;
  }>,
): void {
  const journal = new Journal();
  journal.append({ type: "run.started", seq: 1, task: "change files" });
  mutations.forEach((mutation, index) => {
    journal.append({
      type: "mutation.committed",
      seq: index + 2,
      id: `a${index + 1}`,
      path: mutation.path,
      added: 1,
      removed: mutation.beforeRevision === null ? 0 : 1,
      beforeRevision: mutation.beforeRevision,
      ...(mutation.afterRevision === undefined ? {} : { afterRevision: mutation.afterRevision }),
    });
  });
  new SessionStore(root).save("run-1", journal);
}

function capture(): { io: IO; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    },
  };
}

describe("safe undo", () => {
  test("restores only files that still match the committed revision", async () => {
    await withDir(async (dir) => {
      const created = path.join(dir, "created.txt");
      const edited = path.join(dir, "edited.txt");
      const old = "before\n";
      const createdByAgent = "created by agent\n";
      const editedByAgent = "after\n";
      writeFileSync(created, createdByAgent);
      writeFileSync(edited, editedByAgent);
      const oldRevision = store(dir, old);
      saveSession(dir, [
        {
          path: "created.txt",
          beforeRevision: null,
          afterRevision: revisionOfContent(createdByAgent),
        },
        {
          path: "edited.txt",
          beforeRevision: oldRevision,
          afterRevision: revisionOfContent(editedByAgent),
        },
      ]);
      const output = capture();

      const code = await main(["undo", "run-1", "--repo", dir], output.io);

      expect(code).toBe(0);
      expect(existsSync(created)).toBe(false);
      expect(readFileSync(edited, "utf8")).toBe(old);
    });
  });

  test("restores a file deleted by a session", async () => {
    await withDir(async (dir) => {
      const original = "export const restored = true;\n";
      const beforeRevision = store(dir, original);
      saveSession(dir, [
        {
          path: "src/deleted.ts",
          beforeRevision,
          afterRevision: null,
        },
      ]);
      const output = capture();

      const code = await main(["undo", "run-1", "--repo", dir], output.io);

      expect(code).toBe(0);
      expect(readFileSync(path.join(dir, "src", "deleted.ts"), "utf8")).toBe(original);
      expect(output.lines.join("\n")).toContain("restored src/deleted.ts");
    });
  });

  test("refuses to restore a deleted file when the path was recreated afterwards", async () => {
    await withDir(async (dir) => {
      const original = "before deletion\n";
      const beforeRevision = store(dir, original);
      writeFileSync(path.join(dir, "deleted.txt"), "new user file\n");
      saveSession(dir, [
        {
          path: "deleted.txt",
          beforeRevision,
          afterRevision: null,
        },
      ]);
      const output = capture();

      const code = await main(["undo", "run-1", "--repo", dir], output.io);

      expect(code).toBe(1);
      expect(readFileSync(path.join(dir, "deleted.txt"), "utf8")).toBe("new user file\n");
      expect(output.lines.join("\n")).toContain("left untouched");
    });
  });

  test("refuses to restore a deleted file over a recreated directory", async () => {
    await withDir(async (dir) => {
      const original = "before deletion\n";
      const beforeRevision = store(dir, original);
      await mkdir(path.join(dir, "deleted.txt"));
      saveSession(dir, [
        {
          path: "deleted.txt",
          beforeRevision,
          afterRevision: null,
        },
      ]);
      const output = capture();

      const code = await main(["undo", "run-1", "--repo", dir], output.io);

      expect(code).toBe(1);
      expect(existsSync(path.join(dir, "deleted.txt"))).toBe(true);
      expect(output.lines.join("\n")).toContain("left untouched");
    });
  });

  test("refuses to delete or overwrite files changed after the session", async () => {
    await withDir(async (dir) => {
      const created = path.join(dir, "created.txt");
      const edited = path.join(dir, "edited.txt");
      const oldRevision = store(dir, "before\n");
      writeFileSync(created, "user changed created file\n");
      writeFileSync(edited, "user changed edited file\n");
      saveSession(dir, [
        {
          path: "created.txt",
          beforeRevision: null,
          afterRevision: revisionOfContent("created by agent\n"),
        },
        {
          path: "edited.txt",
          beforeRevision: oldRevision,
          afterRevision: revisionOfContent("after\n"),
        },
      ]);
      const output = capture();

      const code = await main(["undo", "run-1", "--repo", dir], output.io);

      expect(code).toBe(1);
      expect(readFileSync(created, "utf8")).toBe("user changed created file\n");
      expect(readFileSync(edited, "utf8")).toBe("user changed edited file\n");
      expect(output.lines.filter((line) => line.includes("left untouched"))).toHaveLength(2);
    });
  });

  test("legacy sessions without an after revision fail closed", async () => {
    await withDir(async (dir) => {
      writeFileSync(path.join(dir, "created.txt"), "content\n");
      saveSession(dir, [{ path: "created.txt", beforeRevision: null }]);
      const output = capture();

      const code = await main(["undo", "run-1", "--repo", dir], output.io);

      expect(code).toBe(1);
      expect(readFileSync(path.join(dir, "created.txt"), "utf8")).toBe("content\n");
      expect(output.lines.join("\n")).toContain("predates safe undo metadata");
    });
  });
});
