/**
 * The first vertical slice: one approved edit, end to end.
 *
 * This is the test the architecture exists to pass. If the seam
 * `propose → preview → approve → revalidate → commit → journal → replay` is
 * right, everything else composes onto it; if it is wrong, every later feature
 * routes around it. So it is proven before there is a provider, a TUI, a
 * planner or a repository index.
 *
 * Both codecs drive the same assertions. That is the point of the
 * `ActionProposal` boundary: a native tool call and a SEARCH/REPLACE block are
 * two spellings of one intent, and everything downstream must be unable to tell
 * them apart.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NativeCodec, splitArgv, TextCodec } from "../src/codecs.js";
import {
  boundTurnIntent,
  describeProposal,
  mutates,
  renderProposal,
  TOOLS,
  textProtocolPrompt,
} from "../src/protocol.js";
import { renderHeadless, renderInteractive } from "../src/render.js";
import { type Decision, Journal, Run, type RunEvent, replay } from "../src/runtime.js";
import { diffLines, resolveInside, revisionOfContent, Workspace } from "../src/workspace.js";

async function withRepo<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-"));
  try {
    // Realpath it: on macOS the OS temp dir is `/var/...` symlinked to
    // `/private/var/...`, and every path the workspace returns is realpath'd,
    // so a test comparing against the raw path fails for the wrong reason.
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Collects the event stream in the background, the way a renderer would.
 *
 * `drained` matters: a subscriber is asynchronous, so after `run.close()` the
 * queue has not necessarily been read yet. Asserting on `events` without
 * awaiting it is a race that passes or fails on microtask scheduling.
 */
function collect(run: Run): { events: RunEvent[]; frames: string[]; drained: Promise<void> } {
  const events: RunEvent[] = [];
  const frames: string[] = [];
  const drained = (async () => {
    for await (const event of run.events()) {
      events.push(event);
      const frame = renderInteractive(event);
      if (frame !== null) frames.push(frame);
    }
  })();
  return { events, frames, drained };
}

/** Answers every approval request with a fixed decision, as the TUI would. */
function autoRespond(run: Run, decision: Decision): void {
  void (async () => {
    for await (const event of run.events()) {
      if (event.type === "approval.requested") {
        run.send({ type: "approve", id: event.id, decision });
      }
    }
  })();
}

const NOOP_TOOLS = {
  runTool: async () => ({ ok: true, output: "" }),
};

const TEXT_TURN = [
  "I'll bump the version.",
  "EDIT app.ts",
  "<<<<<<< SEARCH",
  "const version = 1;",
  "=======",
  "const version = 2;",
  ">>>>>>> REPLACE",
  "DONE bumped the version",
  "",
].join("\n");

describe("the two codecs agree", () => {
  test("text and native produce an identical proposal", () => {
    const text = new TextCodec();
    text.feed(TEXT_TURN);
    const fromText = text.finish();

    const native = new NativeCodec();
    native.feed({ text: "I'll bump the version." });
    native.feed({
      call: {
        id: "c1",
        name: "edit",
        argumentsDelta: JSON.stringify({
          path: "app.ts",
          operations: [{ search: "const version = 1;", replace: "const version = 2;" }],
        }),
      },
    });
    native.feed({ finish: true });
    const fromNative = native.finish();

    // The whole reason the boundary exists. Two wire formats, one intent.
    expect(fromNative.proposals).toEqual(fromText.proposals);
  });

  test("a directive and a native call for the same tool agree", () => {
    const text = new TextCodec();
    text.feed("RUN npm test\n");
    const native = new NativeCodec();
    native.feed({
      call: { id: "c1", name: "run", argumentsDelta: JSON.stringify({ command: ["npm", "test"] }) },
    });
    native.feed({ finish: true });

    expect(native.finish().proposals).toEqual(text.finish().proposals);
  });

  test("every registry tool appears in the generated prompt", () => {
    // Structural anti-drift: a tool the executor knows and the prompt does not
    // is invisible to the model; the reverse is a guaranteed failed turn.
    const prompt = textProtocolPrompt();
    for (const tool of TOOLS) {
      if (tool.textForm !== undefined) {
        expect(prompt, tool.name).toContain(tool.textForm);
      }
    }
  });
});

describe("decoded action guard", () => {
  test("deduplicates and limits runaway run directives before execution", () => {
    const codec = new TextCodec();
    codec.feed(
      [
        ...Array.from({ length: 20 }, (_, index) => `RUN tool command-${index}`),
        "RUN tool command-0",
        "DONE finished",
        "",
      ].join("\n"),
    );

    const bounded = boundTurnIntent(codec.finish(), {
      proposals: 8,
      runs: 2,
      mutations: 1,
    });

    expect(bounded.turn.proposals).toHaveLength(2);
    expect(bounded.dropped).toBe(19);
    expect(bounded.duplicates).toBe(1);
    expect(bounded.turn.final).toBeNull();
    expect(bounded.turn.repairs).toContain("duplicate_proposal");
    expect(bounded.turn.repairs).toContain("proposal_limit");
    expect(bounded.notice).toContain("over-budget");
  });
});

describe("the transcript stays canonical", () => {
  test("a decoded proposal round-trips through the text protocol", () => {
    // decode(render(p)) === p. This is what lets the assistant turn written
    // into the transcript be a re-rendering rather than the model's raw bytes.
    for (const source of [
      ["EDIT a.ts", "<<<<<<< SEARCH", "old", "=======", "new", ">>>>>>> REPLACE", ""].join("\n"),
      "READ src/app.ts\n",
      "RUN npm test\n",
      "SEARCH needle\n",
      "LIST .\n",
    ]) {
      const first = decodeText(source).proposals;
      const rendered = first.map(renderProposal).join("\n");
      expect(decodeText(`${rendered}\n`).proposals, source).toEqual(first);
    }
  });

  test("a malformed marker direction is accepted and counted", () => {
    // qwen3-coder-30b opens with `>>>>>>> SEARCH` about as often as
    // `<<<<<<< SEARCH`. The word carries the meaning; the direction does not.
    const turn = decodeText(
      ["EDIT a.ts", ">>>>>>> SEARCH", "old", "=======", "new", ">>>>>>> REPLACE", ""].join("\n"),
    );

    expect(turn.proposals).toHaveLength(1);
    expect(turn.repairs).toContain("marker_direction");
    // ...and the canonical re-rendering spells it correctly, so the model
    // never sees its own malformation reflected back.
    const [first] = turn.proposals;
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(renderProposal(first)).toContain("<<<<<<< SEARCH");
    }
  });

  test("a stray closing marker is debris, not prose", () => {
    // Otherwise the user is shown the model's syntax error rendered as if it
    // were an explanation. Seen live, filling the chat with `=======` lines.
    const turn = decodeText("Here is my plan.\n=======\n>>>>>>> REPLACE\n");

    expect(turn.text).toBe("Here is my plan.");
    expect(turn.repairs).toContain("stray_marker");
  });
});

describe("the edit format cannot express every edit", () => {
  test("a quoted region containing the markers is mis-parsed, and that is why the prompt says not to", () => {
    // A real failure, from a real run: asked to change one word in a markdown
    // file that DOCUMENTS merge conflicts, the model quoted ten lines of
    // context, and those lines contained `=======` and `>>>>>>> REPLACE`. The
    // inner divider ended the SEARCH section and the inner terminator ended
    // the block, so the search text was silently truncated to something that
    // does not exist in the file. Nothing threw; the edit simply never applied.
    //
    // This is a limit of a line-delimited format, not a bug with a local fix:
    // both the divider and the terminator become ambiguous, and resolving them
    // needs the file, which the decoder does not have. What DOES fix it is not
    // over-quoting -- `status: Draft` alone was a unique anchor here -- which
    // is now what the prompt tells the model to do, and which also costs fewer
    // tokens and truncates less often.
    const turn = decodeText(
      [
        "EDIT docs.md",
        "<<<<<<< SEARCH",
        "status: Draft",
        "<<<<<<< SEARCH",
        "ours",
        "=======",
        "theirs",
        ">>>>>>> REPLACE",
        "=======",
        "status: Final",
        ">>>>>>> REPLACE",
        "",
      ].join("\n"),
    );

    const [first] = turn.proposals;
    expect(first).toBeDefined();
    if (first !== undefined && first.kind === "edit") {
      // Truncated at the inner divider — not what the model meant.
      expect(first.operations[0]?.search).not.toContain("status: Final");
      expect(first.operations[0]?.search).toContain("status: Draft");
    }
  });

  test("the prompt asks for the smallest unique anchor, and no more than that", () => {
    // It once said more: eight lines about marker collisions and why
    // over-quoting is costly. Benchmarked, that version was WORSE -- the task
    // it targeted fell from 2/3 to 0/3 and false successes across the suite
    // rose from 1 to 6. The protocol is the load-bearing part of this prompt
    // and burying it in caveats costs more than the edge case they addressed.
    // So the guidance stays, the lecture does not, and this test pins the
    // difference so it is not helpfully re-expanded later.
    const prompt = textProtocolPrompt();

    expect(prompt).toContain("smallest text that");
    expect(prompt).not.toContain("cannot be parsed at all");
    expect(prompt.split("\n").length).toBeLessThan(30);
  });
});

describe("streaming decode", () => {
  test("a proposal is only emitted once its terminator arrives", () => {
    // Truncation was 100% of the unrecoverable failures in the recorded
    // corpus. Half an edit must never become an action.
    const codec = new TextCodec();
    const upTo = TEXT_TURN.indexOf(">>>>>>> REPLACE");
    expect(codec.feed(TEXT_TURN.slice(0, upTo))).toEqual([]);
    expect(codec.feed(TEXT_TURN.slice(upTo))).toHaveLength(1);
  });

  test("chunk boundaries in the middle of a marker do not break decoding", () => {
    const codec = new TextCodec();
    const emitted: unknown[] = [];
    for (const char of TEXT_TURN) {
      emitted.push(...codec.feed(char));
    }
    const turn = codec.finish();

    expect(emitted).toHaveLength(1);
    expect(turn.final).toBe("bumped the version");
    expect(turn.text).toBe("I'll bump the version.");
  });

  test("a truncated edit block yields nothing and is counted", () => {
    const codec = new TextCodec();
    codec.feed(TEXT_TURN.slice(0, TEXT_TURN.indexOf("=======")));
    const turn = codec.finish();

    expect(turn.proposals).toEqual([]);
    expect(turn.repairs).toContain("truncated_edit_block");
  });

  test("native arguments are never parsed until the message completes", () => {
    const native = new NativeCodec();
    // Half a JSON document. Acting on this is the native equivalent of
    // applying half an edit.
    expect(native.feed({ call: { id: "c1", name: "run", argumentsDelta: '{"comm' } })).toEqual([]);
    expect(native.feed({ call: { id: "c1", argumentsDelta: 'and":["npm","test"]}' } })).toEqual([]);
    expect(native.feed({ finish: true })).toHaveLength(1);
  });

  test("argv splitting handles quotes and never invokes a shell", () => {
    expect(splitArgv(`npm test -- --grep "two words"`)).toEqual([
      "npm",
      "test",
      "--",
      "--grep",
      "two words",
    ]);
    // No operators, no expansion: these are literal tokens, which is why
    // shell: false is safe.
    expect(splitArgv("echo hi; rm -rf /")).toEqual(["echo", "hi;", "rm", "-rf", "/"]);
  });
});

describe("the workspace previews without mutating", () => {
  test("preview computes the diff and leaves the file alone", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "app.ts");
      writeFileSync(file, "const version = 1;\n");
      const workspace = new Workspace(dir);

      const preview = workspace.preview({
        kind: "edit",
        path: "app.ts",
        create: false,
        rewrite: false,
        baseRevision: null,
        operations: [
          { search: "const version = 1;", replace: "const version = 2;", expectedMatches: 1 },
        ],
      });

      expect(preview.after).toBe("const version = 2;\n");
      expect(preview.baseRevision).toBe(revisionOfContent("const version = 1;\n"));
      expect(preview.afterRevision).toBe(revisionOfContent("const version = 2;\n"));
      expect(preview.added).toBe(1);
      expect(preview.removed).toBe(1);
      // Unchanged on disk: the user has not approved anything yet.
      expect(readFileSync(file, "utf8")).toBe("const version = 1;\n");
    });
  });

  test("an ambiguous anchor is refused with a message the model can act on", async () => {
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "app.ts"), "x = 1;\nx = 1;\n");
      const workspace = new Workspace(dir);

      expect(() =>
        workspace.preview({
          kind: "edit",
          path: "app.ts",
          create: false,
          rewrite: false,
          baseRevision: null,
          operations: [{ search: "x = 1;", replace: "x = 2;", expectedMatches: 1 }],
        }),
      ).toThrow(/appears 2 times/);
    });
  });

  test("a stale proposal is refused at commit, not applied", async () => {
    // The reason baseRevision exists. Approval is consent for a specific
    // version; if the file moved, that consent no longer describes reality.
    await withRepo(async (dir) => {
      const file = path.join(dir, "app.ts");
      writeFileSync(file, "const version = 1;\n");
      const workspace = new Workspace(dir);
      const preview = workspace.preview({
        kind: "edit",
        path: "app.ts",
        create: false,
        rewrite: false,
        baseRevision: null,
        operations: [
          { search: "const version = 1;", replace: "const version = 2;", expectedMatches: 1 },
        ],
      });

      writeFileSync(file, "someone else edited this\n");

      expect(() => workspace.commit(preview)).toThrow(/changed after it was approved/);
      expect(readFileSync(file, "utf8")).toBe("someone else edited this\n");
    });
  });

  test("a symlink pointing out of the workspace is not inside it", async () => {
    await withRepo(async (dir) => {
      const { symlinkSync, mkdirSync } = await import("node:fs");
      const root = path.join(dir, "repo");
      mkdirSync(root);
      mkdirSync(path.join(dir, "outside"));
      writeFileSync(path.join(dir, "outside", "creds"), "secret");
      symlinkSync("../outside", path.join(root, "link"));

      // path.resolve would return repo/link/creds, which looks contained.
      expect(path.resolve(root, "link/creds")).toBe(path.join(root, "link", "creds"));
      expect(resolveInside(root, "link/creds")).toBeNull();
      // ...and a path that does not exist yet must still resolve, or no file
      // could ever be created.
      expect(resolveInside(root, "a/b/new.ts")).toBe(path.join(root, "a", "b", "new.ts"));
    });
  });

  test("the diff is a real LCS, not a whole-file replace", () => {
    const hunks = diffLines("a\nb\nc\n", "a\nB\nc\n");

    expect(hunks.filter((h) => h.kind === "context").map((h) => h.text)).toEqual(["a", "c", ""]);
    expect(hunks.filter((h) => h.kind === "remove").map((h) => h.text)).toEqual(["b"]);
    expect(hunks.filter((h) => h.kind === "add").map((h) => h.text)).toEqual(["B"]);
  });
});

describe("one approved edit, end to end", () => {
  for (const codec of ["text", "native"] as const) {
    test(`${codec} codec: approve, revalidate, commit, journal, replay`, async () => {
      await withRepo(async (dir) => {
        const file = path.join(dir, "app.ts");
        writeFileSync(file, "const version = 1;\n");
        const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
        const { events, frames, drained } = collect(run);
        autoRespond(run, "once");

        run.start("bump the version");
        const turn =
          codec === "text"
            ? decodeText(TEXT_TURN)
            : decodeNative({
                path: "app.ts",
                operations: [{ search: "const version = 1;", replace: "const version = 2;" }],
              });
        await run.submit(turn);
        run.close();
        await drained;
        await drained;

        // 1. The edit actually landed.
        expect(readFileSync(file, "utf8")).toBe("const version = 2;\n");

        // 2. The user was asked before it landed, and the diff was in the ask.
        const requested = events.find((e) => e.type === "approval.requested");
        expect(requested).toBeDefined();
        expect(requested?.type === "approval.requested" && requested.preview?.added).toBe(1);
        expect(order(events)).toEqual([
          "run.started",
          "turn.started",
          "model.text",
          "action.proposed",
          "approval.requested",
          "approval.resolved",
          "action.started",
          "mutation.committed",
          "action.finished",
          ...(codec === "text" ? ["run.finished"] : []),
        ]);

        // 3. Both projections rendered the same facts.
        expect(frames.join("\n")).toContain("+ const version = 2;");
        const headless = events.map(renderHeadless).filter((line) => line !== null);
        expect(headless).toContain("committed app.ts +1 -1");
        const committed = events.find((event) => event.type === "mutation.committed");
        expect(committed?.type === "mutation.committed" && committed.afterRevision).toBe(
          revisionOfContent("const version = 2;\n"),
        );

        // 4. The journal replays to the same state, and carries no token noise.
        const state = replay(run.journal);
        expect(state.committed).toEqual([{ path: "app.ts", added: 1, removed: 1 }]);
        expect(run.journal.all().some((e) => e.type === "model.delta")).toBe(false);

        // 5. The journal round-trips through disk.
        const restored = Journal.deserialize(run.journal.serialize());
        expect(replay(restored)).toEqual(state);
      });
    });
  }

  test("denying leaves the file untouched and tells the model why", async () => {
    await withRepo(async (dir) => {
      const file = path.join(dir, "app.ts");
      writeFileSync(file, "const version = 1;\n");
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      const { events, drained } = collect(run);
      autoRespond(run, "deny");

      run.start("bump the version");
      await run.submit(decodeText(TEXT_TURN));
      run.close();
      await drained;

      expect(readFileSync(file, "utf8")).toBe("const version = 1;\n");
      const finished = events.find((e) => e.type === "action.finished");
      expect(finished?.type === "action.finished" && finished.ok).toBe(false);
      expect(finished?.type === "action.finished" && finished.output).toMatch(/declined/);
      expect(replay(run.journal).committed).toEqual([]);
    });
  });

  test("`always` is scoped to an action class, not to everything", async () => {
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "1\n");
      writeFileSync(path.join(dir, "b.ts"), "1\n");
      const asked: string[] = [];
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "approval.requested") {
            asked.push(event.summary);
            run.send({ type: "approve", id: event.id, decision: "always" });
          }
        }
      })();

      run.start("edit both, then run something");
      await run.submit(
        decodeText(
          ["EDIT a.ts", "<<<<<<< SEARCH", "1", "=======", "2", ">>>>>>> REPLACE", ""].join("\n"),
        ),
      );
      await run.submit(
        decodeText(
          ["EDIT b.ts", "<<<<<<< SEARCH", "1", "=======", "2", ">>>>>>> REPLACE", ""].join("\n"),
        ),
      );
      await run.submit(decodeText("RUN npm test\n"));
      run.close();
      await drained;

      // One ask for the edit class, and a separate one for run: approving
      // edits must never silently approve command execution.
      expect(asked).toHaveLength(2);
      expect(asked[0]).toMatch(/^edit a\.ts/);
      expect(asked[1]).toMatch(/^run npm test/);
    });
  });

  test("a read-only action is never asked about", async () => {
    await withRepo(async (dir) => {
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      const { events, drained } = collect(run);

      run.start("look around");
      await run.submit(decodeText("READ app.ts\n"));
      run.close();
      await drained;

      expect(events.some((e) => e.type === "approval.requested")).toBe(false);
      expect(events.some((e) => e.type === "action.finished")).toBe(true);
    });
  });

  test("cancelling releases a pending approval instead of hanging", async () => {
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "app.ts"), "const version = 1;\n");
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "approval.requested") {
            run.send({ type: "cancel" });
          }
        }
      })();

      run.start("bump");
      await run.submit(decodeText(TEXT_TURN));
      run.close();
      await drained;

      expect(readFileSync(path.join(dir, "app.ts"), "utf8")).toBe("const version = 1;\n");
    });
  });
});

describe("the loop guard", () => {
  test("a re-read of an unchanged file is refused with advice", async () => {
    // Seen live on the first qwen-30b run: turns 4 and 5 were identical
    // re-reads of a file nothing had touched.
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "x\n");
      const outputs: string[] = [];
      const run = new Run({
        workspace: new Workspace(dir),
        runTool: async () => ({ ok: true, output: "1 | x" }),
      });
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "action.finished") outputs.push(`${event.ok}:${event.output}`);
        }
      })();

      run.start("read twice");
      await run.submit(decodeText("READ a.ts\n"));
      await run.submit(decodeText("READ a.ts\n"));
      run.close();
      await drained;

      expect(outputs[0]).toMatch(/^true:/);
      expect(outputs[1]).toMatch(/^false:.*has not changed/);
    });
  });

  test("allows another range of an unchanged file and refuses an exact repeated range", async () => {
    await withRepo(async (dir) => {
      writeFileSync(
        path.join(dir, "large.ts"),
        `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
      );
      const outcomes: boolean[] = [];
      const run = new Run({
        workspace: new Workspace(dir),
        runTool: async () => ({ ok: true, output: "range" }),
      });
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "action.finished") outcomes.push(event.ok);
        }
      })();

      run.start("read the file in ranges");
      await run.submit(decodeText("READ large.ts:1-5\n"));
      await run.submit(decodeText("READ large.ts:6-10\n"));
      await run.submit(decodeText("READ large.ts:1-5\n"));
      run.close();
      await drained;

      expect(outcomes).toEqual([true, true, false]);
    });
  });

  test("a re-read after a mutation is legitimate and allowed", async () => {
    // The guard is precise, not absolute: an edit changes the revision, so
    // the model genuinely needs to see the file again.
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "x\n");
      const outputs: boolean[] = [];
      const run = new Run(
        { workspace: new Workspace(dir), runTool: async () => ({ ok: true, output: "" }) },
        true, // auto-approve the edit
      );
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "action.finished") outputs.push(event.ok);
        }
      })();

      run.start("read, edit, read again");
      await run.submit(decodeText("READ a.ts\n"));
      await run.submit(
        decodeText(
          ["EDIT a.ts", "<<<<<<< SEARCH", "x", "=======", "y", ">>>>>>> REPLACE", ""].join("\n"),
        ),
      );
      await run.submit(decodeText("READ a.ts\n"));
      run.close();
      await drained;

      expect(outputs).toEqual([true, true, true]);
    });
  });

  test("editing one file does not invalidate a read of an unchanged sibling", async () => {
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "x\n");
      writeFileSync(path.join(dir, "b.ts"), "stable\n");
      const outputs: string[] = [];
      const run = new Run(
        { workspace: new Workspace(dir), runTool: async () => ({ ok: true, output: "read" }) },
        true,
      );
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "action.finished") outputs.push(`${event.ok}:${event.output}`);
        }
      })();

      run.start("edit one file without forgetting another");
      await run.submit(decodeText("READ b.ts\n"));
      await run.submit(
        decodeText(
          ["EDIT a.ts", "<<<<<<< SEARCH", "x", "=======", "y", ">>>>>>> REPLACE", ""].join("\n"),
        ),
      );
      await run.submit(decodeText("READ b.ts\n"));
      run.close();
      await drained;

      expect(outputs.at(-1)).toMatch(/^false:.*has not changed/);
    });
  });

  test("an action that failed is refused unchanged until a mutation lands", async () => {
    await withRepo(async (dir) => {
      const outputs: string[] = [];
      const run = new Run({
        workspace: new Workspace(dir),
        runTool: async () => ({ ok: false, output: "no such file" }),
      });
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "action.finished") outputs.push(event.output);
        }
      })();

      run.start("insist");
      await run.submit(decodeText("READ missing.ts\n"));
      await run.submit(decodeText("READ missing.ts\n"));
      run.close();
      await drained;

      expect(outputs[0]).toBe("no such file");
      expect(outputs[1]).toMatch(/already failed and nothing has changed/);
    });
  });
});

describe("refusing to be lied to", () => {
  test("a turn that reads and edits at once has the edit deferred", async () => {
    // Live failure against qwen3-coder-30b: it emitted READ and a
    // SEARCH/REPLACE in one reply, so the anchor was composed before it had
    // seen the file, and did not exist.
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "real content\n");
      const outputs: Array<{ ok: boolean; output: string }> = [];
      const run = new Run(
        {
          workspace: new Workspace(dir),
          runTool: async () => ({ ok: true, output: "real content" }),
        },
        true,
      );
      const drained = (async () => {
        for await (const event of run.events()) {
          if (event.type === "action.finished")
            outputs.push({ ok: event.ok, output: event.output });
        }
      })();

      run.start("look and leap");
      await run.submit(
        decodeText(
          [
            "READ a.ts",
            "EDIT a.ts",
            "<<<<<<< SEARCH",
            "guessed content",
            "=======",
            "new content",
            ">>>>>>> REPLACE",
            "",
          ].join("\n"),
        ),
      );
      run.close();
      await drained;

      expect(outputs[0]?.ok).toBe(true);
      expect(outputs[1]?.ok).toBe(false);
      expect(outputs[1]?.output).toMatch(/before you had seen the file/);
      // The blind guess never reached the file.
      expect(readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("real content\n");
    });
  });

  test("a `final` in a turn whose action failed is not accepted", async () => {
    // The worst observed behaviour: the edit's anchor did not match, and the
    // next reply claimed the function had been added. The file was untouched.
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "real\n");
      const events: RunEvent[] = [];
      const run = new Run(
        { workspace: new Workspace(dir), runTool: async () => ({ ok: true, output: "" }) },
        true,
      );
      const drained = (async () => {
        for await (const event of run.events()) events.push(event);
      })();

      run.start("claim victory");
      await run.submit(
        decodeText(
          [
            "EDIT a.ts",
            "<<<<<<< SEARCH",
            "does not exist",
            "=======",
            "new",
            ">>>>>>> REPLACE",
            "DONE added the thing",
            "",
          ].join("\n"),
        ),
      );
      run.close();
      await drained;

      expect(events.some((event) => event.type === "run.finished")).toBe(false);
      const rebuke = events.find(
        (event) => event.type === "action.finished" && event.id === "final",
      );
      expect(rebuke?.type === "action.finished" && rebuke.output).toMatch(/nothing changed/);
      expect(replay(run.journal).committed).toEqual([]);
    });
  });

  test("a `final` after a successful commit is accepted", async () => {
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "old\n");
      const events: RunEvent[] = [];
      const run = new Run(
        { workspace: new Workspace(dir), runTool: async () => ({ ok: true, output: "" }) },
        true,
      );
      const drained = (async () => {
        for await (const event of run.events()) events.push(event);
      })();

      run.start("do it properly");
      await run.submit(
        decodeText(
          [
            "EDIT a.ts",
            "<<<<<<< SEARCH",
            "old",
            "=======",
            "new",
            ">>>>>>> REPLACE",
            "DONE done",
            "",
          ].join("\n"),
        ),
      );
      run.close();
      await drained;

      expect(events.some((event) => event.type === "run.finished")).toBe(true);
      expect(readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("new\n");
    });
  });
});

describe("submit returns causal results, not observed ones", () => {
  test("results are available immediately, before any subscriber has run", async () => {
    // The bug this prevents shipped once. The CLI built the next prompt from
    // an array a background subscriber fills, read it before the subscriber
    // had run, saw "no action was taken", and qwen3-coder-30b invented file
    // contents that had never existed. Events are for observing; the return
    // value is the causal result.
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "old\n");
      const observed: RunEvent[] = [];
      const run = new Run(
        { workspace: new Workspace(dir), runTool: async () => ({ ok: true, output: "" }) },
        true,
      );
      const drained = (async () => {
        for await (const event of run.events()) observed.push(event);
      })();

      run.start("edit it");
      const outcome = await run.submit(
        decodeText(
          ["EDIT a.ts", "<<<<<<< SEARCH", "old", "=======", "new", ">>>>>>> REPLACE", ""].join(
            "\n",
          ),
        ),
      );

      // Synchronously after the await: the caller has the truth...
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0]?.id).toBe("a1");
      expect(outcome.results[0]?.ok).toBe(true);
      // The result carries the resulting file, so the model can see its edit
      // landed rather than guessing and editing again.
      expect(outcome.results[0]?.output).toContain("new");
      // ...while the subscriber has not necessarily seen anything yet. That is
      // the race, made explicit rather than fixed by timing.
      run.close();
      await drained;
      expect(observed.some((event) => event.type === "action.finished")).toBe(true);
    });
  });

  test("finished is only true when the run genuinely completed", async () => {
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "real\n");
      const run = new Run(
        { workspace: new Workspace(dir), runTool: async () => ({ ok: true, output: "" }) },
        true,
      );
      const drained = (async () => {
        for await (const _ of run.events()) {
          // drain
        }
      })();
      run.start("lie about it");
      const outcome = await run.submit(
        decodeText(
          [
            "EDIT a.ts",
            "<<<<<<< SEARCH",
            "missing",
            "=======",
            "new",
            ">>>>>>> REPLACE",
            "DONE all done",
            "",
          ].join("\n"),
        ),
      );
      run.close();
      await drained;

      // The model said DONE. Its edit failed. `finished` is false, so the
      // caller loops instead of exiting 0 on a lie.
      expect(outcome.finished).toBe(false);
    });
  });
});

describe("a completion can be retracted", () => {
  test("reopen puts the run back to not-done, and the journal shows both", async () => {
    // The verification gate needs this: the model says done, the project's own
    // tests disagree, and the run has to continue. The `run.finished` already
    // in the journal stays -- it is a fact about what was claimed -- so a
    // replay shows the disagreement rather than a clean success followed
    // inexplicably by more turns.
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.ts"), "old\n");
      const run = new Run(
        { workspace: new Workspace(dir), runTool: async () => ({ ok: true, output: "" }) },
        true,
      );
      const drained = (async () => {
        for await (const _ of run.events()) {
          // drain
        }
      })();

      run.start("do it");
      await run.submit(
        decodeText(
          [
            "EDIT a.ts",
            "<<<<<<< SEARCH",
            "old",
            "=======",
            "new",
            ">>>>>>> REPLACE",
            "DONE done",
            "",
          ].join("\n"),
        ),
      );
      expect(run.snapshot().done).toBe(true);

      run.reopen("the tests still fail");
      run.close();
      await drained;

      const state = replay(run.journal);
      expect(state.done).toBe(false);
      expect(state.ok).toBe(false);
      const kinds = run.journal.all().map((event) => event.type);
      expect(kinds).toContain("run.finished");
      expect(kinds).toContain("run.reopened");
    });
  });
});

describe("a cancel cannot be laundered into a completion", () => {
  test("a cancel observed by a proposal-free final turn is journalled, not swallowed", async () => {
    // The served-run failure mode: the client cancels while the model streams a
    // bare "DONE finished" reply. The cancelled flag used to be checked only
    // per-proposal, so a turn with zero proposals sailed past it, emitted
    // `run.finished ok:true`, and the journal carried no trace the client ever
    // spoke. The cancel must win: exactly one `run.cancelled`, no completion.
    await withRepo(async (dir) => {
      const run = new Run({ workspace: new Workspace(dir), ...NOOP_TOOLS });
      const { events, drained } = collect(run);
      run.start("stop this");
      run.send({ type: "cancel" });

      const outcome = await run.submit({ text: "DONE finished", proposals: [], final: "finished" });

      expect(outcome.finished).toBe(false);
      expect(run.snapshot().cancelled).toBe(true);
      expect(run.snapshot().ok).toBe(false);
      run.close();
      await drained;
      expect(events.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
      expect(events.some((event) => event.type === "run.finished")).toBe(false);
    });
  });

  test("a cancel that lands after the last proposal still beats the same turn's DONE", async () => {
    // Same race, later window: the flag flips between the final proposal's
    // execution and the completion claim at the end of the turn.
    await withRepo(async (dir) => {
      writeFileSync(path.join(dir, "a.txt"), "content\n");
      const run: Run = new Run({
        workspace: new Workspace(dir),
        runTool: async () => {
          run.send({ type: "cancel" });
          return { ok: true, output: "content" };
        },
      });
      const { events, drained } = collect(run);
      run.start("stop this");

      const outcome = await run.submit({
        text: "READ then DONE",
        proposals: [{ kind: "call", tool: "read", arguments: { path: "a.txt" } }],
        final: "finished",
      });

      expect(outcome.finished).toBe(false);
      expect(run.snapshot().cancelled).toBe(true);
      run.close();
      await drained;
      expect(events.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
      expect(events.some((event) => event.type === "run.finished")).toBe(false);
    });
  });
});

describe("classification", () => {
  test("edits and commands mutate; reads and searches do not", () => {
    expect(
      mutates({
        kind: "edit",
        path: "a",
        create: false,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "a", replace: "b", expectedMatches: 1 }],
      }),
    ).toBe(true);
    expect(mutates({ kind: "call", tool: "run", arguments: { command: ["ls"] } })).toBe(true);
    expect(mutates({ kind: "call", tool: "read", arguments: { path: "a" } })).toBe(false);
    expect(mutates({ kind: "call", tool: "search", arguments: { query: "x" } })).toBe(false);
    // An unknown tool is assumed to mutate: failing closed is the only safe
    // default for something the registry has never heard of.
    expect(mutates({ kind: "call", tool: "mystery", arguments: {} })).toBe(true);
  });

  test("descriptions are human-readable, because they appear in the prompt", () => {
    expect(
      describeProposal({ kind: "call", tool: "run", arguments: { command: ["npm", "test"] } }),
    ).toBe("run npm test");
    expect(
      describeProposal({
        kind: "edit",
        path: "a.ts",
        create: true,
        rewrite: false,
        baseRevision: null,
        operations: [{ search: "", replace: "x", expectedMatches: 1 }],
      }),
    ).toBe("create a.ts");
  });
});

// ---------------------------------------------------------------------------

function decodeText(source: string) {
  const codec = new TextCodec();
  codec.feed(source);
  return codec.finish();
}

function decodeNative(edit: {
  path: string;
  operations: Array<{ search: string; replace: string }>;
}) {
  const codec = new NativeCodec();
  codec.feed({ text: "I'll bump the version." });
  codec.feed({ call: { id: "c1", name: "edit", argumentsDelta: JSON.stringify(edit) } });
  codec.feed({ finish: true });
  return codec.finish();
}

function order(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}
