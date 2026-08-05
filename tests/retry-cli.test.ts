/**
 * The repair loop that never ends.
 *
 * The gate already refuses a false completion and hands back a classified
 * failure. What it did not do was count. A model that cannot fix the failure --
 * because it is an infrastructure condition, or because its edits change
 * nothing observable -- re-reported completion every turn until the turn budget
 * ran out, and every one of those turns cost a full suite run.
 *
 * These tests drive the real headless loop against a scripted provider that
 * always claims completion, and assert that the run ends on the budget rather
 * than on the turn cap.
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
}

/**
 * Commits one real edit, then claims completion on every later turn.
 *
 * The edit matters: a run that commits nothing is now stopped by the
 * no-change rule before the retry budget is ever consulted, so a no-op model
 * cannot exercise budget exhaustion at all. This is the shape that can -- work
 * happened, and it simply does not fix the failing suite.
 */
async function claimsCompletion(): Promise<ProviderHandle> {
  let streamedTurns = 0;
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
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        );
        return;
      }
      streamedTurns += 1;
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
  return { server, url: `http://127.0.0.1:${address.port}/v1`, streamedTurns: () => streamedTurns };
}

/**
 * A repository whose verification always fails. `varying` makes the output
 * differ on every run, which is the difference between spending the class
 * budget and being stopped for making no progress.
 */
async function repository(varying: boolean): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-retry-cli-")));
  const counter = path.join(root, "attempts");
  const script = varying
    ? `const fs=require('node:fs');let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))}catch{};n+=1;fs.writeFileSync(${JSON.stringify(counter)},String(n));process.stdout.write('AssertionError: expected '+n+' to equal 0');process.exit(1)`
    : "process.stdout.write('AssertionError: expected 2 to equal 3');process.exit(1)";
  writeFileSync(path.join(root, "note.txt"), "old\n");
  writeFileSync(
    path.join(root, "forge.json"),
    `${JSON.stringify({ verify: [[process.execPath, "-e", script]] }, null, 2)}\n`,
  );
  return root;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function runAgainst(varying: boolean): Promise<{
  readonly code: number;
  readonly turns: number;
  readonly summary: string;
  readonly ok: boolean;
}> {
  const root = await repository(varying);
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
  return { code, turns: provider.streamedTurns(), summary: result.state.summary, ok: result.ok };
}

describe("bounded retry of a failing completion gate", () => {
  test("stops on an unchanged failure well before the turn budget", async () => {
    const outcome = await runAgainst(false);

    // One turn of real work, then three gates on an unchanged failure.
    expect(outcome.turns).toBe(4);
    expect(outcome.code).toBe(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("unchanged");
    expect(outcome.summary).toContain("not verified");
  }, 30_000);

  test("spends the class budget when the failure keeps changing, then stops", async () => {
    const outcome = await runAgainst(true);

    // One turn of real work, four retries for a test failure, then the fifth
    // gate ends the run.
    expect(outcome.turns).toBe(6);
    expect(outcome.code).toBe(1);
    expect(outcome.summary).toContain("retries allowed for test failures");
  }, 30_000);
});
