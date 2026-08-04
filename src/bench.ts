/**
 * The benchmark runner.
 *
 * The single most important rule here: **forge does not mark its own
 * homework.** Its verification gate decides when the agent may stop; the
 * *bench* decides whether the task was done, by running its own checks after
 * the agent has exited, against the files on disk. Those two must never be the
 * same command run once and read twice, because a harness that passes itself
 * whenever it believes it is finished measures its confidence, not its work.
 *
 * Each task runs in a throwaway copy of its starting state. Not the original:
 * a suite that mutates itself scores differently the second time, and the
 * second time is when you are comparing.
 *
 * What is deliberately *not* here: a pass rate averaged over the suite and
 * quoted as a headline. With a handful of tasks the difference between 4/6 and
 * 5/6 is one task, and one task is noise. The runner reports per-task outcomes
 * and the aggregate, and the aggregate is a description of these tasks rather
 * than an estimate of anything wider.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execBounded } from "./exec.js";

export interface BenchTask {
  readonly name: string;
  /** What the agent is asked to do. */
  readonly prompt: string;
  /**
   * How the BENCH decides the task was done. Run after the agent exits,
   * against the files it left behind. Independent of anything forge ran.
   */
  readonly verify: readonly (readonly string[])[];
  readonly timeoutSeconds: number;
  /** Directory holding the starting state, copied fresh for each attempt. */
  readonly source: string;
  /**
   * Checks that must pass BEFORE the agent runs and still pass after.
   *
   * The only way to see damage. A pass/fail check answers "was the task done";
   * it cannot answer "was something else broken doing it", and the second
   * question is the one a user actually cares about when handing an agent a
   * repository they depend on. Run first on the untouched copy, so a guard that
   * was already failing is not blamed on the agent.
   */
  readonly guard: readonly (readonly string[])[];
}

export interface TaskOutcome {
  readonly name: string;
  /** The bench's own verdict, from its own checks. */
  readonly passed: boolean;
  /** What forge said about itself. Recorded to compare, never to decide. */
  readonly agentClaimedSuccess: boolean;
  readonly exitCode: number | null;
  readonly seconds: number;
  /** Null when a competing agent does not emit Forge's machine-readable report. */
  readonly turns: number | null;
  /** All proposed actions, edits included. Null when the agent does not report it. */
  readonly toolCalls: number | null;
  readonly timedOut: boolean;
  /** A guard that passed before the agent ran and fails now. */
  readonly damaged: boolean;
  /** The failing verification output, when it failed. */
  readonly detail: string;
}

/**
 * Several runs of one suite, and the spread between them.
 *
 * This exists because a single run misled me. forge scored 9/10 and 10/10 on
 * two runs of the same suite with the same model, and the task that differed
 * takes the same code path in both configurations -- so the entire observed
 * gap was run-to-run variance. I had already written down that a 10-task suite
 * resolves to 10 points and then read a 1-task difference as a result anyway.
 *
 * So: no comparison is reported without a spread, and no difference smaller
 * than the spread is a difference.
 */
export interface TrialSummary {
  readonly identity: BenchmarkIdentity;
  readonly runs: readonly BenchReport[];
  readonly meanPassed: number;
  readonly minPassed: number;
  readonly maxPassed: number;
  readonly total: number;
  /** Per task, how many of the runs it passed. 0 or `trials` means stable. */
  readonly perTask: ReadonlyArray<{ name: string; passes: number; trials: number }>;
  readonly falseSuccesses: number;
  readonly damaged: number;
  readonly seconds: number;
  /** Null rather than a fabricated zero if any run did not report the metric. */
  readonly turns: number | null;
  readonly toolCalls: number | null;
}

export interface BenchReport {
  readonly identity: BenchmarkIdentity;
  readonly outcomes: readonly TaskOutcome[];
  readonly passed: number;
  readonly total: number;
  /**
   * Tasks forge said it had finished but the bench's own checks failed.
   *
   * The number this design exists to be able to report. A harness that cannot
   * measure its own false-success rate is asking to be trusted about the one
   * thing it has no evidence for.
   */
  readonly falseSuccesses: number;
  /** Tasks that were done but which forge did not claim. Rare, and worth seeing. */
  readonly unclaimedSuccesses: number;
  /**
   * Tasks where something that worked before does not now.
   *
   * Reported separately from `passed` even though a damaged task also fails,
   * because "did not finish the job" and "broke the repository" are different
   * things to a user and only one of them is recoverable by asking again.
   */
  readonly damaged: number;
  readonly seconds: number;
  readonly turns: number | null;
  readonly toolCalls: number | null;
}

/** Everything needed to tell two benchmark results apart. */
export interface BenchmarkIdentity {
  readonly subject: string;
  readonly suiteFingerprint: string;
  readonly executableFingerprint: string | null;
  readonly command: readonly string[];
  readonly model: string | null;
  readonly modelDigest: string | null;
  readonly endpoint: string | null;
  readonly nativeProtocol: boolean;
  readonly batchActions: boolean;
}

/**
 * Load a suite directory.
 *
 * A task is a directory containing `task.json` and a `repo/` of starting
 * files. Skipping anything malformed rather than failing the suite: a broken
 * task should cost that task, not the whole run you were waiting on.
 */
export function loadSuite(root: string): BenchTask[] {
  const tasks: BenchTask[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return tasks;
  }
  for (const name of entries.sort()) {
    const directory = path.join(root, name);
    const manifest = path.join(directory, "task.json");
    if (!existsSync(manifest) || !statSync(directory).isDirectory()) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        prompt?: unknown;
        verify?: unknown;
        guard?: unknown;
        timeoutSeconds?: unknown;
      };
      if (typeof parsed.prompt !== "string" || !Array.isArray(parsed.verify)) continue;
      tasks.push({
        name,
        prompt: parsed.prompt,
        verify: parsed.verify as string[][],
        guard: Array.isArray(parsed.guard) ? (parsed.guard as string[][]) : [],
        timeoutSeconds: typeof parsed.timeoutSeconds === "number" ? parsed.timeoutSeconds : 300,
        source: path.join(directory, "repo"),
      });
    } catch {
      // A malformed task.json costs that task.
    }
  }
  return tasks;
}

export interface RunOptions {
  /** The forge binary to exercise. Injected so a bench can compare builds. */
  readonly binary: string;
  /**
   * An arbitrary agent to run instead of forge, as a token array in which the
   * literal token `{task}` is replaced by the prompt.
   *
   * The point of the bench is that the verdict comes from the task's own
   * checks, and those do not care what wrote the files. So a competing agent
   * can be measured on exactly the same tasks, in the same throwaway copies,
   * judged the same way — which is the only kind of comparison worth
   * publishing. Substituting a token rather than appending keeps the prompt in
   * whatever position that agent's CLI wants it.
   */
  readonly agentCommand?: readonly string[] | undefined;
  readonly url?: string | undefined;
  readonly model?: string | undefined;
  /** Extra flags, e.g. `["--no-verify"]` to measure what the gate contributes. */
  readonly flags?: readonly string[];
  readonly onProgress?: ((line: string) => void) | undefined;
  /**
   * Where to keep the evidence from tasks that failed.
   *
   * Without this a bench failure is undiagnosable: the throwaway copy is
   * deleted on the way out, taking the traces, the session journal and the
   * files the agent actually left behind with it. What survives is "FAIL", and
   * "FAIL" is the one thing about a failure that needs no explanation.
   *
   * Only failures are kept. Keeping every run would bury the interesting ones,
   * and a passing task's trace is a curiosity rather than a lead.
   */
  readonly keepFailures?: string | undefined;
  readonly identity?: BenchmarkIdentity | undefined;
}

const EMPTY_IDENTITY: BenchmarkIdentity = {
  subject: "unknown",
  suiteFingerprint: "unknown",
  executableFingerprint: null,
  command: [],
  model: null,
  modelDigest: null,
  endpoint: null,
  nativeProtocol: false,
  batchActions: false,
};

/** Stable content fingerprint for the task contract and every starting file. */
export function fingerprintSuite(tasks: readonly BenchTask[]): string {
  const hash = createHash("sha256");
  for (const task of [...tasks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(
      `${JSON.stringify({
        name: task.name,
        prompt: task.prompt,
        verify: task.verify,
        guard: task.guard,
        timeoutSeconds: task.timeoutSeconds,
      })}\n`,
    );
    for (const file of filesBelow(task.source)) {
      hash.update(`${task.name}/${path.relative(task.source, file)}\0`);
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/** Content fingerprint of the exact executable under test. */
export function fingerprintExecutable(file: string): string | null {
  try {
    const hash = createHash("sha256");
    hash.update(readFileSync(file));
    const parent = path.dirname(file);
    const dist =
      path.basename(parent) === "dist"
        ? parent
        : path.basename(parent) === "bin"
          ? path.resolve(parent, "../dist")
          : null;
    if (dist !== null && existsSync(dist) && statSync(dist).isDirectory()) {
      for (const compiled of filesBelow(dist)) {
        hash.update(`${path.relative(dist, compiled)}\0`);
        hash.update(readFileSync(compiled));
        hash.update("\0");
      }
    }
    return hash.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git" || name === ".forge" || name === "node_modules") continue;
      const candidate = path.join(directory, name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(candidate);
      else if (stat.isFile()) files.push(candidate);
    }
  };
  walk(root);
  return files;
}

/**
 * Run one task in a fresh copy of its starting state.
 *
 * The agent's own exit code and turn count are recorded but never consulted for
 * the verdict. `passed` comes only from `task.verify`.
 */
export async function runTask(task: BenchTask, options: RunOptions): Promise<TaskOutcome> {
  const directory = await mkdtemp(path.join(tmpdir(), `bench-${task.name}-`));
  const started = Date.now();
  try {
    cpSync(task.source, directory, { recursive: true });

    // Which guards hold on the untouched copy. A guard already failing here is
    // the task's own problem and must not be charged to the agent.
    const guardedBefore: number[] = [];
    for (const [index, command] of task.guard.entries()) {
      const check = await execBounded(command, { cwd: directory, timeoutSeconds: 120 });
      if (check.code === 0) guardedBefore.push(index);
    }

    const command =
      options.agentCommand === undefined
        ? ["node", options.binary, "run", task.prompt, "--yes", "--json", ...(options.flags ?? [])]
        : options.agentCommand.map((token) => (token === "{task}" ? task.prompt : token));
    const agent = await execBounded(command, {
      cwd: directory,
      timeoutSeconds: task.timeoutSeconds,
      maxOutputChars: 200_000,
      // Endpoint selection travels as environment rather than as flags, so a
      // task prompt can never be parsed as a flag value however it is worded.
      extraEnv: {
        ...(options.url ? { FORGE_URL: options.url } : {}),
        ...(options.model ? { FORGE_MODEL: options.model } : {}),
        // A competing agent needs its own configuration to reach the same
        // endpoint. Passed through explicitly rather than by inheriting the
        // whole environment, which would hand it the provider keys the
        // allowlist exists to withhold.
        ...(process.env["BENCH_AGENT_ENV"]
          ? Object.fromEntries(
              process.env["BENCH_AGENT_ENV"]
                .split(",")
                .map((pair) => pair.split("="))
                .filter((parts): parts is [string, string] => parts.length === 2),
            )
          : {}),
      },
    });

    let turns: number | null = null;
    let toolCalls: number | null = null;
    let claimed = false;
    try {
      // `--json` prints one document last; anything before it is progress.
      const brace = agent.output.lastIndexOf("\n{");
      const document = JSON.parse(agent.output.slice(brace >= 0 ? brace + 1 : 0)) as {
        ok?: boolean;
        state?: { turn?: number };
        usage?: { turns?: number; actions?: number };
      };
      claimed = document.ok === true;
      turns = document.usage?.turns ?? document.state?.turn ?? null;
      toolCalls = document.usage?.actions ?? null;
    } catch {
      // No parsable report. `claimed` stays false, which is the safe reading:
      // a run that could not say it succeeded is not counted as having.
    }

    // The bench's own verdict. Run here, after the agent is gone, against
    // whatever it actually left on disk.
    let passed = true;
    let detail = "";
    for (const command of task.verify) {
      const check = await execBounded(command, {
        cwd: directory,
        timeoutSeconds: 120,
        maxOutputChars: 8_000,
      });
      if (check.code !== 0) {
        passed = false;
        detail = `$ ${command.join(" ")}\n${check.output}`;
        break;
      }
    }

    // Damage: anything that worked before and does not now.
    let damaged = false;
    for (const index of guardedBefore) {
      const command = task.guard[index];
      if (command === undefined) continue;
      const check = await execBounded(command, { cwd: directory, timeoutSeconds: 120 });
      if (check.code !== 0) {
        damaged = true;
        if (!detail) detail = `guard broken: $ ${command.join(" ")}\n${check.output}`;
        break;
      }
    }

    if (options.keepFailures && (!passed || damaged)) {
      try {
        const kept = path.join(options.keepFailures, task.name);
        mkdirSync(kept, { recursive: true });
        cpSync(directory, kept, { recursive: true });
        writeFileSync(
          path.join(kept, "BENCH.txt"),
          [
            `task: ${task.name}`,
            `prompt: ${task.prompt}`,
            `passed: ${passed}`,
            `damaged: ${damaged}`,
            `agent claimed success: ${claimed}`,
            `exit: ${agent.code}`,
            "",
            "--- why it failed ---",
            detail,
            "",
            "--- what the agent printed ---",
            agent.output,
          ].join("\n"),
          "utf8",
        );
      } catch {
        // Evidence collection must never be the thing that fails a bench run.
      }
    }

    return {
      name: task.name,
      passed: passed && !damaged,
      damaged,
      agentClaimedSuccess: claimed,
      exitCode: agent.code,
      seconds: (Date.now() - started) / 1000,
      turns,
      toolCalls,
      timedOut: agent.timedOut,
      detail,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Run a whole suite, one task at a time.
 *
 * Sequential on purpose. A local endpoint serves one request at a time however
 * many are sent, so concurrency would not shorten the wall clock; it would only
 * make every task's timing depend on what else happened to be in flight, which
 * is the one measurement a bench must not corrupt.
 */
export async function runSuite(
  tasks: readonly BenchTask[],
  options: RunOptions,
): Promise<BenchReport> {
  const outcomes: TaskOutcome[] = [];
  const started = Date.now();
  for (const task of tasks) {
    options.onProgress?.(`  ⋮ ${task.name}`);
    const outcome = await runTask(task, options);
    options.onProgress?.(
      `  ${outcome.passed ? "✓" : "✗"} ${task.name}  ${outcome.seconds.toFixed(1)}s${
        outcome.agentClaimedSuccess && !outcome.passed ? "  (claimed success)" : ""
      }`,
    );
    outcomes.push(outcome);
  }
  return {
    identity: options.identity ?? EMPTY_IDENTITY,
    outcomes,
    passed: outcomes.filter((outcome) => outcome.passed).length,
    total: outcomes.length,
    falseSuccesses: outcomes.filter((o) => o.agentClaimedSuccess && !o.passed).length,
    damaged: outcomes.filter((o) => o.damaged).length,
    unclaimedSuccesses: outcomes.filter((o) => !o.agentClaimedSuccess && o.passed).length,
    seconds: (Date.now() - started) / 1000,
    turns: sumKnown(outcomes.map((outcome) => outcome.turns)),
    toolCalls: sumKnown(outcomes.map((outcome) => outcome.toolCalls)),
  };
}

/** Run the whole suite `trials` times and report the spread. */
export async function runTrials(
  tasks: readonly BenchTask[],
  options: RunOptions,
  trials: number,
): Promise<TrialSummary> {
  const runs: BenchReport[] = [];
  const started = Date.now();
  for (let trial = 0; trial < trials; trial += 1) {
    options.onProgress?.(`  — trial ${trial + 1} of ${trials}`);
    runs.push(
      await runSuite(tasks, {
        ...options,
        ...(options.keepFailures === undefined
          ? {}
          : { keepFailures: path.join(options.keepFailures, `trial-${trial + 1}`) }),
      }),
    );
  }
  const scores = runs.map((run) => run.passed);
  const perTask = tasks.map((task, index) => ({
    name: task.name,
    passes: runs.filter((run) => run.outcomes[index]?.passed === true).length,
    trials,
  }));
  return {
    identity: options.identity ?? EMPTY_IDENTITY,
    runs,
    meanPassed: scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length),
    minPassed: Math.min(...scores),
    maxPassed: Math.max(...scores),
    total: tasks.length,
    perTask,
    falseSuccesses: runs.reduce((sum, run) => sum + run.falseSuccesses, 0),
    damaged: runs.reduce((sum, run) => sum + run.damaged, 0),
    seconds: (Date.now() - started) / 1000,
    turns: sumKnown(runs.map((run) => run.turns)),
    toolCalls: sumKnown(runs.map((run) => run.toolCalls)),
  };
}

function sumKnown(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/**
 * The trial summary as lines.
 *
 * Leads with the spread, not the mean, because the mean is the number someone
 * will quote and the spread is the number that says whether they may.
 */
export function formatTrials(summary: TrialSummary): string {
  const spread = summary.maxPassed - summary.minPassed;
  const lines = [
    "",
    `${summary.meanPassed.toFixed(1)}/${summary.total} mean over ${summary.runs.length} runs · range ${summary.minPassed}-${summary.maxPassed} · ${summary.falseSuccesses} false successes · ${summary.damaged} damaged · ${summary.seconds.toFixed(0)}s`,
    spread === 0
      ? "  the suite was stable across runs"
      : `  run-to-run spread is ${spread} task(s) — a smaller difference than that is not a difference`,
    "",
  ];
  // Unstable tasks first: a task that passes sometimes is where the variance
  // lives, and it is the one worth reading about.
  const unstable = summary.perTask.filter((t) => t.passes > 0 && t.passes < t.trials);
  const failing = summary.perTask.filter((t) => t.passes === 0);
  for (const task of unstable) {
    lines.push(`  ~ ${task.name.padEnd(20)} ${task.passes}/${task.trials} — flaky`);
  }
  for (const task of failing) {
    lines.push(`  ✗ ${task.name.padEnd(20)} 0/${task.trials}`);
  }
  if (unstable.length === 0 && failing.length === 0) {
    lines.push("  every task passed in every run");
  }
  return lines.join("\n");
}

/** The report as lines. Pure, so it is assertable without a terminal. */
export function formatBench(report: BenchReport): string {
  if (report.total === 0) {
    return "No tasks found. A task is a directory with task.json and repo/.";
  }
  const lines = [
    "",
    `${report.passed} of ${report.total} tasks passed the bench's own checks · ${report.seconds.toFixed(1)}s`,
  ];
  if (report.damaged > 0) {
    lines.push(`${report.damaged} task(s) broke something that worked before`);
  }
  if (report.falseSuccesses > 0) {
    lines.push(
      `${report.falseSuccesses} task(s) the agent reported as done and the checks disagreed`,
    );
  }
  if (report.unclaimedSuccesses > 0) {
    lines.push(`${report.unclaimedSuccesses} task(s) passed without the agent claiming them`);
  }
  for (const outcome of report.outcomes) {
    if (!outcome.passed && outcome.detail) {
      lines.push("", `${outcome.name}:`, outcome.detail.split("\n").slice(0, 8).join("\n"));
    }
  }
  return lines.join("\n");
}
