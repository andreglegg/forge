import { describe, expect, test } from "vitest";
import { type FetchLike, probeProvider, replyBudget, streamCompletion } from "../src/provider.js";

function queuedFetch(responses: Response[]): FetchLike {
  return (async () => {
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected fetch");
    return response;
  }) as FetchLike;
}

describe("provider throughput limits", () => {
  test("reserves most of an 8k TPM tier for input unless max tokens is explicit", () => {
    const base = {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "qwen/qwen3.6-27b",
      apiKeyEnv: "GROQ_API_KEY",
      temperature: 0.1,
      contextWindow: 131_072,
      tokensPerMinute: 8_000,
    };

    expect(replyBudget({ ...base, maxTokens: 0 })).toBe(1_000);
    expect(replyBudget({ ...base, maxTokens: 2_048 })).toBe(2_048);
  });

  test("retries one rate-limited streaming request after the provider reset", async () => {
    const fetchLike = queuedFetch([
      new Response("rate limited", {
        status: 429,
        headers: { "x-ratelimit-reset-tokens": "0s" },
      }),
      new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ]);
    let output = "";

    for await (const delta of streamCompletion(
      {
        baseUrl: "https://api.groq.com/openai/v1",
        model: "qwen/qwen3.6-27b",
        apiKeyEnv: "GROQ_API_KEY",
        temperature: 0.1,
        maxTokens: 0,
        contextWindow: 131_072,
        tokensPerMinute: 8_000,
      },
      [{ role: "user", content: "hello" }],
      { fetchLike },
    )) {
      output += delta;
    }

    expect(output).toBe("OK");
  });
});

describe("provider health probing", () => {
  test("confirms the configured model can answer a minimal completion", async () => {
    const result = await probeProvider(
      {
        baseUrl: "http://127.0.0.1:44100/v1",
        model: "small-coder",
        apiKeyEnv: "FORGE_TEST_KEY",
        temperature: 0.1,
        maxTokens: 0,
        contextWindow: 0,
      },
      {
        completion: true,
        fetchLike: queuedFetch([
          new Response(JSON.stringify({ data: [{ id: "small-coder" }] }), { status: 200 }),
          new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
            status: 200,
          }),
        ]),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      models: ["small-coder"],
      selectedModel: "small-coder",
      completionChecked: true,
      error: null,
    });
  });

  test("reports a runtime profile conflict before a coding run starts", async () => {
    const result = await probeProvider(
      {
        baseUrl: "http://127.0.0.1:44100/v1",
        model: "coder-30b",
        apiKeyEnv: "FORGE_TEST_KEY",
        temperature: 0.1,
        maxTokens: 0,
        contextWindow: 0,
      },
      {
        completion: true,
        fetchLike: queuedFetch([
          new Response(JSON.stringify({ data: [{ id: "coder-30b" }] }), { status: 200 }),
          new Response(
            JSON.stringify({ error: { code: "profile_conflict", message: "switch profile" } }),
            { status: 409 },
          ),
        ]),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/profile_conflict|switch profile/i);
  });

  test("rejects a configured model absent from the endpoint catalogue", async () => {
    const result = await probeProvider(
      {
        baseUrl: "http://localhost:1234/v1",
        model: "missing-model",
        apiKeyEnv: "FORGE_TEST_KEY",
        temperature: 0.1,
        maxTokens: 0,
        contextWindow: 0,
      },
      {
        fetchLike: queuedFetch([
          new Response(JSON.stringify({ data: [{ id: "served-model" }] }), { status: 200 }),
        ]),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing-model.*not advertised/i);
  });
});
