/**
 * Bounded command execution for the `run` tool.
 *
 * Model text never reaches a shell: the input is a token array, spawned with
 * `shell: false`, so `;`, `$()` and backticks are literal bytes in an argument
 * rather than syntax. The gate on *which* commands run is the approval prompt
 * -- in this design the human is the allowlist -- but the gate on *how* they
 * run is here, and it is not negotiable.
 *
 * Details carried from the previous harness because each was a real failure:
 *
 * - `code` is `null` on timeout, never a numeric sentinel that collides with a
 *   real exit status.
 * - stdout and stderr share one file descriptor (`['ignore', fd, fd]` --
 *   literally `2>&1 >file`), so a traceback sits where it happened in the text
 *   the model reads. Two pipes concatenated afterwards reorder it.
 * - `detached: true` + `kill(-pid)` kills the process *group*: a grandchild
 *   holding the pipe open must not defeat the timeout. Never `spawn`'s own
 *   `timeout` option, which signals only the direct child.
 * - The merged log lives in the OS temp dir, never the working directory, so
 *   it cannot appear in `git status` and get committed.
 * - Truncation keeps the head and the tail and drops the middle: the head has
 *   the first error, the tail has the summary line a test runner prints.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInside } from "./workspace.js";

export interface ExecResult {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly seconds: number;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly timeoutSeconds?: number;
  readonly maxOutputChars?: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * Extra variables added to the allowlisted environment.
   *
   * Named `extraEnv` rather than `env` so it cannot be mistaken for a
   * replacement: the allowlist is the security property, and a caller that
   * wanted to pass the whole environment would have to say so somewhere this
   * comment is.
   */
  readonly extraEnv?: Record<string, string> | undefined;
}

export type ResolvedCommandInvocation =
  | {
      readonly ok: true;
      readonly command: readonly string[];
      readonly cwd: string;
      readonly notice: string | null;
    }
  | { readonly ok: false; readonly output: string };

const SHELL_CONTROL_TOKEN = /^(?:&&|\|\||[|;<>]|\d*[<>].*)$/;

/**
 * Convert the one shell-shaped command local models emit most often into a
 * shell-free invocation.
 *
 * `RUN cd build && make` is not dangerous in Forge -- every token is passed to
 * `spawn` with `shell: false` -- but without this adapter it tries to launch an
 * executable named `cd`. Small models then spend their remaining turns trying
 * dozens or hundreds of alternative command spellings. Recognising exactly one
 * leading `cd <dir> &&` keeps the security invariant while matching the model's
 * natural interface. Anything more shell-like is rejected rather than guessed.
 */
export function resolveCommandInvocation(
  command: readonly string[],
  workspaceRoot: string,
): ResolvedCommandInvocation {
  if (command.length === 0) return { ok: false, output: "run needs a command" };

  let executable = command;
  let cwd = workspaceRoot;
  let notice: string | null = null;
  if (command[0] === "cd") {
    if (command.length < 4 || command[2] !== "&&") {
      return {
        ok: false,
        output: "RUN does not use a shell. Use exactly: RUN cd <directory> && <one command>.",
      };
    }
    const requested = command[1];
    if (requested === undefined) {
      return { ok: false, output: "RUN cd needs a repository-relative directory" };
    }
    const resolved = resolveInside(workspaceRoot, requested);
    if (resolved === null) {
      return { ok: false, output: "run working directory is outside the repository" };
    }
    try {
      if (!statSync(resolved).isDirectory()) {
        return { ok: false, output: `${requested} is not a directory` };
      }
    } catch {
      return { ok: false, output: `${requested} is not an existing directory` };
    }
    executable = command.slice(3);
    cwd = resolved;
    notice = `used repository working directory ${path.relative(workspaceRoot, resolved) || "."}`;
  }

  if (executable.length === 0) {
    return { ok: false, output: "RUN needs one command after the working directory" };
  }
  if (executable.some((token) => SHELL_CONTROL_TOKEN.test(token))) {
    return {
      ok: false,
      output:
        "RUN executes one command without a shell; chains, pipes, redirects, and multiple && commands are unsupported.",
    };
  }
  return { ok: true, command: executable, cwd, notice };
}

/**
 * The environment a model-approved command runs under: an explicit allowlist,
 * never `process.env` minus a few names. A deny list has to enumerate every
 * provider's key spelling, and the next one added leaks by default. The code
 * being run may be code the model just wrote; it does not get the API keys.
 */
export function commandEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const keep = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "SHELL",
    "USER",
    "TERM",
    // Non-secret configuration used to contain Gradle's cache during a run.
    "GRADLE_USER_HOME",
    "JAVA_HOME",
  ];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env["NO_COLOR"] = "1";
  env["GIT_PAGER"] = "cat";
  env["PYTHONDONTWRITEBYTECODE"] = "1";
  return env;
}

export async function execBounded(
  command: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const executable = command[0];
  if (executable === undefined) {
    return { code: null, output: "empty command", timedOut: false, seconds: 0 };
  }
  // AbortSignal does not replay its event to listeners registered after it has
  // fired. Check before allocating files or spawning so a command requested
  // after cancellation never starts.
  if (options.signal?.aborted === true) {
    return {
      code: null,
      output: "cancelled before command started",
      timedOut: true,
      seconds: 0,
    };
  }
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  const limit = options.maxOutputChars ?? 16000;
  const started = Date.now();
  const dir = mkdtempSync(path.join(tmpdir(), "forge-exec-"));
  const logPath = path.join(dir, "merged.log");
  const fd = openSync(logPath, "w+");

  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(executable, [...command.slice(1)], {
        cwd: options.cwd,
        env: { ...commandEnvironment(), ...(options.extraEnv ?? {}) },
        shell: false,
        detached: true,
        stdio: ["ignore", fd, fd],
      });

      let timedOut = false;
      let settled = false;

      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutSeconds * 1000);
      const onAbort = (): void => {
        timedOut = true;
        killGroup();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          code: timedOut ? null : code,
          output: readClipped(logPath, limit),
          timedOut,
          seconds: (Date.now() - started) / 1000,
        });
      });
    });
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function readClipped(file: string, limit: number): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head - 40;
  return `${text.slice(0, head)}\n… ${text.length - head - tail} chars omitted …\n${text.slice(-tail)}`;
}
