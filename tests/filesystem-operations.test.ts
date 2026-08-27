import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NativeCodec, TextCodec } from "../src/codecs.js";
import { renderProposal } from "../src/protocol.js";
import { Workspace } from "../src/workspace.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-fs-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function decodeText(source: string) {
  const codec = new TextCodec();
  codec.feed(source);
  return codec.finish();
}

function decodeNative(name: string, args: Record<string, unknown>) {
  const codec = new NativeCodec();
  codec.feed({
    call: {
      id: `${name}-1`,
      name,
      argumentsDelta: JSON.stringify(args),
    },
  });
  codec.feed({ finish: true });
  return codec.finish();
}

describe("filesystem protocol", () => {
  test.each([
    ["MKDIR assets/generated\n", "mkdir", { path: "assets/generated" }, "MKDIR assets/generated"],
    [
      "MOVE src/old.ts -> src/new.ts\n",
      "move",
      { source: "src/old.ts", destination: "src/new.ts" },
      "MOVE src/old.ts -> src/new.ts",
    ],
    [
      "COPY templates/base -> generated/base\n",
      "copy",
      { source: "templates/base", destination: "generated/base" },
      "COPY templates/base -> generated/base",
    ],
    [
      "RENAME old name.txt -> new name.txt\n",
      "rename",
      { source: "old name.txt", destination: "new name.txt" },
      "RENAME old name.txt -> new name.txt",
    ],
  ])("normalizes %s in text and native codecs", (source, tool, args, rendered) => {
    const fromText = decodeText(source);
    const fromNative = decodeNative(tool, args);

    expect(fromText.proposals).toEqual(fromNative.proposals);
    expect(fromText.proposals).toHaveLength(1);
    const proposal = fromText.proposals[0];
    expect(proposal).toBeDefined();
    if (proposal !== undefined) expect(renderProposal(proposal)).toBe(rendered);
  });
});

describe("previewed filesystem operations", () => {
  test("deletes a non-empty directory tree without following symlinks", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src", "nested"), { recursive: true });
      writeFileSync(path.join(root, "src", "game.ts"), "export const game = true;\n");
      writeFileSync(path.join(root, "src", "nested", "data.bin"), Buffer.from([0, 1, 2, 255]));
      symlinkSync("../game.ts", path.join(root, "src", "nested", "game-link"));
      const workspace = new Workspace(root);

      const preview = workspace.previewDelete("src");

      expect(preview.kind).toBe("delete");
      expect(
        preview.changes.map((change) => [change.operation, change.entryType, change.path]),
      ).toEqual([
        ["delete", "file", "src/game.ts"],
        ["delete", "file", "src/nested/data.bin"],
        ["delete", "symlink", "src/nested/game-link"],
        ["delete", "directory", "src/nested"],
        ["delete", "directory", "src"],
      ]);
      expect(preview.hunks.some((hunk) => hunk.text.includes("src/nested/data.bin"))).toBe(true);

      workspace.commit(preview);

      expect(existsSync(path.join(root, "src"))).toBe(false);
    });
  });

  test("deletes a final symlink without touching its target", async () => {
    await withRepo(async (root) => {
      writeFileSync(path.join(root, "keep.txt"), "keep me\n");
      symlinkSync("keep.txt", path.join(root, "alias.txt"));
      const workspace = new Workspace(root);

      const preview = workspace.previewDelete("alias.txt");
      workspace.commit(preview);

      expect(existsSync(path.join(root, "alias.txt"))).toBe(false);
      expect(readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("keep me\n");
    });
  });

  test("rejects mutation through a symlinked parent", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, ".git"));
      writeFileSync(path.join(root, ".git", "config"), "protected\n");
      symlinkSync(".git", path.join(root, "metadata"));
      const workspace = new Workspace(root);

      expect(() => workspace.previewDelete("metadata/config")).toThrow(/symbolic-link parent/i);
      expect(() => workspace.previewCopy("metadata/config", "copied.txt")).toThrow(
        /symbolic-link parent/i,
      );
      expect(readFileSync(path.join(root, ".git", "config"), "utf8")).toBe("protected\n");
    });
  });

  test("rejects a stale recursive deletion when the tree changes after preview", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src", "a.ts"), "a\n");
      const workspace = new Workspace(root);
      const preview = workspace.previewDelete("src");
      writeFileSync(path.join(root, "src", "b.ts"), "b\n");

      expect(() => workspace.commit(preview)).toThrow(/changed after it was approved/i);
      expect(existsSync(path.join(root, "src", "a.ts"))).toBe(true);
      expect(existsSync(path.join(root, "src", "b.ts"))).toBe(true);
    });
  });

  test("creates a nested text file and guards every missing parent", async () => {
    await withRepo(async (root) => {
      const workspace = new Workspace(root);
      const preview = workspace.preview({
        kind: "edit",
        path: "generated/nested/file.txt",
        create: true,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "", replace: "created\n", expectedMatches: 1 }],
      });

      workspace.commit(preview);

      expect(readFileSync(path.join(root, "generated", "nested", "file.txt"), "utf8")).toBe(
        "created\n",
      );
    });
  });

  test("rejects nested file creation when a missing parent changes after preview", async () => {
    await withRepo(async (root) => {
      const workspace = new Workspace(root);
      const preview = workspace.preview({
        kind: "edit",
        path: "generated/file.txt",
        create: true,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "", replace: "created\n", expectedMatches: 1 }],
      });
      writeFileSync(path.join(root, "generated"), "concurrent file\n");

      expect(() => workspace.commit(preview)).toThrow(/changed after it was approved/i);
      expect(readFileSync(path.join(root, "generated"), "utf8")).toBe("concurrent file\n");
    });
  });

  test("creates nested directories and records only directories it created", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "assets"));
      const workspace = new Workspace(root);

      const preview = workspace.previewMkdir("assets/generated/icons");
      expect(preview.changes.map((change) => change.path)).toEqual([
        "assets/generated",
        "assets/generated/icons",
      ]);

      workspace.commit(preview);
      expect(lstatSync(path.join(root, "assets", "generated", "icons")).isDirectory()).toBe(true);
    });
  });

  test("rejects mkdir when a planned component appears after preview", async () => {
    await withRepo(async (root) => {
      const workspace = new Workspace(root);
      const preview = workspace.previewMkdir("generated/icons");
      writeFileSync(path.join(root, "generated"), "concurrent file\n");

      expect(() => workspace.commit(preview)).toThrow(/changed after it was approved/i);
      expect(readFileSync(path.join(root, "generated"), "utf8")).toBe("concurrent file\n");
    });
  });

  test("moves a directory tree to an absent destination and preserves binary files and symlinks", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src", "nested"), { recursive: true });
      writeFileSync(path.join(root, "src", "nested", "data.bin"), Buffer.from([1, 2, 3, 255]));
      symlinkSync("nested/data.bin", path.join(root, "src", "data-link"));
      const workspace = new Workspace(root);

      const preview = workspace.previewMove("src", "archive/source");
      workspace.commit(preview);

      expect(existsSync(path.join(root, "src"))).toBe(false);
      expect(readFileSync(path.join(root, "archive", "source", "nested", "data.bin"))).toEqual(
        Buffer.from([1, 2, 3, 255]),
      );
      expect(readlinkSync(path.join(root, "archive", "source", "data-link"))).toBe(
        path.normalize("nested/data.bin"),
      );
    });
  });

  test("rejects a stale move when the source changes after preview", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src", "a.txt"), "a\n");
      const workspace = new Workspace(root);
      const preview = workspace.previewMove("src", "archive/src");
      writeFileSync(path.join(root, "src", "b.txt"), "b\n");

      expect(() => workspace.commit(preview)).toThrow(/changed after it was approved/i);
      expect(existsSync(path.join(root, "src", "a.txt"))).toBe(true);
      expect(existsSync(path.join(root, "archive"))).toBe(false);
    });
  });

  test("copies a directory tree without modifying the source", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "templates", "base"), { recursive: true });
      writeFileSync(path.join(root, "templates", "base", "config.json"), '{"ok":true}\n');
      const workspace = new Workspace(root);

      const preview = workspace.previewCopy("templates/base", "generated/base");
      workspace.commit(preview);

      expect(readFileSync(path.join(root, "templates", "base", "config.json"), "utf8")).toContain(
        "true",
      );
      expect(readFileSync(path.join(root, "generated", "base", "config.json"), "utf8")).toContain(
        "true",
      );
    });
  });

  test("rejects copy when the destination appears after preview", async () => {
    await withRepo(async (root) => {
      writeFileSync(path.join(root, "source.txt"), "source\n");
      const workspace = new Workspace(root);
      const preview = workspace.previewCopy("source.txt", "generated/copied.txt");
      mkdirSync(path.join(root, "generated"));
      writeFileSync(path.join(root, "generated", "copied.txt"), "concurrent\n");

      expect(() => workspace.commit(preview)).toThrow(/changed after it was approved/i);
      expect(readFileSync(path.join(root, "generated", "copied.txt"), "utf8")).toBe("concurrent\n");
      expect(readFileSync(path.join(root, "source.txt"), "utf8")).toBe("source\n");
    });
  });

  test("protects repository metadata and refuses implicit overwrite", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, ".git"));
      writeFileSync(path.join(root, "a.txt"), "a\n");
      writeFileSync(path.join(root, "b.txt"), "b\n");
      const workspace = new Workspace(root);

      expect(() => workspace.previewDelete(".git")).toThrow(/protected/i);
      expect(() => workspace.previewMove("a.txt", "b.txt")).toThrow(/already exists/i);
      expect(() => workspace.previewCopy("a.txt", "b.txt")).toThrow(/already exists/i);
    });
  });
});
