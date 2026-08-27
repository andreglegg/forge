import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const FORGE_PACKAGE_NAME = "@aglegg/forge-harness";
export const FORGE_REGISTRY = "https://registry.npmjs.org/";
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000;
export const UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1_000;
const LATEST_URL = `${FORGE_REGISTRY}@aglegg%2fforge-harness/latest`;

export interface UpdateIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

interface UpdateState {
  readonly packageRoot?: string;
  readonly version?: string;
  readonly lastCheckedAt?: number;
  readonly lastFailureAt?: number;
}

export interface LatestPackage {
  readonly version: string;
  readonly engines?: { readonly node?: string };
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface UpdateRuntime {
  readonly now: () => number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly npmPrefix: () => Promise<string | null>;
  readonly fetchLatest: () => Promise<LatestPackage>;
  readonly install: (version: string) => Promise<CommandResult>;
  readonly readState: () => Promise<UpdateState>;
  readonly writeState: (state: UpdateState) => Promise<void>;
}

export interface BootstrapUpdateInput {
  readonly packageRoot: string;
  readonly currentVersion: string;
  readonly force: boolean;
  readonly io: UpdateIO;
}

export interface BootstrapUpdateResult {
  readonly handled: boolean;
  readonly code: number;
  readonly updated: boolean;
  readonly version: string;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(version: string): readonly [number, number, number] | null {
  const match = STABLE_VERSION.exec(version.trim());
  if (match === null) return null;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return [major, minor, patch];
}

export function compareStableVersions(left: string, right: string): number | null {
  const a = versionParts(left);
  const b = versionParts(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function nodeSatisfiesSimpleEngine(nodeVersion: string, range: string): boolean | null {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (match === null) return null;
  const required = `${match[1]}.${match[2]}.${match[3]}`;
  const normalized = nodeVersion.replace(/^v/, "").split("-")[0] ?? "";
  const comparison = compareStableVersions(normalized, required);
  return comparison === null ? null : comparison >= 0;
}

export function expectedGlobalPackageRoot(prefix: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32"
    ? paths.join(prefix, "node_modules", "@aglegg", "forge-harness")
    : paths.join(prefix, "lib", "node_modules", "@aglegg", "forge-harness");
}

export function isGlobalNpmInstall(
  packageRoot: string,
  prefix: string,
  platform: NodeJS.Platform,
): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const actual = paths.resolve(packageRoot);
  const expected = paths.resolve(expectedGlobalPackageRoot(prefix, platform));
  return platform === "win32"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

export function autoUpdateDisabled(env: Readonly<NodeJS.ProcessEnv>): boolean {
  if (env["CI"] !== undefined && env["CI"] !== "") return true;
  if (env["NO_UPDATE_NOTIFIER"] !== undefined && env["NO_UPDATE_NOTIFIER"] !== "") return true;
  const value = env["FORGE_AUTO_UPDATE"]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

export function updateInstallArgs(version: string): string[] {
  return [
    "install",
    "--global",
    `${FORGE_PACKAGE_NAME}@${version}`,
    `--registry=${FORGE_REGISTRY}`,
    `--@aglegg:registry=${FORGE_REGISTRY}`,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
}

function installKey(packageRoot: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const resolved = paths.resolve(packageRoot);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function checkDue(state: UpdateState, now: number, packageRoot: string, version: string): boolean {
  if (state.packageRoot !== packageRoot || state.version !== version) return true;
  if (
    state.lastCheckedAt !== undefined &&
    now - state.lastCheckedAt >= 0 &&
    now - state.lastCheckedAt < UPDATE_CHECK_INTERVAL_MS
  ) {
    return false;
  }
  if (
    state.lastFailureAt !== undefined &&
    now - state.lastFailureAt >= 0 &&
    now - state.lastFailureAt < UPDATE_FAILURE_RETRY_MS
  ) {
    return false;
  }
  return true;
}

async function safeWriteState(runtime: UpdateRuntime, state: UpdateState): Promise<void> {
  try {
    await runtime.writeState(state);
  } catch {
    // Update bookkeeping must never prevent Forge from starting.
  }
}

function sourceCheckout(packageRoot: string): boolean {
  return existsSync(path.join(packageRoot, "src"));
}

function result(
  handled: boolean,
  code: number,
  updated: boolean,
  version: string,
): BootstrapUpdateResult {
  return { handled, code, updated, version };
}

export async function bootstrapUpdate(
  input: BootstrapUpdateInput,
  runtime: UpdateRuntime = defaultUpdateRuntime(),
): Promise<BootstrapUpdateResult> {
  if (!input.force && autoUpdateDisabled(runtime.env)) {
    return result(false, 0, false, input.currentVersion);
  }

  if (sourceCheckout(input.packageRoot)) {
    if (input.force) {
      input.io.out(
        "Forge self-update is disabled for source checkouts; update the repository instead.",
      );
      return result(true, 0, false, input.currentVersion);
    }
    return result(false, 0, false, input.currentVersion);
  }

  const packageRoot = installKey(input.packageRoot, runtime.platform);
  const state = await runtime.readState().catch(() => ({}));
  if (!input.force && !checkDue(state, runtime.now(), packageRoot, input.currentVersion)) {
    return result(false, 0, false, input.currentVersion);
  }

  const prefix = await runtime.npmPrefix().catch(() => null);
  if (prefix === null) {
    await safeWriteState(runtime, {
      packageRoot,
      version: input.currentVersion,
      lastFailureAt: runtime.now(),
    });
    if (input.force) {
      input.io.err("Could not determine npm's global install prefix.");
      return result(true, 1, false, input.currentVersion);
    }
    return result(false, 0, false, input.currentVersion);
  }
  if (!isGlobalNpmInstall(input.packageRoot, prefix, runtime.platform)) {
    await safeWriteState(runtime, {
      packageRoot,
      version: input.currentVersion,
      lastCheckedAt: runtime.now(),
    });
    if (input.force) {
      input.io.err(
        `Forge self-update is available only for a global npm install. Run: npm install --global ${FORGE_PACKAGE_NAME}@latest`,
      );
      return result(true, 2, false, input.currentVersion);
    }
    return result(false, 0, false, input.currentVersion);
  }

  let latest: LatestPackage;
  try {
    latest = await runtime.fetchLatest();
  } catch (error) {
    await safeWriteState(runtime, {
      packageRoot,
      version: input.currentVersion,
      lastFailureAt: runtime.now(),
    });
    if (input.force) {
      input.io.err(
        `Could not check npm for Forge updates: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result(true, 1, false, input.currentVersion);
    }
    return result(false, 0, false, input.currentVersion);
  }

  const comparison = compareStableVersions(input.currentVersion, latest.version);
  if (comparison === null) {
    await safeWriteState(runtime, {
      packageRoot,
      version: input.currentVersion,
      lastFailureAt: runtime.now(),
    });
    if (input.force) input.io.err(`npm returned an invalid Forge version: ${latest.version}`);
    return result(input.force, input.force ? 1 : 0, false, input.currentVersion);
  }

  if (comparison >= 0) {
    await safeWriteState(runtime, {
      packageRoot,
      version: input.currentVersion,
      lastCheckedAt: runtime.now(),
    });
    if (input.force) input.io.out(`Forge ${input.currentVersion} is already up to date.`);
    return result(input.force, 0, false, input.currentVersion);
  }

  const engine = latest.engines?.node;
  if (engine !== undefined) {
    const compatible = nodeSatisfiesSimpleEngine(runtime.nodeVersion, engine);
    if (compatible !== true) {
      const message =
        compatible === false
          ? `Forge ${latest.version} requires Node ${engine}; current runtime is ${runtime.nodeVersion}.`
          : `Forge ${latest.version} declares an unsupported Node engine range (${engine}); refusing an automatic update.`;
      await safeWriteState(runtime, {
        packageRoot,
        version: input.currentVersion,
        lastCheckedAt: runtime.now(),
      });
      input.io.err(message);
      return result(input.force, input.force ? 1 : 0, false, input.currentVersion);
    }
  }

  const notify = input.force ? input.io.out : input.io.err;
  notify(`Updating Forge ${input.currentVersion} → ${latest.version}...`);
  const installed = await runtime.install(latest.version).catch((error) => ({
    code: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (installed.code !== 0) {
    await safeWriteState(runtime, {
      packageRoot,
      version: input.currentVersion,
      lastFailureAt: runtime.now(),
    });
    const detail =
      installed.stderr
        .trim()
        .split("\n")
        .find((line) => line.trim()) ?? "npm failed";
    input.io.err(
      `Automatic Forge update failed (${detail}). Run: npm install --global ${FORGE_PACKAGE_NAME}@${latest.version}`,
    );
    return result(input.force, input.force ? 1 : 0, false, input.currentVersion);
  }

  await safeWriteState(runtime, {
    packageRoot,
    version: latest.version,
    lastCheckedAt: runtime.now(),
  });
  notify(`Forge updated to ${latest.version}.`);
  return result(input.force, 0, true, latest.version);
}

async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const child = spawn(command, [...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    const finish = (value: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
        });
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-16_384);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
    timer = setTimeout(() => {
      killGroup();
      finish({ code: 1, stdout, stderr: `${stderr}\ncommand timed out`.trim() });
    }, timeoutMs);
    timer.unref();
  });
}

function npmCommand(
  args: readonly string[],
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: readonly string[] } {
  if (platform === "win32") {
    return {
      command: process.env["ComSpec"] ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args],
    };
  }
  return { command: "npm", args };
}

async function runNpm(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  const invocation = npmCommand(args, process.platform);
  return await runProcess(invocation.command, invocation.args, timeoutMs);
}

function parseLatest(value: unknown): LatestPackage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("npm returned malformed package metadata");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["version"] !== "string" || versionParts(record["version"]) === null) {
    throw new Error("npm returned an invalid package version");
  }
  const enginesValue = record["engines"];
  let engines: { readonly node?: string } | undefined;
  if (enginesValue !== undefined) {
    if (enginesValue === null || typeof enginesValue !== "object" || Array.isArray(enginesValue)) {
      throw new Error("npm returned malformed engine metadata");
    }
    const node = (enginesValue as Record<string, unknown>)["node"];
    if (node !== undefined && typeof node !== "string") {
      throw new Error("npm returned malformed Node engine metadata");
    }
    engines = node === undefined ? {} : { node };
  }
  return engines === undefined
    ? { version: record["version"] }
    : { version: record["version"], engines };
}

export function defaultUpdateRuntime(): UpdateRuntime {
  const stateFile = path.join(homedir(), ".forge", "update.json");
  return {
    now: () => Date.now(),
    env: process.env,
    platform: process.platform,
    nodeVersion: process.version,
    npmPrefix: async () => {
      const response = await runNpm(["prefix", "--global"], 5_000);
      return response.code === 0 && response.stdout.trim() ? response.stdout.trim() : null;
    },
    fetchLatest: async () => {
      const response = await fetch(LATEST_URL, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
      return parseLatest(await response.json());
    },
    install: async (version) => await runNpm(updateInstallArgs(version), 120_000),
    readState: async () => {
      try {
        const parsed = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const record = parsed as Record<string, unknown>;
        const packageRoot = record["packageRoot"];
        const version = record["version"];
        const lastCheckedAt = record["lastCheckedAt"];
        const lastFailureAt = record["lastFailureAt"];
        return {
          ...(typeof packageRoot === "string" ? { packageRoot } : {}),
          ...(typeof version === "string" ? { version } : {}),
          ...(typeof lastCheckedAt === "number" && Number.isFinite(lastCheckedAt)
            ? { lastCheckedAt }
            : {}),
          ...(typeof lastFailureAt === "number" && Number.isFinite(lastFailureAt)
            ? { lastFailureAt }
            : {}),
        };
      } catch {
        return {};
      }
    },
    writeState: async (state) => {
      await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      await writeFile(stateFile, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    },
  };
}
