/**
 * Post-claim verification: the project's own commands decide whether a change
 * is done, not the model's assertion that it is.
 *
 * The failure this exists to prevent is the confident wrong finish. A small
 * model that has just written an edit is a poor judge of that edit -- it says
 * "the tests now pass" having never run them, and the harness has no reason to
 * disbelieve it. So when the model claims completion, the configured commands
 * run and the *result* is authoritative. A non-zero exit outranks any sentence
 * the model produced.
 *
 * Two design points carry weight:
 *
 * - Commands are token arrays, executed through `execBounded` with
 *   `shell: false`. Nothing model-written reaches a shell, so a `;` or a `$()`
 *   in a command is an argument byte, not syntax. `quote()` below produces a
 *   shell-looking string for *display only*; it must never be executed.
 * - `configured` is reported separately from `passed`, because "every command
 *   exited zero" and "there was nothing to run" are the same boolean and very
 *   different facts. See `VerificationReport`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ExecResult, execBounded } from "./exec.js";

/**
 * A generous default: the point of this module is to run a project's real test
 * suite, and a suite that takes two minutes is ordinary. The bound is here to
 * catch a command that has hung -- a watcher left in the config, a runner
 * waiting on stdin -- not to hurry a slow one.
 */
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * What each run retains. Deliberately larger than what `formatForModel` hands
 * back: the report is also what a caller writes to a log or shows a human, and
 * those readers can afford detail the model's context cannot.
 */
const CAPTURE_CHARS = 32_000;

/**
 * Ceiling on the failure output offered to the model, across all failing
 * commands. A real ceiling: the per-command floor below cannot push past it,
 * because a budget that says 6,000 and delivers 16,000 when twenty commands
 * fail is not a budget -- it is a suggestion, and the context it overflows is
 * the one the repair has to fit in.
 */
const MODEL_OUTPUT_BUDGET = 6_000;

/**
 * Floor on the per-command share. With many failures an even split degenerates
 * into a few useless lines each; below this it is better to show fewer bytes
 * of more commands than a uniformly unreadable smear.
 */
const MIN_COMMAND_BUDGET = 800;

export interface VerificationConfig {
  /**
   * Token arrays, never shell strings. `["npm", "test"]`, not `"npm test"`:
   * the second form only has a meaning if something splits it, and the thing
   * that splits it is a shell.
   */
  readonly commands: readonly (readonly string[])[];
  readonly timeoutSeconds?: number;
  /**
   * How many times a passing suite must pass before the pass is believed.
   *
   * One execution cannot distinguish "correct" from "won the race this time".
   * A suite whose tests share mutable state and run in parallel can pass once
   * and fail the next run; observed for real, where an agent-authored project
   * passed its own verification, was accepted, and then failed 1 run in 6.
   *
   * Only the success path repeats, so the cost is bounded and paid exactly
   * where a wrong answer is expensive: a failing suite is already believed the
   * first time. Defaults to 1, which is the historical single-run behaviour.
   */
  readonly confirmations?: number;
}

export interface VerifyOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
}

export interface VerificationRun {
  readonly command: readonly string[];
  /** `null` on timeout or cancellation -- never a numeric stand-in that could collide with a real status. */
  readonly code: number | null;
  readonly output: string;
  readonly seconds: number;
  readonly timedOut: boolean;
}

export interface VerificationReport {
  readonly ran: readonly VerificationRun[];
  /** True only if every command exited 0. An empty run vacuously passes. */
  readonly passed: boolean;
  /**
   * Whether there was anything to verify at all.
   *
   * Without this field a caller cannot tell "the suite ran and was green" from
   * "no commands are configured, so nothing contradicted the model" -- both
   * arrive as `passed: true`. They must not be reported the same way. A green
   * run with no tests is not evidence that the change works; it is the absence
   * of evidence, and a harness that prints "verified" for it has taught the
   * user to trust a signal that is not there.
   */
  readonly configured: boolean;
  /**
   * The suite passed and then did not pass again.
   *
   * Reported separately from `passed` because the two call for different
   * repairs: a failing suite needs the code fixed, a flaky one needs the
   * nondeterminism found. Collapsing them sends the model looking for a bug
   * that is not in the code under test.
   */
  readonly flaky: boolean;
}

/**
 * Runs every configured command and reports what happened.
 *
 * All commands run even after one fails, rather than stopping at the first
 * non-zero exit. The extra cost is one command's runtime; the saving is a
 * round trip -- a model told only "lint failed" fixes lint, claims completion
 * again, and only then learns the tests were also broken.
 */
export async function verify(
  config: VerificationConfig,
  options: VerifyOptions,
): Promise<VerificationReport> {
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const ran: VerificationRun[] = [];
  const confirmations = Math.max(1, Math.trunc(config.confirmations ?? 1));

  for (const command of config.commands) {
    let result: ExecResult;
    try {
      result = await execBounded(command, {
        cwd: options.cwd,
        timeoutSeconds,
        maxOutputChars: CAPTURE_CHARS,
        signal: options.signal,
      });
    } catch (error) {
      // A binary that is not installed (`cargo` on a machine without Rust)
      // rejects at spawn. That is a failed verification, not a crashed
      // harness: the caller still needs a report to show, and `passed` has to
      // stay false rather than the whole run dying with an exception.
      result = {
        code: null,
        output: error instanceof Error ? error.message : String(error),
        timedOut: false,
        seconds: 0,
      };
    }
    ran.push({
      // Copied, so a later mutation of the caller's config cannot rewrite
      // history in a report that has already been persisted.
      command: [...command],
      code: result.code,
      output: result.output,
      seconds: result.seconds,
      timedOut: result.timedOut,
    });

    // After cancellation the remaining commands would each spawn and be killed
    // on arrival, filling the report with failures that say nothing about the
    // change under test.
    if (options.signal?.aborted === true) break;
  }

  // `every` on an empty array is true, which is the intended answer: with
  // nothing configured there is nothing to fail on. `configured` is what
  // stops that from being read as success.
  const firstPassPassed = ran.every((run) => run.code === 0);
  const configured = config.commands.length > 0;

  // Confirm only a pass, and only when there was something to pass. A failing
  // suite is already believed, and repeating it would spend the user's time
  // re-deriving an answer the first run gave.
  if (firstPassPassed && configured && confirmations > 1 && options.signal?.aborted !== true) {
    const repeats = await confirm(config, options, timeoutSeconds, confirmations - 1);
    ran.push(...repeats);
    if (repeats.some((run) => run.code !== 0)) {
      return { ran, passed: false, configured, flaky: true };
    }
  }

  return { ran, passed: firstPassPassed, configured, flaky: false };
}

/**
 * Re-runs the suite and returns the runs, stopping at the first disagreement.
 *
 * Stopping early is deliberate: one contradiction already proves the pass does
 * not reproduce, and further repeats would only add cost and noise to a report
 * whose verdict is settled.
 */
async function confirm(
  config: VerificationConfig,
  options: VerifyOptions,
  timeoutSeconds: number,
  rounds: number,
): Promise<VerificationRun[]> {
  const runs: VerificationRun[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const command of config.commands) {
      let result: ExecResult;
      try {
        result = await execBounded(command, {
          cwd: options.cwd,
          timeoutSeconds,
          maxOutputChars: CAPTURE_CHARS,
          signal: options.signal,
        });
      } catch (error) {
        result = {
          code: null,
          output: error instanceof Error ? error.message : String(error),
          timedOut: false,
          seconds: 0,
        };
      }
      runs.push({
        command: [...command],
        code: result.code,
        output: result.output,
        seconds: result.seconds,
        timedOut: result.timedOut,
      });
      if (result.code !== 0) return runs;
      if (options.signal?.aborted === true) return runs;
    }
  }
  return runs;
}

/**
 * The text handed back to the model.
 *
 * Every failing command appears with its exit status and its output, because a
 * model asked to repair a failure it cannot see will guess. The output is
 * capped: verification failure text competes with the file contents and the
 * conversation for a context window that, for the models this harness targets,
 * is small.
 */
export function formatForModel(report: VerificationReport): string {
  if (!report.configured) {
    return [
      "Verification did not run: this project has no verification commands configured.",
      "Nothing here confirms the change works. Do not report it as verified.",
    ].join("\n");
  }

  // Said before the failure list, and said as nondeterminism rather than as a
  // broken build: the same commands already passed in this report, so a model
  // told only "the tests failed" will hunt for a bug in code that is correct
  // and patch a symptom. What needs finding is the shared state.
  if (report.flaky) {
    const failures = report.ran.filter((run) => run.code !== 0);
    return [
      "Verification is FLAKY: the suite passed and then failed on a re-run of the same commands.",
      "The code is not necessarily wrong -- the suite does not give the same answer twice.",
      "Find the source of the nondeterminism (shared files or state between tests that run",
      "in parallel, ordering assumptions, time or randomness) and fix that. Do not weaken or",
      "delete tests, and do not paper over it by making the failure less likely.",
      "",
      ...failures.map(
        (run) => `$ ${quote(run.command)}\n${clip(run.output.trimEnd(), MIN_COMMAND_BUDGET)}`,
      ),
    ].join("\n");
  }

  const failures = report.ran.filter((run) => run.code !== 0);
  if (failures.length === 0) {
    return `Verification passed: ${report.ran.map((run) => quote(run.command)).join(", ")}.`;
  }

  // The floor wins over the even split, and the ceiling wins over the floor.
  // When they conflict, fewer commands are shown in readable detail rather than
  // all of them in an unreadable smear -- and the ones dropped are named, so the
  // model knows its picture is partial instead of assuming it is complete.
  const budget = Math.max(MIN_COMMAND_BUDGET, Math.floor(MODEL_OUTPUT_BUDGET / failures.length));
  const shown = Math.max(1, Math.floor(MODEL_OUTPUT_BUDGET / budget));
  const detailed = failures.slice(0, shown);
  const omittedCommands = failures.slice(shown);
  const lines: string[] = [
    `Verification failed: ${failures.length} of ${report.ran.length} command(s) did not pass.`,
  ];
  for (const run of detailed) {
    const status = run.timedOut
      ? `timed out after ${run.seconds.toFixed(1)}s`
      : `exited ${run.code === null ? "abnormally" : String(run.code)} after ${run.seconds.toFixed(1)}s`;
    const body = clip(run.output.trimEnd(), budget);
    lines.push("", `$ ${quote(run.command)}`, status, body === "" ? "(no output)" : body);
  }
  if (omittedCommands.length > 0) {
    lines.push(
      "",
      `${omittedCommands.length} further failing command(s) not shown: ${omittedCommands
        .map((run) => quote(run.command))
        .join(", ")}`,
    );
  }

  // Naming what still passes stops a repair from trading one failure for
  // another: the model can see which commands its next edit must not break.
  const survivors = report.ran.filter((run) => run.code === 0);
  if (survivors.length > 0) {
    lines.push("", `Still passing: ${survivors.map((run) => quote(run.command)).join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Best-effort discovery of a project's verification commands.
 *
 * A seed for a configuration the user can edit, not an authority. It stops at
 * the first match rather than accumulating across ecosystems: in a repo with
 * both a `package.json` and a `pyproject.toml` there is no way to guess which
 * suite the user considers the gate, and running both by default turns an
 * unrelated ecosystem's broken tooling into a blocked run.
 */
export function detectCommands(root: string): string[][] {
  try {
    if (hasNodeTestScript(root)) return [["npm", "test"]];
    if (exists(root, "pyproject.toml") || exists(root, "pytest.ini")) {
      return [["python", "-m", "pytest", "-q"]];
    }
    if (exists(root, "Cargo.toml")) return [["cargo", "test"]];
    if (exists(root, "go.mod")) return [["go", "test", "./..."]];
  } catch {
    // Detection reads a directory the harness does not own and may not be able
    // to stat. An unreadable root must degrade to "nothing detected" so the
    // caller falls back to asking, never abort the run with an exception.
  }
  return [];
}

/**
 * `package.json` alone proves nothing -- plenty exist only to pin a dependency
 * or set `"type": "module"`. The signal is a `test` script, because that is
 * what `npm test` will actually invoke.
 */
function hasNodeTestScript(root: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    // Missing, unreadable, or malformed all mean the same thing here.
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const scripts = (parsed as Record<string, unknown>)["scripts"];
  if (typeof scripts !== "object" || scripts === null) return false;
  return typeof (scripts as Record<string, unknown>)["test"] === "string";
}

function exists(root: string, name: string): boolean {
  return existsSync(path.join(root, name));
}

/**
 * Keeps the head and the tail, drops the middle.
 *
 * Neither end is expendable: the head holds the first error, which is usually
 * the cause, and the tail holds the summary line a test runner prints -- the
 * count of failures and often the name of each. Truncating to the head alone
 * loses the scoreboard; truncating to the tail alone loses the traceback. The
 * split is weighted toward the head because a stack trace is longer than a
 * summary.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // The marker is part of what is returned, so it comes out of the limit
  // rather than being added on top of it. Returning `limit + 26` characters
  // from a function whose contract is "capped at limit" makes every caller's
  // own budget arithmetic quietly wrong, and it compounds per failing command.
  const marker = (count: number) => `\n… ${count} characters omitted …\n`;
  const reserve = marker(text.length).length;
  const usable = Math.max(0, limit - reserve);
  const head = Math.floor(usable * 0.6);
  const tail = usable - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}${marker(omitted)}${tail > 0 ? text.slice(-tail) : ""}`;
}

/**
 * Renders a token array for a human or a model to read. Display only: the
 * quoting here is not shell-correct escaping and must never be fed to a shell,
 * which is also why nothing in this module ever does.
 */
function quote(command: readonly string[]): string {
  return command
    .map((token) => (token === "" || /\s/.test(token) ? JSON.stringify(token) : token))
    .join(" ");
}
