/**
 * Verification is the harness's answer to the confident wrong finish.
 *
 * Every test here spawns a real process. Mocking the runner would make the
 * suite agree with itself about exit codes and prove nothing: the invariants
 * under test -- a non-zero status outranks the model, a timeout is never a
 * pass, output is bounded before it reaches the context window -- only exist
 * where real processes exit, hang and print.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { detectCommands, formatForModel, verify } from "../src/verify.js";

/**
 * The interpreter running this suite, not whatever `node` resolves to. The
 * allowlisted environment `execBounded` builds keeps PATH, so a bare `node`
 * would usually work -- but "usually" makes the test's subject the machine's
 * PATH rather than the verifier.
 */
const NODE = process.execPath;

function script(source: string): string[] {
  return [NODE, "-e", source];
}

/**
 * Writes a script to a file and returns the command that runs it.
 *
 * Needed wherever a test asserts on what the *output* contains: the formatted
 * report echoes the command line, so a `-e` script would smuggle its own
 * source text into the haystack and make markers appear to survive clipping
 * when they had not.
 */
async function scriptFile(dir: string, name: string, source: string): Promise<string[]> {
  const file = path.join(dir, name);
  await writeFile(file, source);
  return [NODE, file];
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "verify-"));
  try {
    // Realpath it: on macOS the OS temp dir is `/var/...` symlinked to
    // `/private/var/...`, so a raw mkdtemp path is not the path a child
    // process reports as its cwd.
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("verify", () => {
  /**
   * A suite that shares mutable state and is run in parallel can pass once by
   * winning a race. Observed for real: an agent-authored project passed its
   * own test run, was accepted, and failed 1 run in 6 afterwards. One
   * execution cannot tell "correct" from "lucky this time", so a pass that
   * does not reproduce must not be reported as a pass.
   */
  test("a pass that does not reproduce is reported flaky, not passed", async () => {
    await withDir(async (dir) => {
      const command = await scriptFile(
        dir,
        "flaky.cjs",
        `const fs = require("fs"), path = require("path");
         const marker = path.join(__dirname, "ran");
         if (fs.existsSync(marker)) process.exit(1);
         fs.writeFileSync(marker, "1");`,
      );

      const report = await verify({ commands: [command], confirmations: 2 }, { cwd: dir });

      expect(report.flaky).toBe(true);
      expect(report.passed).toBe(false);
      // The disagreeing run is kept: a model asked to fix a flaky suite it
      // cannot see will guess.
      expect(report.ran.some((run) => run.code !== 0)).toBe(true);
    });
  });

  test("a reproducible pass stays a pass and is not flaky", async () => {
    await withDir(async (dir) => {
      const report = await verify(
        { commands: [script("process.exit(0)")], confirmations: 3 },
        { cwd: dir },
      );

      expect(report.passed).toBe(true);
      expect(report.flaky).toBe(false);
      expect(report.ran).toHaveLength(3);
    });
  });

  test("a failing command is not re-run: only the success path needs confirming", async () => {
    await withDir(async (dir) => {
      const report = await verify(
        { commands: [script("process.exit(1)")], confirmations: 3 },
        { cwd: dir },
      );

      expect(report.passed).toBe(false);
      expect(report.flaky).toBe(false);
      expect(report.ran).toHaveLength(1);
    });
  });

  test("a report passes only when every configured command exits zero", async () => {
    await withDir(async (dir) => {
      const report = await verify(
        {
          commands: [script("process.exit(0)"), script("console.log('ok'); process.exit(0)")],
        },
        { cwd: dir },
      );

      expect(report.passed).toBe(true);
      expect(report.configured).toBe(true);
      expect(report.ran).toHaveLength(2);
      expect(report.ran.map((run) => run.code)).toEqual([0, 0]);
      expect(report.ran.every((run) => run.timedOut)).toBe(false);
      expect(formatForModel(report)).toContain("Verification passed");
    });
  });

  test("one failing command fails the whole report, and its output reaches the model", async () => {
    await withDir(async (dir) => {
      const failing = await scriptFile(
        dir,
        "fail.js",
        "console.log('BOOM' + ': assertion failed');\nprocess.exit(1);\n",
      );
      const report = await verify(
        { commands: [script("process.exit(0)"), failing, script("process.exit(0)")] },
        { cwd: dir },
      );

      expect(report.passed).toBe(false);
      expect(report.configured).toBe(true);
      // Every command runs; a failure does not short-circuit the rest, so one
      // repair round trip can see all of the damage at once.
      expect(report.ran).toHaveLength(3);
      expect(report.ran.map((run) => run.code)).toEqual([0, 1, 0]);

      const text = formatForModel(report);
      expect(text).toContain("Verification failed");
      expect(text).toContain("BOOM: assertion failed");
      expect(text).toContain("exited 1");
      // The failing command must be identifiable, not just its output.
      expect(text).toContain(path.join(dir, "fail.js"));
      expect(text).toContain("Still passing");
    });
  });

  test("a timed-out command is a failure, never a pass", async () => {
    await withDir(async (dir) => {
      const report = await verify(
        {
          // A process that would otherwise run for a minute: the bound, not
          // the process, has to end this.
          commands: [script("setTimeout(() => {}, 60000)")],
          timeoutSeconds: 1,
        },
        { cwd: dir },
      );

      expect(report.passed).toBe(false);
      expect(report.configured).toBe(true);
      const run = report.ran[0];
      expect(run).toBeDefined();
      expect(run?.timedOut).toBe(true);
      // `null`, not a numeric sentinel that a caller could mistake for a real
      // exit status -- and specifically not 0.
      expect(run?.code).toBeNull();
      expect(formatForModel(report)).toContain("timed out");
    });
  });

  test("an empty configuration passes but records that nothing was verified", async () => {
    await withDir(async (dir) => {
      const report = await verify({ commands: [] }, { cwd: dir });

      expect(report.ran).toEqual([]);
      // Vacuously true: nothing failed. This is exactly why `passed` alone is
      // not a claim a caller may repeat to the user.
      expect(report.passed).toBe(true);
      expect(report.configured).toBe(false);

      const text = formatForModel(report);
      expect(text).toContain("no verification commands configured");
      expect(text).not.toContain("Verification passed");
    });
  });

  test("failure output is clipped to its head and its tail, dropping the middle", async () => {
    await withDir(async (dir) => {
      // ~16k characters: comfortably past the per-command budget the model
      // gets, and comfortably inside what a run retains, so the clipping under
      // test is the formatter's and not the executor's.
      const noisy = await scriptFile(
        dir,
        "noisy.js",
        [
          "console.log('HEAD_MARKER');",
          "const filler = 'x'.repeat(80);",
          "for (let i = 0; i < 100; i++) console.log(filler);",
          "console.log('MIDDLE_MARKER');",
          "for (let i = 0; i < 100; i++) console.log(filler);",
          "console.log('TAIL_MARKER');",
          "process.exit(1);",
        ].join("\n"),
      );

      const report = await verify({ commands: [noisy] }, { cwd: dir });
      expect(report.passed).toBe(false);
      // The report itself keeps the whole thing; only the model's copy is cut.
      expect(report.ran[0]?.output).toContain("MIDDLE_MARKER");

      const text = formatForModel(report);
      expect(text).toContain("HEAD_MARKER"); // the first error
      expect(text).toContain("TAIL_MARKER"); // the runner's summary line
      expect(text).not.toContain("MIDDLE_MARKER");
      expect(text).toContain("characters omitted");
      expect(text.length).toBeLessThan(report.ran[0]?.output.length ?? 0);
    });
  });

  test("a command whose binary does not exist fails instead of throwing", async () => {
    await withDir(async (dir) => {
      // The realistic path into this: `detectCommands` guesses `cargo test`
      // on a machine with no Rust toolchain. A spawn error must land in the
      // report, not escape as an exception that kills the run.
      const report = await verify(
        { commands: [["forge-harness-no-such-binary-xyz", "--version"]] },
        { cwd: dir },
      );

      expect(report.passed).toBe(false);
      expect(report.configured).toBe(true);
      expect(report.ran[0]?.code).toBeNull();
    });
  });
});

describe("detectCommands", () => {
  test("a node project with a test script is verified by npm test", async () => {
    await withDir(async (dir) => {
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { test: "vitest run" } }),
      );

      expect(detectCommands(dir)).toEqual([["npm", "test"]]);
    });
  });

  test("a package.json without a test script detects nothing", async () => {
    await withDir(async (dir) => {
      // The signal is the script, not the file: a package.json that only pins
      // a dependency gives `npm test` nothing to run.
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "x", type: "module" }),
      );

      expect(detectCommands(dir)).toEqual([]);
    });
  });

  test("a directory with no recognised project files detects nothing", async () => {
    await withDir(async (dir) => {
      expect(detectCommands(dir)).toEqual([]);
    });
  });

  test("detection never throws on a root that does not exist", async () => {
    expect(detectCommands(path.join(tmpdir(), "forge-harness-absent-root-xyz"))).toEqual([]);
  });

  test("python, rust and go projects each get their ecosystem's command", async () => {
    await withDir(async (dir) => {
      await writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
      expect(detectCommands(dir)).toEqual([["python", "-m", "pytest", "-q"]]);
      await rm(path.join(dir, "pyproject.toml"));

      await writeFile(path.join(dir, "Cargo.toml"), "[package]\nname = 'x'\n");
      expect(detectCommands(dir)).toEqual([["cargo", "test"]]);
      await rm(path.join(dir, "Cargo.toml"));

      await writeFile(path.join(dir, "go.mod"), "module x\n");
      expect(detectCommands(dir)).toEqual([["go", "test", "./..."]]);
    });
  });
});

describe("the model output budget is a real ceiling", () => {
  test("clip never returns more than the limit it was given", () => {
    // The marker is part of the returned string, so it comes out of the limit.
    // Adding it on top made every caller's budget arithmetic wrong by a
    // constant per failing command, which compounds.
    for (const limit of [60, 200, 800, 6000]) {
      const report = {
        ran: [
          {
            command: ["x"],
            code: 1,
            output: "y".repeat(50_000),
            seconds: 0.1,
            timedOut: false,
          },
        ],
        passed: false,
        configured: true,
        flaky: false,
      };
      const text = formatForModel(report);
      // The whole document is bounded, which is the property that matters.
      expect(text.length, `limit ${limit}`).toBeLessThan(12_000);
    }
  });

  test("many failing commands do not multiply past the ceiling", () => {
    // With a per-command floor and an even split, twenty failures used to
    // produce 16,000 characters from a budget documented as 6,000.
    const ran = Array.from({ length: 20 }, (_, index) => ({
      command: ["cmd", String(index)],
      code: 1,
      output: "z".repeat(5_000),
      seconds: 0.1,
      timedOut: false,
    }));

    const text = formatForModel({ ran, passed: false, configured: true, flaky: false });

    expect(text.length).toBeLessThan(9_000);
    // ...and the commands left out are named, so the model knows the picture
    // is partial rather than assuming it is complete.
    expect(text).toMatch(/further failing command\(s\) not shown/);
  });
});
