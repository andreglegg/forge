import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { NativeCodec, TextCodec } from "../src/codecs.js";
import { renderProposal } from "../src/protocol.js";
import { indexRepository } from "../src/repository.js";
import {
  buildRepositorySymbols,
  extractSourceSymbols,
  findRepositorySymbols,
} from "../src/symbols.js";
import { revisionOfContent } from "../src/workspace.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-symbols-")));
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

describe("symbol protocol", () => {
  test("normalizes SYMBOL identically in text and native codecs", () => {
    const fromText = decodeText("SYMBOL RequestHandler\n");
    const fromNative = decodeNative("symbol", { query: "RequestHandler", path: "." });

    expect(fromText.proposals).toEqual(fromNative.proposals);
    expect(fromText.proposals).toHaveLength(1);
    const proposal = fromText.proposals[0];
    expect(proposal).toBeDefined();
    if (proposal !== undefined) expect(renderProposal(proposal)).toBe("SYMBOL RequestHandler");
  });
});

describe("TypeScript and JavaScript declaration extraction", () => {
  test("extracts top-level declarations and members with exact locations", () => {
    const source = [
      "export interface RequestHandler {",
      "  handle(input: string): Promise<void>;",
      "  readonly name: string;",
      "}",
      "export class ApiHandler implements RequestHandler {",
      "  readonly name = 'api';",
      "  async handle(input: string): Promise<void> { void input; }",
      "  get active(): boolean { return true; }",
      "}",
      "export type HandlerResult = { ok: boolean };",
      "export enum HandlerKind { Api, Worker }",
      "export function createHandler(): ApiHandler { return new ApiHandler(); }",
      "export const DEFAULT_HANDLER = createHandler(), SECONDARY = createHandler();",
      "function helper() { const localOnly = 1; return localOnly; }",
      "",
    ].join("\n");

    const extracted = extractSourceSymbols("src/handlers.ts", source);
    const byQualified = new Map(
      extracted.declarations.map((entry) => [entry.qualifiedName, entry]),
    );

    expect(byQualified.get("RequestHandler")).toMatchObject({
      kind: "interface",
      path: "src/handlers.ts",
      line: 1,
      column: 18,
      exported: true,
    });
    expect(byQualified.get("RequestHandler.handle")).toMatchObject({
      kind: "method",
      line: 2,
      column: 3,
    });
    expect(byQualified.get("RequestHandler.name")).toMatchObject({ kind: "property", line: 3 });
    expect(byQualified.get("ApiHandler")).toMatchObject({ kind: "class", line: 5, exported: true });
    expect(byQualified.get("ApiHandler.handle")).toMatchObject({ kind: "method", line: 7 });
    expect(byQualified.get("ApiHandler.active")).toMatchObject({ kind: "getter", line: 8 });
    expect(byQualified.get("HandlerResult")).toMatchObject({ kind: "type", line: 10 });
    expect(byQualified.get("HandlerKind")).toMatchObject({ kind: "enum", line: 11 });
    expect(byQualified.get("HandlerKind.Api")).toMatchObject({ kind: "enum-member", line: 11 });
    expect(byQualified.get("createHandler")).toMatchObject({ kind: "function", line: 12 });
    expect(byQualified.get("DEFAULT_HANDLER")).toMatchObject({ kind: "variable", line: 13 });
    expect(byQualified.get("SECONDARY")).toMatchObject({ kind: "variable", line: 13 });
    expect(byQualified.get("helper")).toMatchObject({
      kind: "function",
      line: 14,
      exported: false,
    });
    expect(extracted.declarations.some((entry) => entry.name === "localOnly")).toBe(false);
    expect(extracted.parseDiagnostics).toBe(0);
    expect(new Set(extracted.declarations.map((entry) => entry.revision))).toEqual(
      new Set([revisionOfContent(source)]),
    );
  });

  test("extracts CommonJS-era JavaScript declarations without matching comments or strings", () => {
    const source = [
      "// function FakeComment() {}",
      "const text = 'class FakeString {}';",
      "class RealService {",
      "  run() { return text; }",
      "}",
      "function makeService() { return new RealService(); }",
      "module.exports = { RealService, makeService };",
      "",
    ].join("\n");

    const extracted = extractSourceSymbols("src/service.js", source);
    const names = extracted.declarations.map((entry) => entry.qualifiedName);

    expect(names).toContain("text");
    expect(names).toContain("RealService");
    expect(names).toContain("RealService.run");
    expect(names).toContain("makeService");
    expect(names).not.toContain("FakeComment");
    expect(names).not.toContain("FakeString");
  });
});

describe("bounded repository symbol index", () => {
  test("finds exact declarations in deep projects and reports revision-bound locations", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "packages", "api", "src", "features", "billing"), {
        recursive: true,
      });
      for (let index = 0; index < 225; index += 1) {
        const directory = path.join(root, "packages", "generated", String(index));
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, `file-${index}.ts`),
          `export const generated${index} = ${index};\n`,
        );
      }
      const target = path.join(
        root,
        "packages",
        "api",
        "src",
        "features",
        "billing",
        "invoice-service.ts",
      );
      const source = [
        "export class InvoiceService {",
        "  calculateTotal(): number { return 42; }",
        "}",
        "",
      ].join("\n");
      writeFileSync(target, source);

      const repository = indexRepository(root);
      const symbols = buildRepositorySymbols(root, repository);
      const result = findRepositorySymbols(root, "InvoiceService", { index: repository, symbols });
      const member = findRepositorySymbols(root, "InvoiceService.calculateTotal", {
        index: repository,
        symbols,
      });

      expect(symbols.candidateFiles).toBeGreaterThan(225);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        qualifiedName: "InvoiceService",
        kind: "class",
        path: "packages/api/src/features/billing/invoice-service.ts",
        line: 1,
        revision: revisionOfContent(source),
      });
      expect(member.matches[0]).toMatchObject({
        qualifiedName: "InvoiceService.calculateTotal",
        line: 2,
      });
      expect(result.output).toContain("packages/api/src/features/billing/invoice-service.ts:1:");
      expect(result.output).toContain(revisionOfContent(source).slice(0, 12));
    });
  });

  test("honors path scopes, file-size bounds, and exact-name matching", async () => {
    await withRepo(async (root) => {
      mkdirSync(path.join(root, "apps", "api"), { recursive: true });
      mkdirSync(path.join(root, "apps", "web"), { recursive: true });
      writeFileSync(path.join(root, "apps", "api", "handler.ts"), "export class Handler {}\n");
      writeFileSync(path.join(root, "apps", "web", "handler.ts"), "export class Handler {}\n");
      writeFileSync(
        path.join(root, "apps", "web", "huge.ts"),
        `export class Huge {}\n${"x".repeat(200)}`,
      );
      const index = indexRepository(root);
      const symbols = buildRepositorySymbols(root, index, { maxFileBytes: 100 });

      const scoped = findRepositorySymbols(root, "Handler", { index, symbols, path: "apps/api" });
      const partial = findRepositorySymbols(root, "Hand", { index, symbols });
      const skipped = findRepositorySymbols(root, "Huge", { index, symbols });

      expect(scoped.matches.map((entry) => entry.path)).toEqual(["apps/api/handler.ts"]);
      expect(partial.matches).toEqual([]);
      expect(skipped.matches).toEqual([]);
      expect(symbols.skippedLargeFiles).toBe(1);
    });
  });
});
