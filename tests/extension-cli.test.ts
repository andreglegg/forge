/**
 * The beforeCompletion extension point, end to end through headless `forge run`:
 * explicit opt-in, the bounded reject budget, fail-closed protocol errors, the
 * startup api gate, and the manifest snapshot a mid-run forge.json edit cannot
 * change.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";

function capturedIO(): { readonly io: IO; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

interface ProviderHandle {
  readonly server: Server;
  readonly url: string;
  readonly requests: () => readonly string[];
  readonly streamedTurns: () => number;
}

async function scriptedProvider(script: (turn: number) => string): Promise<ProviderHandle> {
  let streamedTurns = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "scripted" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as { stream?: boolean };
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        );
        return;
      }
      streamedTurns += 1;
      requests.push(raw);
      const content = script(streamedTurns);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider did not bind");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requests,
    streamedTurns: () => streamedTurns,
  };
}

const EDIT_NOTE = [
  "EDIT note.txt",
  "<<<<<<< SEARCH",
  "old",
  "=======",
  "new",
  ">>>>>>> REPLACE",
  "",
].join("\n");

async function repository(extensions?: Record<string, unknown>): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-extension-cli-")));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "note.txt"), "old\n");
  const config: Record<string, unknown> = { verify: [[process.execPath, "-e", "void 0"]] };
  if (extensions !== undefined) config["extensions"] = extensions;
  writeFileSync(path.join(root, "forge.json"), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

interface StreamEnvelope {
  readonly type: string;
  readonly event?: {
    readonly type: string;
    readonly name?: string;
    readonly decision?: string;
    readonly reason?: string;
  };
  readonly result?: {
    readonly ok: boolean;
    readonly extensions?: {
      readonly enabled: boolean;
      readonly ok: boolean;
      readonly resolutions: ReadonlyArray<{ readonly name: string; readonly decision: string }>;
    };
  };
}

function envelopes(out: readonly string[]): StreamEnvelope[] {
  return out.map((line) => JSON.parse(line) as StreamEnvelope);
}

function events(out: readonly string[]): NonNullable<StreamEnvelope["event"]>[] {
  return envelopes(out)
    .filter((envelope) => envelope.type === "event")
    .map((envelope) => envelope.event)
    .filter((event): event is NonNullable<StreamEnvelope["event"]> => event !== undefined);
}

async function withProvider(script: (turn: number) => string): Promise<ProviderHandle> {
  const provider = await scriptedProvider(script);
  cleanup.push(
    async () =>
      new Promise<void>((resolve, reject) =>
        provider.server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return provider;
}

describe("the beforeCompletion extension point", () => {
  test("a reject reopens the run with the reason and a later accept finishes it", async () => {
    const root = await repository({
      reviewer: {
        api: "1.0",
        command: [process.execPath, "reviewer.cjs"],
        events: ["beforeCompletion"],
      },
    });
    writeFileSync(
      path.join(root, "reviewer.cjs"),
      [
        'const fs = require("node:fs");',
        'const count = fs.existsSync("reviewer.count") ? Number(fs.readFileSync("reviewer.count", "utf8")) : 0;',
        'fs.writeFileSync("reviewer.count", String(count + 1));',
        "const decision = count === 0",
        '  ? { decision: "reject", reason: "add a second line to note.txt" }',
        '  : { decision: "accept" };',
        "fs.writeFileSync(process.env.FORGE_EXTENSION_RESULT, JSON.stringify(decision));",
      ].join("\n"),
    );
    const provider = await withProvider((turn) =>
      turn === 1 ? EDIT_NOTE : "DONE changed note.txt\n",
    );
    const captured = capturedIO();

    const code = await main(
      [
        "run",
        "Change note.txt from old to new.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--extensions",
        "--stream-json",
      ],
      captured.io,
    );

    expect(code).toBe(0);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("new\n");
    const observed = events(captured.out);
    const invoked = observed.filter((event) => event.type === "extension.invoked");
    expect(invoked.length).toBeGreaterThanOrEqual(2);
    expect(invoked[0]?.name).toBe("reviewer");
    const resolved = observed.filter((event) => event.type === "extension.resolved");
    expect(resolved.map((event) => event.decision)).toEqual(["reject", "accept"]);
    expect(resolved[0]?.reason).toBe("add a second line to note.txt");
    const reopened = observed.filter((event) => event.type === "run.reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.reason).toContain("reviewer");
    expect(reopened[0]?.reason).toContain("add a second line to note.txt");
    // The bounded reason became the next model input.
    expect(provider.requests().some((body) => body.includes("add a second line to note.txt"))).toBe(
      true,
    );
    const result = envelopes(captured.out).find((envelope) => envelope.type === "result")?.result;
    expect(result?.ok).toBe(true);
    expect(result?.extensions).toMatchObject({ enabled: true, ok: true });
    expect(result?.extensions?.resolutions.map((entry) => entry.decision)).toEqual([
      "reject",
      "accept",
    ]);
  }, 30_000);

  test("an extension writing garbage fails the run closed", async () => {
    const root = await repository({
      reviewer: {
        api: "1.0",
        command: [
          process.execPath,
          "-e",
          'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT, "definitely not json")',
        ],
        events: ["beforeCompletion"],
      },
    });
    const provider = await withProvider((turn) =>
      turn === 1 ? EDIT_NOTE : "DONE changed note.txt\n",
    );
    const captured = capturedIO();

    const code = await main(
      [
        "run",
        "Change note.txt from old to new.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--extensions",
        "--stream-json",
      ],
      captured.io,
    );

    expect(code).toBe(1);
    const observed = events(captured.out);
    const failed = observed.filter((event) => event.type === "run.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toContain("reviewer");
    const result = envelopes(captured.out).find((envelope) => envelope.type === "result")?.result;
    expect(result?.ok).toBe(false);
    expect(result?.extensions?.ok).toBe(false);
  }, 30_000);

  test("an always-reject extension spends exactly two reopens then fails with code 1", async () => {
    const root = await repository({
      reviewer: {
        api: "1.0",
        command: [
          process.execPath,
          "-e",
          'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT,' +
            ' JSON.stringify({ decision: "reject", reason: "still not right" }))',
        ],
        events: ["beforeCompletion"],
      },
    });
    const provider = await withProvider((turn) =>
      turn === 1 ? EDIT_NOTE : "DONE changed note.txt\n",
    );
    const captured = capturedIO();

    const code = await main(
      [
        "run",
        "Change note.txt from old to new.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--extensions",
        "--stream-json",
      ],
      captured.io,
    );

    expect(code).toBe(1);
    const observed = events(captured.out);
    expect(observed.filter((event) => event.type === "run.reopened")).toHaveLength(2);
    expect(
      observed.filter(
        (event) => event.type === "extension.resolved" && event.decision === "reject",
      ),
    ).toHaveLength(3);
    const failed = observed.filter((event) => event.type === "run.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toContain("reject");
  }, 30_000);

  test("a manifest without --extensions executes nothing", async () => {
    const root = await repository({
      reviewer: {
        api: "1.0",
        command: [
          process.execPath,
          "-e",
          'require("node:fs").writeFileSync("invoked.txt", "x");' +
            'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT, JSON.stringify({ decision: "accept" }))',
        ],
        events: ["beforeCompletion"],
      },
    });
    const provider = await withProvider((turn) =>
      turn === 1 ? EDIT_NOTE : "DONE changed note.txt\n",
    );
    const captured = capturedIO();

    const code = await main(
      [
        "run",
        "Change note.txt from old to new.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--stream-json",
      ],
      captured.io,
    );

    expect(code).toBe(0);
    expect(existsSync(path.join(root, "invoked.txt"))).toBe(false);
    const observed = events(captured.out);
    expect(observed.some((event) => event.type.startsWith("extension."))).toBe(false);
    const result = envelopes(captured.out).find((envelope) => envelope.type === "result")?.result;
    expect(result?.extensions).toMatchObject({ enabled: false });
  }, 30_000);

  test("a declared api this Forge does not implement is refused before provider preflight", async () => {
    for (const api of ["2.0", "1.1"]) {
      const root = await repository({
        reviewer: {
          api,
          command: [process.execPath, "-e", "void 0"],
          events: ["beforeCompletion"],
        },
      });
      const captured = capturedIO();
      const code = await main(
        [
          "run",
          "Change note.txt from old to new.",
          "--repo",
          root,
          "--url",
          "http://127.0.0.1:1/v1",
          "--model",
          "none",
          "--yes",
          "--extensions",
        ],
        captured.io,
      );
      expect(code).toBe(2);
      const message = captured.err.join("\n");
      expect(message).toContain("reviewer");
      expect(message).toContain(api);
      expect(message).toContain("1.0");
      expect(message).not.toContain("preflight");
    }
  }, 30_000);

  test("--extensions is refused outside headless forge run", async () => {
    const root = await repository();
    const captured = capturedIO();
    const code = await main(["plan", "look around", "--repo", root, "--extensions"], captured.io);
    expect(code).toBe(2);
    expect(captured.err.join("\n")).toContain("--extensions");
  });

  test("a mid-run forge.json edit cannot change the active extension set", async () => {
    const root = await repository({
      watcher: {
        api: "1.0",
        command: [process.execPath, "ext-a.cjs"],
        events: ["beforeCompletion"],
      },
    });
    const extension = (sentinel: string): string =>
      [
        `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "x");`,
        'require("node:fs").writeFileSync(process.env.FORGE_EXTENSION_RESULT, JSON.stringify({ decision: "accept" }));',
      ].join("\n");
    writeFileSync(path.join(root, "ext-a.cjs"), extension("ext-a-invoked.txt"));
    writeFileSync(path.join(root, "ext-b.cjs"), extension("ext-b-invoked.txt"));
    const editManifest = [
      "EDIT forge.json",
      "<<<<<<< SEARCH",
      '        "ext-a.cjs"',
      "=======",
      '        "ext-b.cjs"',
      ">>>>>>> REPLACE",
      "",
    ].join("\n");
    const provider = await withProvider((turn) =>
      turn === 1 ? editManifest : "DONE updated the configuration\n",
    );
    const captured = capturedIO();

    const code = await main(
      [
        "run",
        "Update the project configuration.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--extensions",
        "--json",
      ],
      captured.io,
    );

    expect(code).toBe(0);
    expect(readFileSync(path.join(root, "forge.json"), "utf8")).toContain("ext-b.cjs");
    expect(existsSync(path.join(root, "ext-a-invoked.txt"))).toBe(true);
    expect(existsSync(path.join(root, "ext-b-invoked.txt"))).toBe(false);
  }, 30_000);
});
