import { classifyVerificationReport, type FailureClass } from "./recovery.js";
import type { VerificationReport } from "./verify.js";

/**
 * Bounded retry accounting for the completion gate.
 *
 * `recovery.ts` names what went wrong and hands the model one directive; this
 * module decides how many times that is worth doing. It is pure bookkeeping
 * over reports the gate already produced: it runs nothing, reads nothing, and
 * asks no model anything. Exhausting a budget can only ever stop a run -- it
 * never converts an unverified change into an accepted one.
 */

export interface RetryDecision {
  readonly action: "retry" | "stop";
  readonly class: FailureClass;
  /** How many failures of this class have been recorded, including this one. */
  readonly attempts: number;
  /** Retries still available for this class after this decision. */
  readonly remaining: number;
  /** True when this failure is indistinguishable from the two before it. */
  readonly noProgress: boolean;
  readonly reason: string;
}

/**
 * Retries allowed per class, in the same spirit as each class's directive.
 *
 * Classes the model can repair from its own workspace get room to iterate.
 * Classes whose cause is outside the repository get one retry at most: further
 * attempts spend turns re-reading a condition the model cannot change, which is
 * exactly the loop `recoveryDirective` tells it not to enter.
 */
const BUDGETS: Readonly<Record<FailureClass, number>> = {
  syntax: 4,
  type: 4,
  test: 4,
  flaky: 2,
  timeout: 1,
  toolchain: 1,
  infrastructure: 1,
  unknown: 2,
};

/**
 * Identical failures that end a run. Two is one wasted attempt too many to be
 * an accident and few enough that a model taking a genuine second pass at the
 * same error is not cut off: the first repeat is tolerated, the second is not.
 */
const NO_PROGRESS_REPEATS = 3;

/** Enough of each failure to tell repair from repetition, bounded so a long suite log cannot dominate. */
const SIGNATURE_CHARS = 400;

export function retryBudgetFor(failure: FailureClass): number {
  return BUDGETS[failure];
}

/**
 * Whitespace is normalized and nothing else. Digits and paths are load-bearing
 * -- "3 tests failed" becoming "1 test failed" is the progress this is looking
 * for, and masking numbers would read it as a run going nowhere.
 *
 * The bound applies to each run's output, not to the joined result. Clipping
 * the joined string let one long command -- an inline `node -e` script, say --
 * fill the budget by itself, so every failure looked identical and every run
 * stopped for making no progress. The command is kept whole and the output is
 * what gets clipped, because the output is the part a repair changes.
 */
function signature(report: VerificationReport): string {
  return report.ran
    .filter((run) => run.code !== 0)
    .map((run) => {
      const output = run.output.replace(/\s+/g, " ").trim().slice(0, SIGNATURE_CHARS);
      return `${run.command.join(" ")} :: ${output}`;
    })
    .join(" | ");
}

export class RetryBudget {
  private readonly attempts = new Map<FailureClass, number>();
  private lastSignature: string | null = null;
  private repeats = 0;

  /**
   * Record one failed gate and decide whether the failure is worth handing back.
   *
   * @throws if given a passing report -- a budget that could be spent on success
   * would be a path from "verified" to "stopped", and there must not be one.
   */
  record(report: VerificationReport): RetryDecision {
    if (report.passed) {
      throw new Error("RetryBudget.record received a passing verification report");
    }
    const classified = classifyVerificationReport(report);
    const failure: FailureClass = classified[0]?.class ?? "unknown";
    const attempts = (this.attempts.get(failure) ?? 0) + 1;
    this.attempts.set(failure, attempts);

    const current = signature(report);
    this.repeats = current !== "" && current === this.lastSignature ? this.repeats + 1 : 1;
    this.lastSignature = current;
    const noProgress = this.repeats >= NO_PROGRESS_REPEATS;

    const budget = BUDGETS[failure];
    const remaining = Math.max(0, budget - attempts);
    if (noProgress) {
      return {
        action: "stop",
        class: failure,
        attempts,
        remaining,
        noProgress,
        reason: `verification failed ${this.repeats} times with unchanged ${failure} output; the last attempts changed nothing observable`,
      };
    }
    if (attempts > budget) {
      return {
        action: "stop",
        class: failure,
        attempts,
        remaining: 0,
        noProgress,
        reason: `spent all ${budget} retries allowed for ${failure} failures`,
      };
    }
    return {
      action: "retry",
      class: failure,
      attempts,
      remaining,
      noProgress,
      reason: `${remaining} of ${budget} ${failure} retries remain`,
    };
  }
}

/** The run-ending message. Says why it stopped and that the change is unverified. */
export function stopNotice(decision: RetryDecision): string {
  return [
    `Stopping: ${decision.reason}.`,
    "The change is not verified and must not be reported as complete.",
  ].join("\n");
}
