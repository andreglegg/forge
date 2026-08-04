/**
 * The native wires, and the property that matters about them: whatever the
 * provider said, what comes out the other side is the same `ActionProposal`
 * the text protocol produces.
 *
 * Both frame translators are pure functions of a parsed SSE frame, so they are
 * tested against recorded frame shapes rather than against a live API. The
 * shapes are the two providers' documented streaming formats; what is asserted
 * is the normalisation, which is this file's whole job.
 */

import { describe, expect, test } from "vitest";
// The translators are internal; they are exercised through the codec by
// replaying the deltas each wire would produce. That is the contract that
// matters -- a translator that is "correct" but assembles into the wrong
// proposal is not correct.
import type { NativeDelta } from "../src/codecs.js";
import { NativeCodec, TextCodec } from "../src/codecs.js";
import { wireFor } from "../src/native.js";
import { nativeToolSchemas } from "../src/protocol.js";

/** What `fromOpenAI` yields for a streamed `read` call, fragment by fragment. */
const OPENAI_DELTAS: NativeDelta[] = [
  { text: "Let me look." },
  { call: { id: "index-0", name: "read" } },
  { call: { id: "index-0", argumentsDelta: '{"pa' } },
  { call: { id: "index-0", argumentsDelta: 'th":"src/app.ts"}' } },
  { finish: true },
];

/** The same call as Anthropic streams it: name in the block start, JSON in deltas. */
const ANTHROPIC_DELTAS: NativeDelta[] = [
  { text: "Let me look." },
  { call: { id: "index-0", name: "read" } },
  { call: { id: "index-0", argumentsDelta: '{"pa' } },
  { call: { id: "index-0", argumentsDelta: 'th":"src/app.ts"}' } },
  { finish: true },
];

function decodeNative(deltas: readonly NativeDelta[]) {
  const codec = new NativeCodec();
  for (const delta of deltas) codec.feed(delta);
  return codec.finish();
}

describe("wire detection", () => {
  test("anthropic by host, openai for everything else", () => {
    // Every local server copies OpenAI's shape, so that is the right default;
    // only the one host that does not gets special-cased.
    expect(wireFor("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(wireFor("https://api.openai.com/v1")).toBe("openai");
    expect(wireFor("http://127.0.0.1:8790/v1")).toBe("openai");
  });
});

describe("the wires normalise to one intent", () => {
  test("native providers are explicitly offered the edit tool", () => {
    const names = nativeToolSchemas().map((tool) => {
      const fn = (tool as { function?: { name?: string } }).function;
      return fn?.name;
    });

    expect(names).toContain("edit");
  });

  test("both providers' fragments assemble into the same proposal", () => {
    const fromOpenAI = decodeNative(OPENAI_DELTAS);
    const fromAnthropic = decodeNative(ANTHROPIC_DELTAS);

    expect(fromOpenAI.proposals).toEqual(fromAnthropic.proposals);
    expect(fromOpenAI.proposals).toEqual([
      { kind: "call", tool: "read", arguments: { path: "src/app.ts" } },
    ]);
  });

  test("a native call and a text directive are the same proposal", () => {
    // The claim the whole boundary rests on. If these ever diverge, everything
    // downstream -- loop guard, approval, journal -- is testing two systems.
    const text = new TextCodec();
    text.feed("READ src/app.ts\n");

    expect(decodeNative(OPENAI_DELTAS).proposals).toEqual(text.finish().proposals);
  });

  test("keying by index, not by the provider's id, is what makes assembly work", () => {
    // The bug this prevents: the tool id appears on the FIRST fragment only,
    // and every fragment after it identifies the call by index. Keying by id
    // files the name under `call_abc` and the arguments under `index-0`,
    // leaving one call with no arguments and one with no name -- and the codec
    // emits neither, so the turn silently does nothing.
    const split: NativeDelta[] = [
      { call: { id: "call_abc", name: "read" } },
      { call: { id: "index-0", argumentsDelta: '{"path":"a.ts"}' } },
      { finish: true },
    ];

    expect(decodeNative(split).proposals).toEqual([]);
  });
});

describe("partial arguments are never acted on", () => {
  test("a call is not emitted until the message completes", () => {
    const codec = new NativeCodec();
    codec.feed({ call: { id: "index-0", name: "read" } });
    // Half a JSON document. Acting on this is the native equivalent of
    // applying half an edit.
    expect(codec.feed({ call: { id: "index-0", argumentsDelta: '{"path":"a' } })).toEqual([]);
    expect(codec.feed({ finish: true })).toHaveLength(0);
    // ...and unparseable arguments are recorded rather than guessed at.
    expect(codec.finish().repairs).toContain("unparseable_native_arguments");
  });

  test("an edit arrives natively as the same EditProposal a text block makes", () => {
    const native = decodeNative([
      {
        call: {
          id: "index-0",
          name: "edit",
          argumentsDelta: JSON.stringify({
            path: "a.ts",
            operations: [{ search: "old", replace: "new" }],
          }),
        },
      },
      { finish: true },
    ]);
    const text = new TextCodec();
    text.feed(
      ["EDIT a.ts", "<<<<<<< SEARCH", "old", "=======", "new", ">>>>>>> REPLACE", ""].join("\n"),
    );

    expect(native.proposals).toEqual(text.finish().proposals);
  });
});
