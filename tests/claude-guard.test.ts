import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

function run(command: unknown) {
  return spawnSync(process.execPath, ["scripts/claude-guard.mjs"], {
    encoding: "utf8",
    input: JSON.stringify({ tool_input: { command } }),
  });
}

describe("Claude command guard", () => {
  test("allows ordinary repository commands", () => {
    const result = run("npm run check");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test.each([
    "rm -rf /",
    "git reset --hard",
    "git clean -fd",
    "git push origin main --force",
    "sudo sh",
  ])("blocks destructive command: %s", (command) => {
    const result = run(command);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Blocked destructive command pattern");
  });

  test("fails closed on malformed hook input", () => {
    const result = spawnSync(process.execPath, ["scripts/claude-guard.mjs"], {
      encoding: "utf8",
      input: "not json",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
  });
});
