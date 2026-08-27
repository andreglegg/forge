/**
 * Doctor surfaces the profile recommendation as advisory output only.
 *
 * The probe already discovers advertised model ids and an optional context
 * window; doctor now cross-checks them against the configured profiles. The
 * recommendation is never applied: forge.json must be byte-identical after the
 * run, exit-code semantics are unchanged, and adopting a profile stays an
 * explicit user action named in the output.
 */

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

interface StubHandle {
  readonly server: Server;
  readonly url: string;
}

/** Advertises two models with distinct context windows and answers the probe completion. */
async function advertisingStub(): Promise<StubHandle> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "served", context_length: 65536 },
            { id: "big-model", context_length: 131072 },
          ],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        );
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}

async function unavailableStub(): Promise<StubHandle> {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("model server unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}

async function repository(config: object): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-doctor-recommend-")));
  writeFileSync(path.join(root, "forge.json"), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

interface DoctorJson {
  readonly ok: boolean;
  readonly nextSteps: readonly string[];
  readonly recommendation: {
    readonly recommended: string | null;
    readonly reason: string | null;
    readonly selectedFits: boolean;
    readonly mismatches: readonly { name: string; reason: string }[];
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(config: object): Promise<{ root: string; url: string }> {
  const root = await repository(config);
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  const stub = await advertisingStub();
  cleanup.push(
    async () =>
      new Promise<void>((resolve, reject) =>
        stub.server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return { root, url: stub.url };
}

describe("doctor profile recommendation", () => {
  test("names the fitting profile in --json and never touches forge.json", async () => {
    const { root, url } = await setup({
      model: "served",
      profiles: { bad: { model: "absent" }, good: { model: "served", contextWindow: 32768 } },
    });
    const before = readFileSync(path.join(root, "forge.json"));

    const captured = capturedIO();
    const code = await main(["doctor", "--repo", root, "--url", url, "--json"], captured.io);

    const parsed = JSON.parse(captured.out.join("\n")) as DoctorJson;
    expect(code).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.recommendation.recommended).toBe("good");
    expect(parsed.recommendation.mismatches).toEqual([
      { name: "bad", reason: expect.stringContaining("not advertised") },
    ]);
    expect(readFileSync(path.join(root, "forge.json"))).toEqual(before);
  }, 30_000);

  test("keeps exit 2 on a failed probe while naming the fitting alternative", async () => {
    const config = {
      profile: "big",
      profiles: { big: { model: "absent" }, fit: { model: "served" } },
    };
    const { root, url } = await setup(config);

    const json = capturedIO();
    const jsonCode = await main(["doctor", "--repo", root, "--url", url, "--json"], json.io);
    const human = capturedIO();
    const humanCode = await main(["doctor", "--repo", root, "--url", url], human.io);

    const parsed = JSON.parse(json.out.join("\n")) as DoctorJson;
    expect(jsonCode).toBe(2);
    expect(humanCode).toBe(2);
    expect(parsed.recommendation.recommended).toBe("fit");
    expect(parsed.recommendation.selectedFits).toBe(false);
    const lines = [...human.out, ...human.err].join("\n");
    expect(lines).toContain("profile big does not fit");
    expect(lines).toContain("--profile fit");
  }, 30_000);

  test("does not judge another model's window by the selected model's entry", async () => {
    // The probe carries served's 65536 window; a profile targeting big-model
    // with its own 131072 window must be recommended, not rejected against it.
    const { root, url } = await setup({
      model: "served",
      profiles: { grand: { model: "big-model", contextWindow: 131072 } },
    });

    const json = capturedIO();
    const code = await main(["doctor", "--repo", root, "--url", url, "--json"], json.io);

    const parsed = JSON.parse(json.out.join("\n")) as DoctorJson;
    expect(code).toBe(0);
    expect(parsed.recommendation.mismatches).toEqual([]);
    expect(parsed.recommendation.recommended).toBe("grand");
  }, 30_000);

  test("stays silent when forge.json defines no profiles", async () => {
    const { root, url } = await setup({ model: "served" });

    const json = capturedIO();
    const jsonCode = await main(["doctor", "--repo", root, "--url", url, "--json"], json.io);
    const human = capturedIO();
    const humanCode = await main(["doctor", "--repo", root, "--url", url], human.io);

    const parsed = JSON.parse(json.out.join("\n")) as DoctorJson;
    expect(jsonCode).toBe(0);
    expect(humanCode).toBe(0);
    expect(parsed.recommendation).toEqual({
      recommended: null,
      reason: null,
      selectedFits: true,
      mismatches: [],
    });
    expect([...human.out, ...human.err].join("\n")).not.toContain("--profile");
  }, 30_000);

  test("turns an unhealthy first-run setup into concrete next steps", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-doctor-first-run-")));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    const stub = await unavailableStub();
    cleanup.push(
      async () =>
        new Promise<void>((resolve, reject) =>
          stub.server.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const json = capturedIO();
    const jsonCode = await main(["doctor", "--repo", root, "--url", stub.url, "--json"], json.io);
    const human = capturedIO();
    const humanCode = await main(["doctor", "--repo", root, "--url", stub.url], human.io);

    const parsed = JSON.parse(json.out.join("\n")) as DoctorJson;
    const lines = [...human.out, ...human.err].join("\n");
    expect(jsonCode).toBe(2);
    expect(humanCode).toBe(2);
    expect(parsed.nextSteps).toEqual([
      expect.stringMatching(/forge init/i),
      expect.stringMatching(/--url <base-url>/i),
    ]);
    expect(lines).toMatch(/config.*detected defaults/i);
    expect(lines).toMatch(/next:.*forge init/i);
    expect(lines).toMatch(/next:.*--url <base-url>/i);
  }, 30_000);
});
