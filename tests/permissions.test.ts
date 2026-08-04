import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { TextCodec } from "../src/codecs.js";
import { Run } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";

function decode(source: string) {
  const codec = new TextCodec();
  codec.feed(source);
  return codec.finish();
}

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-permissions-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("runtime capability policy", () => {
  test("refuses an edit before preview even with automatic approval enabled", async () => {
    await withRepo(async (root) => {
      const file = path.join(root, "app.ts");
      writeFileSync(file, "old\n");
      const outputs: string[] = [];
      const run = new Run(
        {
          workspace: new Workspace(root),
          runTool: async () => ({ ok: true, output: "should not run" }),
          authorize: () => "read-only mode forbids edits and command execution",
        },
        true,
      );
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "action.finished") outputs.push(event.output);
        }
      })();

      run.start("change it");
      await run.submit(
        decode(
          ["EDIT app.ts", "<<<<<<< SEARCH", "old", "=======", "new", ">>>>>>> REPLACE", ""].join(
            "\n",
          ),
        ),
      );
      run.close();
      await drained;

      expect(readFileSync(file, "utf8")).toBe("old\n");
      expect(outputs).toEqual([expect.stringMatching(/read-only mode/i)]);
    });
  });

  test("refuses every filesystem mutation before preview even with automatic approval enabled", async () => {
    await withRepo(async (root) => {
      const file = path.join(root, "obsolete.ts");
      writeFileSync(file, "export const obsolete = true;\n");
      mkdirSync(path.join(root, "source"));
      writeFileSync(path.join(root, "source", "data.txt"), "data\n");
      let called = false;
      const run = new Run(
        {
          workspace: new Workspace(root),
          runTool: async () => {
            called = true;
            return { ok: true, output: "should not run" };
          },
          authorize: () => "read-only mode forbids edits and command execution",
        },
        true,
      );
      const drained = (async () => {
        for await (const _event of run.events()) {
          // drain
        }
      })();

      run.start("try filesystem mutations");
      const outcome = await run.submit(
        decode(
          [
            "DELETE obsolete.ts",
            "MKDIR new-dir",
            "MOVE source -> moved-source",
            "COPY source -> copied-source",
            "RENAME obsolete.ts -> renamed.ts",
            "",
          ].join("\n"),
        ),
      );
      run.close();
      await drained;

      expect(called).toBe(false);
      expect(readFileSync(file, "utf8")).toContain("obsolete");
      expect(existsSync(path.join(root, "source", "data.txt"))).toBe(true);
      expect(existsSync(path.join(root, "new-dir"))).toBe(false);
      expect(existsSync(path.join(root, "moved-source"))).toBe(false);
      expect(existsSync(path.join(root, "copied-source"))).toBe(false);
      expect(existsSync(path.join(root, "renamed.ts"))).toBe(false);
      expect(outcome.results).toHaveLength(5);
      expect(
        outcome.results.every((result) => !result.ok && /read-only mode/i.test(result.output)),
      ).toBe(true);
    });
  });

  test("refuses command execution without calling the command effect", async () => {
    await withRepo(async (root) => {
      let called = false;
      const run = new Run(
        {
          workspace: new Workspace(root),
          runTool: async () => {
            called = true;
            return { ok: true, output: "ran" };
          },
          authorize: () => "plan mode is read-only",
        },
        true,
      );
      const drained = (async () => {
        for await (const _event of run.events()) {
          // drain
        }
      })();

      run.start("plan it");
      const outcome = await run.submit(decode("RUN npm test\n"));
      run.close();
      await drained;

      expect(called).toBe(false);
      expect(outcome.results[0]).toMatchObject({ ok: false, output: "plan mode is read-only" });
    });
  });
});
