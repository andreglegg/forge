import { readFileSync, realpathSync, writeFileSync } from "node:fs";
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

async function scriptedProvider(): Promise<ProviderHandle> {
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
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    streamedTurns: () => streamedTurns,
  };
}

async function repository(startHookFails = false): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-hooks-cli-")));
  const marker = path.join(root, "hooks.log");
  const append = (value: string): string[] => [
    process.execPath,
    "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${value}\n`)})`,
  ];
  const appendVerified = (value: string): string[] => [
    process.execPath,
    "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${value}:`)} + process.env.FORGE_VERIFIED + '\\n')`,
  ];
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
        hooks: {
          sessionStart: startHookFails
            ? [[process.execPath, "-e", "process.stderr.write('start blocked'); process.exit(9)"]]
            : [append("start")],
          beforeVerify: [append("before")],
          afterVerify: [appendVerified("after")],
          sessionEnd: [appendVerified("end")],
        },
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

describe("headless lifecycle hooks", () => {
  test("records every enabled lifecycle phase in the final result", async () => {
    const root = await repository();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const provider = await scriptedProvider();
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
        "--hooks",
        "--json",
      ],
      captured.io,
    );
    const result = JSON.parse(captured.out.join("\n")) as {
      hooks: {
        enabled: boolean;
        ok: boolean;
        reports: Array<{ event: string; ok: boolean }>;
      };
    };

    expect(code).toBe(0);
    expect(captured.err).toEqual([]);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("new\n");
    expect(readFileSync(path.join(root, "hooks.log"), "utf8")).toBe(
      "start\nbefore\nafter:true\nend:true\n",
    );
    expect(result.hooks).toMatchObject({
      enabled: true,
      ok: true,
      reports: [
        { event: "sessionStart", ok: true },
        { event: "beforeVerify", ok: true },
        { event: "afterVerify", ok: true },
        { event: "sessionEnd", ok: true },
      ],
    });
  }, 30_000);

  test("a failing start hook prevents streamed model generation", async () => {
    const root = await repository(true);
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const provider = await scriptedProvider();
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
        "--hooks",
        "--json",
      ],
      captured.io,
    );
    const result = JSON.parse(captured.out.join("\n")) as {
      usage: { turns: number };
      hooks: { ok: boolean; reports: Array<{ event: string; ok: boolean }> };
    };

    expect(code).toBe(2);
    expect(captured.err).toEqual([]);
    expect(provider.streamedTurns()).toBe(0);
    expect(result.usage.turns).toBe(0);
    expect(result.hooks).toMatchObject({
      ok: false,
      reports: [
        { event: "sessionStart", ok: false },
        { event: "sessionEnd", ok: true },
      ],
    });
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("old\n");
  }, 30_000);
});
