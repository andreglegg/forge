import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NativeCodec, TextCodec } from "../src/codecs.js";
import { boundTurnIntent, renderProposal } from "../src/protocol.js";
import { Run, type RunEvent } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-delete-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function textTurn(source: string) {
  const codec = new TextCodec();
  codec.feed(source);
  return codec.finish();
}

async function collect(run: Run): Promise<{ events: RunEvent[]; drained: Promise<void> }> {
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of run.events()) events.push(event);
  })();
  return { events, drained };
}

describe("delete protocol", () => {
  test("text and native delete calls normalize identically and round-trip", () => {
    const fromText = textTurn("DELETE src/game.ts\n");
    const native = new NativeCodec();
    native.feed({
      call: {
        id: "delete-1",
        name: "delete",
        argumentsDelta: JSON.stringify({ path: "src/game.ts" }),
      },
    });
    native.feed({ finish: true });
    const fromNative = native.finish();

    expect(fromText.proposals).toEqual(fromNative.proposals);
    expect(fromText.proposals).toHaveLength(1);
    const [proposal] = fromText.proposals;
    expect(proposal).toBeDefined();
    if (proposal !== undefined) expect(renderProposal(proposal)).toBe("DELETE src/game.ts");
  });

  test("allows a bounded group of file deletions without relaxing edit limits", () => {
    const decoded = textTurn(
      [
        "DELETE src/game.ts",
        "DELETE src/index.ts",
        "DELETE src/extra.ts",
        "EDIT package.json",
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        ">>>>>>> REPLACE",
        "EDIT README.md",
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        ">>>>>>> REPLACE",
        "DONE removed obsolete files",
        "",
      ].join("\n"),
    );

    const bounded = boundTurnIntent(decoded, {
      proposals: 8,
      runs: 2,
      mutations: 1,
      deletes: 2,
    });

    expect(
      bounded.turn.proposals.map((proposal) =>
        proposal.kind === "call"
          ? `${proposal.tool}:${String(proposal.arguments["path"] ?? "")}`
          : `edit:${proposal.path}`,
      ),
    ).toEqual(["delete:src/game.ts", "delete:src/index.ts", "edit:package.json"]);
    expect(bounded.dropped).toBe(2);
    expect(bounded.turn.final).toBeNull();
  });
});

describe("revision-guarded file deletion", () => {
  test("previews, approves, deletes, journals, and confirms absence", async () => {
    await withRepo(async (root) => {
      const target = path.join(root, "src", "game.ts");
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(target), { recursive: true }),
      );
      writeFileSync(target, "export const game = true;\n");
      const run = new Run(
        {
          workspace: new Workspace(root),
          runTool: async () => ({ ok: false, output: "delete reached ordinary tool execution" }),
          retain: () => "retained-before",
        },
        true,
      );
      const collected = await collect(run);

      run.start("delete game.ts");
      const result = await run.submit(textTurn("DELETE src/game.ts\nDONE removed obsolete file\n"));
      run.close();
      await collected.drained;

      expect(result.finished).toBe(true);
      expect(result.results).toContainEqual(
        expect.objectContaining({
          ok: true,
          output: expect.stringMatching(/deleted src\/game\.ts.*no longer exists/is),
        }),
      );
      expect(existsSync(target)).toBe(false);
      expect(collected.events).toContainEqual(
        expect.objectContaining({
          type: "mutation.committed",
          path: "src/game.ts",
          beforeRevision: "retained-before",
          afterRevision: null,
        }),
      );
    });
  });

  test("shows the full removal preview before an interactive approval", async () => {
    await withRepo(async (root) => {
      const target = path.join(root, "obsolete.txt");
      writeFileSync(target, "first line\nsecond line\n");
      const run = new Run(
        {
          workspace: new Workspace(root),
          runTool: async () => ({ ok: false, output: "unexpected tool call" }),
        },
        false,
      );
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of run.events()) {
          events.push(event);
          if (event.type === "approval.requested") {
            run.send({ type: "approve", id: event.id, decision: "once" });
          }
        }
      })();

      run.start("remove obsolete.txt");
      await run.submit(textTurn("DELETE obsolete.txt\n"));
      run.close();
      await drained;

      const approval = events.find(
        (event): event is Extract<RunEvent, { type: "approval.requested" }> =>
          event.type === "approval.requested",
      );
      expect(approval).toMatchObject({
        summary: "delete obsolete.txt",
        preview: {
          kind: "delete",
          path: "obsolete.txt",
          added: 0,
          removed: 3,
          afterRevision: null,
        },
      });
      expect(approval?.preview?.hunks.every((hunk) => hunk.kind === "remove")).toBe(true);
      expect(existsSync(target)).toBe(false);
    });
  });

  test("refuses a stale approved deletion", async () => {
    await withRepo(async (root) => {
      const target = path.join(root, "file.txt");
      writeFileSync(target, "original\n");
      const workspace = new Workspace(root);
      const preview = workspace.previewDelete("file.txt");
      writeFileSync(target, "changed by user\n");

      expect(() => workspace.commit(preview)).toThrow(/changed after it was approved/i);
      expect(readFileSync(target, "utf8")).toBe("changed by user\n");
    });
  });

  test("deletes an explicitly targeted directory tree", async () => {
    await withRepo(async (root) => {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "src")));
      const workspace = new Workspace(root);

      const preview = workspace.previewDelete("src");
      expect(preview.changes).toContainEqual(
        expect.objectContaining({ operation: "delete", entryType: "directory", path: "src" }),
      );

      workspace.commit(preview);
      expect(existsSync(path.join(root, "src"))).toBe(false);
    });
  });
});
