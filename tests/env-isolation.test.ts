import { describe, expect, test } from "vitest";

describe("test environment isolation", () => {
  test("inherited FORGE_* variables never reach the suite", () => {
    // Provider-resolution tests assert shipped defaults; a contributor's shell
    // exporting FORGE_URL/FORGE_MODEL/FORGE_API_KEY must not change them.
    // Tests that exercise overrides set variables explicitly and locally.
    const leaked = Object.keys(process.env).filter((key) => key.startsWith("FORGE_"));
    expect(leaked).toEqual([]);
  });
});
