import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  benchmarkAgentEnvironment,
  caseId,
  classifyPolyglotFailure,
  diagnosticExcerpt,
  discoverPolyglotCases,
  firstAttemptPrompt,
  isPolyglotInfrastructureFailure,
  isTestAuthoringExercise,
  POLYGLOT_LANGUAGES,
  POLYGLOT_VERIFIER_TIMEOUTS,
  type PolyglotAttempt,
  type PolyglotCase,
  type PolyglotOptions,
  preparePolyglotCase,
  resolvedPolyglotProfile,
  runPolyglot,
  selectPolyglotCases,
  verificationCommands,
} from "../src/polyglot.js";

async function withDataset<T>(body: (dataset: string, output: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "polyglot-adapter-")));
  const dataset = path.join(root, "dataset");
  const output = path.join(root, "output");
  for (const language of POLYGLOT_LANGUAGES) {
    const exercise = path.join(dataset, language, "exercises", "practice", `${language}-case`);
    mkdirSync(path.join(exercise, ".meta"), { recursive: true });
    const testName = language === "javascript" ? "case.spec.js" : "case.test";
    writeFileSync(path.join(exercise, "solution.txt"), "stub\n");
    if (language === "go") writeFileSync(path.join(exercise, "interface.go"), "package exercise\n");
    writeFileSync(
      path.join(exercise, testName),
      language === "javascript"
        ? "xit('works', () => {});\n"
        : language === "java"
          ? '@Disabled("later")\nclass CaseTest {}\n'
          : "tests\n",
    );
    writeFileSync(path.join(exercise, ".meta", "reference.txt"), "secret solution\n");
    writeFileSync(
      path.join(exercise, ".meta", "config.json"),
      JSON.stringify({
        files: {
          solution: ["solution.txt"],
          test: [testName],
          example: [".meta/reference.txt"],
        },
      }),
    );
  }
  try {
    return await body(dataset, output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function options(dataset: string, output: string): PolyglotOptions {
  return {
    dataset,
    output,
    binary: process.execPath,
    model: "qwen3.5-9b",
    modelDigest: "sha256:model",
    endpoint: "http://127.0.0.1:9999/v1",
    temperature: 0.3,
    contextWindow: 32_768,
    maxTokens: 4_096,
    nativeProtocol: false,
    languages: ["python"],
    tries: 2,
    firstTurns: 12,
    retryTurns: 8,
  };
}

function attempt(number: number, turnsBudget: number): PolyglotAttempt {
  return {
    number,
    turnsBudget,
    exitCode: 0,
    timedOut: false,
    claimedSuccess: true,
    turns: 3,
    actions: 4,
    seconds: 1,
    output: JSON.stringify({ ok: true }),
  };
}

describe("Polyglot discovery and preparation", () => {
  test("resolves a cheap discovery profile while preserving explicit overrides", () => {
    const base = options("/dataset", "/output");
    const {
      tries: _tries,
      firstTurns: _firstTurns,
      retryTurns: _retryTurns,
      ...withoutBudgets
    } = base;
    expect(resolvedPolyglotProfile({ ...withoutBudgets, discovery: true })).toMatchObject({
      profile: "discovery",
      perLanguage: 2,
      tries: 1,
      firstTurns: 8,
    });
    expect(
      resolvedPolyglotProfile({
        ...base,
        discovery: true,
        perLanguage: 3,
        tries: 2,
        firstTurns: 10,
      }),
    ).toMatchObject({ perLanguage: 3, tries: 2, firstTurns: 10 });
    expect(
      resolvedPolyglotProfile({ ...withoutBudgets, discovery: true, cases: ["python/one"] }),
    ).toMatchObject({ perLanguage: 0 });
  });

  test("discovers every language from official metadata", async () => {
    await withDataset(async (dataset) => {
      const cases = discoverPolyglotCases(dataset);

      expect(cases).toHaveLength(6);
      expect(new Set(cases.map((candidate) => candidate.language))).toEqual(
        new Set(POLYGLOT_LANGUAGES),
      );
      expect(selectPolyglotCases(cases, { smoke: true })).toHaveLength(6);
    });
  });

  test("selects deterministic evenly spaced language screens", () => {
    const cases = POLYGLOT_LANGUAGES.flatMap((language) =>
      Array.from(
        { length: 10 },
        (_, index): PolyglotCase => ({
          language,
          name: `case-${String(index).padStart(2, "0")}`,
          source: `/tmp/${language}/${index}`,
          solutionFiles: ["solution.txt"],
          supportFiles: [],
          testFiles: ["case.test"],
          exampleFiles: [],
        }),
      ),
    );

    const selected = selectPolyglotCases(cases, { perLanguage: 3 });

    expect(selected).toHaveLength(18);
    expect(selected.filter((candidate) => candidate.language === "python").map(caseId)).toEqual([
      "python/case-00",
      "python/case-05",
      "python/case-09",
    ]);
  });

  test("excludes reference solutions and enables skipped tests", async () => {
    await withDataset(async (dataset, output) => {
      const cases = discoverPolyglotCases(dataset);
      const javascript = cases.find((candidate) => candidate.language === "javascript");
      const java = cases.find((candidate) => candidate.language === "java");
      expect(javascript).toBeDefined();
      expect(java).toBeDefined();
      if (javascript === undefined || java === undefined) return;

      const jsRepo = path.join(output, "js");
      preparePolyglotCase(javascript, jsRepo);
      expect(existsSync(path.join(jsRepo, ".meta"))).toBe(false);
      expect(JSON.parse(readFileSync(path.join(jsRepo, "forge.json"), "utf8"))).toEqual({
        verify: verificationCommands(javascript),
      });
      expect(readFileSync(path.join(jsRepo, "case.spec.js"), "utf8")).toContain("it('works'");

      const javaRepo = path.join(output, "java");
      preparePolyglotCase(java, javaRepo);
      expect(readFileSync(path.join(javaRepo, "case.test"), "utf8")).not.toContain("@Disabled");
    });
  });

  test("uses native full-test commands and names the complete implementation context", async () => {
    await withDataset(async (dataset, output) => {
      const python = discoverPolyglotCases(dataset).find(
        (candidate) => candidate.language === "python",
      ) as PolyglotCase;
      const pythonCommand = verificationCommands(python)[0] ?? [];
      expect(pythonCommand).toContain("pytest");
      expect(pythonCommand[0]).toBe("uv");
      expect(pythonCommand[0]).not.toBe(process.execPath);
      const go = discoverPolyglotCases(dataset).find(
        (candidate) => candidate.language === "go",
      ) as PolyglotCase;
      expect(verificationCommands(go)[0]).toContain("-timeout=55s");
      expect(POLYGLOT_VERIFIER_TIMEOUTS.go).toBe(60);
      const java = discoverPolyglotCases(dataset).find(
        (candidate) => candidate.language === "java",
      ) as PolyglotCase;
      expect(verificationCommands(java)[0]).toContain("--info");
      expect(go.supportFiles).toContain("interface.go");
      expect(firstAttemptPrompt(go, output)).toContain("Related source or interface file(s)");
      expect(firstAttemptPrompt(python, output)).toContain("primary implementation file(s)");
      expect(firstAttemptPrompt(python, output)).toContain("run the tests before editing");
      expect(firstAttemptPrompt(python, output)).toContain("preserve it if they already pass");
      expect(firstAttemptPrompt(python, output)).toContain("setup failure, not a code failure");
    });
  });

  test("gives specification-driven guidance only to test-authoring exercises", async () => {
    await withDataset(async (dataset, output) => {
      const goSource = path.join(dataset, "go", "exercises", "practice", "go-case");
      mkdirSync(path.join(goSource, ".docs"));
      writeFileSync(
        path.join(goSource, ".docs", "instructions.md"),
        "This is a special exercise. Design a test suite against supplied implementations.\n",
      );
      const cases = discoverPolyglotCases(dataset);
      const go = cases.find((candidate) => candidate.language === "go") as PolyglotCase;
      const python = cases.find((candidate) => candidate.language === "python") as PolyglotCase;

      expect(isTestAuthoringExercise(go)).toBe(true);
      expect(firstAttemptPrompt(go, output)).toContain("test file the primary deliverable");
      expect(firstAttemptPrompt(go, output)).toContain(
        "Run node .forge-test-authoring-verifier.mjs",
      );
      const repository = path.join(output, "go-special");
      preparePolyglotCase(go, repository);
      expect(verificationCommands(go)).toEqual([["node", ".forge-test-authoring-verifier.mjs"]]);
      expect(existsSync(path.join(repository, ".forge-test-authoring-verifier.mjs"))).toBe(true);
      expect(isTestAuthoringExercise(python)).toBe(false);
      expect(firstAttemptPrompt(python, output)).not.toContain("test file the primary deliverable");
    });
  });
});

describe("Polyglot execution", () => {
  test("preflight preserves an already-passing prepared case without model turns", async () => {
    await withDataset(async (dataset, output) => {
      let agentCalls = 0;
      const report = await runPolyglot(options(dataset, output), {
        runAttempt: async (_prompt, _repository, number, turnsBudget) => {
          agentCalls += 1;
          return attempt(number, turnsBudget);
        },
        preflightVerify: async () => ({ passed: true, output: "already passes", timedOut: false }),
      });

      expect(agentCalls).toBe(0);
      expect(report.passedCaseCount).toBe(1);
      expect(report.firstAttemptPassCount).toBe(1);
      expect(report.totalTurns).toBe(0);
      expect(report.results[0]?.attempts).toEqual([]);
      expect(report.results[0]?.verification).toBe("already passes");
    });
  });

  test("a failing preflight continues into the bounded model attempt", async () => {
    await withDataset(async (dataset, output) => {
      let agentCalls = 0;
      const report = await runPolyglot(options(dataset, output), {
        runAttempt: async (_prompt, _repository, number, turnsBudget) => {
          agentCalls += 1;
          return attempt(number, turnsBudget);
        },
        preflightVerify: async () => ({
          passed: false,
          output: "assertion failed",
          timedOut: false,
        }),
        verify: async () => ({ passed: true, output: "passes after edit", timedOut: false }),
      });

      expect(agentCalls).toBe(1);
      expect(report.passedCaseCount).toBe(1);
      expect(report.results[0]?.attempts).toHaveLength(1);
      expect(report.results[0]?.verification).toBe("passes after edit");
    });
  });

  test("runs isolated cases with bounded concurrency", async () => {
    await withDataset(async (dataset, output) => {
      let active = 0;
      let peak = 0;
      const report = await runPolyglot(
        { ...options(dataset, output), languages: ["go", "python"], jobs: 2 },
        {
          runAttempt: async (_prompt, _repository, number, turnsBudget) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return attempt(number, turnsBudget);
          },
          verify: async () => ({ passed: true, output: "passed", timedOut: false }),
        },
      );

      expect(report.completedCaseCount).toBe(2);
      expect(report.identity.caseConcurrency).toBe(2);
      expect(peak).toBe(2);
    });
  });

  test("uses a fresh eight-turn retry, checkpoints, and resumes completed cases", async () => {
    await withDataset(async (dataset, output) => {
      const prompts: string[] = [];
      const budgets: number[] = [];
      let agentCalls = 0;
      let verifierCalls = 0;
      const verifierBudgets: number[] = [];
      const config = options(dataset, output);
      const dependencies = {
        runAttempt: async (
          prompt: string,
          _repository: string,
          number: number,
          turnsBudget: number,
        ): Promise<PolyglotAttempt> => {
          agentCalls += 1;
          prompts.push(prompt);
          budgets.push(turnsBudget);
          return attempt(number, turnsBudget);
        },
        verify: async (_candidate: PolyglotCase, _repository: string, timeoutSeconds: number) => {
          verifierCalls += 1;
          verifierBudgets.push(timeoutSeconds);
          return verifierCalls === 1
            ? { passed: false, output: "assertion failed: expected 2", timedOut: false }
            : { passed: true, output: "1 passed", timedOut: false };
        },
      };

      const first = await runPolyglot(config, dependencies);
      const resumed = await runPolyglot(config, dependencies);

      expect(first.completedCaseCount).toBe(1);
      expect(first.passedCaseCount).toBe(1);
      expect(first.firstAttemptPassCount).toBe(0);
      expect(first.totalTurns).toBe(6);
      expect(first.totalActions).toBe(8);
      expect(first.falseSuccessAttemptCount).toBe(1);
      expect(first.incomplete).toBe(false);
      expect(budgets).toEqual([12, 8]);
      expect(verifierBudgets).toEqual([60, 60]);
      expect(first.identity.verifierTimeouts.go).toBe(60);
      expect(first.identity.attemptTimeoutSeconds).toBe(900);
      expect(prompts[1]).toContain("assertion failed: expected 2");
      expect(agentCalls).toBe(2);
      expect(resumed.results).toEqual(first.results);
      expect(existsSync(path.join(output, "report.json"))).toBe(true);
      expect(existsSync(path.join(output, "cases", "python", "python-case", "attempt-2.log"))).toBe(
        true,
      );
    });
  });

  test("refuses to mix results from a different run identity", async () => {
    await withDataset(async (dataset, output) => {
      const config = { ...options(dataset, output), batchSize: 1 };
      await runPolyglot(config, {
        runAttempt: async (_prompt, _repository, number, turnsBudget) =>
          attempt(number, turnsBudget),
        verify: async () => ({ passed: true, output: "passed", timedOut: false }),
      });

      await expect(runPolyglot({ ...config, temperature: 0.1 })).rejects.toThrow(
        "run identity differs",
      );
    });
  });

  test("does not spend a model retry on a verifier infrastructure failure", async () => {
    await withDataset(async (dataset, output) => {
      let agentCalls = 0;
      const report = await runPolyglot(options(dataset, output), {
        runAttempt: async (_prompt, _repository, number, turnsBudget) => {
          agentCalls += 1;
          return attempt(number, turnsBudget);
        },
        verify: async () => ({
          passed: false,
          output: "Could not create parent directory for lock file gradle.zip.lck",
          timedOut: false,
        }),
      });
      const result = JSON.parse(
        readFileSync(path.join(output, "cases", "python", "python-case", "result.json"), "utf8"),
      ) as { infrastructureError: boolean; attempts: unknown[] };

      expect(agentCalls).toBe(1);
      expect(report.infrastructureErrorCount).toBe(1);
      expect(result.infrastructureError).toBe(true);
      expect(result.attempts).toHaveLength(1);
    });
  });

  test("does not spend a retry when the model endpoint rejects the runtime profile", async () => {
    await withDataset(async (dataset, output) => {
      let agentCalls = 0;
      const report = await runPolyglot(options(dataset, output), {
        runAttempt: async (_prompt, _repository, number, turnsBudget) => {
          agentCalls += 1;
          return {
            ...attempt(number, turnsBudget),
            exitCode: 1,
            claimedSuccess: false,
            turns: 0,
            actions: 0,
            output:
              'HTTP 409 from http://127.0.0.1:44100/v1: {"error":{"code":"profile_conflict"}}',
          };
        },
        verify: async () => ({ passed: false, output: "assertion failed", timedOut: false }),
      });

      const result = JSON.parse(
        readFileSync(path.join(output, "cases", "python", "python-case", "result.json"), "utf8"),
      ) as { infrastructureError: boolean; failureClass: string; attempts: unknown[] };

      expect(agentCalls).toBe(1);
      expect(report.infrastructureErrorCount).toBe(1);
      expect(report.results).toHaveLength(0);
      expect(result.infrastructureError).toBe(true);
      expect(result.failureClass).toBe("infrastructure");
      expect(result.attempts).toHaveLength(1);
    });
  });
});

describe("Polyglot failure classification", () => {
  test("builds bounded retry evidence around the first useful diagnostic", () => {
    const output = [
      "$ go test ./...",
      "ordinary setup noise",
      "panic: test timed out after 55s",
      "goroutine 10 [sync.RWMutex.RLock]:",
      "react.(*cell).Value()",
      "/work/react/react.go:50 +0x74",
      ...Array.from({ length: 100 }, (_, index) => `noise ${index} ${"x".repeat(40)}`),
      "FAIL react 55.0s",
    ].join("\n");

    const excerpt = diagnosticExcerpt(output, 1_000);

    expect(excerpt.length).toBeLessThanOrEqual(1_000);
    expect(excerpt).toContain("Primary diagnostic");
    expect(excerpt).toContain("panic: test timed out after 55s");
    expect(excerpt).toContain("/work/react/react.go:50");
    expect(excerpt).toContain("Output tail");
  });

  test("prefers infrastructure and timeout over diagnostic text", () => {
    expect(classifyPolyglotFailure(false, true, true, "assertion failed", [])).toBe(
      "infrastructure",
    );
    expect(classifyPolyglotFailure(false, false, true, "assertion failed", [])).toBe("timeout");
    expect(
      classifyPolyglotFailure(false, false, false, "panic: test timed out after 55s", []),
    ).toBe("hang_or_deadlock");
  });

  test("separates syntax, compile, assertion, and no-progress failures", () => {
    expect(classifyPolyglotFailure(false, false, false, "SyntaxError: bad token", [])).toBe(
      "syntax",
    );
    expect(classifyPolyglotFailure(false, false, false, "cannot find symbol Foo", [])).toBe(
      "type_or_compile",
    );
    expect(classifyPolyglotFailure(false, false, false, "expected 2 but got 3", [])).toBe(
      "test_failure",
    );
    expect(
      classifyPolyglotFailure(
        false,
        false,
        false,
        "12 tests completed, 3 failed\nBUILD FAILED",
        [],
      ),
    ).toBe("test_failure");
    expect(classifyPolyglotFailure(false, false, false, "unknown", [attempt(1, 12)])).toBe(
      "unknown",
    );
    expect(
      classifyPolyglotFailure(false, false, false, "unknown", [{ ...attempt(1, 12), actions: 0 }]),
    ).toBe("no_progress");
  });

  test("recognizes toolchain and provider provisioning failures", () => {
    expect(
      isPolyglotInfrastructureFailure(
        "Could not create parent directory for lock file /broken/gradle.zip.lck",
      ),
    ).toBe(true);
    expect(
      isPolyglotInfrastructureFailure("Could not find tools.jar in a valid JDK installation"),
    ).toBe(true);
    expect(
      isPolyglotInfrastructureFailure(
        'HTTP 409 from http://127.0.0.1:44100/v1: {"error":{"code":"profile_conflict"}}',
      ),
    ).toBe(true);
    expect(isPolyglotInfrastructureFailure("expected HTTP 409 but got HTTP 500")).toBe(false);
    expect(isPolyglotInfrastructureFailure("expected 2 but got 3")).toBe(false);
  });
});

describe("an authenticated endpoint", () => {
  /**
   * Every benchmark to date ran against a local unauthenticated endpoint, so
   * this never surfaced: `execBounded` builds a credential-free environment on
   * purpose -- the code it runs may be code the model just wrote -- and the
   * benchmark spawns `forge run` through it. Against a hosted provider the
   * spawned agent therefore preflighted fine and got HTTP 401 on the first
   * completion, once per case, reported as an infrastructure error.
   *
   * The agent Forge spawns is Forge, not model output. It gets the key; the
   * model's own commands still do not.
   */
  test("forwards the provider credential to the agent it spawns", () => {
    const previous = process.env["FORGE_API_KEY"];
    process.env["FORGE_API_KEY"] = "sk-test-value";
    try {
      const env = benchmarkAgentEnvironment("/tmp/out");
      expect(env["FORGE_API_KEY"]).toBe("sk-test-value");
      expect(env["GRADLE_USER_HOME"]).toContain("tool-cache");
    } finally {
      if (previous === undefined) delete process.env["FORGE_API_KEY"];
      else process.env["FORGE_API_KEY"] = previous;
    }
  });

  test("adds nothing when no credential is set", () => {
    const previous = process.env["FORGE_API_KEY"];
    delete process.env["FORGE_API_KEY"];
    try {
      const env = benchmarkAgentEnvironment("/tmp/out");
      expect("FORGE_API_KEY" in env).toBe(false);
    } finally {
      if (previous !== undefined) process.env["FORGE_API_KEY"] = previous;
    }
  });
});
