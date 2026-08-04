import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  comparePolyglotReports,
  comparePolyglotWithLittleCoder,
  exactMcNemar,
  formatPolyglotComparison,
} from "../src/compare.js";
import type { PolyglotCaseResult, PolyglotReport } from "../src/polyglot.js";

function result(id: string, passed: boolean): PolyglotCaseResult {
  const [language = "python", exercise = id] = id.split("/");
  return {
    id,
    language: language as PolyglotCaseResult["language"],
    exercise,
    passed,
    passedFirstAttempt: passed,
    attemptOutcomes: [passed],
    infrastructureError: false,
    timedOut: false,
    falseSuccessAttempts: 0,
    failureClass: passed ? null : "test_failure",
    attempts: [],
    verification: "",
    seconds: 1,
    worktreeRetained: !passed,
  };
}

function report(fingerprint: string, outcomes: readonly boolean[]): PolyglotReport {
  const results = outcomes.map((passed, index) => result(`python/case-${index}`, passed));
  return {
    identity: {
      benchmark: "aider-polyglot",
      version: 1,
      profile: "standard",
      datasetCommit: "abc123",
      executableFingerprint: fingerprint,
      model: "model",
      modelDigest: "digest",
      endpoint: "local",
      temperature: 0,
      contextWindow: 32_768,
      maxTokens: 4_096,
      nativeProtocol: false,
      taskPacket: false,
      batchActions: false,
      caseConcurrency: 1,
      tries: 2,
      firstTurns: 12,
      retryTurns: 8,
      attemptTimeoutSeconds: 900,
      verifierTimeouts: {
        python: 60,
        go: 60,
        rust: 180,
        javascript: 90,
        cpp: 240,
        java: 300,
      },
      selection: { languages: [], cases: [], smoke: false, limit: 0, perLanguage: 7 },
    },
    identityFingerprint: fingerprint,
    officialCaseCount: 225,
    selectedCaseCount: results.length,
    completedCaseCount: results.length,
    passedCaseCount: results.filter((item) => item.passed).length,
    firstAttemptPassCount: 0,
    passRate1: 0,
    passRateFinal: 0,
    scoreSelected: 0,
    incomplete: false,
    infrastructureErrorCount: 0,
    timeoutCount: 0,
    falseSuccessAttemptCount: fingerprint === "candidate" ? 1 : 2,
    totalTurns: fingerprint === "candidate" ? 8 : 10,
    totalActions: 20,
    totalSeconds: fingerprint === "candidate" ? 8 : 10,
    failureClasses: {},
    perLanguage: {},
    results,
  };
}

describe("paired Polyglot comparison", () => {
  test("counts per-case gains and regressions and measures paired significance", () => {
    const comparison = comparePolyglotReports(
      report("baseline", [false, false, false, true, true]),
      report("candidate", [true, true, true, false, true]),
    );

    expect(comparison).toMatchObject({
      gains: 3,
      regressions: 1,
      passDelta: 2,
      turnsDelta: -2,
      secondsDelta: -2,
      falseSuccessAttemptDelta: -1,
    });
    expect(comparison.exactMcNemarP).toBe(0.625);
    expect(formatPolyglotComparison(comparison)).toContain("3 gained · 1 regressed");
  });

  test("rejects selections or case sets that cannot be paired", () => {
    const baseline = report("baseline", [false, true]);
    const candidate = report("candidate", [true, true]);
    const differentSelection = {
      ...candidate,
      identity: {
        ...candidate.identity,
        selection: { ...candidate.identity.selection, perLanguage: 8 },
      },
    };
    expect(() => comparePolyglotReports(baseline, differentSelection)).toThrow("selections differ");

    const differentCases = report("candidate", [true]);
    expect(() => comparePolyglotReports(baseline, differentCases)).toThrow("case IDs differ");
  });

  test("returns one when no discordant pairs exist", () => {
    expect(exactMcNemar(0, 0)).toBe(1);
  });

  test("normalizes a Little Coder report and names discordant cases", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "forge-cross-agent-"));
    try {
      const manifest = path.join(dir, "cases.txt");
      const littleCoder = path.join(dir, "little-coder.json");
      writeFileSync(manifest, "python/case-0\npython/case-1\n");
      writeFileSync(
        littleCoder,
        JSON.stringify({
          languages: {
            python: {
              details: [
                { name: "case-0", status: "fail", time: 3, turns: 4 },
                { name: "case-1", status: "pass_2", time: 5, turns: 6 },
              ],
            },
          },
        }),
      );

      const comparison = comparePolyglotWithLittleCoder(
        report("forge", [true, false]),
        littleCoder,
        manifest,
      );
      expect(comparison).toMatchObject({
        littleCoderPassed: 1,
        forgePassed: 1,
        forgeOnly: ["python/case-0"],
        littleCoderOnly: ["python/case-1"],
        littleCoderSeconds: 8,
        littleCoderTurns: 10,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects incomplete cross-agent case sets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "forge-cross-agent-"));
    try {
      const manifest = path.join(dir, "cases.txt");
      const littleCoder = path.join(dir, "little-coder.json");
      writeFileSync(manifest, "python/case-0\npython/case-1\n");
      writeFileSync(
        littleCoder,
        JSON.stringify({
          languages: { python: { details: [{ name: "case-0", status: "pass_1" }] } },
        }),
      );
      expect(() =>
        comparePolyglotWithLittleCoder(report("forge", [true, false]), littleCoder, manifest),
      ).toThrow("cases differ from manifest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
