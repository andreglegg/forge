/**
 * Replacing a file wholesale.
 *
 * Observed live: a 320-line index.html and "make it 3D with three.js". A
 * whole-file rewrite through SEARCH/REPLACE has to quote the entire original
 * *and* its replacement, which does not fit in one reply, so every attempt was
 * truncated and nothing happened for eighteen turns. The model said so itself:
 * "I cannot replace the entire file content because search/replace requires
 * exact matching."
 *
 * CREATE carries only the new text, so it fits where an edit does not -- but it
 * refused outright on an existing file to stop a model clobbering work it had
 * never looked at. That guard is right, and too blunt: a model that has just
 * read the file is not clobbering blind.
 *
 * So CREATE over an existing file is allowed exactly when the model has read
 * the complete bounded file at its current revision, and refused otherwise.
 * Ranged reads and clipped large-file reads are evidence for anchored edits,
 * not permission to replace bytes the model has never seen. The prompt is
 * unchanged deliberately -- protocol.ts records that padding it measurably hurt.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type Decision, Run } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";

async function withRepo<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "rewrite-"));
  try {
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NOOP_TOOLS = { runTool: async () => ({ ok: true, output: "" }) };

function autoRespond(run: Run, decision: Decision): void {
  void (async () => {
    for await (const event of run.events()) {
      if (event.type === "approval.requested")
        run.send({ type: "approve", id: event.id, decision });
    }
  })();
}

function createOf(target: string, contents: string) {
  return {
    text: "replacing it",
    proposals: [
      {
        kind: "edit" as const,
        path: target,
        create: true,
        rewrite: false,
        operations: [{ search: "", replace: contents, expectedMatches: 1 }],
        baseRevision: null,
      },
    ],
    final: null,
  };
}

describe("CREATE over an existing file", () => {
  test("is refused when the model has not read it", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "index.html");
      writeFileSync(file, "<html>original</html>\n");
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      run.start("make it 3d");

      const outcome = await run.submit(createOf("index.html", "<html>replaced</html>\n"));

      expect(outcome.results.some((r) => !r.ok)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("<html>original</html>\n");
    });
  });

  test("replaces the file once the model has read it", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "index.html");
      writeFileSync(file, "<html>original</html>\n");
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      autoRespond(run, "always");
      run.start("make it 3d");

      await run.submit({
        text: "reading first",
        proposals: [{ kind: "call", tool: "read", arguments: { path: "index.html" } }],
        final: null,
      });
      await run.submit(createOf("index.html", "<html>replaced</html>\n"));

      expect(readFileSync(file, "utf8")).toBe("<html>replaced</html>\n");
    });
  });

  test("a ranged read does not license a whole-file clobber", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "index.html");
      writeFileSync(file, "<html>original</html>\n");
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      autoRespond(run, "always");
      run.start("make it 3d");

      await run.submit({
        text: "reading one range",
        proposals: [
          {
            kind: "call",
            tool: "read",
            arguments: { path: "index.html", start: 1, end: 1 },
          },
        ],
        final: null,
      });
      const outcome = await run.submit(createOf("index.html", "<html>replaced</html>\n"));

      expect(outcome.results.some((result) => !result.ok)).toBe(true);
      expect(outcome.results.at(-1)?.output).toMatch(/complete file/i);
      expect(readFileSync(file, "utf8")).toBe("<html>original</html>\n");
    });
  });

  test("an unrestricted read of a large clipped file does not license a clobber", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "large.html");
      const original = `<html>${"x".repeat(20_000)}</html>\n`;
      writeFileSync(file, original);
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      autoRespond(run, "always");
      run.start("replace the large page");

      await run.submit({
        text: "reading the large file",
        proposals: [{ kind: "call", tool: "read", arguments: { path: "large.html" } }],
        final: null,
      });
      const outcome = await run.submit(createOf("large.html", "<html>replaced</html>\n"));

      expect(outcome.results.some((result) => !result.ok)).toBe(true);
      expect(outcome.results.at(-1)?.output).toMatch(/anchored EDIT/i);
      expect(readFileSync(file, "utf8")).toBe(original);
    });
  });

  test("a failed read does not license a clobber", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "index.html");
      writeFileSync(file, "<html>original</html>\n");
      const run = new Run({
        workspace: new Workspace(dir),
        runTool: async () => ({ ok: false, output: "read failed" }),
      });
      run.start("make it 3d");

      await run.submit({
        text: "reading first",
        proposals: [{ kind: "call", tool: "read", arguments: { path: "index.html" } }],
        final: null,
      });
      const outcome = await run.submit(createOf("index.html", "<html>replaced</html>\n"));

      expect(outcome.results.some((result) => !result.ok)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("<html>original</html>\n");
    });
  });

  test("a stale read does not license a clobber", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "index.html");
      writeFileSync(file, "<html>original</html>\n");
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      autoRespond(run, "always");
      run.start("make it 3d");

      await run.submit({
        text: "reading first",
        proposals: [{ kind: "call", tool: "read", arguments: { path: "index.html" } }],
        final: null,
      });
      // Something else changed the file after that read.
      writeFileSync(file, "<html>changed by someone else</html>\n");

      await run.submit(createOf("index.html", "<html>replaced</html>\n"));

      expect(readFileSync(file, "utf8")).toBe("<html>changed by someone else</html>\n");
    });
  });
});
