import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

interface ScriptedProvider {
  readonly server: Server;
  readonly url: string;
  readonly reviewRequest: () => string;
}

async function provider(): Promise<ScriptedProvider> {
  let reviewRequest = "";
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "scripted-delete" }] }));
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
      const body = JSON.parse(raw) as {
        stream?: boolean;
        messages?: Array<{ role?: string; content?: string }>;
      };
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        );
        return;
      }
      const checking = body.messages?.some((message) =>
        message.content?.includes("You are checking work that has already been applied"),
      );
      const content = checking
        ? "DONE both requested paths are absent"
        : ["DELETE src/game.ts", "DELETE src/index.ts", "DONE deleted both files", ""].join("\n");
      if (checking) reviewRequest = raw;
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
    reviewRequest: () => reviewRequest,
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("delete CLI regression", () => {
  test("deletes both files from one model turn and verifies their absence without tests", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-delete-cli-")));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "game.ts"), "export const game = true;\n");
    writeFileSync(path.join(root, "src", "index.ts"), "export * from './game.js';\n");
    const scripted = await provider();
    cleanup.push(
      async () =>
        new Promise<void>((resolve, reject) =>
          scripted.server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const captured = capturedIO();

    const code = await main(
      [
        "run",
        "Delete src/game.ts and src/index.ts.",
        "--repo",
        root,
        "--url",
        scripted.url,
        "--model",
        "scripted-delete",
        "--yes",
        "--json",
      ],
      captured.io,
    );
    const result = JSON.parse(captured.out.join("\n")) as {
      ok: boolean;
      state: { committed: Array<{ path: string; added: number; removed: number }> };
    };

    expect(code).toBe(0);
    expect(captured.err).toEqual([]);
    expect(existsSync(path.join(root, "src", "game.ts"))).toBe(false);
    expect(existsSync(path.join(root, "src", "index.ts"))).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      state: {
        committed: [
          { path: "src/game.ts", added: 0 },
          { path: "src/index.ts", added: 0 },
        ],
      },
    });
    expect(scripted.reviewRequest()).toContain("src/game.ts — deleted; the path no longer exists");
    expect(scripted.reviewRequest()).toContain("src/index.ts — deleted; the path no longer exists");
  }, 30_000);
});
