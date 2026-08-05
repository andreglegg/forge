import { describe, expect, test } from "vitest";
import {
  classifyVerificationReport,
  classifyVerificationRun,
  recoveryDirective,
} from "../src/recovery.js";
import { formatForModel, type VerificationReport, type VerificationRun } from "../src/verify.js";

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: ["npm", "test"],
    code: 1,
    output: "",
    seconds: 0.2,
    timedOut: false,
    ...overrides,
  };
}

function report(runs: readonly VerificationRun[], flaky = false): VerificationReport {
  return { ran: runs, passed: false, configured: true, flaky };
}

describe("verification failure classification", () => {
  test.each([
    ["syntax", run({ output: "SyntaxError: Unexpected token }" })],
    ["type", run({ output: "src/a.ts(1,2): error TS2322: Type string is not assignable" })],
    ["test", run({ output: "AssertionError: expected 2 to equal 3\n1 test failed" })],
    ["timeout", run({ timedOut: true, code: null, seconds: 120 })],
    ["toolchain", run({ code: null, output: "spawn cargo ENOENT" })],
    ["infrastructure", run({ code: null, output: "connection refused by model service" })],
    ["unknown", run({ output: "process exited for an undocumented reason" })],
  ] as const)("classifies %s failures", (expected, candidate) => {
    expect(classifyVerificationRun(candidate).class).toBe(expected);
  });

  test("classifies confirmation disagreement as flaky regardless of output", () => {
    const failures = classifyVerificationReport(
      report([run({ code: 0 }), run({ output: "AssertionError" })], true),
    );
    expect(failures.map((failure) => failure.class)).toEqual(["flaky"]);
  });

  test("formats one bounded class-specific recovery directive", () => {
    const output = formatForModel(report([run({ output: "AssertionError: expected true" })]));
    expect(output).toContain("Failure class: test.");
    expect(output).toContain("Recovery: isolate the first failing assertion");
    expect(output.match(/Recovery:/g)).toHaveLength(1);
  });

  test("infrastructure recovery stops speculative code edits", () => {
    const directive = recoveryDirective([
      classifyVerificationRun(run({ code: null, output: "no space left on device" })),
    ]);
    expect(directive).toContain("stop code edits");
    expect(directive).toContain("at most once");
  });
});
