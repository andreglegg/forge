import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import { type ProjectConfigResult, readProjectConfig } from "../src/product.js";
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

async function readConfig(config: unknown): Promise<ProjectConfigResult> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "product-adapters-")));
  try {
    writeFileSync(path.join(root, "forge.json"), JSON.stringify(config));
    return readProjectConfig(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("verifyAdapters configuration", () => {
  const command = ["npm", "test"];

  test("a valid adapter parses, and a config without the key parses unchanged", async () => {
    const valid = await readConfig({
      verify: [command],
      verifyAdapters: [{ command, failWhen: "\\bFAIL\\b", evidence: "^not ok " }],
    });
    expect(valid.errors).toEqual([]);
    expect(valid.config.verifyAdapters).toHaveLength(1);
    expect(valid.config.verifyAdapters?.[0]?.failWhen).toBe("\\bFAIL\\b");

    const legacy = await readConfig({ verify: [command] });
    expect(legacy.errors).toEqual([]);
    expect(legacy.config.verifyAdapters).toBeUndefined();
  });

  test("an invalid regular expression is a hard config error, not a silent skip", async () => {
    const result = await readConfig({
      verify: [command],
      verifyAdapters: [{ command, failWhen: "([unclosed" }],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.config).toEqual({});
  });

  test("a pattern over the length cap is rejected", async () => {
    const result = await readConfig({
      verify: [command],
      verifyAdapters: [{ command, failWhen: "a".repeat(501) }],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.config).toEqual({});
  });

  test("an adapter must declare at least one pattern", async () => {
    const result = await readConfig({ verify: [command], verifyAdapters: [{ command }] });
    expect(result.errors).toHaveLength(1);
    expect(result.config).toEqual({});
  });

  test("an adapter naming a command absent from verify refuses to load", async () => {
    // An orphaned adapter that loaded would silently never apply, which is the
    // exact false-comfort failure the adapter exists to prevent.
    const orphaned = await readConfig({
      verify: [["npm", "run", "lint"]],
      verifyAdapters: [{ command, failWhen: "FAIL" }],
    });
    expect(orphaned.errors).toHaveLength(1);
    expect(orphaned.errors[0]).toContain("npm test");
    expect(orphaned.config).toEqual({});

    const noVerify = await readConfig({ verifyAdapters: [{ command, failWhen: "FAIL" }] });
    expect(noVerify.errors).toHaveLength(1);
    expect(noVerify.config).toEqual({});
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
