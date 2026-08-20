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
  taskContextBudgetChars,
  transcriptBudgetChars,
  VerificationCadence,
} from "../src/cli.js";
import { Workspace } from "../src/workspace.js";

describe("task context import following", () => {
  test("uses an explicitly named symbol to inline declarations and callers with unrelated filenames", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-semantic-")));
    try {
      mkdirSync(path.join(dir, "src"), { recursive: true });
      writeFileSync(
        path.join(dir, "src", "engine.ts"),
        "export class InvoiceService { calculateTotal() { return 10; } }\n",
      );
      writeFileSync(
        path.join(dir, "src", "checkout.ts"),
        'import { InvoiceService as BillingEngine } from "./engine";\nexport function submit() { return new BillingEngine().calculateTotal(); }\n',
      );
      writeFileSync(path.join(dir, "src", "unrelated.ts"), "export const untouched = true;\n");

      const result = await taskContext(
        new Workspace(dir),
        "Fix InvoiceService without changing its public API",
        24_000,
      );
      const declaration = result.receipt.items.find((item) => item.path === "src/engine.ts");
      const caller = result.receipt.items.find((item) => item.path === "src/checkout.ts");

      expect(declaration?.included).toBe(true);
      expect(declaration?.reason).toContain("declares task symbol InvoiceService");
      expect(caller?.included).toBe(true);
      expect(caller?.reason).toContain("calls task symbol InvoiceService from submit");
      expect(result.text).toContain("export class InvoiceService");
      expect(result.text).toContain("new BillingEngine().calculateTotal()");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not add semantic evidence for ordinary prose", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-natural-language-")));
    try {
      writeFileSync(path.join(dir, "service.ts"), "export class Service { run() {} }\n");
      const result = await taskContext(new Workspace(dir), "fix the service", 24_000);

      expect(result.receipt.items.every((item) => !item.reason.includes("task symbol"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an inlined file pulls in one local dependency", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-import-")));
    try {
      mkdirSync(path.join(dir, "src"));
      writeFileSync(
        path.join(dir, "src", "price.ts"),
        'import { RATE } from "./config.js";\nexport const total = 10 * RATE;\n',
      );
      writeFileSync(path.join(dir, "src", "config.js"), "export const RATE = 1.2;\n");

      const result = await taskContext(new Workspace(dir), "fix the price calculation", 24_000);
      const dependency = result.receipt.items.find((item) => item.path === "src/config.js");

      expect(dependency?.included).toBe(true);
      expect(dependency?.reason).toBe("imported by src/price.ts");
      expect(result.text).toContain("export const RATE = 1.2;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("follows export, require, dynamic, index, and TypeScript .js-specifier dependencies", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-relationships-")));
    try {
      mkdirSync(path.join(dir, "src", "types"), { recursive: true });
      writeFileSync(
        path.join(dir, "src", "service.ts"),
        [
          'export { config } from "./config.js";',
          'export type { Request } from "./types";',
          'const legacy = require("./legacy");',
          'export const lazy = () => import("./lazy");',
          "export const SERVICE_SENTINEL = legacy;",
          "",
        ].join("\n"),
      );
      writeFileSync(path.join(dir, "src", "config.ts"), "export const config = 1;\n");
      writeFileSync(path.join(dir, "src", "types", "index.ts"), "export type Request = {};\n");
      writeFileSync(path.join(dir, "src", "legacy.js"), "module.exports = 2;\n");
      writeFileSync(path.join(dir, "src", "lazy.ts"), "export default 3;\n");

      const result = await taskContext(new Workspace(dir), "fix the service", 24_000);
      const followed = result.receipt.items
        .filter((item) => item.reason === "imported by src/service.ts")
        .map((item) => item.path)
        .sort();

      expect(followed).toEqual([
        "src/config.ts",
        "src/lazy.ts",
        "src/legacy.js",
        "src/types/index.ts",
      ]);
      expect(result.text).toContain("export const config = 1;");
      expect(result.text).toContain("export type Request = {};");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finds and inlines a named file beyond the old depth and 200-file limits", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-large-project-")));
    try {
      for (let index = 0; index < 250; index += 1) {
        const generated = path.join(dir, "packages", "generated", String(index));
        mkdirSync(generated, { recursive: true });
        writeFileSync(
          path.join(generated, `module-${index}.ts`),
          `export const generated${index} = ${index};\n`,
        );
      }
      const relative = "packages/app/src/features/billing/invoice-service.ts";
      const target = path.join(dir, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "export const BILLING_SENTINEL = true;\n");

      const result = await taskContext(new Workspace(dir), "fix the invoice service", 24_000);
      const selected = result.receipt.items.find((item) => item.path === relative);

      expect(result.text).toContain("Repository index:");
      expect(result.text).toContain("BILLING_SENTINEL");
      expect(selected?.included).toBe(true);
      expect(selected?.reason).toContain("inlined");
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

      const minimal = await taskContext(new Workspace(dir), "implement the exercise", 24_000);
      const packet = await taskContext(new Workspace(dir), "implement the exercise", 24_000, true);

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

describe("project skill context", () => {
  test("a matched skill is compiled into context and accounted for in the receipt", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-skill-")));
    try {
      writeFileSync(path.join(dir, "service.ts"), "export const service = 1;\n");
      mkdirSync(path.join(dir, ".forge", "skills"), { recursive: true });
      writeFileSync(
        path.join(dir, ".forge", "skills", "deploy.md"),
        "---\nkeywords: [deploy]\n---\nRun the canary first, then promote.\n",
      );

      const result = await taskContext(new Workspace(dir), "deploy the service", 24_000);
      const entry = result.receipt.items.find(
        (item) => item.id === "skill:.forge/skills/deploy.md",
      );

      expect(entry?.included).toBe(true);
      expect(entry?.reason).toBe("matched task keywords: deploy");
      expect(entry?.chars).toBeGreaterThan(0);
      expect(result.text).toContain("Run the canary first, then promote.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a skill is dropped before scoped instructions when the budget runs out", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "context-skill-budget-")));
    try {
      writeFileSync(path.join(dir, "service.ts"), "export const service = 1;\n");
      mkdirSync(path.join(dir, ".forge", "instructions"), { recursive: true });
      writeFileSync(
        path.join(dir, ".forge", "instructions", "deploy.md"),
        "---\nkeywords: [deploy]\n---\nNever skip the smoke test.\n",
      );
      mkdirSync(path.join(dir, ".forge", "skills"), { recursive: true });
      writeFileSync(
        path.join(dir, ".forge", "skills", "deploy.md"),
        `---\nkeywords: [deploy]\n---\n${"CANARY_SKILL_MARKER ".repeat(300)}\n`,
      );

      const result = await taskContext(new Workspace(dir), "deploy the service", 3_000);
      const instruction = result.receipt.items.find(
        (item) => item.id === "instruction:.forge/instructions/deploy.md",
      );
      const skill = result.receipt.items.find(
        (item) => item.id === "skill:.forge/skills/deploy.md",
      );

      // Instructions outscore skills, so the budget evicts the skill first --
      // and the receipt records the eviction instead of hiding it.
      expect(instruction?.included).toBe(true);
      expect(skill?.included).toBe(false);
      expect(result.text).toContain("Never skip the smoke test.");
      expect(result.text).not.toContain("CANARY_SKILL_MARKER");
      expect(result.receipt.droppedChars).toBeGreaterThan(0);
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

  test("sizes Groq Free prompts from TPM instead of the model's 131k context window", () => {
    const config = {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "qwen/qwen3.6-27b",
      apiKeyEnv: "GROQ_API_KEY",
      temperature: 0.1,
      maxTokens: 0,
      contextWindow: 131_072,
      tokensPerMinute: 8_000,
    };

    expect(transcriptBudgetChars(config)).toBe(15_500);
    expect(taskContextBudgetChars(config, 2_500)).toBe(12_000);
    expect(transcriptBudgetChars({ ...config, tokensPerMinute: 0 })).toBeGreaterThan(300_000);
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
