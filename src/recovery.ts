import type { VerificationReport, VerificationRun } from "./verify.js";

export type FailureClass =
  | "syntax"
  | "type"
  | "test"
  | "timeout"
  | "toolchain"
  | "infrastructure"
  | "flaky"
  | "unknown";

export interface ClassifiedFailure {
  readonly class: FailureClass;
  readonly command: readonly string[];
  readonly reason: string;
}

const SYNTAX_PATTERNS = [
  /syntaxerror/i,
  /parse error/i,
  /unexpected token/i,
  /unterminated (?:string|template|comment)/i,
  /expected ["'`)}\]]/i,
];

const TYPE_PATTERNS = [
  /type error/i,
  /typeerror:.*is not assignable/i,
  /error TS\d+:/,
  /cannot find name/i,
  /does not exist on type/i,
  /mismatched types/i,
  /trait bound .* is not satisfied/i,
];

const TEST_PATTERNS = [
  /assertionerror/i,
  /expected .* (?:to|but)/i,
  /\bFAIL(?:ED)?\b/,
  /test result: FAILED/i,
  /tests? failed/i,
  /failures?:/i,
];

const TOOLCHAIN_PATTERNS = [
  /command not found/i,
  /not recognized as an internal or external command/i,
  /enoent/i,
  /no such file or directory.*(?:node|npm|pnpm|yarn|bun|python|pytest|cargo|go|java|gradle)/i,
  /could not determine executable/i,
  /module .* not found/i,
  /cannot find module/i,
  // Python's spelling, which the patterns above do not cover.
  /no module named/i,
];

/**
 * A missing module that is the repository's own.
 *
 * "Cannot find module" is the single most common intermediate state in a
 * JavaScript or Python repair: a test imports the file the model has not
 * written yet. Observed live -- a test importing `../src/money.js` was
 * classified `toolchain`, which is budgeted for one retry because a missing
 * *executable* is not something the model can fix by editing code. The run
 * stopped while the actual repair was one CREATE away.
 *
 * The discriminator is the specifier. A relative or absolute path is a file in
 * this repository and therefore code the model owns; a bare specifier
 * (`express`, `pytest`) is an uninstalled dependency and genuinely environment
 * work, which is what the toolchain class is for.
 */
const REPOSITORY_MODULE_PATTERNS = [
  /(?:cannot find module|module not found:?)[\s'"]*(?:[.]{1,2}\/|\/)/i,
  /cannot find module\s+['"][^'"]*\/[^'"]*['"]/i,
  /no module named\s+['"][.]/i,
];

const INFRASTRUCTURE_PATTERNS = [
  /connection (?:refused|reset|timed out)/i,
  /network is unreachable/i,
  /temporary failure in name resolution/i,
  /service unavailable/i,
  /rate limit/i,
  /out of memory/i,
  /no space left on device/i,
  /docker daemon/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyVerificationRun(run: VerificationRun): ClassifiedFailure {
  const output = run.output.trim();
  if (run.timedOut) {
    return {
      class: "timeout",
      command: run.command,
      reason: "verification exceeded its time bound",
    };
  }
  if (matchesAny(output, INFRASTRUCTURE_PATTERNS)) {
    return {
      class: "infrastructure",
      command: run.command,
      reason: "external infrastructure failed",
    };
  }
  if (matchesAny(output, TOOLCHAIN_PATTERNS) && !matchesAny(output, REPOSITORY_MODULE_PATTERNS)) {
    return {
      class: "toolchain",
      command: run.command,
      reason: "required executable or dependency is unavailable",
    };
  }
  if (matchesAny(output, REPOSITORY_MODULE_PATTERNS)) {
    return {
      class: "test",
      command: run.command,
      reason: "a module in this repository could not be resolved",
    };
  }
  if (matchesAny(output, SYNTAX_PATTERNS)) {
    return { class: "syntax", command: run.command, reason: "source could not be parsed" };
  }
  if (matchesAny(output, TYPE_PATTERNS)) {
    return { class: "type", command: run.command, reason: "static type checking failed" };
  }
  if (matchesAny(output, TEST_PATTERNS)) {
    return {
      class: "test",
      command: run.command,
      reason: "an executable assertion or test failed",
    };
  }
  return {
    class: "unknown",
    command: run.command,
    reason: "failure did not match a supported classifier",
  };
}

export function classifyVerificationReport(
  report: VerificationReport,
): readonly ClassifiedFailure[] {
  if (report.flaky) {
    return report.ran
      .filter((run) => run.code !== 0)
      .map((run) => ({
        class: "flaky" as const,
        command: run.command,
        reason: "a previously passing command failed on confirmation",
      }));
  }
  return report.ran.filter((run) => run.code !== 0).map(classifyVerificationRun);
}

export function recoveryDirective(failures: readonly ClassifiedFailure[]): string | null {
  const primary = failures[0];
  if (primary === undefined) return null;
  switch (primary.class) {
    case "syntax":
      return "Recovery: inspect the first parser error and the immediately surrounding source. Make one minimal syntax correction, then rerun the same narrow command before any broader edit.";
    case "type":
      return "Recovery: follow the first type error to its declaration and use sites. Make one type-consistent correction, preserving public APIs unless the task explicitly requires changing them, then rerun the same command.";
    case "test":
      return "Recovery: isolate the first failing assertion, read the implementation and test together, state the behavioral mismatch, make one targeted correction, and rerun only that failing test first.";
    case "timeout":
      return "Recovery: do not repeat the same timed-out command unchanged. Run a narrower deterministic test or compile target once; if no narrower command exists, report the timeout as a blocker rather than editing code speculatively.";
    case "toolchain":
      return "Recovery: treat this as environment setup, not a code defect. Verify the required executable or dependency exists and use the repository's documented setup path. Do not modify implementation code to hide a missing toolchain.";
    case "infrastructure":
      return "Recovery: stop code edits. Retry the same external operation at most once after checking the reported service, network, disk, or memory condition; if it still fails, report an infrastructure blocker.";
    case "flaky":
      return "Recovery: reproduce the nondeterminism with the same command, then inspect shared state, ordering, time, randomness, and parallel file access. Do not weaken assertions or increase retries.";
    case "unknown":
      return "Recovery: read the first complete failure block, identify whether it is code, environment, or infrastructure, and perform one evidence-gathering action before attempting another edit.";
  }
}
