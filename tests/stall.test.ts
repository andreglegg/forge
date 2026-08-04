/**
 * The silent stall.
 *
 * Observed live: a 320-line file, a request to rewrite it wholesale, and a
 * reply budget too small to hold the quoted original plus its replacement. The
 * edit block was cut off mid-stream, the decoder correctly refused it, and the
 * turn produced no action at all. The model then retried the identical thing
 * eighteen times, burning the whole turn budget and 343 seconds while the user
 * watched it narrate intent.
 *
 * Two things were missing. The repetition guard only ever sees decoded
 * proposals, so a turn that decodes nothing is invisible to the one loop
 * breaker in the system. And `truncated_edit_block` was recorded in the trace
 * but never told to the model or the user -- the harness knew exactly what was
 * wrong and said nothing.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { Run } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";

async function withRepo<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "stall-"));
  try {
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NOOP_TOOLS = { runTool: async () => ({ ok: true, output: "" }) };
const NOTHING = { text: "I'll rewrite the file.", proposals: [], final: null };

describe("a turn that produces no action", () => {
  test("a truncated edit block is explained to the model, not silently dropped", async () => {
    await withRepo(async (dir) => {
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      run.start("convert it to three.js");

      const outcome = await run.submit({ ...NOTHING, repairs: ["truncated_edit_block"] });

      const said = outcome.results.map((result) => result.output).join("\n");
      expect(said).toMatch(/truncated|too large|smaller/i);
      expect(outcome.results.every((result) => !result.ok)).toBe(true);
      expect(outcome.finished).toBe(false);
    });
  });

  test("repeated no-action turns stop the run instead of burning the budget", async () => {
    await withRepo(async (dir) => {
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      run.start("convert it to three.js");

      const first = await run.submit({ ...NOTHING, repairs: ["truncated_edit_block"] });
      expect(first.stalled ?? false).toBe(false);

      const second = await run.submit({ ...NOTHING, repairs: ["truncated_edit_block"] });
      expect(second.stalled).toBe(true);
    });
  });

  test("an action of any kind clears the stall counter", async () => {
    await withRepo(async (dir) => {
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      run.start("convert it to three.js");

      await run.submit({ ...NOTHING, repairs: ["truncated_edit_block"] });
      await run.submit({
        text: "reading first",
        proposals: [{ kind: "call", tool: "list", arguments: { path: "." } }],
        final: null,
      });
      const third = await run.submit({ ...NOTHING, repairs: ["truncated_edit_block"] });

      // Progress happened in between, so this is the first stall of a new
      // streak rather than the second of an old one.
      expect(third.stalled ?? false).toBe(false);
    });
  });

  test("a plain empty reply is nudged too, without blaming truncation", async () => {
    await withRepo(async (dir) => {
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      run.start("do the thing");

      const outcome = await run.submit(NOTHING);

      const said = outcome.results.map((result) => result.output).join("\n");
      expect(said).toMatch(/no action/i);
      expect(said).not.toMatch(/truncated/i);
    });
  });
});
