/**
 * Where a command runs.
 *
 * `exec.ts` decides *how* a command runs -- token array, `shell: false`,
 * bounded time, bounded output. This module decides *where*, and it is the only
 * place that answer is made. The host backend is the existing behaviour,
 * unchanged and still the default. The container backend is opt-in isolation
 * for the gap worktrees leave: a worktree contains repository mutations, but a
 * verification suite is arbitrary project code, the model can edit that code,
 * and until now it ran on the host with the host's filesystem in reach.
 *
 * The container backend is a command *transform*, not a second executor. It
 * builds argv for `docker run` and hands it to `execBounded`, so the timeout,
 * the process-group kill, the merged output stream and the output clip are the
 * same code paths the host backend uses. There is no second implementation of
 * the bounds to keep in sync, and no path where model text reaches a shell:
 * the project's command is passed as argv positionals after the image.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { type ExecOptions, type ExecResult, execBounded } from "./exec.js";

export type ExecutionRuntime = "host" | "docker" | "podman";

export interface BackendSettings {
  readonly runtime: ExecutionRuntime;
  readonly image: string;
  /** Off by default: an isolated command that can still reach the network is barely isolated. */
  readonly network: boolean;
  /** Memory bound in MiB; swap is always pinned equal, so it cannot undo the bound. */
  readonly memoryMiB: number;
  /** CPU bound; fractional values are valid runtime input. */
  readonly cpus: number;
  /** Process-count bound; the fork-bomb stop, and the most portably enforced of the set. */
  readonly pids: number;
  /** Size of the writable /tmp; its pages are charged against `memoryMiB`. */
  readonly tmpfsMiB: number;
  /** Root filesystem read-only; /workspace and /tmp stay writable. */
  readonly readOnlyRoot: boolean;
  /**
   * The one escape hatch for runtimes that cannot enforce cgroup limits
   * (rootless without cpu delegation hard-errors). Disabling drops only the
   * three resource bounds -- never the filesystem semantics.
   */
  readonly limits: boolean;
}

export interface ExecutionBackend {
  readonly name: ExecutionRuntime;
  readonly settings: BackendSettings | null;
  run(command: readonly string[], options: ExecOptions & { root: string }): Promise<ExecResult>;
}

/** Where the repository appears inside the container. Fixed, so paths in output are stable. */
const MOUNT = "/workspace";

/**
 * Variables that mean something in a container.
 *
 * Deliberately not `commandEnvironment()`: every path-valued host variable in
 * that allowlist -- PATH, HOME, TMPDIR, JAVA_HOME -- is wrong inside an image
 * that has its own, and forwarding them replaces working container defaults
 * with host paths that do not exist there. What is left is locale and
 * output-shape configuration, which travels.
 */
const CONTAINER_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  GIT_PAGER: "cat",
  PYTHONDONTWRITEBYTECODE: "1",
  // A container path, not a host path. Docker's --user runs a numeric uid with
  // no passwd entry, which gets HOME=/ -- unwritable even before the read-only
  // root -- so npm, cargo, go, and pip cache writes all need a HOME that lives
  // on the tmpfs. Each run gets a cold cache, which is what a verification
  // gate wants. Caller extraEnv is appended later and still wins.
  HOME: "/tmp",
};

const LOCALE_KEYS = ["LANG", "LC_ALL", "TZ"] as const;

export type ContainerInvocation =
  | { readonly ok: true; readonly command: readonly string[]; readonly containerName: string }
  | { readonly ok: false; readonly output: string };

export interface ContainerContext {
  readonly cwd: string;
  readonly root: string;
  readonly extraEnv?: Record<string, string> | undefined;
}

/**
 * Build the argv that runs one command inside a container.
 *
 * Pure, and separated from execution so the security-relevant part -- what is
 * mounted, what environment crosses the boundary, whether there is a network --
 * is asserted in tests that do not need a container runtime installed.
 */
export function containerInvocation(
  command: readonly string[],
  context: ContainerContext,
  settings: BackendSettings,
  id: string = randomUUID(),
): ContainerInvocation {
  if (command.length === 0) return { ok: false, output: "container backend needs a command" };
  const root = path.resolve(context.root);
  const cwd = path.resolve(context.cwd);
  const relative = path.relative(root, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, output: "command working directory is outside the repository" };
  }
  const workdir = relative === "" ? MOUNT : `${MOUNT}/${relative.split(path.sep).join("/")}`;
  const containerName = `forge-${id}`;

  const argv: string[] = [settings.runtime, "run", "--rm", "--init", "--name", containerName];
  if (!settings.network) argv.push("--network", "none");
  // Rootless podman already maps the invoking user to the container's root, so
  // pinning --user there breaks images that expect to own their own files.
  // Docker does not, and without this every file a build writes into the mount
  // comes back root-owned on the host.
  if (settings.runtime === "docker" && typeof process.getuid === "function") {
    argv.push("--user", `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`);
  }
  if (settings.limits) {
    argv.push(
      "--memory",
      `${settings.memoryMiB}m`,
      // Always equal to --memory: extra swap would let a runaway exceed the
      // bound by paging. An internal invariant, not a configuration field.
      "--memory-swap",
      `${settings.memoryMiB}m`,
      "--cpus",
      String(settings.cpus),
      "--pids-limit",
      String(settings.pids),
    );
  }
  if (settings.readOnlyRoot) argv.push("--read-only");
  // Explicit for both runtimes: podman's --read-only would otherwise mount an
  // *unbounded* tmpfs on /tmp while docker would leave it read-only, and
  // mode=1777 keeps it writable by docker's --user uid.
  argv.push("--tmpfs", `/tmp:rw,size=${settings.tmpfsMiB}m,mode=1777`);
  argv.push("--volume", `${root}:${MOUNT}`, "--workdir", workdir);
  for (const [key, value] of Object.entries(CONTAINER_ENV)) argv.push("--env", `${key}=${value}`);
  for (const key of LOCALE_KEYS) {
    const value = process.env[key];
    if (value !== undefined) argv.push("--env", `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(context.extraEnv ?? {})) {
    argv.push("--env", `${key}=${value}`);
  }
  // The image is the last option-position token; everything after it is the
  // command, which is why no token of it needs quoting or escaping.
  argv.push(settings.image, ...command);
  return { ok: true, command: argv, containerName };
}

/** The default. Exported so callers can name it instead of passing undefined. */
export const hostExecutionBackend: ExecutionBackend = {
  name: "host",
  settings: null,
  run: async (command, options) => await execBounded(command, options),
};

function containerBackend(settings: BackendSettings): ExecutionBackend {
  return {
    name: settings.runtime,
    settings,
    run: async (command, options) => {
      const invocation = containerInvocation(command, { ...options, root: options.root }, settings);
      if (!invocation.ok) {
        return { code: null, output: invocation.output, timedOut: false, seconds: 0 };
      }
      let result: ExecResult;
      try {
        result = await execBounded(invocation.command, { ...options, cwd: options.root });
      } catch (error) {
        // A missing runtime binary arrives as a spawn error. Reported as a
        // failed command naming the runtime, rather than thrown, so it reads
        // as the toolchain problem it is instead of crashing the run.
        const detail = error instanceof Error ? error.message : String(error);
        return {
          code: null,
          output: `could not start ${settings.runtime}: ${detail}`,
          timedOut: false,
          seconds: 0,
        };
      }
      // Killing the client does not stop the container it asked for, so a
      // timed-out run would otherwise keep holding the repository mount.
      if (result.timedOut) {
        await execBounded([settings.runtime, "rm", "--force", invocation.containerName], {
          cwd: options.root,
          timeoutSeconds: 20,
          maxOutputChars: 400,
        }).catch(() => undefined);
      }
      return result;
    },
  };
}

export interface ExecutionSettingsInput {
  readonly runtime?: ExecutionRuntime | undefined;
  readonly image?: string | undefined;
  readonly network?: boolean | undefined;
  readonly memoryMiB?: number | undefined;
  readonly cpus?: number | undefined;
  readonly pids?: number | undefined;
  readonly tmpfsMiB?: number | undefined;
  readonly readOnlyRoot?: boolean | undefined;
  readonly limits?: boolean | undefined;
}

/**
 * @throws if a container runtime is requested without an image. Guessing one
 * would silently run the project's suite against a toolchain nobody chose.
 */
export function resolveExecutionBackend(
  input: ExecutionSettingsInput | undefined,
): ExecutionBackend {
  const runtime = input?.runtime ?? "host";
  if (runtime === "host") return hostExecutionBackend;
  const image = input?.image;
  if (image === undefined || image.trim() === "") {
    throw new Error(
      `execution runtime ${runtime} needs an image; set execution.image in forge.json`,
    );
  }
  // The image is the one non-numeric value in option position. A name that
  // starts with a dash would be read by the runtime as an option -- e.g.
  // `--privileged=true` -- turning a config field into a flag injection.
  if (image.startsWith("-")) {
    throw new Error(`execution image may not start with "-": ${image}`);
  }
  const memoryMiB = input?.memoryMiB ?? 4096;
  const tmpfsMiB = input?.tmpfsMiB ?? 1024;
  const limits = input?.limits ?? true;
  // tmpfs pages are charged to the memory cgroup, so a /tmp bigger than the
  // memory bound OOM-kills writers before /tmp fills -- a confusing symptom
  // better rejected here by name.
  if (limits && tmpfsMiB > memoryMiB) {
    throw new Error(
      `execution tmpfsMiB (${tmpfsMiB}) may not exceed memoryMiB (${memoryMiB}) while limits are on`,
    );
  }
  return containerBackend({
    runtime,
    image,
    network: input?.network ?? false,
    // Bounds a verification workload -- compilers and test runners, not
    // services. 4 GiB clears real cargo/tsc/jest runs while stopping a
    // runaway; 512 pids leaves headroom for per-crate rustc and jest workers.
    memoryMiB,
    cpus: input?.cpus ?? 2,
    pids: input?.pids ?? 512,
    tmpfsMiB,
    readOnlyRoot: input?.readOnlyRoot ?? true,
    limits,
  });
}

export function describeBackend(backend: ExecutionBackend): string {
  const settings = backend.settings;
  if (settings === null) return "host (commands run directly on this machine)";
  const bounds = settings.limits
    ? `${settings.memoryMiB} MiB · ${settings.cpus} cpus · ${settings.pids} pids`
    : "NO RESOURCE LIMITS";
  const rootState = settings.readOnlyRoot ? "read-only root" : "writable root";
  return [
    settings.runtime,
    settings.image,
    settings.network ? "network" : "no network",
    rootState,
    bounds,
  ].join(" · ");
}
