/**
 * Where a command runs.
 *
 * Worktree isolation contains repository *mutations*; it does nothing about a
 * command, and a verification suite is arbitrary project-owned code that the
 * model can also edit. These tests pin the argv the container backend builds,
 * because every safety property of that backend is a property of its argv:
 * no shell, no host environment, no filesystem beyond the repository, and no
 * network unless the project asked for one.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type BackendSettings,
  containerInvocation,
  describeBackend,
  hostExecutionBackend,
  resolveExecutionBackend,
} from "../src/backend.js";
import { verify } from "../src/verify.js";

function usable(runtime: string): boolean {
  try {
    execFileSync(runtime, ["info"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const CONTAINER_RUNTIME = ["docker", "podman"].find(usable);

const ROOT = "/repo/project";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function settings(overrides: Partial<BackendSettings> = {}): BackendSettings {
  return { runtime: "docker", image: "node:22", network: false, ...overrides };
}

function argvFor(overrides: Partial<BackendSettings> = {}, cwd = ROOT): readonly string[] {
  const invocation = containerInvocation(["npm", "test"], { cwd, root: ROOT }, settings(overrides));
  if (!invocation.ok) throw new Error(invocation.output);
  return invocation.command;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("container invocation", () => {
  test("runs the command as argv after the image, with no shell anywhere", () => {
    const argv = argvFor();
    expect(argv.slice(0, 2)).toEqual(["docker", "run"]);
    expect(argv.slice(-3)).toEqual(["node:22", "npm", "test"]);
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("-c");
    expect(argv.some((token) => token.includes("&&"))).toBe(false);
  });

  test("mounts only the repository, read-write, and works inside it", () => {
    const argv = argvFor();
    expect(valueAfter(argv, "--volume")).toBe(`${ROOT}:/workspace`);
    expect(argv.filter((token) => token === "--volume")).toHaveLength(1);
    expect(valueAfter(argv, "--workdir")).toBe("/workspace");
  });

  test("maps a subdirectory working directory into the mount", () => {
    const argv = argvFor({}, `${ROOT}/packages/api`);
    expect(valueAfter(argv, "--workdir")).toBe("/workspace/packages/api");
  });

  test("refuses a working directory outside the repository", () => {
    const invocation = containerInvocation(
      ["npm", "test"],
      { cwd: "/etc", root: ROOT },
      settings(),
    );
    expect(invocation.ok).toBe(false);
    if (!invocation.ok) expect(invocation.output).toContain("outside the repository");
  });

  test("disables the network by default and enables it only on request", () => {
    expect(argvFor()).toContain("none");
    expect(valueAfter(argvFor(), "--network")).toBe("none");
    expect(valueAfter(argvFor({ network: true }), "--network")).toBeUndefined();
  });

  test("removes the container and reaps its children", () => {
    const argv = argvFor();
    expect(argv).toContain("--rm");
    expect(argv).toContain("--init");
  });

  test("names the container so a timeout has something to kill", () => {
    const invocation = containerInvocation(
      ["npm", "test"],
      { cwd: ROOT, root: ROOT },
      settings(),
      "abc123",
    );
    if (!invocation.ok) throw new Error(invocation.output);
    expect(valueAfter(invocation.command, "--name")).toBe("forge-abc123");
    expect(invocation.containerName).toBe("forge-abc123");
  });

  test("forwards no host paths into the container", () => {
    const argv = argvFor();
    const forwarded = argv
      .filter((_, index) => argv[index - 1] === "--env")
      .map((entry) => entry.split("=")[0]);
    for (const hostPath of ["PATH", "HOME", "TMPDIR", "SHELL", "USER", "JAVA_HOME"]) {
      expect(forwarded).not.toContain(hostPath);
    }
    expect(forwarded).toContain("NO_COLOR");
  });

  test("forwards caller-supplied variables but never the ambient environment", () => {
    const invocation = containerInvocation(
      ["npm", "test"],
      { cwd: ROOT, root: ROOT, extraEnv: { FORGE_VERIFIED: "true" } },
      settings(),
    );
    if (!invocation.ok) throw new Error(invocation.output);
    expect(invocation.command).toContain("FORGE_VERIFIED=true");
    expect(invocation.command.some((token) => token.startsWith("ANTHROPIC"))).toBe(false);
    expect(invocation.command).not.toContain("--env-file");
  });

  test("runs as the invoking user under docker so build output is not root-owned", () => {
    expect(valueAfter(argvFor({ runtime: "docker" }), "--user")).toMatch(/^\d+:\d+$/);
  });

  test("leaves user mapping to rootless podman", () => {
    const argv = argvFor({ runtime: "podman" });
    expect(argv[0]).toBe("podman");
    expect(argv).not.toContain("--user");
  });
});

describe("backend resolution", () => {
  test("defaults to the host, unchanged", () => {
    const backend = resolveExecutionBackend(undefined);
    expect(backend.name).toBe("host");
    expect(describeBackend(backend)).toContain("host");
  });

  test("requires an image for a container runtime", () => {
    expect(() => resolveExecutionBackend({ runtime: "docker" })).toThrow(/image/);
  });

  test("describes a container backend by runtime, image, and network", () => {
    const backend = resolveExecutionBackend({ runtime: "podman", image: "python:3.12" });
    expect(backend.name).toBe("podman");
    expect(describeBackend(backend)).toContain("python:3.12");
    expect(describeBackend(backend)).toContain("no network");
  });

  test("verification still runs on the host by default", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-backend-")));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, "ok.js"), "process.exit(0)\n");

    const report = await verify(
      { commands: [[process.execPath, "ok.js"]] },
      { cwd: root, backend: hostExecutionBackend },
    );

    expect(report.passed).toBe(true);
  });

  test.skipIf(usable("podman"))("reports a missing runtime as a failed command", async () => {
    const backend = resolveExecutionBackend({ runtime: "podman", image: "alpine" });

    const result = await backend.run(["true"], { cwd: "/tmp", root: "/tmp" });

    expect(result.code).toBeNull();
    expect(result.output).toContain("could not start podman");
    expect(result.timedOut).toBe(false);
  });
});

/**
 * Runs only where a container runtime exists. Skipped rather than mocked: the
 * point of these two is that the argv above is accepted by a real runtime and
 * that the isolation it claims is the isolation it gets.
 */
describe.skipIf(CONTAINER_RUNTIME === undefined)("a real container", () => {
  const runtime = (CONTAINER_RUNTIME ?? "docker") as "docker" | "podman";

  test("runs the repository's verification inside the image", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-container-")));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, "check.sh"), "#!/bin/sh\ntest -f /workspace/check.sh\n");

    const backend = resolveExecutionBackend({ runtime, image: "alpine:3" });
    const report = await verify(
      { commands: [["sh", "check.sh"]], timeoutSeconds: 180 },
      { cwd: root, backend },
    );

    expect(report.passed).toBe(true);
  }, 300_000);

  test("has no network unless asked", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-container-net-")));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));

    const backend = resolveExecutionBackend({ runtime, image: "alpine:3" });
    const result = await backend.run(["ping", "-c", "1", "-W", "2", "1.1.1.1"], {
      cwd: root,
      root,
      timeoutSeconds: 120,
    });

    expect(result.code).not.toBe(0);
  }, 300_000);
});
