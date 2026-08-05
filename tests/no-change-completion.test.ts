/**
 * The false success.
 *
 * Observed driving a 14B through a real build: the model was asked to add
 * `parseAmount` to `src/money.js`, failed to apply any edit, said so in its own
 * final message ("I am unable to proceed with the requested changes"), and the
 * run exited **0** with `ok: true` and an empty `committed` list. The gate had
 * run `npm test`, the pre-existing suite was green, and a green suite was taken
 * as evidence that the task was done.
 *
 * It is the exact failure this package says matters most -- a confident wrong
 * finish -- and it was structural: doing nothing keeps a green suite green, so
 * verification cannot distinguish success from inaction. The gate needs the one
 * fact verification does not carry, which is whether anything changed at all.
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

/** Claims completion immediately, every turn, and never proposes an action. */
async function claimsCompletion(): Promise<{ server: Server; url: string; turns: () => number }> {
  let turns = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "scripted" }] }));
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
      turns += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "DONE unable to proceed, but calling it done\n" } }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/v1`, turns: () => turns };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** A repository whose suite passes before anything is asked of it. */
async function greenRepository(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-nochange-")));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "ok.js"), "process.exit(0)\n");
  writeFileSync(
    path.join(root, "forge.json"),
    `${JSON.stringify({ verify: [[process.execPath, "ok.js"]] }, null, 2)}\n`,
  );
  return root;
}

describe("a completion that changed nothing", () => {
  test("is refused, and the run fails instead of reporting success", async () => {
    const root = await greenRepository();
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
        "Add parseAmount to src/money.js.",
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
      state: { committed: unknown[]; summary: string };
    };

    expect(result.state.committed).toHaveLength(0);
    expect(code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.state.summary).toMatch(/nothing|no change/i);
    // Pushed back on once before giving up, rather than either accepting the
    // claim or spending all twelve turns on a model that has stopped working.
    expect(provider.turns()).toBe(2);
  }, 60_000);

  test("a named deliverable that was never written is refused", async () => {
    // The live failure: work landed, the suite stayed green because a file that
    // does not exist breaks nothing, and Forge exited 0.
    const root = await greenRepository();
    writeFileSync(path.join(root, "note.txt"), "old\n");
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
        "Add clamp to note.txt. Add tests/clamp.test.js with cases.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--max-turns",
        "4",
        "--json",
      ],
      captured.io,
    );

    expect(code).not.toBe(0);
    const result = JSON.parse(captured.out.join("\n")) as { ok: boolean };
    expect(result.ok).toBe(false);
  }, 60_000);

  test("a run that did commit something is still gated only by verification", async () => {
    const root = await greenRepository();
    writeFileSync(path.join(root, "note.txt"), "old\n");
    const provider = await (async () => {
      let turns = 0;
      const server = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: "scripted" }] }));
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
          turns += 1;
          const content =
            turns === 1
              ? [
                  "EDIT note.txt",
                  "<<<<<<< SEARCH",
                  "old",
                  "=======",
                  "new",
                  ">>>>>>> REPLACE",
                  "",
                ].join("\n")
              : "DONE changed the note\n";
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no bind");
      return { server, url: `http://127.0.0.1:${address.port}/v1` };
    })();
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
        "Change note.txt from old to new.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--json",
      ],
      captured.io,
    );

    expect(code).toBe(0);
    const result = JSON.parse(captured.out.join("\n")) as { ok: boolean };
    expect(result.ok).toBe(true);
  }, 60_000);
});
