import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import { FORGE_VERSION } from "../src/version.js";

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly bin?: Record<string, string>;
  readonly files?: string[];
  readonly scripts?: Record<string, string>;
}

function manifest(): PackageManifest {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
}

describe("public package contract", () => {
  test("publishes one installable forge binary with a synchronized version", () => {
    const pkg = manifest();

    expect(pkg.private).not.toBe(true);
    expect(pkg.version).toBe(FORGE_VERSION);
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.bin).toEqual({ forge: "bin/forge" });
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "bin",
        "dist",
        "README.md",
        "LICENSE",
        "docs/PRODUCT_PLAN.md",
        "docs/ROADMAP.md",
      ]),
    );
    expect(pkg.scripts?.["prepack"]).toContain("npm run check");
    expect(pkg.scripts?.["prepack"]).toContain("npm run build");
  });

  test("reports the package version without opening a repository or provider", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: IO = { out: (text) => out.push(text), err: (text) => err.push(text) };

    const code = await main(["--version"], io);

    expect(code).toBe(0);
    expect(out).toEqual([FORGE_VERSION]);
    expect(err).toEqual([]);
  });
});

describe("release automation", () => {
  test("uses the TypeScript toolchain on every supported runner", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("actions/setup-node");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm pack --dry-run");
    expect(workflow).toContain("windows-latest");
    expect(workflow).not.toContain("setup-python");
    expect(workflow).not.toContain("pytest");
  });
});
