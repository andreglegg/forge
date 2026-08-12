/**
 * `forge serve` end to end: the real headless orchestration behind the stdio
 * transport, against a scripted HTTP provider.
 *
 * The load-bearing claim is the approval seam. A headless run without --yes
 * auto-denies every approval because nobody can answer; under serve, the wire
 * client stands exactly where the TTY user stands, so the decision that
 * resolves `approval.requested` is the client's -- and everything else
 * (assembly, permission mode, gate, session journal) is byte-identical to
 * `forge run`.
 */

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { type IO, main } from "../src/cli.js";
import type { RunEvent } from "../src/runtime.js";

interface ProviderHandle {
  readonly server: Server;
  readonly url: string;
  readonly modelProbes: () => number;
}

/**
 * Scripted provider: first streamed turn proposes one EDIT, every later one
 * claims completion. `editThenDone: false` claims completion from the start,
 * for runs that must commit nothing.
 */
async function scriptedProvider(editThenDone: boolean): Promise<ProviderHandle> {
  let streamedTurns = 0;
  let modelProbes = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      modelProbes += 1;
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
        editThenDone && streamedTurns === 1
          ? [
              "EDIT note.txt",
              "<<<<<<< SEARCH",
              "old",
              "=======",
              "new",
              ">>>>>>> REPLACE",
              "",
            ].join("\n")
          : "DONE finished\n";
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
    modelProbes: () => modelProbes,
  };
}

/** A repository whose verification always passes, so the gate reflects the run. */
async function repository(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-serve-cli-")));
  writeFileSync(path.join(root, "note.txt"), "old\n");
  writeFileSync(
    path.join(root, "forge.json"),
    `${JSON.stringify({ verify: [[process.execPath, "-e", "process.exit(0)"]] }, null, 2)}\n`,
  );
  return root;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

interface WireResult {
  readonly ok: boolean;
  readonly mode: string;
  readonly session: string;
}

interface Wire {
  readonly code: number;
  readonly lines: string[];
  readonly events: RunEvent[];
  readonly results: WireResult[];
}

/**
 * Spawn-shaped client: reacts to the server's own output, with reactions
 * deferred a macrotask the way real pipe I/O would be.
 */
async function client(
  root: string,
  url: string,
  extraArgs: readonly string[],
  react: (document: Record<string, unknown>, write: (request: unknown) => void) => void,
): Promise<Wire> {
  const input = new PassThrough();
  const write = (request: unknown): void => {
    input.write(`${JSON.stringify(request)}\n`);
  };
  const lines: string[] = [];
  const io: IO = {
    out: (text) => {
      lines.push(text);
      const document = JSON.parse(text) as Record<string, unknown>;
      setImmediate(() => react(document, write));
    },
    err: () => undefined,
  };
  const code = await main(
    [
      "serve",
      "--repo",
      root,
      "--url",
      url,
      "--model",
      "scripted",
      "--max-turns",
      "2",
      ...extraArgs,
    ],
    io,
    input,
  );
  input.end();
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    code,
    lines,
    events: parsed
      .filter((document) => document["type"] === "event")
      .map((document) => document["event"] as RunEvent),
    results: parsed
      .filter((document) => document["type"] === "result")
      .map((document) => document["result"] as unknown as WireResult),
  };
}

async function scenario(
  editThenDone: boolean,
): Promise<{ root: string; provider: ProviderHandle }> {
  const root = await repository();
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  const provider = await scriptedProvider(editThenDone);
  cleanup.push(
    async () =>
      new Promise<void>((resolve, reject) =>
        provider.server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return { root, provider };
}

describe("forge serve", () => {
  test("an approval is resolved by the wire client, not by the headless auto-deny", async () => {
    const { root, provider } = await scenario(true);
    const wire = await client(root, provider.url, [], (document, write) => {
      if (document["type"] === "contract") write({ type: "run.start", task: "apply the change" });
      const event = document["event"] as RunEvent | undefined;
      if (document["type"] === "event" && event?.type === "approval.requested") {
        write({ type: "approve", id: event.id, decision: "once" });
      }
      if (document["type"] === "result") write({ type: "shutdown" });
    });

    expect(wire.code).toBe(0);
    const header = JSON.parse(wire.lines[0] ?? "") as {
      type: string;
      contract: { requests: string[] };
    };
    expect(header.type).toBe("contract");
    expect(header.contract.requests).toContain("run.start");
    const requestedAt = wire.events.findIndex((event) => event.type === "approval.requested");
    const committedAt = wire.events.findIndex((event) => event.type === "mutation.committed");
    expect(requestedAt).toBeGreaterThanOrEqual(0);
    expect(committedAt).toBeGreaterThan(requestedAt);
    const resolved = wire.events.find((event) => event.type === "approval.resolved");
    expect(resolved).toMatchObject({ decision: "once" });
    expect(wire.results).toHaveLength(1);
    expect(wire.results[0]?.ok).toBe(true);
  }, 30_000);

  test("a wire denial commits nothing and the run fails by the existing denial semantics", async () => {
    const { root, provider } = await scenario(true);
    const wire = await client(root, provider.url, [], (document, write) => {
      if (document["type"] === "contract") write({ type: "run.start", task: "apply the change" });
      const event = document["event"] as RunEvent | undefined;
      if (document["type"] === "event" && event?.type === "approval.requested") {
        write({ type: "approve", id: event.id, decision: "deny" });
      }
      if (document["type"] === "result") write({ type: "shutdown" });
    });

    expect(wire.code).toBe(0);
    expect(wire.events.some((event) => event.type === "mutation.committed")).toBe(false);
    const resolved = wire.events.find((event) => event.type === "approval.resolved");
    expect(resolved).toMatchObject({ decision: "deny" });
    expect(wire.results).toHaveLength(1);
    expect(wire.results[0]?.ok).toBe(false);
    // Permission-mode resolution is identical to `forge run`.
    expect(wire.results[0]?.mode).toBe("workspace");
  }, 30_000);

  test("a wire cancel is journalled exactly once and ends the run before the gate", async () => {
    // The dangerous window: the cancel lands while the model's next turn is a
    // bare DONE with no proposals. A swallowed cancel here used to finish
    // ok:true, run the project's verify commands the client had just tried to
    // stop, and leave zero trace of the client's decision in the journal.
    const { root, provider } = await scenario(true);
    const wire = await client(root, provider.url, [], (document, write) => {
      if (document["type"] === "contract") write({ type: "run.start", task: "apply the change" });
      const event = document["event"] as RunEvent | undefined;
      if (document["type"] === "event" && event?.type === "approval.requested") {
        write({ type: "approve", id: event.id, decision: "once" });
      }
      if (document["type"] === "event" && event?.type === "mutation.committed") {
        write({ type: "cancel" });
      }
      if (document["type"] === "result") write({ type: "shutdown" });
    });

    expect(wire.code).toBe(0);
    // Exactly one run.cancelled in the journal (design risk 37): the client's
    // decision is evidence, and idempotent evidence.
    expect(wire.events.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    // No completion claim survives the cancel, and the gate never runs.
    expect(wire.events.some((event) => event.type === "run.finished" && event.ok)).toBe(false);
    expect(wire.events.some((event) => event.type === "verification.started")).toBe(false);
    expect(wire.results).toHaveLength(1);
    expect(wire.results[0]?.ok).toBe(false);
  }, 30_000);

  test("serial runs share one process: two results, two journals, one provider probe", async () => {
    const { root, provider } = await scenario(false);
    let started = 0;
    const wire = await client(root, provider.url, ["--yes"], (document, write) => {
      if (document["type"] === "contract") {
        started += 1;
        write({ type: "run.start", task: "first task" });
      }
      if (document["type"] === "result") {
        if (started === 1) {
          started += 1;
          write({ type: "run.start", task: "second task" });
        } else {
          write({ type: "shutdown" });
        }
      }
    });

    expect(wire.code).toBe(0);
    expect(wire.results).toHaveLength(2);
    const [first, second] = wire.results;
    expect(first?.session).toBeTruthy();
    expect(second?.session).toBeTruthy();
    expect(first?.session).not.toBe(second?.session);
    for (const result of wire.results) {
      expect(existsSync(path.join(root, ".forge", "sessions", `${result.session}.jsonl`))).toBe(
        true,
      );
    }
    // Assembly and preflight are paid once per process, not once per run.
    expect(provider.modelProbes()).toBe(1);
  }, 30_000);

  test("a preflight failure still announces the contract before the error", async () => {
    const root = await repository();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const input = new PassThrough();
    const lines: string[] = [];
    const io: IO = { out: (text) => lines.push(text), err: () => undefined };

    const code = await main(
      ["serve", "--repo", root, "--url", "http://127.0.0.1:1/v1", "--model", "none"],
      io,
      input,
    );

    expect(code).toBe(2);
    expect((JSON.parse(lines[0] ?? "") as { type: string }).type).toBe("contract");
    expect((JSON.parse(lines[1] ?? "") as { type: string }).type).toBe("error");
  }, 30_000);
});
