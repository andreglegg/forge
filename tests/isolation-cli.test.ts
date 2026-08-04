import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function capturedIO(): { readonly io: IO; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

async function repository(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-isolation-cli-")));
  git(root, "init");
  git(root, "config", "user.email", "forge-tests@example.invalid");
  git(root, "config", "user.name", "Forge Tests");
  writeFileSync(path.join(root, ".gitignore"), ".forge/\n");
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
      },
      null,
      2,
    )}\n`,
  );
  git(root, "add", ".gitignore", "note.txt", "forge.json");
  git(root, "commit", "-m", "initial");
  return root;
}

async function scriptedProvider(): Promise<{ readonly server: Server; readonly url: string }> {
  let streamingTurn = 0;
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
      streamingTurn += 1;
      const text =
        streamingTurn % 2 === 1
          ? [
              "EDIT note.txt",
              "<<<<<<< SEARCH",
              "old",
              "=======",
              "new",
              ">>>>>>> REPLACE",
              "",
            ].join("\n")
          : "DONE changed note.txt from old to new\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("isolated CLI runs", () => {
  test("retains an unpromoted patch, then promotes a separately verified run", async () => {
    const root = await repository();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const provider = await scriptedProvider();
    cleanup.push(
      async () =>
        new Promise<void>((resolve, reject) =>
          provider.server.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const retained = capturedIO();
    const retainedCode = await main(
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
        "--isolate",
        "--json",
      ],
      retained.io,
    );
    const retainedResult = JSON.parse(retained.out.join("\n")) as {
      session: string;
      isolation: { patch: string; changed: boolean; promoted: boolean; errors: string[] };
    };

    expect(retainedCode).toBe(0);
    expect(retained.err).toEqual([]);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("old\n");
    expect(retainedResult.isolation).toMatchObject({
      changed: true,
      promoted: false,
      errors: [],
    });
    expect(existsSync(path.join(root, retainedResult.isolation.patch))).toBe(true);
    expect(
      existsSync(path.join(root, ".forge", "sessions", `${retainedResult.session}.jsonl`)),
    ).toBe(true);

    const promoted = capturedIO();
    const promotedCode = await main(
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
        "--isolate",
        "--promote",
        "--json",
      ],
      promoted.io,
    );
    const promotedResult = JSON.parse(promoted.out.join("\n")) as {
      isolation: { changed: boolean; promoted: boolean; errors: string[] };
    };

    expect(promotedCode).toBe(0);
    expect(promoted.err).toEqual([]);
    expect(promotedResult.isolation).toMatchObject({
      changed: true,
      promoted: true,
      errors: [],
    });
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("new\n");
    expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("M note.txt");
  }, 30_000);
});
