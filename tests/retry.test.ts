import { describe, expect, test } from "vitest";
import { RetryBudget, retryBudgetFor, stopNotice } from "../src/retry.js";
import type { VerificationReport, VerificationRun } from "../src/verify.js";

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

function failing(output: string): VerificationReport {
  return report([run({ output })]);
}

describe("retry budgets", () => {
  test("spends a repairable class budget and then stops", () => {
    const budget = new RetryBudget();
    const seen: string[] = [];
    for (let attempt = 1; attempt <= retryBudgetFor("test") + 1; attempt += 1) {
      seen.push(budget.record(failing(`AssertionError: expected ${attempt} to equal 0`)).action);
    }
    expect(seen.slice(0, -1).every((action) => action === "retry")).toBe(true);
    expect(seen.at(-1)).toBe("stop");
  });

  test("reports the budget it spent when it stops", () => {
    const budget = new RetryBudget();
    let decision = budget.record(failing("SyntaxError: Unexpected token }"));
    for (let attempt = 1; attempt <= retryBudgetFor("syntax"); attempt += 1) {
      decision = budget.record(failing(`SyntaxError: Unexpected token ${attempt}`));
    }
    expect(decision.action).toBe("stop");
    expect(decision.class).toBe("syntax");
    expect(decision.attempts).toBe(retryBudgetFor("syntax") + 1);
    expect(decision.remaining).toBe(0);
    expect(decision.reason).toContain("syntax");
  });

  test("allows infrastructure exactly one retry, matching its recovery directive", () => {
    const budget = new RetryBudget();
    expect(budget.record(failing("connection refused")).action).toBe("retry");
    expect(budget.record(failing("connection reset")).action).toBe("stop");
  });

  test("keeps budgets separate per failure class", () => {
    const budget = new RetryBudget();
    expect(budget.record(failing("connection refused")).action).toBe("retry");
    const decision = budget.record(failing("AssertionError: expected 1 to equal 2"));
    expect(decision.action).toBe("retry");
    expect(decision.class).toBe("test");
    expect(decision.remaining).toBe(retryBudgetFor("test") - 1);
  });

  test("stops on an unchanged failure before the class budget runs out", () => {
    const budget = new RetryBudget();
    const identical = "AssertionError: expected 2 to equal 3";
    expect(budget.record(failing(identical)).action).toBe("retry");
    expect(budget.record(failing(identical)).action).toBe("retry");
    const decision = budget.record(failing(identical));
    expect(decision.action).toBe("stop");
    expect(decision.noProgress).toBe(true);
    expect(decision.reason).toContain("unchanged");
    expect(retryBudgetFor("test")).toBeGreaterThan(3);
  });

  test("treats a changed failure as progress and clears the no-progress streak", () => {
    const budget = new RetryBudget();
    const identical = "AssertionError: expected 2 to equal 3";
    budget.record(failing(identical));
    budget.record(failing(identical));
    expect(budget.record(failing("AssertionError: expected 4 to equal 5")).noProgress).toBe(false);
    expect(budget.record(failing(identical)).action).toBe("retry");
  });

  test("ignores whitespace when deciding whether a failure changed", () => {
    const budget = new RetryBudget();
    budget.record(failing("AssertionError:   expected 2\n\nto equal 3"));
    budget.record(failing("AssertionError: expected 2\nto equal 3"));
    expect(budget.record(failing("AssertionError: expected 2 to equal 3")).noProgress).toBe(true);
  });

  test("separates identical output produced by different commands", () => {
    const budget = new RetryBudget();
    const output = "FAILED";
    budget.record(report([run({ output })]));
    budget.record(report([run({ command: ["cargo", "test"], output })]));
    expect(budget.record(report([run({ output })])).noProgress).toBe(false);
  });

  test("a long command does not mask a changed failure", () => {
    // Regression: the signature was clipped after joining, so an inline
    // `node -e` script filled the bound by itself and every failure hashed
    // the same. Real projects verify with commands this long.
    const budget = new RetryBudget();
    const command = ["node", "-e", `/* ${"x".repeat(600)} */ run()`];
    const attempt = (n: number): VerificationReport =>
      report([run({ command, output: `AssertionError: expected ${n} to equal 0` })]);
    budget.record(attempt(1));
    budget.record(attempt(2));
    expect(budget.record(attempt(3)).noProgress).toBe(false);
  });

  test("never records a passing report", () => {
    const budget = new RetryBudget();
    expect(() => budget.record({ ran: [], passed: true, configured: true, flaky: false })).toThrow(
      /passing/,
    );
  });

  test("classifies an unconfigured gate as unknown rather than crashing", () => {
    const budget = new RetryBudget();
    const decision = budget.record({ ran: [], passed: false, configured: false, flaky: false });
    expect(decision.class).toBe("unknown");
    expect(decision.action).toBe("retry");
  });

  test("writes a fail-stop notice that names the class and forbids a success claim", () => {
    const budget = new RetryBudget();
    let decision = budget.record(failing("connection refused"));
    decision = budget.record(failing("connection reset"));
    const notice = stopNotice(decision);
    expect(notice).toContain("infrastructure");
    expect(notice).toContain("not verified");
    expect(notice.split("\n").length).toBeLessThanOrEqual(4);
  });
});
