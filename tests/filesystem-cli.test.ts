import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";

function capturedIO(): { readonly io: IO; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

describe("directory operation CLI regression", () => {
  test("removes a non-empty src directory and verifies its absence in one turn", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-directory-cli-")));
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    writeFileSync(path.join(root, "src", "game.ts"), "export const game = true;\n");
    writeFileSync(path.join(root, "src", "nested", "data.bin"), Buffer.from([0, 255]));
    let reviewRequest = "";
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "scripted-directory" }] }));
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
          messages?: Array<{ content?: string }>;
        };
        if (body.stream !== true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
          );
          return;
        }
        const reviewing = body.messages?.some((message) =>
          message.content?.includes("You are checking work that has already been applied"),
        );
        const content = reviewing ? "DONE src is absent" : "DELETE src\nDONE removed src\n";
        if (reviewing) reviewRequest = raw;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("provider did not bind");
      const captured = capturedIO();

      const code = await main(
        [
          "run",
          "Remove the src directory.",
          "--repo",
          root,
          "--url",
          `http://127.0.0.1:${address.port}/v1`,
          "--model",
          "scripted-directory",
          "--yes",
          "--json",
        ],
        captured.io,
      );
      const result = JSON.parse(captured.out.join("\n")) as {
        ok: boolean;
        state: { committed: Array<{ path: string }> };
      };

      expect(code).toBe(0);
      expect(captured.err).toEqual([]);
      expect(existsSync(path.join(root, "src"))).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.state.committed.map((entry) => entry.path)).toEqual([
        "src/game.ts",
        "src/nested/data.bin",
        "src/nested",
        "src",
      ]);
      expect(reviewRequest).toContain("src — deleted or moved away; the path no longer exists");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
