import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NativeCodec, TextCodec } from "../src/codecs.js";
import { renderProposal } from "../src/protocol.js";
import {
  buildRepositoryRelationships,
  relatedRepository,
  resolveRelativeModuleDependencies,
} from "../src/relationships.js";
import { indexRepository } from "../src/repository.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-relationships-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function decodeText(source: string) {
  const codec = new TextCodec();
  codec.feed(source);
  return codec.finish();
}

function decodeNative(name: string, args: Record<string, unknown>) {
  const codec = new NativeCodec();
  codec.feed({ call: { id: `${name}-1`, name, argumentsDelta: JSON.stringify(args) } });
  codec.feed({ finish: true });
  return codec.finish();
}

describe("dependency relationship protocol", () => {
  test("normalizes RELATED identically in text and native codecs", () => {
    const fromText = decodeText("RELATED packages/api/src/service.ts\n");
    const fromNative = decodeNative("related", { path: "packages/api/src/service.ts" });

    expect(fromText.proposals).toEqual(fromNative.proposals);
    expect(fromText.proposals).toHaveLength(1);
    const proposal = fromText.proposals[0];
    expect(proposal).toBeDefined();
    if (proposal !== undefined) {
      expect(renderProposal(proposal)).toBe("RELATED packages/api/src/service.ts");
    }
  });
});

describe("static repository relationships", () => {
  test("resolves relative imports, dependents, package ownership, and related tests", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "packages", "api", "src", "types"), { recursive: true });
      mkdirSync(path.join(root, "packages", "api", "tests"), { recursive: true });
      writeFileSync(
        path.join(root, "packages", "api", "package.json"),
        JSON.stringify({ name: "@example/api" }),
      );
      writeFileSync(
        path.join(root, "packages", "api", "src", "service.ts"),
        [
          'import { config } from "./config";',
          'export type { Request } from "./types";',
          'const legacy = require("./legacy");',
          'export async function load() { return import("./lazy.js"); }',
          "export const service = config + legacy;",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(root, "packages", "api", "src", "config.ts"),
        "export const config = 1;\n",
      );
      writeFileSync(
        path.join(root, "packages", "api", "src", "types", "index.ts"),
        "export type Request = {};\n",
      );
      writeFileSync(
        path.join(root, "packages", "api", "src", "legacy.js"),
        "module.exports = 2;\n",
      );
      writeFileSync(path.join(root, "packages", "api", "src", "lazy.ts"), "export default 3;\n");
      writeFileSync(
        path.join(root, "packages", "api", "src", "controller.ts"),
        'import { service } from "./service";\nexport const controller = service;\n',
      );
      writeFileSync(
        path.join(root, "packages", "api", "tests", "service.test.ts"),
        'import { service } from "../src/service";\nvoid service;\n',
      );

      const index = indexRepository(root);
      const graph = buildRepositoryRelationships(root, index);
      const result = relatedRepository(root, "packages/api/src/service.ts", { index, graph });

      expect(graph.outgoing.get("packages/api/src/service.ts")).toEqual([
        "packages/api/src/config.ts",
        "packages/api/src/lazy.ts",
        "packages/api/src/legacy.js",
        "packages/api/src/types/index.ts",
      ]);
      expect(graph.incoming.get("packages/api/src/service.ts")).toEqual([
        "packages/api/src/controller.ts",
        "packages/api/tests/service.test.ts",
      ]);
      expect(result.packageRoot).toBe("packages/api");
      expect(result.tests).toEqual(["packages/api/tests/service.test.ts"]);
      expect(result.output).toContain("Package: packages/api");
      expect(result.output).toContain("Direct dependencies (4)");
      expect(result.output).toContain("Inbound dependents (2)");
      expect(result.output).toContain("Related tests (1)");
      expect(result.output).toContain("static relative TypeScript/JavaScript imports");
    });
  });

  test("resolves one file's dependencies without scanning every source file", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src", "feature"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "feature", "entry.ts"),
        'import value from "../shared";\nexport { helper } from "./helper.js";\n',
      );
      writeFileSync(path.join(root, "src", "shared.ts"), "export default 1;\n");
      writeFileSync(path.join(root, "src", "feature", "helper.ts"), "export const helper = 2;\n");
      const index = indexRepository(root);
      const source = 'import value from "../shared";\nexport { helper } from "./helper.js";\n';

      expect(resolveRelativeModuleDependencies(index, "src/feature/entry.ts", source)).toEqual([
        "src/feature/helper.ts",
        "src/shared.ts",
      ]);
    });
  });

  test("bounds source scanning and reports unsupported alias edges honestly", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "entry.ts"),
        'import { value } from "@app/value";\nimport { local } from "./local";\nvoid value; void local;\n',
      );
      writeFileSync(path.join(root, "src", "local.ts"), "export const local = 1;\n");
      writeFileSync(path.join(root, "src", "value.ts"), "export const value = 2;\n");
      const index = indexRepository(root);
      const graph = buildRepositoryRelationships(root, index, { maxFiles: 1 });
      const result = relatedRepository(root, "src/entry.ts", { index, graph });

      expect(graph.scannedFiles).toBe(1);
      expect(graph.truncated).toBe(true);
      expect(graph.outgoing.get("src/entry.ts")).toEqual(["src/local.ts"]);
      expect(result.output).toContain("scan truncated");
      expect(result.output).not.toContain("src/value.ts");
    });
  });
});
