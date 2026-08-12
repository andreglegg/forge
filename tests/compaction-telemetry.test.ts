/**
 * Compaction telemetry: counters about an eviction, never a second transcript.
 *
 * The load-bearing guarantees are the first two blocks. Byte-identity is what
 * lets this slice claim zero score effect -- if the reported variant ever
 * disagrees with `compactTranscript`, telemetry has silently become a
 * model-visible intervention that was never benchmarked. The no-content test
 * enforces rule 4: the report may say *how much* was evicted, never *what*.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import { compactTranscript, compactTranscriptReported } from "../src/compaction.js";
import { EVENT_CONTRACT_VERSION } from "../src/contract.js";
import type { Message } from "../src/provider.js";
import { Run, type RunEvent, replay } from "../src/runtime.js";
import { SessionStore } from "../src/session.js";
import { Workspace } from "../src/workspace.js";

const SETUP: Message[] = [
  { role: "system", content: "system setup" },
  { role: "user", content: "initial task" },
];

/**
 * Hand-built so every evidence priority is hit exactly once: a failure line
 * (5), a user constraint (4), a file path (3), a protocol verb without a path
 * (2), a deliberate duplicate of the failure line, and pure noise. The noise
 * carries a sentinel that must never surface in the report.
 */
function overBudgetFixture(): Message[] {
  const evicted = [
    "verification failed: expected 2",
    "verification failed: expected 2",
    `EVICTED_SECRET_TOKEN ${"z".repeat(300)}`,
    "src/app/main.ts:10 needs a guard",
    "RUN npm test",
  ].join("\n");
  return [
    ...SETUP,
    { role: "assistant", content: evicted },
    { role: "user", content: `Do not add dependencies.\n${"q".repeat(400)}` },
    { role: "assistant", content: "latest action" },
    { role: "user", content: "recent result" },
  ];
}

describe("byte identity with compactTranscript", () => {
  test("reported messages equal the unreported output for every case class", () => {
    const cases: Array<{ name: string; messages: Message[]; budget: number }> = [
      { name: "under budget", messages: [...SETUP], budget: 10_000 },
      { name: "over budget", messages: overBudgetFixture(), budget: 600 },
      { name: "evidence suppressed", messages: overBudgetFixture(), budget: 40 },
      {
        name: "single message",
        messages: [{ role: "user", content: "x".repeat(200) }],
        budget: 100,
      },
      {
        name: "clipped recent head",
        messages: [...SETUP, { role: "assistant", content: "a".repeat(1_000) }],
        budget: 200,
      },
      { name: "empty", messages: [], budget: 100 },
    ];
    for (const entry of cases) {
      expect(compactTranscriptReported(entry.messages, entry.budget).messages, entry.name).toEqual(
        compactTranscript(entry.messages, entry.budget),
      );
    }
  });
});

describe("a transcript under budget", () => {
  test("is returned unchanged with a null report", () => {
    const messages = overBudgetFixture();
    const outcome = compactTranscriptReported(messages, 100_000);

    expect(outcome.report).toBeNull();
    expect(outcome.messages).toEqual(messages);
  });

  test("an empty transcript is silent too", () => {
    const outcome = compactTranscriptReported([], 100);
    expect(outcome.report).toBeNull();
    expect(outcome.messages).toEqual([]);
  });
});

describe("counter correctness", () => {
  test("chars and messages sum exactly and evidence priorities are counted", () => {
    const messages = overBudgetFixture();
    const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    const { messages: bounded, report } = compactTranscriptReported(messages, 600);

    expect(report).not.toBeNull();
    if (report === null) throw new Error("expected a report");
    expect(report.budgetChars).toBe(600);
    expect(report.inputMessages).toBe(messages.length);
    expect(report.inputChars).toBe(inputChars);
    expect(report.keptChars + report.omittedChars).toBe(report.inputChars);
    expect(report.keptMessages + report.omittedMessages).toBe(report.inputMessages);
    expect(report.keptChars).toBeLessThanOrEqual(report.budgetChars);
    expect(report.omittedMessages).toBe(2);
    expect(report.recentKeptMessages).toBe(2);
    expect(report.setupClipped).toBe(false);
    expect(report.finalOverflowClipped).toBe(false);
    expect(report.evidence.candidateLines).toBe(5);
    expect(report.evidence.keptLines).toBe(4);
    expect(report.evidence.keptByPriority).toEqual({ 5: 1, 4: 1, 3: 1, 2: 1 });
    expect(report.evidence.dedupSkipped).toBe(1);
    expect(report.evidence.truncatedLines).toBe(0);
    const notice = bounded.find((message) => message.content.includes("context guard"));
    expect(notice).toBeDefined();
    expect(report.noticeChars).toBe(notice?.content.length);
  });

  test("setupClipped is true only when the first two messages exceed their limit", () => {
    const clipped = compactTranscriptReported(
      [
        { role: "system", content: "s".repeat(500) },
        { role: "user", content: "task ".repeat(100) },
        { role: "assistant", content: "latest" },
      ],
      180,
    );
    expect(clipped.report?.setupClipped).toBe(true);
    expect(compactTranscriptReported(overBudgetFixture(), 600).report?.setupClipped).toBe(false);
  });

  test("two calls with identical inputs produce identical reports", () => {
    const messages = overBudgetFixture();
    const first = compactTranscriptReported(messages, 600);
    const second = compactTranscriptReported(messages, 600);
    expect(second.report).toEqual(first.report);
    expect(second.messages).toEqual(first.messages);
  });

  test("the report carries counters, never evicted content", () => {
    const { report } = compactTranscriptReported(overBudgetFixture(), 600);
    expect(report).not.toBeNull();
    expect(JSON.stringify(report)).not.toContain("EVICTED_SECRET_TOKEN");
  });
});

describe("the durable event", () => {
  test("recordCompaction journals one context.compacted that survives persistence", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "forge-compaction-"));
    try {
      const run = new Run({
        workspace: new Workspace(dir),
        runTool: async () => ({ ok: true, output: "" }),
      });
      run.start("bound the transcript");
      const before = run.snapshot();
      const { report } = compactTranscriptReported(overBudgetFixture(), 600);
      if (report === null) throw new Error("expected a report");

      run.recordCompaction(report);

      const recorded = run.journal.all().filter((event) => event.type === "context.compacted");
      expect(recorded).toHaveLength(1);
      const event = recorded[0];
      if (event === undefined || event.type !== "context.compacted") {
        throw new Error("expected a context.compacted event");
      }
      expect(event.seq).toBeGreaterThan(0);
      expect(event.turn).toBe(1);
      expect(event.report).toEqual(report);
      // A state no-op: telemetry must not change what a replay reconstructs.
      expect(run.snapshot()).toEqual(before);

      const store = new SessionStore(dir);
      store.save("compaction-telemetry", run.journal);
      const loaded = store.load("compaction-telemetry");
      if (loaded === null) throw new Error("expected the session to load");
      const survived = loaded.all().filter((entry) => entry.type === "context.compacted");
      expect(survived).toHaveLength(1);
      expect(replay(loaded)).toEqual(replay(run.journal));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Big enough that turn two's transcript exceeds the 32k floor of the budget. */
const OVERSIZED_REPLY = "n".repeat(40_000);

async function scriptedProvider(): Promise<{ server: Server; url: string }> {
  let turns = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "scripted" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        );
        return;
      }
      turns += 1;
      const content = turns === 1 ? `${OVERSIZED_REPLY}\n` : "DONE nothing needed doing\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("the stream surface", () => {
  test("context.compacted precedes its turn.started and the header speaks 1.1", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-compaction-run-"));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const provider = await scriptedProvider();
    cleanup.push(
      async () =>
        new Promise<void>((resolve, reject) =>
          provider.server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const out: string[] = [];
    const io: IO = { out: (text) => out.push(text), err: () => undefined };

    await main(
      [
        "run",
        "Say done.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        // Pin the window so the budget sits at its 32k floor, which the 40k
        // reply then overruns on the second turn's request.
        "--context",
        "9000",
        "--max-tokens",
        "512",
        "--yes",
        "--no-verify",
        "--max-turns",
        "2",
        "--stream-json",
      ],
      io,
    );

    const header = JSON.parse(out[0] ?? "{}") as {
      type: string;
      contract: { version: string; events: string[] };
    };
    expect(header.type).toBe("contract");
    expect(header.contract.version).toBe(EVENT_CONTRACT_VERSION);
    expect(header.contract.events).toContain("context.compacted");

    const events = out
      .slice(1)
      .map((line) => JSON.parse(line) as { type: string; event?: RunEvent })
      .filter((entry) => entry.type === "event" && entry.event !== undefined)
      .map((entry) => entry.event as RunEvent);
    const compactions = events.filter((event) => event.type === "context.compacted");
    expect(compactions).toHaveLength(1);
    const compaction = compactions[0];
    if (compaction === undefined || compaction.type !== "context.compacted") {
      throw new Error("expected a context.compacted event");
    }
    // Emitted while the request is assembled, so it lands before the turn it
    // belongs to starts -- the stamped turn is how a client correlates it.
    expect(compaction.turn).toBe(2);
    const compactionIndex = events.indexOf(compaction);
    const turnTwoIndex = events.findIndex(
      (event) => event.type === "turn.started" && event.turn === 2,
    );
    expect(turnTwoIndex).toBeGreaterThan(compactionIndex);
  }, 60_000);
});
