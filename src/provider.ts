/**
 * Provider transport. Bytes in, normalized deltas out.
 *
 * Streaming is the default and not an option, because it is what makes the
 * incremental codecs useful: a proposal can be rendered as it forms, and a
 * stalled endpoint is detectable. `fetch` takes the `AbortSignal` directly, so
 * cancellation tears down the socket rather than abandoning a promise that
 * keeps being billed.
 *
 * Deliberately thin. It knows about SSE framing and nothing about tools, edits
 * or turns -- the codecs own that, and keeping the boundary here is what lets a
 * local llama.cpp server and a frontier API share every line above it.
 */

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly temperature: number;
  /** 0 means "derive from the endpoint's declared window". */
  readonly maxTokens: number;
  readonly contextWindow: number;
}

export const DEFAULT_PROVIDER: ProviderConfig = {
  // The user's local llama.cpp gateway. `model: ""` means "ask the endpoint":
  // discoverModel() reads /v1/models and takes the first entry, so switching
  // the served model (30B coder today, a 9B tomorrow) needs no forge config.
  baseUrl: "http://127.0.0.1:8790/v1",
  model: "",
  apiKeyEnv: "FORGE_API_KEY",
  temperature: 0.1,
  maxTokens: 0,
  contextWindow: 0,
};

/**
 * Ask the endpoint what it serves.
 *
 * llama.cpp, LM Studio, vLLM and Ollama all answer /v1/models, and a local
 * server nearly always serves exactly one model -- naming it in config is a
 * detail that goes stale the day the server flag changes. Returns null rather
 * than throwing: an unreachable endpoint is reported by the first completion,
 * with a better message than a probe failure would give.
 */
export async function discoverModel(
  config: ProviderConfig,
  fetchLike: FetchLike = globalThis.fetch,
): Promise<string | null> {
  try {
    const response = await fetchLike(`${config.baseUrl}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { data?: Array<{ id?: string }> };
    return parsed.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

export interface Message {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export type FetchLike = typeof globalThis.fetch;

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * The reply budget, derived from the endpoint's window rather than fixed.
 *
 * A constant is wrong on both ends: sized for a 16k endpoint it truncates a
 * 65k one, and sized for 65k it overflows 16k. In the predecessor a fixed
 * budget truncated 47 of 65 benchmark cases. An eighth of the window, capped,
 * with a floor that still fits a schema.
 */
export function replyBudget(config: ProviderConfig): number {
  if (config.maxTokens > 0) {
    return config.maxTokens;
  }
  if (config.contextWindow <= 0) {
    return 3000;
  }
  return Math.max(
    512,
    Math.min(8192, Math.floor(config.contextWindow / 8), Math.floor(config.contextWindow / 4)),
  );
}

/**
 * Stream a completion, yielding text deltas.
 *
 * Yields rather than returns so the caller can feed a codec incrementally and
 * render as it goes. The full text is available by concatenating, which is what
 * the headless path does.
 */
export async function* streamCompletion(
  config: ProviderConfig,
  messages: readonly Message[],
  options: { signal?: AbortSignal | undefined; fetchLike?: FetchLike | undefined } = {},
): AsyncGenerator<string> {
  const fetchLike = options.fetchLike ?? globalThis.fetch;
  const key = process.env[config.apiKeyEnv] ?? "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) {
    headers["authorization"] = `Bearer ${key}`;
  }
  const response = await fetchLike(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: replyBudget(config),
      stream: true,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new ProviderError(
      `HTTP ${response.status} from ${config.baseUrl}: ${clip(await response.text())}`,
    );
  }
  if (response.body === null) {
    throw new ProviderError("the endpoint returned no body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  // Node's ReadableStream is async-iterable; the DOM lib type is not, so the
  // cast is to the runtime contract rather than around a defect.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        return;
      }
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        const text = parsed.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text) {
          yield text;
        }
      } catch {
        // A malformed SSE frame is one lost delta, not a failed request.
      }
    }
  }
}

function clip(text: string, limit = 300): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
