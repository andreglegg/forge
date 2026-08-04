import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import {
  initializeProject,
  modeRefusal,
  readProjectConfig,
  resolvePermissionMode,
} from "../src/product.js";

function capturedIO(): { readonly io: IO; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-product-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("project configuration", () => {
  test("initializes a project with its detected verification command", async () => {
    await withRepo(async (root) => {
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );

      const first = initializeProject(root);
      const second = initializeProject(root);

      expect(first.created).toBe(true);
      expect(first.config.verify).toEqual([["npm", "test"]]);
      expect(second.created).toBe(false);
      expect(JSON.parse(readFileSync(path.join(root, "forge.json"), "utf8"))).toEqual({
        verify: [["npm", "test"]],
      });
    });
  });

  test("exposes init and resolved config through offline CLI commands", async () => {
    await withRepo(async (root) => {
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      const initialized = capturedIO();

      const initCode = await main(["init", "--repo", root, "--json"], initialized.io);
      const configured = capturedIO();
      const configCode = await main(
        ["config", "--repo", root, "--mode", "read-only", "--json"],
        configured.io,
      );

      expect(initCode).toBe(0);
      expect(JSON.parse(initialized.out.join("\n"))).toMatchObject({
        created: true,
        file: "forge.json",
        config: { verify: [["npm", "test"]] },
      });
      expect(configCode).toBe(0);
      expect(JSON.parse(configured.out.join("\n"))).toMatchObject({
        mode: "read-only",
        verify: [["npm", "test"]],
        provider: { url: "http://127.0.0.1:8790/v1", model: null },
      });
      expect([...initialized.err, ...configured.err]).toEqual([]);
    });
  });

  test("rejects incompatible machine-output modes before touching a provider", async () => {
    await withRepo(async (root) => {
      const captured = capturedIO();

      const code = await main(["config", "--repo", root, "--json", "--stream-json"], captured.io);

      expect(code).toBe(2);
      expect(captured.out).toEqual([]);
      expect(captured.err).toEqual([expect.stringMatching(/either --json or --stream-json/i)]);
    });
  });

  test("fails closed on unknown or malformed project settings", async () => {
    await withRepo(async (root) => {
      writeFileSync(path.join(root, "forge.json"), JSON.stringify({ verify: "npm test" }));

      const result = readProjectConfig(root);

      expect(result.config).toEqual({});
      expect(result.errors.join("\n")).toMatch(/invalid forge\.json/i);
      expect(() => initializeProject(root)).toThrow(/invalid forge\.json/i);
    });
  });
});

describe("isolated command validation", () => {
  test("rejects unsafe or unsupported flag combinations before provider access", async () => {
    await withRepo(async (root) => {
      const promoteOnly = capturedIO();
      const promoteOnlyCode = await main(
        ["run", "task", "--repo", root, "--promote"],
        promoteOnly.io,
      );
      const unverified = capturedIO();
      const unverifiedCode = await main(
        ["run", "task", "--repo", root, "--isolate", "--promote", "--no-verify"],
        unverified.io,
      );
      const plan = capturedIO();
      const planCode = await main(["plan", "task", "--repo", root, "--isolate"], plan.io);

      expect(promoteOnlyCode).toBe(2);
      expect(promoteOnly.err).toEqual([expect.stringMatching(/requires --isolate/i)]);
      expect(unverifiedCode).toBe(2);
      expect(unverified.err).toEqual([expect.stringMatching(/requires verification/i)]);
      expect(planCode).toBe(2);
      expect(plan.err).toEqual([expect.stringMatching(/only.*forge run.*workspace mode/i)]);
    });
  });
});

describe("permission modes", () => {
  test("resolves explicit and command aliases", () => {
    expect(resolvePermissionMode({})).toBe("workspace");
    expect(resolvePermissionMode({ mode: "read-only" })).toBe("read-only");
    expect(resolvePermissionMode({}, "plan")).toBe("plan");
    expect(resolvePermissionMode({ plan: true })).toBe("plan");
  });

  test("rejects conflicting and unknown modes", () => {
    expect(() => resolvePermissionMode({ plan: true, mode: "read-only" })).toThrow(/conflicting/i);
    expect(() => resolvePermissionMode({ mode: "root" })).toThrow(/unknown permission mode/i);
  });

  test("explains why mutating effects are unavailable", () => {
    expect(modeRefusal("plan")).toMatch(/implementation plan.*without editing/i);
    expect(modeRefusal("read-only")).toMatch(/forbids edits and command/i);
    expect(modeRefusal("workspace")).toBe("");
  });
});
