/**
 * The extension boundary, unit level: the strict manifest schema, the api
 * version gate, and the request/result file protocol. Every path that is not
 * an explicit accept or a well-formed reject must fail closed.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkExtensionApi,
  checkExtensionsApi,
  EXTENSION_API_VERSION,
  type ExtensionResolution,
  invokeExtensions,
} from "../src/extension.js";
import { readProjectConfig } from "../src/product.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function repository(config: unknown = {}): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-extension-")));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "forge.json"), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

function manifest(extension: Record<string, unknown>): Record<string, unknown> {
  return { extensions: { reviewer: extension } };
}

const script = (body: string): string[] => [process.execPath, "-e", body];

const accepting = script(
  'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT, JSON.stringify({ decision: "accept" }))',
);

function context(repository: string): {
  repository: string;
  sessionId: string;
  event: "beforeCompletion";
  summary: string;
  mutatedPaths: string[];
  verification: { passed: boolean; commands: string[] };
} {
  return {
    repository,
    sessionId: "session-1",
    event: "beforeCompletion",
    summary: "changed note.txt",
    mutatedPaths: ["note.txt"],
    verification: { passed: true, commands: ["node -e ok"] },
  };
}

describe("the extensions manifest schema", () => {
  test("accepts a strict well-formed manifest", async () => {
    const root = await repository(
      manifest({ api: "1.0", command: script("void 0"), events: ["beforeCompletion"] }),
    );
    const result = readProjectConfig(root);
    expect(result.errors).toEqual([]);
    expect(result.config.extensions?.["reviewer"]?.api).toBe("1.0");
  });

  test("rejects unknown keys instead of ignoring them", async () => {
    const root = await repository(
      manifest({
        api: "1.0",
        command: script("void 0"),
        events: ["beforeCompletion"],
        autoApprove: true,
      }),
    );
    const result = readProjectConfig(root);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid forge.json");
    expect(result.config.extensions).toBeUndefined();
  });

  test("rejects an empty command token array", async () => {
    const root = await repository(
      manifest({ api: "1.0", command: [], events: ["beforeCompletion"] }),
    );
    expect(readProjectConfig(root).errors).toHaveLength(1);
  });

  test("rejects a command that is not a token array", async () => {
    const root = await repository(
      manifest({ api: "1.0", command: "npm test", events: ["beforeCompletion"] }),
    );
    expect(readProjectConfig(root).errors).toHaveLength(1);
  });

  test("rejects an api string that is not major.minor", async () => {
    const root = await repository(
      manifest({ api: "one.zero", command: script("void 0"), events: ["beforeCompletion"] }),
    );
    expect(readProjectConfig(root).errors).toHaveLength(1);
  });

  test("rejects an event outside the versioned vocabulary", async () => {
    const root = await repository(
      manifest({ api: "1.0", command: script("void 0"), events: ["afterVerify"] }),
    );
    expect(readProjectConfig(root).errors).toHaveLength(1);
  });
});

describe("the extension api version gate", () => {
  test("implements 1.0 and accepts an extension declaring it", () => {
    expect(EXTENSION_API_VERSION).toBe("1.0");
    expect(checkExtensionApi("reviewer", "1.0")).toBeNull();
  });

  test("refuses a different major, naming the extension and the implemented version", () => {
    const error = checkExtensionApi("reviewer", "2.0");
    expect(error).toContain("reviewer");
    expect(error).toContain("2.0");
    expect(error).toContain(EXTENSION_API_VERSION);
  });

  test("refuses a minor newer than implemented rather than guessing", () => {
    const error = checkExtensionApi("reviewer", "1.1");
    expect(error).toContain("reviewer");
    expect(error).toContain(EXTENSION_API_VERSION);
  });

  test("refuses an unparseable api declaration", () => {
    expect(checkExtensionApi("reviewer", "banana")).toContain("reviewer");
  });

  test("checks every manifest entry and names the offender", () => {
    expect(
      checkExtensionsApi({
        zeta: { api: "1.0", command: ["true"], events: ["beforeCompletion"] },
        alpha: { api: "3.0", command: ["true"], events: ["beforeCompletion"] },
      }),
    ).toContain("alpha");
    expect(checkExtensionsApi(undefined)).toBeNull();
  });
});

describe("the result file protocol", () => {
  test("an accept decision with exit 0 resolves accept", async () => {
    const root = await repository();
    const report = await invokeExtensions(
      { reviewer: { api: "1.0", command: accepting, events: ["beforeCompletion"] } },
      context(root),
    );
    expect(report.ok).toBe(true);
    expect(report.resolutions).toHaveLength(1);
    expect(report.resolutions[0]?.decision).toBe("accept");
  });

  test("the request file carries the api, the claim, and the evidence, outside the repository", async () => {
    const root = await repository();
    const capture = path.join(root, "request-capture.json");
    const pathCapture = path.join(root, "request-path.txt");
    const body = [
      'const fs = require("node:fs");',
      `fs.copyFileSync(process.env.FORGE_EXTENSION_REQUEST, ${JSON.stringify(capture)});`,
      `fs.writeFileSync(${JSON.stringify(pathCapture)}, process.env.FORGE_EXTENSION_REQUEST);`,
      'fs.writeFileSync(process.env.FORGE_EXTENSION_RESULT, JSON.stringify({ decision: "accept" }));',
    ].join("\n");
    await invokeExtensions(
      { reviewer: { api: "1.0", command: script(body), events: ["beforeCompletion"] } },
      context(root),
    );
    const request = JSON.parse(readFileSync(capture, "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({
      api: EXTENSION_API_VERSION,
      event: "beforeCompletion",
      sessionId: "session-1",
      summary: "changed note.txt",
      mutatedPaths: ["note.txt"],
      verification: { passed: true },
    });
    expect(readFileSync(pathCapture, "utf8").startsWith(root)).toBe(false);
  });

  test("a reject requires a reason and a long reason is clipped", async () => {
    const root = await repository();
    const body =
      'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT,' +
      ' JSON.stringify({ decision: "reject", reason: "x".repeat(3000) }))';
    const report = await invokeExtensions(
      { reviewer: { api: "1.0", command: script(body), events: ["beforeCompletion"] } },
      context(root),
    );
    expect(report.rejected?.decision).toBe("reject");
    expect(report.rejected?.reason).toHaveLength(2000);
  });

  test("a reject without a reason fails closed", async () => {
    const root = await repository();
    const body =
      'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT,' +
      ' JSON.stringify({ decision: "reject", reason: "" }))';
    const report = await invokeExtensions(
      { reviewer: { api: "1.0", command: script(body), events: ["beforeCompletion"] } },
      context(root),
    );
    expect(report.ok).toBe(false);
    expect(report.failed?.decision).toBe("failed");
    expect(report.failed?.reason).toContain("reason");
  });

  test("a missing result file fails closed with a stated cause", async () => {
    const root = await repository();
    const report = await invokeExtensions(
      { reviewer: { api: "1.0", command: script("void 0"), events: ["beforeCompletion"] } },
      context(root),
    );
    expect(report.failed?.decision).toBe("failed");
    expect(report.failed?.reason).toContain("result");
  });

  test("a malformed result file fails closed", async () => {
    const root = await repository();
    const body =
      'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT, "definitely not json")';
    const report = await invokeExtensions(
      { reviewer: { api: "1.0", command: script(body), events: ["beforeCompletion"] } },
      context(root),
    );
    expect(report.failed?.decision).toBe("failed");
    expect(report.failed?.reason).not.toBe("");
  });

  test("a nonzero exit fails closed even with a valid accept file", async () => {
    const root = await repository();
    const body =
      'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT,' +
      ' JSON.stringify({ decision: "accept" })); process.exit(3);';
    const report = await invokeExtensions(
      { reviewer: { api: "1.0", command: script(body), events: ["beforeCompletion"] } },
      context(root),
    );
    expect(report.failed?.decision).toBe("failed");
    expect(report.failed?.code).toBe(3);
    expect(report.failed?.reason).toContain("3");
  });

  test("a timeout fails closed", async () => {
    const root = await repository();
    const report = await invokeExtensions(
      {
        reviewer: {
          api: "1.0",
          command: script("setTimeout(() => {}, 5000)"),
          events: ["beforeCompletion"],
          timeoutSeconds: 1,
        },
      },
      context(root),
    );
    expect(report.failed?.decision).toBe("failed");
    expect(report.failed?.timedOut).toBe(true);
    expect(report.failed?.reason).toContain("timed out");
  }, 15_000);

  test("extensions run sorted by name and a reject stops the chain", async () => {
    const root = await repository();
    const sentinel = path.join(root, "beta-invoked.txt");
    const betaBody = [
      `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "x");`,
      'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT, JSON.stringify({ decision: "accept" }));',
    ].join("\n");
    const alphaBody =
      'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT,' +
      ' JSON.stringify({ decision: "reject", reason: "not yet" }))';
    const invoked: string[] = [];
    const resolutions: ExtensionResolution[] = [];
    const report = await invokeExtensions(
      {
        beta: { api: "1.0", command: script(betaBody), events: ["beforeCompletion"] },
        alpha: { api: "1.0", command: script(alphaBody), events: ["beforeCompletion"] },
      },
      context(root),
      {
        invoked: (invocation) => invoked.push(invocation.name),
        resolved: (resolution) => resolutions.push(resolution),
      },
    );
    expect(invoked).toEqual(["alpha"]);
    expect(resolutions.map((resolution) => resolution.decision)).toEqual(["reject"]);
    expect(report.rejected?.name).toBe("alpha");
    expect(existsSync(sentinel)).toBe(false);
  });

  test("an extension subprocess never sees provider credentials", async () => {
    const root = await repository();
    const capture = path.join(root, "env-keys.txt");
    const body = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(capture)}, Object.keys(process.env).join("\\n"));`,
      'fs.writeFileSync(process.env.FORGE_EXTENSION_RESULT, JSON.stringify({ decision: "accept" }));',
    ].join("\n");
    const previous = process.env["FORGE_API_KEY"];
    process.env["FORGE_API_KEY"] = "sk-test-secret";
    try {
      await invokeExtensions(
        { reviewer: { api: "1.0", command: script(body), events: ["beforeCompletion"] } },
        context(root),
      );
    } finally {
      if (previous === undefined) delete process.env["FORGE_API_KEY"];
      else process.env["FORGE_API_KEY"] = previous;
    }
    const keys = readFileSync(capture, "utf8").split("\n");
    expect(keys).not.toContain("FORGE_API_KEY");
    expect(keys).toContain("PATH");
    expect(keys).toContain("FORGE_EXTENSION_RESULT");
  });
});
