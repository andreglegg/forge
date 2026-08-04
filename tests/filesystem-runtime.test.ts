import {
  chmodSync,
  existsSync,
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
import { type IO, main } from "../src/cli.js";
import { TextCodec } from "../src/codecs.js";
import { storeBytes } from "../src/objects.js";
import { renderHeadless, renderInteractive } from "../src/render.js";
import { Run } from "../src/runtime.js";
import { SessionStore } from "../src/session.js";
import { Workspace } from "../src/workspace.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-fs-runtime-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function decode(source: string) {
  const codec = new TextCodec();
  codec.feed(source);
  return codec.finish();
}

async function execute(root: string, directive: string, id: string): Promise<Run> {
  const workspace = new Workspace(root);
  const run = new Run(
    {
      workspace,
      runTool: async () => ({ ok: false, output: "unexpected non-filesystem tool" }),
      retain: (content) =>
        storeBytes(root, typeof content === "string" ? Buffer.from(content, "utf8") : content),
    },
    true,
  );
  const drained = (async () => {
    for await (const _event of run.events()) {
      // drain
    }
  })();
  run.start(directive);
  await run.submit(decode(`${directive}\n`));
  run.close();
  await drained;
  new SessionStore(root).save(id, run.journal);
  return run;
}

function capture(): { io: IO; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  };
}

describe("filesystem runtime and undo", () => {
  test("recursively deletes and restores text, binary, directories, and symlinks", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src", "nested"), { recursive: true });
      writeFileSync(path.join(root, "src", "game.ts"), "export const game = true;\n");
      const binary = Buffer.from([0, 1, 2, 255]);
      writeFileSync(path.join(root, "src", "nested", "data.bin"), binary);
      symlinkSync("../game.ts", path.join(root, "src", "nested", "game-link"));

      const run = await execute(root, "DELETE src", "delete-tree");
      expect(existsSync(path.join(root, "src"))).toBe(false);
      expect(run.snapshot().committed.map((entry) => entry.path)).toContain("src");
      const mutationEvents = run.journal
        .all()
        .filter((event) => event.type === "mutation.committed");
      expect(mutationEvents.map((event) => renderHeadless(event)).filter(Boolean)).toEqual([
        "committed src +0 -1",
      ]);
      expect(mutationEvents.map((event) => renderInteractive(event)).filter(Boolean)).toEqual([
        "    ✓ src  +0 -1",
      ]);

      const output = capture();
      const code = await main(["undo", "delete-tree", "--repo", root], output.io);

      expect(code).toBe(0);
      expect(readFileSync(path.join(root, "src", "game.ts"), "utf8")).toContain("game = true");
      expect(readFileSync(path.join(root, "src", "nested", "data.bin"))).toEqual(binary);
      expect(readlinkSync(path.join(root, "src", "nested", "game-link"))).toBe("../game.ts");
    });
  });

  test("does not delete anything when undo retention fails", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
      const run = new Run(
        {
          workspace: new Workspace(root),
          runTool: async () => ({ ok: false, output: "unexpected tool" }),
          retain: () => {
            throw new Error("object store unavailable");
          },
        },
        true,
      );
      const drained = (async () => {
        for await (const _event of run.events()) {
          // drain
        }
      })();

      run.start("DELETE src");
      const result = await run.submit(decode("DELETE src\n"));
      run.close();
      await drained;

      expect(result.results).toContainEqual(
        expect.objectContaining({
          ok: false,
          output: expect.stringMatching(/undo data.*not applied/i),
        }),
      );
      expect(existsSync(path.join(root, "src", "index.ts"))).toBe(true);
      expect(run.snapshot().committed).toEqual([]);
    });
  });

  test("moves a tree and undo restores the exact source location", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");

      await execute(root, "MOVE src -> archive/source", "move-tree");
      expect(existsSync(path.join(root, "src"))).toBe(false);
      expect(existsSync(path.join(root, "archive", "source", "index.ts"))).toBe(true);

      const code = await main(["undo", "move-tree", "--repo", root], capture().io);

      expect(code).toBe(0);
      expect(readFileSync(path.join(root, "src", "index.ts"), "utf8")).toContain("export");
      expect(existsSync(path.join(root, "archive"))).toBe(false);
    });
  });

  test("copy undo removes only the copied tree", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "templates", "base"), { recursive: true });
      writeFileSync(path.join(root, "templates", "base", "config.json"), '{"ok":true}\n');

      await execute(root, "COPY templates/base -> generated/base", "copy-tree");
      expect(existsSync(path.join(root, "generated", "base", "config.json"))).toBe(true);

      const code = await main(["undo", "copy-tree", "--repo", root], capture().io);

      expect(code).toBe(0);
      expect(existsSync(path.join(root, "generated"))).toBe(false);
      expect(readFileSync(path.join(root, "templates", "base", "config.json"), "utf8")).toContain(
        "true",
      );
    });
  });

  test("rename undo returns a file to its old name", async () => {
    await withRepo(async (root) => {
      writeFileSync(path.join(root, "old name.txt"), "content\n");

      await execute(root, "RENAME old name.txt -> new name.txt", "rename-file");
      expect(existsSync(path.join(root, "old name.txt"))).toBe(false);
      expect(existsSync(path.join(root, "new name.txt"))).toBe(true);

      const code = await main(["undo", "rename-file", "--repo", root], capture().io);

      expect(code).toBe(0);
      expect(readFileSync(path.join(root, "old name.txt"), "utf8")).toBe("content\n");
      expect(existsSync(path.join(root, "new name.txt"))).toBe(false);
    });
  });

  test("nested CREATE undo removes the file and only the parents it created", async () => {
    await withRepo(async (root) => {
      const directive = [
        "CREATE generated/nested/file.txt",
        "<<<<<<< SEARCH",
        "=======",
        "created",
        ">>>>>>> REPLACE",
      ].join("\n");

      const run = await execute(root, directive, "create-nested-file");
      expect(readFileSync(path.join(root, "generated", "nested", "file.txt"), "utf8")).toBe(
        "created",
      );
      expect(run.snapshot().committed.map((entry) => entry.path)).toEqual([
        "generated",
        "generated/nested",
        "generated/nested/file.txt",
      ]);

      const code = await main(["undo", "create-nested-file", "--repo", root], capture().io);

      expect(code).toBe(0);
      expect(existsSync(path.join(root, "generated"))).toBe(false);
    });
  });

  test("mkdir undo removes exactly the nested directories it created", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "assets"));

      await execute(root, "MKDIR assets/generated/icons", "mkdir-tree");
      expect(existsSync(path.join(root, "assets", "generated", "icons"))).toBe(true);

      const code = await main(["undo", "mkdir-tree", "--repo", root], capture().io);

      expect(code).toBe(0);
      expect(existsSync(path.join(root, "assets", "generated"))).toBe(false);
      expect(existsSync(path.join(root, "assets"))).toBe(true);
    });
  });

  test("undo refuses a created directory whose mode changed after the session", async () => {
    await withRepo(async (root) => {
      await execute(root, "MKDIR generated", "mkdir-mode-change");
      chmodSync(path.join(root, "generated"), 0o700);
      const output = capture();

      const code = await main(["undo", "mkdir-mode-change", "--repo", root], output.io);

      expect(code).toBe(1);
      expect(existsSync(path.join(root, "generated"))).toBe(true);
      expect(output.lines.join("\n")).toContain("left untouched");
    });
  });
});
