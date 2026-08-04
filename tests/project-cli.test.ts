import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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

function stream(response: import("node:http").ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
  );
}

describe("real-project repository navigation", () => {
  test("navigates a deep 200+ file project with search, ranged read, and relationships", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-project-cli-")));
    for (let index = 0; index < 220; index += 1) {
      const directory = path.join(root, "packages", "generated", String(index));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, `module-${index}.ts`),
        `export const generated${index} = ${index};\n`,
      );
    }
    mkdirSync(path.join(root, "packages", "api", "src", "routes"), { recursive: true });
    mkdirSync(path.join(root, "packages", "api", "src", "deep"), { recursive: true });
    writeFileSync(
      path.join(root, "packages", "api", "package.json"),
      JSON.stringify({ name: "@example/api" }),
    );
    writeFileSync(
      path.join(root, "packages", "api", "src", "routes", "health.test.ts"),
      'import { REQUEST_SENTINEL } from "../deep/handler";\nexport const healthTest = REQUEST_SENTINEL === 42;\n',
    );
    writeFileSync(
      path.join(root, "packages", "api", "src", "deep", "config.ts"),
      "export const API_VALUE = 42;\n",
    );
    writeFileSync(
      path.join(root, "packages", "api", "src", "deep", "handler.ts"),
      'import { API_VALUE } from "./config";\nexport const REQUEST_SENTINEL = API_VALUE;\n',
    );
    writeFileSync(
      path.join(root, "packages", "api", "src", "deep", "large.ts"),
      `${Array.from({ length: 120 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n")}\n`,
    );

    const streamRequests: string[] = [];
    const scripted = [
      "GLOB **/*.test.ts\n",
      "GREP REQUEST_SENTINEL\n",
      "READ packages/api/src/deep/large.ts:40-44\n",
      "RELATED packages/api/src/deep/handler.ts\n",
      "DONE inspected the project\n",
    ];
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "scripted-project" }] }));
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
        streamRequests.push(raw);
        stream(response, scripted[streamRequests.length - 1] ?? "DONE complete\n");
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("provider did not bind");
      const captured = capturedIO();

      const code = await main(
        [
          "plan",
          "Inspect this project: locate its tests, find REQUEST_SENTINEL, read lines 40-44 of the large API file, and identify the handler's dependencies, dependents, package, and related tests.",
          "--repo",
          root,
          "--url",
          `http://127.0.0.1:${address.port}/v1`,
          "--model",
          "scripted-project",
          "--json",
        ],
        captured.io,
      );
      const result = JSON.parse(captured.out.join("\n")) as {
        ok: boolean;
        mode: string;
        state: { committed: unknown[] };
      };

      expect(code).toBe(0);
      expect(captured.err).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("plan");
      expect(result.state.committed).toEqual([]);
      expect(streamRequests).toHaveLength(5);
      expect(streamRequests[0]).toContain("Repository index: 225 files");
      expect(streamRequests[1]).toContain("packages/api/src/routes/health.test.ts");
      expect(streamRequests[2]).toContain(
        "packages/api/src/deep/handler.ts:2: export const REQUEST_SENTINEL = API_VALUE;",
      );
      expect(streamRequests[3]).toContain("exact lines 40-44 of 121");
      expect(streamRequests[3]).toContain("export const line40 = 40;");
      expect(streamRequests[3]).toContain("export const line44 = 44;");
      expect(streamRequests[4]).toContain("Relationships for packages/api/src/deep/handler.ts");
      expect(streamRequests[4]).toContain("Package: packages/api");
      expect(streamRequests[4]).toContain("packages/api/src/deep/config.ts");
      expect(streamRequests[4]).toContain("packages/api/src/routes/health.test.ts");
      expect(streamRequests[4]).toContain("Related tests (1)");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
