import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  autoUpdateDisabled,
  bootstrapUpdate,
  compareStableVersions,
  expectedGlobalPackageRoot,
  isGlobalNpmInstall,
  nodeSatisfiesSimpleEngine,
  type UpdateIO,
  type UpdateRuntime,
  updateInstallArgs,
} from "../src/update.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capturedIO(): { io: UpdateIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

interface RuntimeControls {
  readonly now?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly nodeVersion?: string;
  readonly prefix?: string | null;
  readonly latest?: { version: string; engines?: { node?: string } };
  readonly fetchError?: Error;
  readonly installCode?: number;
  readonly state?: {
    packageRoot?: string;
    version?: string;
    lastCheckedAt?: number;
    lastFailureAt?: number;
  };
}

function fakeRuntime(controls: RuntimeControls = {}): {
  runtime: UpdateRuntime;
  installs: string[];
  prefixCalls: { count: number };
  writes: Array<{
    packageRoot?: string;
    version?: string;
    lastCheckedAt?: number;
    lastFailureAt?: number;
  }>;
} {
  const installs: string[] = [];
  const writes: Array<{
    packageRoot?: string;
    version?: string;
    lastCheckedAt?: number;
    lastFailureAt?: number;
  }> = [];
  const prefixCalls = { count: 0 };
  const runtime: UpdateRuntime = {
    now: () => controls.now ?? 1_000_000,
    env: controls.env ?? {},
    platform: controls.platform ?? "darwin",
    nodeVersion: controls.nodeVersion ?? "v22.19.0",
    npmPrefix: async () => {
      prefixCalls.count += 1;
      return controls.prefix === undefined ? "/opt/npm" : controls.prefix;
    },
    fetchLatest: async () => {
      if (controls.fetchError !== undefined) throw controls.fetchError;
      return controls.latest ?? { version: "0.1.2", engines: { node: ">=22.12.0" } };
    },
    install: async (version) => {
      installs.push(version);
      return { code: controls.installCode ?? 0, stdout: "", stderr: "install failed" };
    },
    readState: async () => controls.state ?? {},
    writeState: async (state) => {
      writes.push(state);
    },
  };
  return { runtime, installs, prefixCalls, writes };
}

function globalRoot(prefix = "/opt/npm"): string {
  return expectedGlobalPackageRoot(prefix, "darwin");
}

describe("update version policy", () => {
  test("compares only strict stable semantic versions", () => {
    expect(compareStableVersions("0.1.2", "0.1.3")).toBe(-1);
    expect(compareStableVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareStableVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareStableVersions("1.0.0-beta.1", "1.0.0")).toBeNull();
    expect(compareStableVersions("v1.0.0", "1.0.0")).toBeNull();
  });

  test("accepts the package's simple minimum Node engine and fails closed on unknown ranges", () => {
    expect(nodeSatisfiesSimpleEngine("v22.19.0", ">=22.12.0")).toBe(true);
    expect(nodeSatisfiesSimpleEngine("v22.11.0", ">=22.12.0")).toBe(false);
    expect(nodeSatisfiesSimpleEngine("v24.0.0", ">=22.12.0")).toBe(true);
    expect(nodeSatisfiesSimpleEngine("v22.19.0", "^22 || ^24")).toBeNull();
  });

  test("recognizes only the platform-specific global npm package path", () => {
    expect(
      isGlobalNpmInstall("/opt/npm/lib/node_modules/@aglegg/forge-harness", "/opt/npm", "darwin"),
    ).toBe(true);
    expect(
      isGlobalNpmInstall("/project/node_modules/@aglegg/forge-harness", "/opt/npm", "darwin"),
    ).toBe(false);
    expect(
      isGlobalNpmInstall(
        "C:\\Users\\Andre\\AppData\\Roaming\\npm\\node_modules\\@aglegg\\forge-harness",
        "C:\\Users\\Andre\\AppData\\Roaming\\npm",
        "win32",
      ),
    ).toBe(true);
  });

  test("honors explicit opt-out and CI update suppression", () => {
    expect(autoUpdateDisabled({ FORGE_AUTO_UPDATE: "0" })).toBe(true);
    expect(autoUpdateDisabled({ FORGE_AUTO_UPDATE: "false" })).toBe(true);
    expect(autoUpdateDisabled({ CI: "true" })).toBe(true);
    expect(autoUpdateDisabled({})).toBe(false);
  });

  test("pins both npm registry keys and disables install lifecycle scripts", () => {
    expect(updateInstallArgs("0.2.0")).toEqual([
      "install",
      "--global",
      "@aglegg/forge-harness@0.2.0",
      "--registry=https://registry.npmjs.org/",
      "--@aglegg:registry=https://registry.npmjs.org/",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  });
});

describe("bootstrap updater", () => {
  test("updates a proven global npm install to the exact validated version", async () => {
    const { runtime, installs, writes } = fakeRuntime({
      latest: { version: "0.1.3", engines: { node: ">=22.12.0" } },
    });
    const captured = capturedIO();

    const outcome = await bootstrapUpdate(
      { packageRoot: globalRoot(), currentVersion: "0.1.2", force: false, io: captured.io },
      runtime,
    );

    expect(outcome).toEqual({ handled: false, code: 0, updated: true, version: "0.1.3" });
    expect(installs).toEqual(["0.1.3"]);
    expect(captured.out).toEqual([]);
    expect(captured.err).toEqual(["Updating Forge 0.1.2 → 0.1.3...", "Forge updated to 0.1.3."]);
    expect(writes.at(-1)).toEqual({
      packageRoot: globalRoot(),
      version: "0.1.3",
      lastCheckedAt: 1_000_000,
    });
  });

  test("throttles ordinary checks but force bypasses the interval", async () => {
    const automatic = fakeRuntime({
      state: { packageRoot: globalRoot(), version: "0.1.2", lastCheckedAt: 999_500 },
    });
    const captured = capturedIO();
    const skipped = await bootstrapUpdate(
      { packageRoot: globalRoot(), currentVersion: "0.1.2", force: false, io: captured.io },
      automatic.runtime,
    );
    expect(skipped.updated).toBe(false);
    expect(automatic.prefixCalls.count).toBe(0);

    const forced = fakeRuntime({
      state: { packageRoot: globalRoot(), version: "0.1.2", lastCheckedAt: 999_500 },
    });
    const forcedIO = capturedIO();
    const checked = await bootstrapUpdate(
      { packageRoot: globalRoot(), currentVersion: "0.1.2", force: true, io: forcedIO.io },
      forced.runtime,
    );
    expect(checked).toEqual({ handled: true, code: 0, updated: false, version: "0.1.2" });
    expect(forced.prefixCalls.count).toBe(1);
    expect(forcedIO.out).toEqual(["Forge 0.1.2 is already up to date."]);
  });

  test("network failure never blocks an ordinary local-first startup", async () => {
    const { runtime, installs, writes } = fakeRuntime({ fetchError: new Error("offline") });
    const captured = capturedIO();

    const outcome = await bootstrapUpdate(
      { packageRoot: globalRoot(), currentVersion: "0.1.2", force: false, io: captured.io },
      runtime,
    );

    expect(outcome).toEqual({ handled: false, code: 0, updated: false, version: "0.1.2" });
    expect(installs).toEqual([]);
    expect(captured.out).toEqual([]);
    expect(captured.err).toEqual([]);
    expect(writes.at(-1)).toEqual({
      packageRoot: globalRoot(),
      version: "0.1.2",
      lastFailureAt: 1_000_000,
    });
  });

  test("refuses a newer package that needs a newer Node runtime", async () => {
    const { runtime, installs } = fakeRuntime({
      latest: { version: "0.2.0", engines: { node: ">=24.0.0" } },
    });
    const captured = capturedIO();

    const outcome = await bootstrapUpdate(
      { packageRoot: globalRoot(), currentVersion: "0.1.2", force: false, io: captured.io },
      runtime,
    );

    expect(outcome.updated).toBe(false);
    expect(installs).toEqual([]);
    expect(captured.err.join("\n")).toMatch(/requires Node >=24\.0\.0/);
  });

  test("never self-updates a source checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forge-source-update-"));
    roots.push(root);
    await mkdir(path.join(root, "src"));
    const { runtime, installs, prefixCalls } = fakeRuntime({
      latest: { version: "0.1.3", engines: { node: ">=22.12.0" } },
    });
    const captured = capturedIO();

    const outcome = await bootstrapUpdate(
      { packageRoot: root, currentVersion: "0.1.2", force: true, io: captured.io },
      runtime,
    );

    expect(outcome).toEqual({ handled: true, code: 0, updated: false, version: "0.1.2" });
    expect(prefixCalls.count).toBe(0);
    expect(installs).toEqual([]);
    expect(captured.out.join("\n")).toMatch(/source checkouts/);
  });

  test("caches a known local or npx install without repeatedly spawning npm", async () => {
    const packageRoot = "/project/node_modules/@aglegg/forge-harness";
    const { runtime, prefixCalls } = fakeRuntime({
      state: { packageRoot, version: "0.1.2", lastCheckedAt: 999_500 },
    });
    const captured = capturedIO();

    const outcome = await bootstrapUpdate(
      { packageRoot, currentVersion: "0.1.2", force: false, io: captured.io },
      runtime,
    );

    expect(outcome.updated).toBe(false);
    expect(prefixCalls.count).toBe(0);
  });

  test("never turns a local or npx package into a global install", async () => {
    const { runtime, installs } = fakeRuntime();
    const captured = capturedIO();

    const outcome = await bootstrapUpdate(
      {
        packageRoot: "/project/node_modules/@aglegg/forge-harness",
        currentVersion: "0.1.2",
        force: true,
        io: captured.io,
      },
      runtime,
    );

    expect(outcome.code).toBe(2);
    expect(installs).toEqual([]);
    expect(captured.err.join("\n")).toMatch(/global npm install/);
  });

  test("an install failure keeps the current CLI usable and gives a pinned recovery command", async () => {
    const { runtime } = fakeRuntime({
      latest: { version: "0.1.3", engines: { node: ">=22.12.0" } },
      installCode: 1,
    });
    const captured = capturedIO();

    const outcome = await bootstrapUpdate(
      { packageRoot: globalRoot(), currentVersion: "0.1.2", force: false, io: captured.io },
      runtime,
    );

    expect(outcome).toEqual({ handled: false, code: 0, updated: false, version: "0.1.2" });
    expect(captured.err.join("\n")).toContain("@aglegg/forge-harness@0.1.3");
  });
});
