/**
 * Two failures observed running Forge against OpenRouter models.
 *
 * The first cost a run outright. With no `--context`, `contextWindow` is 0 and
 * `replyBudget` falls back to 3000 tokens. Pointed at a 256k-context endpoint,
 * the model's edit exceeded that on every attempt, was truncated every time,
 * and the run stopped -- a configuration failure wearing the costume of a
 * capability failure. The endpoint advertises the real number in `/models`,
 * which preflight already fetches and was throwing away.
 *
 * The second is a decoder blind spot. A 30B model replied with what looks like
 * a tool *result* rather than a tool *call* -- `{"status":"read","path":...,
 * "contents":"..."}` -- and the contents were invented, naming a package that
 * does not exist in the repository. Forge decoded nothing and the stall breaker
 * stopped it in two turns, which is correct, but no repair named what went
 * wrong, so the model was never told.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { TextCodec } from "../src/codecs.js";
import { type ProviderConfig, probeProvider, replyBudget } from "../src/provider.js";
import { loadTraces, score } from "../src/replay.js";

const BASE: ProviderConfig = {
  baseUrl: "http://provider.test/v1",
  model: "big/model",
  apiKeyEnv: "FORGE_API_KEY",
  maxTokens: 0,
  contextWindow: 0,
  temperature: 0.1,
};

function respondWith(body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

describe("context window discovery", () => {
  test("reports what the endpoint advertises for the selected model", async () => {
    const probe = await probeProvider(BASE, {
      fetchLike: respondWith({
        data: [
          { id: "small/model", context_length: 8192 },
          { id: "big/model", context_length: 262144 },
        ],
      }),
    });

    expect(probe.ok).toBe(true);
    expect(probe.contextWindow).toBe(262144);
  });

  test("stays silent when the endpoint advertises nothing", async () => {
    // Ollama and most OpenAI-compatible servers do not carry this field.
    const probe = await probeProvider(BASE, {
      fetchLike: respondWith({ data: [{ id: "big/model" }] }),
    });

    expect(probe.ok).toBe(true);
    expect(probe.contextWindow).toBeNull();
  });

  test("ignores a nonsense value rather than sizing a run from it", async () => {
    const probe = await probeProvider(BASE, {
      fetchLike: respondWith({ data: [{ id: "big/model", context_length: -5 }] }),
    });

    expect(probe.contextWindow).toBeNull();
  });

  test("a discovered window lifts the reply budget off its floor", () => {
    // The observed failure, and the fix, in two lines.
    expect(replyBudget({ ...BASE, contextWindow: 0 })).toBe(3000);
    expect(replyBudget({ ...BASE, contextWindow: 262144 })).toBeGreaterThan(3000);
  });
});

function decode(reply: string) {
  const codec = new TextCodec();
  codec.feed(reply);
  return codec.finish();
}

describe("a reply that fabricates a tool result", () => {
  test("is named as such rather than decoding to silence", () => {
    const observed = JSON.stringify({
      status: "read",
      path: "package.json",
      contents: '{\n  "name": "bank"\n}',
    });

    const turn = decode(observed);

    expect(turn.proposals).toHaveLength(0);
    expect(turn.repairs).toContain("hallucinated_tool_result");
  });

  test("recognises the shape whatever the tool was", () => {
    const turn = decode(JSON.stringify({ status: "ok", path: "src/a.js", output: "done" }));
    expect(turn.repairs).toContain("hallucinated_tool_result");
  });

  test("does not fire on ordinary prose that merely mentions a file", () => {
    const turn = decode("I read package.json and its status looks fine; the contents are normal.");
    expect(turn.repairs).not.toContain("hallucinated_tool_result");
  });

  test("does not fire on a real action", () => {
    const turn = decode("READ package.json\n");
    expect(turn.repairs).not.toContain("hallucinated_tool_result");
  });
});

describe("the captured trace stays a regression", () => {
  /**
   * `bench/traces/` is the free half of the loop. A live model discovers a
   * failure once -- rate-limited, occasionally paid -- and the reply is kept
   * here, where the decoder is measured against it forever at no cost. The
   * scratchpad that held the original run was wiped hours after it produced
   * this, which is exactly why the fixture lives in the repository.
   */
  test("the recorded nemotron replies still classify as fabricated results", async () => {
    const directory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "bench",
      "traces",
    );
    const records = [];
    for await (const record of loadTraces(directory)) records.push(record);

    expect(records.length).toBeGreaterThan(0);
    const report = score(records);
    expect(report.byRepair["hallucinated_tool_result"]).toBe(records.length);
    expect(report.byCategory["tool_result_echo"]).toBe(records.length);
    expect(report.conversionRate).toBe(0);
  });
});
