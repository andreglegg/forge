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
import { type ExecutionBackend, hostExecutionBackend } from "./backend.js";
import { type ExecResult, resolveCommandInvocation } from "./exec.js";
import {
  classifyVerificationReport,
  recoveryDirective,
  verificationRunFailed,
} from "./recovery.js";

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

/**
 * Cap on the matched-line fragment quoted in the "exited 0, but the configured
 * failure pattern matched" status. The fragment is a whole line of the retained
 * output -- bounded only by `CAPTURE_CHARS` -- so quoting it verbatim would let
 * a single long line hand the model several times `MODEL_OUTPUT_BUDGET` in one
 * status line. The status only needs to name the match; the clipped body below
 * it carries the detail.
 */
const ADAPTER_STATUS_CHARS = 200;

/**
 * A declarative, user-authored strictening of one command's verdict.
 *
 * An adapter can only fail an exit-0 run or reshape its failure evidence.
 * There is deliberately no field that can convert a non-zero exit, timeout, or
 * spawn failure into a pass: false success stays unreachable by construction.
 * Patterns run in-process on already-bounded captured output -- no project
 * code executes, and nothing model-written can author one (they live in
 * forge.json, validated at load).
 */
export interface VerificationAdapter {
  /** Matched to a configured command by exact token-array equality. */
  readonly command: readonly string[];
  /** An exit-0 run whose output has a line matching this pattern FAILS. */
  readonly failWhen?: string | undefined;
  /** Output lines matching this replace the head/tail clip in the model-facing body. */
  readonly evidence?: string | undefined;
}

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
  /** Applied to matching commands on every run, confirmations included. */
  readonly adapters?: readonly VerificationAdapter[] | undefined;
}

export interface VerifyOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  /**
   * Where the commands run. Defaults to the host, which is what every caller
   * did before backends existed. A project's suite is arbitrary code that the
   * model can edit, so this is the one place worth isolating even when the
   * repository itself is already in a worktree.
   */
  readonly backend?: ExecutionBackend | undefined;
}

export interface VerificationRun {
  readonly command: readonly string[];
  /** `null` on timeout or cancellation -- never a numeric stand-in that could collide with a real status. */
  readonly code: number | null;
  readonly output: string;
  readonly seconds: number;
  readonly timedOut: boolean;
  /**
   * The first output line the matched adapter's `failWhen` flagged on an
   * exit-0 run, `null` when no adapter objected. Optional so persisted runs
   * from before adapters existed still satisfy the shape.
   */
  readonly adapterFailure?: string | null;
  /** The matched adapter's `evidence` pattern, carried so the formatter can apply it. */
  readonly evidencePattern?: string;
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
    ran.push(await runCommandOnce(command, config, options, timeoutSeconds));

    // After cancellation the remaining commands would each spawn and be killed
    // on arrival, filling the report with failures that say nothing about the
    // change under test.
    if (options.signal?.aborted === true) break;
  }

  // `every` on an empty array is true, which is the intended answer: with
  // nothing configured there is nothing to fail on. `configured` is what
  // stops that from being read as success.
  const firstPassPassed = !ran.some(verificationRunFailed);
  const configured = config.commands.length > 0;

  // Confirm only a pass, and only when there was something to pass. A failing
  // suite is already believed, and repeating it would spend the user's time
  // re-deriving an answer the first run gave.
  if (firstPassPassed && configured && confirmations > 1 && options.signal?.aborted !== true) {
    const repeats = await confirm(config, options, timeoutSeconds, confirmations - 1);
    ran.push(...repeats);
    if (repeats.some(verificationRunFailed)) {
      return { ran, passed: false, configured, flaky: true };
    }
  }

  return { ran, passed: firstPassPassed, configured, flaky: false };
}

/**
 * One execution of one command, adapter verdict included, so the first pass
 * and every confirmation judge a run by exactly the same predicate.
 */
async function runCommandOnce(
  command: readonly string[],
  config: VerificationConfig,
  options: VerifyOptions,
  timeoutSeconds: number,
): Promise<VerificationRun> {
  let result: ExecResult;
  try {
    result = await executeVerificationCommand(command, options, timeoutSeconds);
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
  const adapter = adapterFor(config.adapters, command);
  // `failWhen` is consulted only on a clean exit: it can make the gate
  // stricter, never rescue a run that already failed.
  const adapterFailure =
    result.code === 0 && adapter?.failWhen !== undefined
      ? firstLineMatching(result.output, adapter.failWhen)
      : null;
  return {
    // Copied, so a later mutation of the caller's config cannot rewrite
    // history in a report that has already been persisted.
    command: [...command],
    code: result.code,
    output: result.output,
    seconds: result.seconds,
    timedOut: result.timedOut,
    adapterFailure,
    ...(adapter?.evidence === undefined ? {} : { evidencePattern: adapter.evidence }),
  };
}

function adapterFor(
  adapters: readonly VerificationAdapter[] | undefined,
  command: readonly string[],
): VerificationAdapter | null {
  for (const adapter of adapters ?? []) {
    if (
      adapter.command.length === command.length &&
      adapter.command.every((token, index) => token === command[index])
    ) {
      return adapter;
    }
  }
  return null;
}

/**
 * Patterns are line-scoped: user regexes never see the whole capture at once,
 * which keeps a 32k-character output from feeding a pathological pattern more
 * than one line of backtracking room. Invalid patterns throw -- forge.json
 * validation rejects them before any run in the CLI path.
 */
function firstLineMatching(output: string, source: string): string | null {
  const pattern = new RegExp(source);
  for (const line of output.split("\n")) {
    if (pattern.test(line)) return line;
  }
  return null;
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
      const run = await runCommandOnce(command, config, options, timeoutSeconds);
      runs.push(run);
      if (verificationRunFailed(run)) return runs;
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
async function executeVerificationCommand(
  command: readonly string[],
  options: VerifyOptions,
  timeoutSeconds: number,
): Promise<ExecResult> {
  const invocation = resolveCommandInvocation(command, options.cwd);
  if (!invocation.ok) {
    return { code: null, output: invocation.output, timedOut: false, seconds: 0 };
  }
  const backend = options.backend ?? hostExecutionBackend;
  return await backend.run(invocation.command, {
    cwd: invocation.cwd,
    root: options.cwd,
    timeoutSeconds,
    maxOutputChars: CAPTURE_CHARS,
    signal: options.signal,
  });
}

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
    const failures = report.ran.filter(verificationRunFailed);
    const directive = recoveryDirective(classifyVerificationReport(report));
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
      ...(directive === null ? [] : ["", directive]),
    ].join("\n");
  }

  const failures = report.ran.filter(verificationRunFailed);
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
  const classified = classifyVerificationReport(report);
  const directive = recoveryDirective(classified);
  const classes = [...new Set(classified.map((failure) => failure.class))];
  const lines: string[] = [
    `Verification failed: ${failures.length} of ${report.ran.length} command(s) did not pass.`,
    `Failure class${classes.length === 1 ? "" : "es"}: ${classes.join(", ")}.`,
  ];
  for (const run of detailed) {
    // An adapter failure is named as a pattern match on a clean exit, so the
    // model repairs the failing test instead of hunting for a crash.
    const status = run.timedOut
      ? `timed out after ${run.seconds.toFixed(1)}s`
      : (run.adapterFailure ?? null) !== null
        ? `exited 0, but the configured failure pattern matched: ${clipLine(run.adapterFailure ?? "", ADAPTER_STATUS_CHARS)}`
        : `exited ${run.code === null ? "abnormally" : String(run.code)} after ${run.seconds.toFixed(1)}s`;
    const body = clip(evidenceBody(run) ?? run.output.trimEnd(), budget);
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
  const survivors = report.ran.filter((run) => !verificationRunFailed(run));
  if (survivors.length > 0) {
    lines.push("", `Still passing: ${survivors.map((run) => quote(run.command)).join(", ")}.`);
  }
  if (directive !== null) lines.push("", directive);
  return lines.join("\n");
}

/**
 * The adapter's evidence lines, or `null` to fall back to the head/tail clip.
 * Applied at format time to the retained output, and still subject to the
 * caller's per-command budget: evidence reshapes the body, never enlarges it.
 */
function evidenceBody(run: VerificationRun): string | null {
  if (run.evidencePattern === undefined) return null;
  const pattern = new RegExp(run.evidencePattern);
  const lines = run.output.split("\n").filter((line) => pattern.test(line));
  return lines.length === 0 ? null : lines.join("\n");
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
    const node = nodeVerificationCommand(root);
    if (node !== null) return [node];
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
 * or set `"type": "module"`. A declared root `check` script is preferred because
 * real projects commonly aggregate type checking, linting, and tests there;
 * otherwise a root `test` script remains the conservative fallback.
 */
function nodeVerificationCommand(root: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    // Missing, unreadable, or malformed all mean the same thing here.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const scripts = record["scripts"];
  if (typeof scripts !== "object" || scripts === null) return null;
  const scriptRecord = scripts as Record<string, unknown>;
  const script =
    typeof scriptRecord["check"] === "string"
      ? "check"
      : typeof scriptRecord["test"] === "string"
        ? "test"
        : null;
  if (script === null) return null;

  const manager = packageManager(root, record["packageManager"]);
  if (manager === "pnpm" || manager === "yarn") return [manager, script];
  if (manager === "bun") return ["bun", "run", script];
  return script === "test" ? ["npm", "test"] : ["npm", "run", script];
}

function packageManager(root: string, declared: unknown): "npm" | "pnpm" | "yarn" | "bun" {
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
  }
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  if (exists(root, "bun.lock") || exists(root, "bun.lockb")) return "bun";
  return "npm";
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
 * Truncation for text that must stay on one line. `clip()` keeps head and tail
 * around a multi-line marker, which would break a status line in two; here the
 * tail is expendable and the omission count says what was dropped. As in
 * `clip`, the marker comes out of the limit, not on top of it.
 */
function clipLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = (count: number) => ` … ${count} characters omitted`;
  const reserve = marker(text.length).length;
  const head = Math.max(0, limit - reserve);
  return `${text.slice(0, head)}${marker(text.length - head)}`;
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
