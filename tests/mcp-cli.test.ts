import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import type { RunEvent } from "../src/runtime.js";

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.mjs");

function capturedIO(): { readonly io: IO; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

interface ProviderHandle {
  readonly server: Server;
  readonly url: string;
  readonly requests: () => number;
}

/** Scripted turns: an MCP call, then a real edit, then completion. */
async function scriptedProvider(): Promise<ProviderHandle> {
  let requests = 0;
  let streamedTurns = 0;
  const server = createServer((request, response) => {
    requests += 1;
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
          ? 'MCP files hello {"name":"world"}\n'
          : streamedTurns === 2
            ? [
                "EDIT note.txt",
                "<<<<<<< SEARCH",
                "old",
                "=======",
                "new",
                ">>>>>>> REPLACE",
                "",
              ].join("\n")
            : "DONE changed note.txt\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests: () => requests };
}

async function repository(serverMode = "happy"): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-mcp-cli-")));
  writeFileSync(path.join(root, "note.txt"), "old\n");
  writeFileSync(
    path.join(root, "forge.json"),
    `${JSON.stringify(
      {
        verify: [
          [
            process.execPath,
            "-e",
            "const fs=require('node:fs'); if(fs.readFileSync('note.txt','utf8')!=='new\\n') process.exit(1)",
          ],
        ],
        mcp: { servers: { files: { command: [process.execPath, FIXTURE, serverMode] } } },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function streamedEvents(lines: readonly string[]): RunEvent[] {
  return lines
    .map((line) => JSON.parse(line) as { type?: string; event?: RunEvent })
    .filter((record) => record.type === "event" && record.event !== undefined)
    .map((record) => record.event as RunEvent);
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function withProviderAndRepo(serverMode = "happy") {
  const root = await repository(serverMode);
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  const provider = await scriptedProvider();
  cleanup.push(
    async () =>
      new Promise<void>((resolve, reject) =>
        provider.server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return { root, provider };
}

describe("mcp at the CLI boundary", () => {
  test("with --mcp the call is journalled through the ordinary action events", async () => {
    const { root, provider } = await withProviderAndRepo();
    const captured = capturedIO();
    const code = await main(
      [
        "run",
        "Say hello over MCP, then change note.txt from old to new.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--mcp",
        "--stream-json",
      ],
      captured.io,
    );
    expect(code).toBe(0);
    const events = streamedEvents(captured.out);
    const proposed = events.find(
      (event) =>
        event.type === "action.proposed" &&
        event.proposal.kind === "call" &&
        event.proposal.tool === "mcp",
    );
    expect(proposed).toMatchObject({
      proposal: {
        kind: "call",
        tool: "mcp",
        arguments: { server: "files", tool: "hello", arguments: { name: "world" } },
      },
    });
    const id = proposed?.type === "action.proposed" ? proposed.id : "";
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", id }));
    expect(events).toContainEqual(expect.objectContaining({ type: "action.started", id }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "action.finished",
        id,
        ok: true,
        output: "hello world\nsecond line",
      }),
    );
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("new\n");
  }, 30_000);

  test("an MCP proposal without --mcp fails with an actionable message, never silently", async () => {
    const { root, provider } = await withProviderAndRepo();
    const captured = capturedIO();
    const code = await main(
      [
        "run",
        "Say hello over MCP, then change note.txt from old to new.",
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
    const events = streamedEvents(captured.out);
    const finished = events.filter((event) => event.type === "action.finished");
    expect(finished[0]).toMatchObject({
      ok: false,
      output: expect.stringMatching(/--mcp/),
    });
  }, 30_000);

  test("a declared server that cannot start fails the run before the provider is contacted", async () => {
    const { root, provider } = await withProviderAndRepo("exit-now");
    const captured = capturedIO();
    const code = await main(
      [
        "run",
        "Say hello over MCP.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--mcp",
      ],
      captured.io,
    );
    expect(code).toBe(2);
    expect(provider.requests()).toBe(0);
    expect(captured.err.join("\n")).toMatch(/mcp server files/);
  }, 30_000);

  test("--mcp is refused outside headless run", async () => {
    const captured = capturedIO();
    const code = await main(["plan", "inspect things", "--mcp"], captured.io);
    expect(code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--mcp/);
  });
});
