import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NativeCodec, TextCodec } from "../src/codecs.js";
import { renderProposal } from "../src/protocol.js";
import {
  globRepository,
  indexRepository,
  listRepository,
  projectMap,
  readRepositoryText,
  repositoryFiles,
  searchRepository,
} from "../src/repository.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-repository-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function decodeText(source: string) {
  const codec = new TextCodec();
  codec.feed(source);
  return codec.finish();
}

function decodeNative(name: string, args: Record<string, unknown>) {
  const codec = new NativeCodec();
  codec.feed({
    call: { id: `${name}-1`, name, argumentsDelta: JSON.stringify(args) },
  });
  codec.feed({ finish: true });
  return codec.finish();
}

describe("project-scale inspection protocol", () => {
  test.each([
    [
      "READ src/large.ts:40-80\n",
      "read",
      { path: "src/large.ts", start: 40, end: 80 },
      "READ src/large.ts:40-80",
    ],
    ["GLOB **/*.test.ts\n", "glob", { pattern: "**/*.test.ts", path: "." }, "GLOB **/*.test.ts"],
  ])("normalizes %s in text and native codecs", (source, tool, args, rendered) => {
    const fromText = decodeText(source);
    const fromNative = decodeNative(tool, args);

    expect(fromText.proposals).toEqual(fromNative.proposals);
    expect(fromText.proposals).toHaveLength(1);
    const proposal = fromText.proposals[0];
    expect(proposal).toBeDefined();
    if (proposal !== undefined) expect(renderProposal(proposal)).toBe(rendered);
  });
});

describe("project-scale repository catalog", () => {
  test("indexes deep projects beyond the old depth and 200-file limits", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "packages", "app", "src", "features", "billing"), {
        recursive: true,
      });
      for (let index = 0; index < 250; index += 1) {
        const directory = path.join(root, "packages", "generated", String(index));
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, `file-${index}.ts`),
          `export const value${index} = ${index};\n`,
        );
      }
      writeFileSync(
        path.join(root, "packages", "app", "src", "features", "billing", "invoice-service.ts"),
        "export const BILLING_SENTINEL = true;\n",
      );
      mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
      writeFileSync(
        path.join(root, "node_modules", "ignored", "dependency.js"),
        "secret dependency\n",
      );
      writeFileSync(path.join(root, ".env"), "TOKEN=not-for-context\n");

      const index = indexRepository(root);
      const files = repositoryFiles(index);

      expect(files).toContain("packages/app/src/features/billing/invoice-service.ts");
      expect(files).toContain("packages/generated/249/file-249.ts");
      expect(files).not.toContain("node_modules/ignored/dependency.js");
      expect(files).not.toContain(".env");
      expect(index.fileCount).toBeGreaterThan(250);
    });
  });

  test("uses Git ignore rules when the repository is available", async () => {
    await withRepo(async (root) => {
      git(root, "init", "-q");
      writeFileSync(path.join(root, ".gitignore"), "generated/\n*.log\n");
      mkdirSync(path.join(root, "src"));
      mkdirSync(path.join(root, "generated"));
      writeFileSync(path.join(root, "src", "main.ts"), "export {};\n");
      writeFileSync(path.join(root, "generated", "bundle.js"), "ignored\n");
      writeFileSync(path.join(root, "debug.log"), "ignored\n");

      const index = indexRepository(root);
      const files = repositoryFiles(index);

      expect(index.source).toBe("git");
      expect(files).toContain("src/main.ts");
      expect(files).toContain(".gitignore");
      expect(files).not.toContain("generated/bundle.js");
      expect(files).not.toContain("debug.log");
    });
  });

  test("lists one directory instead of dumping the whole repository", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "apps", "web", "src"), { recursive: true });
      writeFileSync(path.join(root, "apps", "web", "package.json"), "{}\n");
      writeFileSync(path.join(root, "apps", "web", "src", "main.ts"), "export {};\n");

      const rootListed = listRepository(root, ".");
      const listed = listRepository(root, "apps/web");

      expect(rootListed.output).toContain("directory apps/");
      expect(listed.output).toContain("file apps/web/package.json");
      expect(listed.output).toContain("directory apps/web/src/");
      expect(listed.output).not.toContain("apps/web/src/main.ts");
    });
  });

  test("glob locates deep files across a monorepo", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "packages", "api", "src", "routes"), { recursive: true });
      mkdirSync(path.join(root, "packages", "web", "src"), { recursive: true });
      writeFileSync(path.join(root, "packages", "api", "src", "routes", "health.test.ts"), "ok\n");
      writeFileSync(path.join(root, "packages", "web", "src", "app.test.ts"), "ok\n");

      const result = globRepository(root, "**/*.test.ts");

      expect(result.matches).toBe(2);
      expect(result.output).toContain("packages/api/src/routes/health.test.ts");
      expect(result.output).toContain("packages/web/src/app.test.ts");
    });
  });

  test("search scans deep files, supports path and glob filters, and skips binary data", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "packages", "api", "src", "deep"), { recursive: true });
      mkdirSync(path.join(root, "packages", "web", "src"), { recursive: true });
      writeFileSync(
        path.join(root, "packages", "api", "src", "deep", "handler.ts"),
        "export const REQUEST_SENTINEL = 42;\n",
      );
      writeFileSync(
        path.join(root, "packages", "web", "src", "component.tsx"),
        "export const REQUEST_SENTINEL = 7;\n",
      );
      writeFileSync(
        path.join(root, "packages", "api", "src", "deep", "image.bin"),
        Buffer.from([0, 1, 2, 3]),
      );

      const result = searchRepository(root, "REQUEST_SENTINEL", {
        path: "packages/api",
        glob: "**/*.ts",
      });

      expect(result.hits).toBe(1);
      expect(result.output).toContain("packages/api/src/deep/handler.ts:1:");
      expect(result.output).not.toContain("packages/web");
      expect(result.filesScanned).toBeGreaterThan(0);
    });
  });

  test("reads exact bounded line ranges and directs large-file continuation", async () => {
    await withRepo(async (root) => {
      const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
      writeFileSync(path.join(root, "large.txt"), `${lines.join("\n")}\n`);

      const ranged = readRepositoryText(root, "large.txt", { start: 40, end: 44 });
      const bounded = readRepositoryText(root, "large.txt", { maxChars: 120 });

      expect(ranged.content).toBe("line 40\nline 41\nline 42\nline 43\nline 44");
      expect(ranged.startLine).toBe(40);
      expect(ranged.endLine).toBe(44);
      expect(ranged.totalLines).toBe(201);
      expect(ranged.truncated).toBe(true);
      expect(bounded.truncated).toBe(true);
      expect(bounded.endLine).toBeLessThan(200);
    });
  });

  test("does not read binary files or symlinks that escape or alias hidden paths", async () => {
    await withRepo(async (root) => {
      writeFileSync(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));
      const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
      writeFileSync(outside, "outside\n");
      writeFileSync(path.join(root, ".env"), "TOKEN=hidden\n");
      symlinkSync(outside, path.join(root, "outside-link"));
      symlinkSync(".env", path.join(root, "config-link"));
      try {
        expect(() => readRepositoryText(root, "binary.dat")).toThrow(/binary/i);
        expect(() => readRepositoryText(root, "outside-link")).toThrow(/outside/i);
        expect(() => readRepositoryText(root, "config-link")).toThrow(/not available/i);
      } finally {
        if (existsSync(outside)) await rm(outside, { force: true });
      }
    });
  });

  test("builds a bounded project map with manifests and navigation guidance", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "apps", "web", "src"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), "{}\n");
      writeFileSync(path.join(root, "apps", "web", "package.json"), "{}\n");
      writeFileSync(path.join(root, "apps", "web", "src", "main.ts"), "export {};\n");

      const map = projectMap(indexRepository(root), 1_000);

      expect(map).toContain("Repository index:");
      expect(map).toContain("package.json");
      expect(map).toContain("apps/web/package.json");
      expect(map).toContain("Use LIST");
      expect(map.length).toBeLessThanOrEqual(1_050);
    });
  });
});
