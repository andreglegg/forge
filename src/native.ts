/**
 * Native tool-calling transports, normalized to one delta stream.
 *
 * OpenAI and Anthropic disagree about almost everything on the wire: where the
 * tool name lives, whether arguments arrive as a JSON string or as a typed
 * block, how a stream frames its events, even what a "delta" is. None of that
 * disagreement is allowed past this file. Both are turned into the same
 * `NativeDelta` the codec already consumes, so the decoder, the loop guard, the
 * approval gate and both renderers cannot tell which provider answered.
 *
 * That is the same boundary the text codec sits behind. The point of having it
 * is that adding a third provider is a function here and nothing anywhere else.
 *
 * Deliberately *not* an abstraction over "a provider". It is two functions that
 * translate two wire formats. A provider interface with hooks would have to
 * anticipate what the next provider needs, and the next provider will need
 * something else.
 */

import type { NativeDelta } from "./codecs.js";
import { nativeToolSchemas } from "./protocol.js";
import type { Message, ProviderConfig } from "./provider.js";
import { replyBudget } from "./provider.js";

export type Wire = "openai" | "anthropic";

/**
 * Which wire format an endpoint speaks, guessed from its URL.
 *
 * A guess, and named as one. It is right for the two hosted APIs and for every
 * local server that copies OpenAI's shape, which is all of them; `--wire`
 * overrides it. Probing instead would cost a round trip on every start to learn
 * something the URL almost always already says.
 */
export function wireFor(baseUrl: string): Wire {
  return /anthropic\.com/i.test(baseUrl) ? "anthropic" : "openai";
}

export interface NativeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly fetchLike?: typeof globalThis.fetch | undefined;
}

/** Stream a turn as normalized deltas, whichever wire the endpoint speaks. */
export async function* streamNative(
  config: ProviderConfig,
  messages: readonly Message[],
  options: NativeOptions = {},
): AsyncGenerator<NativeDelta> {
  const wire = wireFor(config.baseUrl);
  const fetchLike = options.fetchLike ?? globalThis.fetch;
  const key = process.env[config.apiKeyEnv] ?? "";

  const request =
    wire === "anthropic"
      ? {
          url: `${config.baseUrl}/messages`,
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: anthropicBody(config, messages),
        }
      : {
          url: `${config.baseUrl}/chat/completions`,
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: openaiBody(config, messages),
        };

  const response = await fetchLike(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${config.baseUrl}: ${await response.text()}`);
  }
  if (response.body === null) {
    throw new Error("the endpoint returned no body");
  }

  for await (const frame of sseFrames(response.body)) {
    const deltas = wire === "anthropic" ? fromAnthropic(frame) : fromOpenAI(frame);
    for (const delta of deltas) {
      yield delta;
    }
  }
}

function openaiBody(config: ProviderConfig, messages: readonly Message[]): Record<string, unknown> {
  return {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: replyBudget(config),
    stream: true,
    tools: nativeToolSchemas(),
  };
}

/**
 * Anthropic takes the system prompt out of the message list.
 *
 * Sending it as a `system`-role message instead is accepted and quietly
 * ignored, which is the worst failure shape available: the request succeeds,
 * the model is simply never told the protocol, and every reply is prose.
 */
function anthropicBody(
  config: ProviderConfig,
  messages: readonly Message[],
): Record<string, unknown> {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const rest = messages.filter((message) => message.role !== "system");
  return {
    model: config.model,
    max_tokens: replyBudget(config),
    temperature: config.temperature,
    stream: true,
    ...(system ? { system } : {}),
    messages: rest.map((message) => ({ role: message.role, content: message.content })),
    tools: nativeToolSchemas().map((tool) => {
      const fn = (tool as { function: { name: string; parameters: unknown } }).function;
      return { name: fn.name, input_schema: fn.parameters };
    }),
  };
}

/**
 * SSE frames, line-assembled.
 *
 * Shared by both wires because both use SSE, even though what is inside the
 * frames differs entirely. A malformed frame is skipped: it costs one delta,
 * where throwing would cost the turn.
 */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload);
      } catch {
        // One lost frame, not a failed request.
      }
    }
  }
}

interface OpenAIFrame {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

function fromOpenAI(frame: unknown): NativeDelta[] {
  const parsed = frame as OpenAIFrame;
  const choice = parsed.choices?.[0];
  if (choice === undefined) return [];
  const out: NativeDelta[] = [];
  const text = choice.delta?.content;
  if (typeof text === "string" && text) {
    out.push({ text });
  }
  for (const call of choice.delta?.tool_calls ?? []) {
    // Keyed by index, never by the provider's id, for the same reason as the
    // Anthropic path: the id appears on the FIRST fragment of a call and never
    // again, so keying by it files the name under `call_x` and the arguments
    // that follow under the index. The codec assembles a call from its key and
    // would then hold one call with no arguments and one with no name, and
    // emit neither. The index is present on every fragment.
    const id = `index-${call.index ?? 0}`;
    out.push({
      call: {
        id,
        ...(call.function?.name ? { name: call.function.name } : {}),
        ...(call.function?.arguments !== undefined
          ? { argumentsDelta: call.function.arguments }
          : {}),
      },
    });
  }
  if (choice.finish_reason) {
    out.push({ finish: true });
  }
  return out;
}

interface AnthropicFrame {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
}

function fromAnthropic(frame: unknown): NativeDelta[] {
  const parsed = frame as AnthropicFrame;
  switch (parsed.type) {
    case "content_block_start": {
      const block = parsed.content_block;
      if (block?.type !== "tool_use") return [];
      // Keyed by the stream INDEX, not by the tool id. The id appears only in
      // this frame; every `input_json_delta` that follows identifies its block
      // by index alone. Using the id here and the index later would file the
      // name and the arguments under two different keys, and the codec -- which
      // assembles a call from its id -- would see a call with no arguments and
      // a call with no name, and emit neither.
      return [
        {
          call: {
            id: `index-${parsed.index ?? 0}`,
            ...(block.name ? { name: block.name } : {}),
          },
        },
      ];
    }
    case "content_block_delta": {
      if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
        return [{ text: parsed.delta.text }];
      }
      if (parsed.delta?.type === "input_json_delta" && parsed.delta.partial_json !== undefined) {
        return [
          {
            call: {
              id: `index-${parsed.index ?? 0}`,
              argumentsDelta: parsed.delta.partial_json,
            },
          },
        ];
      }
      return [];
    }
    case "message_stop":
      return [{ finish: true }];
    default:
      return [];
  }
}
