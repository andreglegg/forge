import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { planChangeImpact } from "../src/impact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "forge-impact-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages", "core", "src"), { recursive: true });
  mkdirSync(path.join(root, "packages", "core", "tests"), { recursive: true });
  mkdirSync(path.join(root, "packages", "api", "src"), { recursive: true });
  mkdirSync(path.join(root, "packages", "api", "tests"), { recursive: true });
  writeFileSync(path.join(root, "packages", "core", "package.json"), '{"name":"core"}\n');
  writeFileSync(path.join(root, "packages", "api", "package.json"), '{"name":"api"}\n');
  writeFileSync(
    path.join(root, "packages", "core", "src", "money.ts"),
    "export const cents = 100;\n",
  );
  writeFileSync(
    path.join(root, "packages", "core", "src", "invoice.ts"),
    'import { cents } from "./money";\nexport const total = cents;\n',
  );
  writeFileSync(
    path.join(root, "packages", "api", "src", "checkout.ts"),
    'import { total } from "../../core/src/invoice";\nexport const checkout = total;\n',
  );
  writeFileSync(
    path.join(root, "packages", "api", "src", "server.ts"),
    'import { checkout } from "./checkout";\nexport const serve = checkout;\n',
  );
  writeFileSync(
    path.join(root, "packages", "core", "tests", "invoice.test.ts"),
    'import { total } from "../src/invoice";\nvoid total;\n',
  );
  writeFileSync(
    path.join(root, "packages", "api", "tests", "checkout.test.ts"),
    'import { checkout } from "../src/checkout";\nvoid checkout;\n',
  );
  return root;
}

describe("change-impact planning", () => {
  test("maps committed paths through inbound closure to packages and candidate tests", async () => {
    const root = await fixture();
    const plan = planChangeImpact(root, ["packages/core/src/money.ts"]);

    expect(plan.changed).toEqual(["packages/core/src/money.ts"]);
    expect(plan.affected).toEqual([
      "packages/api/src/checkout.ts",
      "packages/api/src/server.ts",
      "packages/api/tests/checkout.test.ts",
      "packages/core/src/invoice.ts",
      "packages/core/src/money.ts",
      "packages/core/tests/invoice.test.ts",
    ]);
    expect(plan.packages).toEqual(["packages/api", "packages/core"]);
    expect(plan.tests).toEqual([
      "packages/api/tests/checkout.test.ts",
      "packages/core/tests/invoice.test.ts",
    ]);
    expect(plan.output).toContain("configured authoritative completion gate remains mandatory");
  });

  test("reports deleted or moved-away paths without inventing impact evidence", async () => {
    const root = await fixture();
    const plan = planChangeImpact(root, ["packages/core/src/missing.ts"]);

    expect(plan.changed).toEqual([]);
    expect(plan.affected).toEqual([]);
    expect(plan.unanalyzable).toEqual(["packages/core/src/missing.ts"]);
    expect(plan.output).toContain("absent from the current repository index");
  });

  test("bounds inbound closure and test output deterministically", async () => {
    const root = await fixture();
    const plan = planChangeImpact(root, ["packages/core/src/money.ts"], {
      maxAffected: 2,
      maxTests: 1,
    });

    expect(plan.affected).toHaveLength(2);
    expect(plan.tests).toHaveLength(1);
    expect(plan.truncated).toBe(true);
    expect(plan.output).toContain("impact analysis truncated");
  });
});
