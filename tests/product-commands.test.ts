import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { executionBackendFor, type IO, main } from "../src/cli.js";
import {
  initializeProject,
  modeRefusal,
  readProjectConfig,
  resolvePermissionMode,
  selectModelProfile,
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

  test("resolves and lists strict named model profiles", async () => {
    await withRepo(async (root) => {
      writeFileSync(
        path.join(root, "forge.json"),
        JSON.stringify({
          profile: "local",
          profiles: {
            fast: { model: "fast-model", maxTurns: 6 },
            local: {
              url: "http://127.0.0.1:44100/v1",
              model: "local-model",
              apiKeyEnv: "LOCAL_MODEL_API_KEY",
              contextWindow: 65_536,
              maxTokens: 4_096,
              temperature: 0.2,
              native: true,
              maxTurns: 10,
            },
          },
        }),
      );

      const project = readProjectConfig(root);
      const selected = selectModelProfile(project.config);
      const listed = capturedIO();
      const listCode = await main(["profiles", "--repo", root, "--json"], listed.io);
      const configured = capturedIO();
      const configCode = await main(["config", "--repo", root, "--json"], configured.io);

      expect(project.errors).toEqual([]);
      expect(selected).toMatchObject({
        name: "local",
        profile: {
          model: "local-model",
          apiKeyEnv: "LOCAL_MODEL_API_KEY",
          contextWindow: 65_536,
          maxTokens: 4_096,
          native: true,
          maxTurns: 10,
        },
      });
      expect(listCode).toBe(0);
      expect(JSON.parse(listed.out.join("\n"))).toMatchObject({
        selected: "local",
        profiles: [
          { name: "fast", selected: false, model: "fast-model" },
          { name: "local", selected: true, model: "local-model" },
        ],
      });
      expect(configCode).toBe(0);
      expect(JSON.parse(configured.out.join("\n"))).toMatchObject({
        profile: "local",
        provider: {
          url: "http://127.0.0.1:44100/v1",
          model: "local-model",
          apiKeyEnv: "LOCAL_MODEL_API_KEY",
          contextWindow: 65_536,
          maxTokens: 4_096,
          temperature: 0.2,
          native: true,
          maxTurns: 10,
        },
      });
      expect([...listed.err, ...configured.err]).toEqual([]);
    });
  });

  test("uses GROQ_API_KEY for the exact Groq API host without exposing the key", async () => {
    await withRepo(async (root) => {
      const configured = capturedIO();

      const code = await main(
        [
          "config",
          "--repo",
          root,
          "--url",
          "https://api.groq.com/openai/v1",
          "--model",
          "qwen/qwen3.6-27b",
          "--json",
        ],
        configured.io,
      );
      const result = JSON.parse(configured.out.join("\n"));

      expect(code).toBe(0);
      expect(result.provider).toMatchObject({
        url: "https://api.groq.com/openai/v1",
        model: "qwen/qwen3.6-27b",
        apiKeyEnv: "GROQ_API_KEY",
      });
      expect(JSON.stringify(result)).not.toContain("groq-secret-value");
    });
  });

  test("does not send the Groq key to lookalike or insecure hosts", async () => {
    await withRepo(async (root) => {
      for (const url of [
        "https://api.groq.com.attacker.invalid/openai/v1",
        "http://api.groq.com/openai/v1",
      ]) {
        const configured = capturedIO();
        const code = await main(
          ["config", "--repo", root, "--url", url, "--model", "qwen/qwen3.6-27b", "--json"],
          configured.io,
        );
        const result = JSON.parse(configured.out.join("\n"));

        expect(code).toBe(0);
        expect(result.provider.apiKeyEnv).toBe("FORGE_API_KEY");
      }
    });
  });

  test("lets an explicit API-key environment override Groq inference", async () => {
    await withRepo(async (root) => {
      const configured = capturedIO();

      const code = await main(
        [
          "config",
          "--repo",
          root,
          "--url",
          "https://api.groq.com/openai/v1",
          "--model",
          "qwen/qwen3.6-27b",
          "--api-key-env",
          "MY_GROQ_KEY",
          "--json",
        ],
        configured.io,
      );
      const result = JSON.parse(configured.out.join("\n"));

      expect(code).toBe(0);
      expect(result.provider.apiKeyEnv).toBe("MY_GROQ_KEY");
    });
  });

  test("lets explicit CLI values override a selected profile", async () => {
    await withRepo(async (root) => {
      writeFileSync(
        path.join(root, "forge.json"),
        JSON.stringify({
          profiles: {
            local: {
              url: "http://profile.invalid/v1",
              model: "profile-model",
              contextWindow: 16_000,
              maxTokens: 2_000,
              temperature: 0.2,
              native: true,
              maxTurns: 8,
            },
          },
        }),
      );
      const configured = capturedIO();

      const code = await main(
        [
          "config",
          "--repo",
          root,
          "--profile",
          "local",
          "--url",
          "http://override.invalid/v1",
          "--model",
          "override-model",
          "--context",
          "32000",
          "--max-tokens",
          "3000",
          "--temperature",
          "0.7",
          "--max-turns",
          "14",
          "--json",
        ],
        configured.io,
      );
      const result = JSON.parse(configured.out.join("\n"));

      expect(code).toBe(0);
      expect(result).toMatchObject({
        profile: "local",
        provider: {
          url: "http://override.invalid/v1",
          model: "override-model",
          contextWindow: 32_000,
          maxTokens: 3_000,
          temperature: 0.7,
          native: true,
          maxTurns: 14,
        },
      });
    });
  });

  test("rejects unknown and malformed profiles", async () => {
    await withRepo(async (root) => {
      writeFileSync(
        path.join(root, "forge.json"),
        JSON.stringify({ profiles: { local: { contextWindow: -1 } } }),
      );
      expect(readProjectConfig(root).errors.join("\n")).toMatch(/contextWindow|greater than 0/i);

      writeFileSync(
        path.join(root, "forge.json"),
        JSON.stringify({ profiles: { local: { model: "one" }, remote: { model: "two" } } }),
      );
      expect(() => selectModelProfile(readProjectConfig(root).config, "missing")).toThrow(
        /available: local, remote/i,
      );
      const captured = capturedIO();
      const code = await main(
        ["config", "--repo", root, "--profile", "missing", "--json"],
        captured.io,
      );
      expect(code).toBe(2);
      expect(captured.err.join("\n")).toMatch(/unknown model profile/i);
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

  test("accepts well-formed execution bounds and rejects malformed ones by field name", async () => {
    await withRepo(async (root) => {
      writeFileSync(
        path.join(root, "forge.json"),
        JSON.stringify({
          execution: {
            runtime: "docker",
            image: "node:22",
            memoryMiB: 2048,
            cpus: 1.5,
            pids: 256,
            tmpfsMiB: 512,
            readOnlyRoot: false,
            limits: true,
          },
        }),
      );
      expect(readProjectConfig(root).errors).toEqual([]);

      writeFileSync(
        path.join(root, "forge.json"),
        JSON.stringify({ execution: { runtime: "docker", image: "node:22", memoryMiB: "2g" } }),
      );
      expect(readProjectConfig(root).errors.join("\n")).toMatch(/memoryMiB/);

      writeFileSync(
        path.join(root, "forge.json"),
        JSON.stringify({ execution: { runtime: "docker", image: "node:22", pids: -1 } }),
      );
      expect(readProjectConfig(root).errors.join("\n")).toMatch(/pids/);
    });
  });
});

describe("execution backend flags", () => {
  const configured = {
    execution: {
      runtime: "docker" as const,
      image: "node:22",
      memoryMiB: 2048,
      cpus: 1,
      pids: 100,
      readOnlyRoot: true,
      limits: true,
    },
  };

  test("flags beat forge.json so an operator can contain a run", () => {
    const backend = executionBackendFor(configured, {
      "sandbox-memory": "1024",
      "sandbox-cpus": "1.5",
      "sandbox-pids": "64",
    });
    expect(backend.settings).toMatchObject({ memoryMiB: 1024, cpus: 1.5, pids: 64 });
  });

  test("config bounds hold when no flag is given", () => {
    const backend = executionBackendFor(configured, {});
    expect(backend.settings).toMatchObject({
      memoryMiB: 2048,
      cpus: 1,
      pids: 100,
      readOnlyRoot: true,
      limits: true,
    });
  });

  test("weakening flags beat an explicit config true", () => {
    const backend = executionBackendFor(configured, {
      "sandbox-writable-root": true,
      "sandbox-no-limits": true,
    });
    expect(backend.settings).toMatchObject({ readOnlyRoot: false, limits: false });
  });

  test("rejects malformed bound values by flag name", () => {
    for (const [flag, value] of [
      ["sandbox-memory", "abc"],
      ["sandbox-memory", "0"],
      ["sandbox-memory", "1.5"],
      ["sandbox-memory", "-1"],
      ["sandbox-pids", "Infinity"],
      ["sandbox-cpus", "0"],
    ] as const) {
      expect(() => executionBackendFor(configured, { [flag]: value })).toThrow(
        new RegExp(`--${flag}`),
      );
    }
    // A bare flag parses as boolean true and is rejected, not treated as 1.
    expect(() => executionBackendFor(configured, { "sandbox-memory": true })).toThrow(
      /--sandbox-memory/,
    );
  });

  test("bound flags without a container runtime resolve to the host", () => {
    const backend = executionBackendFor({}, { "sandbox-memory": "1024" });
    expect(backend.name).toBe("host");
  });

  test("rejects an image that would parse as a runtime option", () => {
    expect(() =>
      executionBackendFor({ execution: { runtime: "docker", image: "--privileged=true" } }, {}),
    ).toThrow(/image may not start/);
  });

  test("rejects a tmpfs larger than the memory bound while limits are on", () => {
    expect(() =>
      executionBackendFor(
        { execution: { runtime: "docker", image: "node:22", memoryMiB: 1024, tmpfsMiB: 8192 } },
        {},
      ),
    ).toThrow(/tmpfsMiB.*memoryMiB/);
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
      const riskOnly = capturedIO();
      const riskOnlyCode = await main(["run", "task", "--repo", root, "--allow-risk"], riskOnly.io);
      const plan = capturedIO();
      const planCode = await main(["plan", "task", "--repo", root, "--isolate"], plan.io);

      expect(promoteOnlyCode).toBe(2);
      expect(promoteOnly.err).toEqual([expect.stringMatching(/requires --isolate/i)]);
      expect(unverifiedCode).toBe(2);
      expect(unverified.err).toEqual([expect.stringMatching(/requires verification/i)]);
      expect(riskOnlyCode).toBe(2);
      expect(riskOnly.err).toEqual([expect.stringMatching(/requires --isolate --promote/i)]);
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
