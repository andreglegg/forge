import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { planFocusedVerification } from "../src/focused-verification.js";
import type { ChangeImpactPlan } from "../src/impact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-focused-")));
  roots.push(root);
  mkdirSync(path.join(root, "packages", "api", "src"), { recursive: true });
  mkdirSync(path.join(root, "packages", "api", "tests"), { recursive: true });
  mkdirSync(path.join(root, "packages", "web", "tests"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  writeFileSync(
    path.join(root, "packages", "api", "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  writeFileSync(
    path.join(root, "packages", "web", "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  writeFileSync(path.join(root, "packages", "api", "tests", "money.test.ts"), "export {};\n");
  writeFileSync(path.join(root, "packages", "api", "tests", "tax.test.ts"), "export {};\n");
  writeFileSync(path.join(root, "packages", "web", "tests", "page.test.ts"), "export {};\n");
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "tests", "root.test.ts"), "export {};\n");
  return root;
}

function impact(tests: readonly string[]): ChangeImpactPlan {
  return {
    changed: ["packages/api/src/money.ts"],
    unanalyzable: [],
    affected: ["packages/api/src/money.ts"],
    packages: ["packages/api"],
    tests,
    truncated: false,
    output: "impact",
  };
}

describe("focused verification planning", () => {
  test("specializes a configured package test command with only that package's tests", async () => {
    const root = await project();
    const plan = planFocusedVerification(
      root,
      impact([
        "packages/api/tests/money.test.ts",
        "packages/web/tests/page.test.ts",
        "packages/api/tests/tax.test.ts",
      ]),
      [["cd", "packages/api", "&&", "npm", "test"]],
    );

    expect(plan.commands).toEqual([
      {
        command: [
          "cd",
          "packages/api",
          "&&",
          "npm",
          "test",
          "--",
          "tests/money.test.ts",
          "tests/tax.test.ts",
        ],
        packageRoot: "packages/api",
        tests: ["packages/api/tests/money.test.ts", "packages/api/tests/tax.test.ts"],
        reason: "candidate tests in packages/api derived from the configured package test command",
      },
    ]);
    expect(plan.output).toContain("npm test -- tests/money.test.ts tests/tax.test.ts");
  });

  test("supports root pnpm and bun test commands without inventing a runner", async () => {
    const root = await project();
    const rootImpact = impact(["tests/root.test.ts"]);

    expect(
      planFocusedVerification(root, rootImpact, [["pnpm", "test"]]).commands[0]?.command,
    ).toEqual(["pnpm", "test", "--", "tests/root.test.ts"]);
    expect(
      planFocusedVerification(root, rootImpact, [["bun", "test"]]).commands[0]?.command,
    ).toEqual(["bun", "test", "tests/root.test.ts"]);
  });

  test("refuses commands that cannot be narrowed deterministically", async () => {
    const root = await project();
    const candidate = impact(["packages/api/tests/money.test.ts"]);

    expect(planFocusedVerification(root, candidate, [["npm", "run", "check"]]).commands).toEqual(
      [],
    );
    expect(
      planFocusedVerification(root, candidate, [["npm", "test", "--", "--watch"]]).commands,
    ).toEqual([]);
    expect(
      planFocusedVerification(root, candidate, [["cd", "packages/api", "&&", "npm", "run", "lint"]])
        .commands,
    ).toEqual([]);
  });

  test("bounds commands and candidate test paths", async () => {
    const root = await project();
    const candidate = impact([
      "packages/api/tests/money.test.ts",
      "packages/api/tests/tax.test.ts",
    ]);
    const plan = planFocusedVerification(
      root,
      candidate,
      [
        ["cd", "packages/api", "&&", "npm", "test"],
        ["cd", "packages/api", "&&", "pnpm", "test"],
      ],
      { maxCommands: 1, maxTestsPerCommand: 1 },
    );

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]?.tests).toEqual(["packages/api/tests/money.test.ts"]);
    expect(plan.truncated).toBe(true);
  });
});
