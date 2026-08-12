/**
 * The executable proof of the adapter slice: a repository whose suite exits 0
 * while printing FAIL cannot finish a headless run as ok:true once an adapter
 * names that output a failure.
 *
 * This drives the real headless loop against a scripted provider, exactly like
 * tests/retry-cli.test.ts, because the property under test spans the whole
 * gate: config loading, verification, formatting, and the retry budget.
 */

import { realpathSync, writeFileSync } from "node:fs";
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

interface ProviderHandle {
  readonly server: Server;
  readonly url: string;
  readonly streamedTurns: () => number;
  readonly requests: readonly string[];
}

/** Commits one real edit, then claims completion on every later turn. */
async function claimsCompletion(): Promise<ProviderHandle> {
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
      const content =
        streamedTurns === 1
          ? [
              "EDIT note.txt",
              "<<<<<<< SEARCH",
              "old",
              "=======",
              "new",
              ">>>>>>> REPLACE",
              "",
            ].join("\n")
          : "DONE fixed it\n";
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
    streamedTurns: () => streamedTurns,
    requests,
  };
}

/** A suite that prints a failure and then exits 0: the exact shape the adapter exists for. */
async function repository(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-adapter-cli-")));
  const command = [
    process.execPath,
    "-e",
    "process.stdout.write('1 failing FAIL: expected 2 to equal 3');process.exit(0)",
  ];
  writeFileSync(path.join(root, "note.txt"), "old\n");
  writeFileSync(
    path.join(root, "forge.json"),
    `${JSON.stringify(
      {
        verify: [command],
        verifyAdapters: [{ command, failWhen: "\\bFAIL\\b", evidence: "FAIL" }],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("the adapter-gated completion gate", () => {
  test("an exit-0-but-failing suite cannot end a run as ok:true", async () => {
    const root = await repository();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const provider = await claimsCompletion();
    cleanup.push(
      async () =>
        new Promise<void>((resolve, reject) =>
          provider.server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const captured = capturedIO();

    const code = await main(
      [
        "run",
        "Make the failing check pass.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--max-turns",
        "12",
        "--json",
      ],
      captured.io,
    );
    const result = JSON.parse(captured.out.join("\n")) as {
      ok: boolean;
      state: { summary: string };
    };

    expect(code).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.state.summary).toContain("not verified");
    // One turn of real work, then three gates on an unchanged adapter failure:
    // the no-progress detector must see an exit-0 failure, or the run would
    // burn the whole class budget on identical output.
    expect(provider.streamedTurns()).toBe(4);
    // The objection the model saw names the class of failure correctly.
    const objections = provider.requests.filter((raw) =>
      raw.includes("exited 0, but the configured failure pattern matched"),
    );
    expect(objections.length).toBeGreaterThan(0);
  }, 30_000);
});
