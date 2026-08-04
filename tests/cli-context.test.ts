import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  boundTranscript,
  observationsFrom,
  positiveIntegerOption,
  systemPrompt,
  taskContext,
  transcriptBudgetChars,
  VerificationCadence,
} from "../src/cli.js";
import { Workspace } from "../src/workspace.js";

describe("task context import following", () => {
  test("an inlined file pulls in one local dependency", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-import-")));
    try {
      mkdirSync(path.join(dir, "src"));
      writeFileSync(
        path.join(dir, "src", "price.ts"),
        'import { RATE } from "./config.js";\nexport const total = 10 * RATE;\n',
      );
      writeFileSync(path.join(dir, "src", "config.js"), "export const RATE = 1.2;\n");

      const result = taskContext(new Workspace(dir), "fix the price calculation", 24_000);
      const dependency = result.receipt.items.find((item) => item.path === "src/config.js");

      expect(dependency?.included).toBe(true);
      expect(dependency?.reason).toBe("imported by src/price.ts");
      expect(result.text).toContain("export const RATE = 1.2;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the opt-in task packet includes hidden exercise specifications", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-packet-")));
    try {
      mkdirSync(path.join(dir, ".docs"));
      writeFileSync(path.join(dir, "solution.ts"), "export function solve() {}\n");
      writeFileSync(path.join(dir, ".docs", "instructions.md"), "Handle empty inputs.\n");

      const minimal = taskContext(new Workspace(dir), "implement the exercise", 24_000);
      const packet = taskContext(new Workspace(dir), "implement the exercise", 24_000, true);

      expect(minimal.text).not.toContain("Handle empty inputs.");
      expect(packet.text).toContain("Handle empty inputs.");
      expect(
        packet.receipt.items.find((item) => item.path === ".docs/instructions.md")?.reason,
      ).toBe("known student-facing exercise specification");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bounded run options", () => {
  test("steers consecutive edits toward executable feedback", () => {
    const cadence = new VerificationCadence();

    cadence.observe({ committedMutation: true, ranCommand: false });
    expect(cadence.steer()).toBeNull();
    cadence.observe({ committedMutation: true, ranCommand: false });
    expect(cadence.steer()).toContain("Run the narrowest relevant compile or test command now");
    expect(cadence.steer()).toBeNull();
    cadence.observe({ committedMutation: false, ranCommand: true });
    cadence.observe({ committedMutation: true, ranCommand: false });
    expect(cadence.steer()).toBeNull();
  });

  test("accepts positive turn limits and rejects invalid values", () => {
    expect(positiveIntegerOption("8", 12)).toBe(8);
    expect(positiveIntegerOption("0", 12)).toBe(12);
    expect(positiveIntegerOption("not-a-number", 12)).toBe(12);
    expect(positiveIntegerOption(true, 12)).toBe(12);
  });

  test("retains stable setup and newest messages when history exceeds its budget", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "initial task" },
      { role: "assistant" as const, content: "old".repeat(40) },
      { role: "user" as const, content: "recent result" },
    ];

    const bounded = boundTranscript(messages, 140);

    expect(bounded[0]).toEqual(messages[0]);
    expect(bounded[1]).toEqual(messages[1]);
    expect(bounded).not.toContainEqual(messages[2]);
    expect(bounded.at(-1)).toEqual(messages.at(-1));
    expect(bounded.some((message) => message.content.includes("context guard"))).toBe(true);
    expect(transcriptBudgetChars({ contextWindow: 0, maxTokens: 0 })).toBeGreaterThan(100_000);
  });

  test("retains omitted failures, paths, and user constraints as compact evidence", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "initial task" },
      {
        role: "assistant" as const,
        content: `${"noise ".repeat(80)}\nverification failed: TypeError in src/api/client.ts:42 expected status 200`,
      },
      {
        role: "user" as const,
        content: `Do not add dependencies. Preserve the public API. ${"more noise ".repeat(40)}`,
      },
      { role: "assistant" as const, content: "latest action" },
      { role: "user" as const, content: "recent result" },
    ];

    const bounded = boundTranscript(messages, 430);
    const compacted = bounded.map((message) => message.content).join("\n");

    expect(bounded.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(
      430,
    );
    expect(compacted).toContain("initial task");
    expect(compacted).toContain("verification failed");
    expect(compacted).toContain("src/api/client.ts:42");
    expect(compacted).toContain("Do not add dependencies");
    expect(compacted).toContain("recent result");
    expect(compacted).not.toContain("noise noise noise noise noise noise noise noise");
  });

  test("clips oversized setup while remaining within an extreme budget", () => {
    const bounded = boundTranscript(
      [
        { role: "system", content: "s".repeat(500) },
        { role: "user", content: "task ".repeat(100) },
        { role: "assistant", content: "latest" },
      ],
      180,
    );

    expect(bounded.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(
      180,
    );
    expect(bounded.some((message) => message.content.includes("context guard"))).toBe(true);
  });

  test("deduplicates and clips tool observations", () => {
    const output = "x".repeat(5_000);
    const text = observationsFrom(
      [
        { id: "a1", ok: false, output },
        { id: "a2", ok: false, output },
      ],
      "guarded",
      4_200,
    );

    expect(text.length).toBeLessThanOrEqual(4_200);
    expect(text).toContain("guarded");
    expect(text).toContain("duplicate result");
    expect(text).toContain("chars omitted");
  });

  test("keeps conservative action sequencing unless batching is explicitly enabled", () => {
    expect(systemPrompt(false, false)).toContain("One small edit per reply");
    expect(systemPrompt(false, false)).toContain("Before editing a non-stub implementation");
    expect(systemPrompt(false, false)).toContain("preserve the working code");
    expect(systemPrompt(false, false)).toContain("setup failure, not a failing test");
    expect(systemPrompt(false, false)).not.toContain("Batch independent reads");
    expect(systemPrompt(false, true)).toContain("Batch independent reads");
    expect(systemPrompt(false, true)).toContain("exact current");
  });
});
