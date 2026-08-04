import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { commandEnvironment, execBounded } from "../src/exec.js";

describe("command environment", () => {
  test("retains non-secret Java toolchain configuration", () => {
    const environment = commandEnvironment({
      JAVA_HOME: "/jdk",
      GRADLE_USER_HOME: "/gradle",
      OPENAI_API_KEY: "secret",
    });

    expect(environment["JAVA_HOME"]).toBe("/jdk");
    expect(environment["GRADLE_USER_HOME"]).toBe("/gradle");
    expect(environment["OPENAI_API_KEY"]).toBeUndefined();
  });
});

describe("execBounded cancellation", () => {
  test("an already-aborted signal prevents the command from starting", async () => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "exec-abort-")));
    try {
      const marker = path.join(dir, "started");
      const controller = new AbortController();
      controller.abort();

      const result = await execBounded(
        [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
        ],
        { cwd: dir, signal: controller.signal },
      );

      expect(result.code).toBeNull();
      expect(result.timedOut).toBe(true);
      expect(result.output).toContain("cancelled before command started");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
