/**
 * Capability-aware profile recommendation.
 *
 * Endpoint capability discovery and named profiles never met: doctor could
 * pass while the selected profile targeted a model the endpoint does not
 * serve, and nothing ever said which configured profile would fit. The
 * recommendation is pure data-in data-out: no I/O, no model call, and it is
 * never applied automatically.
 */

import { describe, expect, test } from "vitest";
import { type AdvertisedEndpoint, recommendProfile } from "../src/product.js";

const endpoint: AdvertisedEndpoint = {
  url: "http://127.0.0.1:8080/v1",
  models: ["qwen-30b"],
  contextWindow: 32768,
  contextWindowModel: "qwen-30b",
};

describe("recommendProfile", () => {
  test("recommends the profile matching an advertised model and explains the mismatch", () => {
    const result = recommendProfile(
      endpoint,
      { a: { model: "other" }, b: { model: "qwen-30b", contextWindow: 32768 } },
      "a",
    );

    expect(result.recommended).toBe("b");
    expect(result.reason).toContain("qwen-30b");
    expect(result.selectedFits).toBe(false);
    expect(result.mismatches).toEqual([
      { name: "a", reason: expect.stringContaining("not advertised") },
    ]);
  });

  test("excludes profiles targeting a different endpoint but normalizes trailing slashes", () => {
    const result = recommendProfile(
      endpoint,
      {
        local: { url: `${endpoint.url}/`, model: "qwen-30b" },
        remote: { url: "http://10.0.0.9:9999/v1", model: "qwen-30b" },
      },
      null,
    );

    expect(result.recommended).toBe("local");
    expect(result.mismatches).toEqual([
      { name: "remote", reason: expect.stringContaining("different endpoint") },
    ]);
  });

  test("never recommends a profile claiming more context than the endpoint advertises", () => {
    const result = recommendProfile(
      endpoint,
      { huge: { model: "qwen-30b", contextWindow: 131072 } },
      null,
    );

    expect(result.recommended).toBeNull();
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]?.reason).toContain("131072");
    expect(result.mismatches[0]?.reason).toContain("32768");
  });

  test("only verifies a context claim against the model the probed window belongs to", () => {
    // The probe reads context_length from the selected model's entry alone, so
    // the window is not an endpoint-wide capability. Gateway advertises
    // small=8192 and big=131072; with "small" selected the probe carries 8192.
    const gateway: AdvertisedEndpoint = {
      url: endpoint.url,
      models: ["small", "big"],
      contextWindow: 8192,
      contextWindowModel: "small",
    };

    // A profile targeting the other advertised model must not be rejected
    // against the selected model's window.
    const forward = recommendProfile(
      gateway,
      { large: { model: "big", contextWindow: 131072 } },
      null,
    );
    expect(forward.mismatches).toEqual([]);
    expect(forward.recommended).toBe("large");

    // The reverse direction: with "big" selected (window 131072), a profile
    // targeting "small" is unverifiable, not verified-as-fitting; and a
    // model-unset profile inherits the selected model, so its claim is checked.
    const reversed = recommendProfile(
      { ...gateway, contextWindow: 131072, contextWindowModel: "big" },
      { inherit: { contextWindow: 262144 }, tiny: { model: "small", contextWindow: 32768 } },
      null,
    );
    expect(reversed.mismatches).toEqual([
      { name: "inherit", reason: expect.stringContaining("big") },
    ]);
    expect(reversed.recommended).toBe("tiny");
  });

  test("treats context claims as unverifiable when the endpoint advertises no window", () => {
    const result = recommendProfile(
      { ...endpoint, contextWindow: null },
      { big: { model: "qwen-30b", contextWindow: 131072 } },
      null,
    );

    expect(result.recommended).toBe("big");
    expect(result.mismatches).toEqual([]);
  });

  test("ranks exact model match over model-unset, breaks ties by name, ignores key order", () => {
    const forward = recommendProfile(
      endpoint,
      { aa: {}, mm: { model: "qwen-30b" }, zz: { model: "qwen-30b" } },
      null,
    );
    const reversed = recommendProfile(
      endpoint,
      { zz: { model: "qwen-30b" }, mm: { model: "qwen-30b" }, aa: {} },
      null,
    );

    expect(forward.recommended).toBe("mm");
    expect(reversed).toEqual(forward);
  });

  test("stays silent when the selected profile is the top fit or no profiles exist", () => {
    const selectedBest = recommendProfile(
      endpoint,
      { best: { model: "qwen-30b" }, spare: {} },
      "best",
    );
    const empty = recommendProfile(endpoint, undefined, null);

    expect(selectedBest.recommended).toBeNull();
    expect(selectedBest.selectedFits).toBe(true);
    expect(empty).toEqual({ recommended: null, reason: null, selectedFits: true, mismatches: [] });
  });
});
