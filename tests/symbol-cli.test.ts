import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import { revisionOfContent } from "../src/workspace.js";

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

describe("symbol navigation through the CLI", () => {
  test("returns revision-bound declaration locations to the next model turn", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-symbol-cli-")));
    for (let index = 0; index < 220; index += 1) {
      const directory = path.join(root, "packages", "generated", String(index));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, `module-${index}.ts`),
        `export const generated${index} = ${index};\n`,
      );
    }
    const targetDirectory = path.join(root, "packages", "api", "src", "billing");
    mkdirSync(targetDirectory, { recursive: true });
    const source = [
      "export class InvoiceService {",
      "  calculateTotal(): number { return 42; }",
      "}",
      "",
    ].join("\n");
    writeFileSync(path.join(targetDirectory, "invoice-service.ts"), source);
    writeFileSync(
      path.join(targetDirectory, "checkout.ts"),
      [
        'import { InvoiceService as BillingService } from "./invoice-service";',
        "export function checkout(): BillingService { return new BillingService(); }",
        "",
      ].join("\n"),
    );

    const streamRequests: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "scripted-symbol" }] }));
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
        const scripted = ["SYMBOL InvoiceService\n", "CALLERS InvoiceService\n", "DONE found it\n"];
        stream(response, scripted[streamRequests.length - 1] ?? "DONE found it\n");
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
          "Find the declaration and direct constructor callers of InvoiceService with exact locations.",
          "--repo",
          root,
          "--url",
          `http://127.0.0.1:${address.port}/v1`,
          "--model",
          "scripted-symbol",
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
      expect(result).toMatchObject({ ok: true, mode: "plan", state: { committed: [] } });
      expect(streamRequests).toHaveLength(3);
      expect(streamRequests[0]).toContain("Repository index: 222 files");
      expect(streamRequests[1]).toContain("Symbol declarations for InvoiceService (1)");
      expect(streamRequests[1]).toContain(
        "class InvoiceService — packages/api/src/billing/invoice-service.ts:1:14-1:28 [exported]",
      );
      expect(streamRequests[1]).toContain(`[rev ${revisionOfContent(source).slice(0, 12)}]`);
      expect(streamRequests[1]).toContain("TypeScript compiler syntax tree");
      expect(streamRequests[2]).toContain("Semantic callers for InvoiceService (1)");
      expect(streamRequests[2]).toContain(
        "checkout — packages/api/src/billing/checkout.ts:2:57-2:71",
      );
      expect(streamRequests[2]).toContain("checker-resolved direct calls and constructor calls");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
