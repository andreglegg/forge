import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { commandEnvironment, execBounded, resolveCommandInvocation } from "../src/exec.js";

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

describe("run command normalization", () => {
  test("executes a common cd-directory-and-command form without a shell", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "exec-cwd-")));
    try {
      await mkdir(path.join(root, "build"));

      const resolved = resolveCommandInvocation(["cd", "build", "&&", "make", "-j4"], root);

      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.output);
      expect(resolved.command).toEqual(["make", "-j4"]);
      expect(resolved.cwd).toBe(path.join(root, "build"));
      expect(resolved.notice).toMatch(/working directory.*build/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs the normalized command in the selected repository directory", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "exec-cwd-run-")));
    try {
      await mkdir(path.join(root, "build"));
      const resolved = resolveCommandInvocation(
        ["cd", "build", "&&", process.execPath, "-e", "process.stdout.write(process.cwd())"],
        root,
      );
      if (!resolved.ok) throw new Error(resolved.output);

      const result = await execBounded(resolved.command, { cwd: resolved.cwd });

      expect(result.code).toBe(0);
      expect(result.output).toBe(path.join(root, "build"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects shell chains instead of spawning misleading literal argv", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "exec-shell-")));
    try {
      await mkdir(path.join(root, "build"));

      const resolved = resolveCommandInvocation(
        ["cd", "build", "&&", "cmake", "..", "&&", "make"],
        root,
      );

      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("expected rejection");
      expect(resolved.output).toMatch(/one command|shell/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a working directory outside the repository", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "exec-escape-")));
    try {
      const resolved = resolveCommandInvocation(["cd", "..", "&&", "make"], root);

      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("expected rejection");
      expect(resolved.output).toMatch(/outside|repository/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
