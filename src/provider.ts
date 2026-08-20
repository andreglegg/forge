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
  /** Optional provider throughput cap, distinct from the model context window. */
  readonly tokensPerMinute?: number;
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

export interface ProviderProbe {
  readonly ok: boolean;
  readonly status: number | null;
  readonly models: readonly string[];
  readonly selectedModel: string | null;
  readonly completionChecked: boolean;
  readonly error: string | null;
  /**
   * The context window the endpoint advertises for the selected model, or null
   * when it advertises none.
   *
   * Optional metadata, read where offered and never required: OpenRouter
   * publishes `context_length` in `/models`, Ollama and most OpenAI-compatible
   * servers publish nothing. Worth reading because the alternative is a guess
   * that has already cost a run -- see `replyBudget`.
   */
  readonly contextWindow: number | null;
}

export interface ProviderProbeOptions {
  readonly completion?: boolean | undefined;
  readonly fetchLike?: FetchLike | undefined;
}

/**
 * Validate endpoint discovery and, when requested, one minimal non-streaming
 * completion. `/models` alone is not enough for gateways that advertise several
 * models while only one runtime profile is active.
 */
export async function probeProvider(
  config: ProviderConfig,
  options: ProviderProbeOptions = {},
): Promise<ProviderProbe> {
  const fetchLike = options.fetchLike ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  const key = process.env[config.apiKeyEnv] ?? "";
  if (key) headers["authorization"] = `Bearer ${key}`;
  try {
    const response = await fetchLike(`${config.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        models: [],
        selectedModel: null,
        completionChecked: false,
        contextWindow: null,
        error: `HTTP ${response.status} from ${config.baseUrl}/models: ${clip(await response.text())}`,
      };
    }
    const parsed = (await response.json()) as {
      data?: Array<{ id?: unknown; context_length?: unknown }>;
    };
    const entries = parsed.data ?? [];
    const models = entries.flatMap((item) =>
      typeof item.id === "string" && item.id.length > 0 ? [item.id] : [],
    );
    const selectedModel = config.model || models[0] || null;
    const advertised = entries.find((item) => item.id === selectedModel)?.context_length;
    // A non-positive or non-integer value is discarded rather than repaired:
    // sizing a run from a nonsense number is worse than falling back.
    const contextWindow =
      typeof advertised === "number" && Number.isInteger(advertised) && advertised > 0
        ? advertised
        : null;
    if (selectedModel === null) {
      return {
        ok: false,
        status: response.status,
        models,
        selectedModel: null,
        completionChecked: false,
        contextWindow,
        error: "the endpoint advertised no usable model ids",
      };
    }
    if (config.model && !models.includes(config.model)) {
      return {
        ok: false,
        status: response.status,
        models,
        selectedModel,
        completionChecked: false,
        contextWindow,
        error: `${config.model} is not advertised by the endpoint`,
      };
    }
    if (options.completion !== true) {
      return {
        ok: true,
        status: response.status,
        models,
        selectedModel,
        completionChecked: false,
        contextWindow,
        error: null,
      };
    }
    const completion = await requestWithRateLimitRetry(
      `${config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages: [{ role: "user", content: "Reply with OK." }],
          temperature: 0,
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      },
      fetchLike,
    );
    if (!completion.ok) {
      return {
        ok: false,
        status: completion.status,
        models,
        selectedModel,
        completionChecked: true,
        contextWindow,
        error: `HTTP ${completion.status} from ${config.baseUrl}: ${clip(await completion.text())}`,
      };
    }
    return {
      ok: true,
      status: completion.status,
      models,
      selectedModel,
      completionChecked: true,
      contextWindow,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      models: [],
      selectedModel: config.model || null,
      completionChecked: false,
      contextWindow: null,
      error: error instanceof Error ? error.message : String(error),
    };
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
  const derived =
    config.contextWindow <= 0
      ? 3000
      : Math.max(
          512,
          Math.min(
            8192,
            Math.floor(config.contextWindow / 8),
            Math.floor(config.contextWindow / 4),
          ),
        );
  const rateLimit = config.tokensPerMinute ?? 0;
  if (rateLimit <= 0) return derived;
  // A constrained provider needs room for the next input too. One eighth keeps
  // a useful edit-sized reply while leaving most of the minute for repository
  // context; an explicit --max-tokens remains an intentional override.
  return Math.min(derived, Math.max(256, Math.floor(rateLimit / 8)));
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
  const response = await requestWithRateLimitRetry(
    `${config.baseUrl}/chat/completions`,
    {
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
    },
    fetchLike,
  );
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

const MAX_RATE_LIMIT_RETRY_MS = 65_000;

function retryDelayMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers.get("x-ratelimit-reset-tokens");
  if (reset === null) return null;
  const match = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(reset.trim());
  if (match === null) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2] ?? 0);
  const milliseconds = (minutes * 60 + seconds) * 1000;
  return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : null;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) return;
    const aborted = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
    };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

async function requestWithRateLimitRetry(
  url: string,
  init: RequestInit,
  fetchLike: FetchLike,
): Promise<Response> {
  let response = await fetchLike(url, init);
  if (response.status !== 429) return response;
  const wait = retryDelayMs(response.headers);
  if (wait === null || wait > MAX_RATE_LIMIT_RETRY_MS) return response;
  // Consume the first response before reusing the request body and socket.
  await response.text();
  await delay(wait, init.signal ?? undefined);
  response = await fetchLike(url, init);
  return response;
}

function clip(text: string, limit = 300): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
