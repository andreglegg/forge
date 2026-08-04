import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type BenchTask, fingerprintSuite, runTask, runTrials } from "../src/bench.js";

async function withTask<T>(body: (task: BenchTask, root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "bench-metrics-")));
  const source = path.join(root, "repo");
  mkdirSync(source);
  writeFileSync(path.join(source, "input.txt"), "starting state\n");
  const task: BenchTask = {
    name: "measured-task",
    prompt: "make it work",
    verify: [[process.execPath, "-e", "process.exit(0)"]],
    guard: [],
    timeoutSeconds: 10,
    source,
  };
  try {
    return await body(task, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("benchmark identity", () => {
  test("the suite fingerprint changes with starting content", async () => {
    await withTask(async (task) => {
      const before = fingerprintSuite([task]);
      writeFileSync(path.join(task.source, "input.txt"), "different state\n");
      const after = fingerprintSuite([task]);

      expect(before).toMatch(/^[a-f0-9]{16}$/);
      expect(after).not.toBe(before);
    });
  });

  test("a launcher fingerprint includes its compiled implementation", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "bench-binary-")));
    try {
      mkdirSync(path.join(root, "bin"));
      mkdirSync(path.join(root, "dist"));
      const launcher = path.join(root, "bin", "forge");
      writeFileSync(launcher, "import '../dist/cli.js';\n");
      writeFileSync(path.join(root, "dist", "cli.js"), "export const version = 1;\n");
      const { fingerprintExecutable } = await import("../src/bench.js");
      const before = fingerprintExecutable(launcher);
      writeFileSync(path.join(root, "dist", "cli.js"), "export const version = 2;\n");

      expect(fingerprintExecutable(launcher)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("benchmark action metrics", () => {
  test("reads Forge's reported turns and actions", async () => {
    await withTask(async (task) => {
      const payload = JSON.stringify({ ok: true, usage: { turns: 4, actions: 7 } });
      const outcome = await runTask(task, {
        binary: "unused",
        agentCommand: [process.execPath, "-e", `console.log(${JSON.stringify(payload)})`],
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.agentClaimedSuccess).toBe(true);
      expect(outcome.turns).toBe(4);
      expect(outcome.toolCalls).toBe(7);
    });
  });

  test("unreported competitor metrics are null, not zero", async () => {
    await withTask(async (task) => {
      const outcome = await runTask(task, {
        binary: "unused",
        agentCommand: [process.execPath, "-e", "console.log('completed')"],
      });

      expect(outcome.turns).toBeNull();
      expect(outcome.toolCalls).toBeNull();
    });
  });
});

describe("benchmark evidence", () => {
  test("keeps failures from every repeated trial separately", async () => {
    await withTask(async (task, root) => {
      const failures = path.join(root, "failures");
      const failingTask = {
        ...task,
        verify: [[process.execPath, "-e", "process.exit(1)"]],
      };

      await runTrials(
        [failingTask],
        {
          binary: "unused",
          agentCommand: [process.execPath, "-e", "process.exit(0)"],
          keepFailures: failures,
        },
        2,
      );

      expect(existsSync(path.join(failures, "trial-1", task.name, "BENCH.txt"))).toBe(true);
      expect(existsSync(path.join(failures, "trial-2", task.name, "BENCH.txt"))).toBe(true);
    });
  });
});
