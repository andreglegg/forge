import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { commandEnvironment } from "../src/exec.js";
import {
  composeIssueTask,
  composePullRequestBody,
  fetchIssueTask,
  githubCliEnvironment,
  ISSUE_BODY_TRUNCATION_MARKER,
  parseIssueReference,
  pullRequestTitle,
} from "../src/github.js";

interface GhStub {
  readonly dir: string;
  readonly invocations: () => string[][];
  readonly seenToken: () => string | null;
}

/**
 * A recording `gh` placed at the front of PATH. Configuration is baked into
 * the script text because gh runs under the command allowlist plus only
 * GH_TOKEN/GITHUB_TOKEN, so a test-specific variable would never arrive.
 */
function installGhStub(config: { response?: string; issueExit?: number } = {}): GhStub {
  const dir = mkdtempSync(path.join(tmpdir(), "forge-gh-stub-"));
  const log = path.join(dir, "argv.log");
  const envLog = path.join(dir, "env.log");
  const response = path.join(dir, "response.json");
  writeFileSync(response, config.response ?? "{}", "utf8");
  const script = `#!/bin/sh
{
  for arg in "$@"; do printf '%s\\n' "$arg"; done
  printf '%s\\n' '==='
} >> '${log}'
printf 'gh-token=%s\\n' "\${GH_TOKEN-unset}" >> '${envLog}'
case "$1" in
  issue) cat '${response}'; exit ${config.issueExit ?? 0} ;;
  pr) printf 'https://github.com/example/repo/pull/17\\n'; exit 0 ;;
esac
exit 0
`;
  const gh = path.join(dir, "gh");
  writeFileSync(gh, script, "utf8");
  chmodSync(gh, 0o755);
  return {
    dir,
    invocations: () => {
      let text = "";
      try {
        text = readFileSync(log, "utf8");
      } catch {
        return [];
      }
      const groups: string[][] = [];
      let current: string[] = [];
      for (const line of text.split("\n")) {
        if (line === "===") {
          groups.push(current);
          current = [];
        } else if (line !== "") current.push(line);
      }
      return groups;
    },
    seenToken: () => {
      try {
        return readFileSync(envLog, "utf8").trim();
      } catch {
        return null;
      }
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function stubOnPath(config: { response?: string; issueExit?: number } = {}): GhStub {
  const stub = installGhStub(config);
  cleanup.push(async () => rm(stub.dir, { recursive: true, force: true }));
  vi.stubEnv("PATH", `${stub.dir}${path.delimiter}${process.env["PATH"] ?? ""}`);
  return stub;
}

const ISSUE = {
  number: 7,
  title: "Fix the flaky test",
  body: "The suite fails on cold caches.",
  state: "OPEN",
  url: "https://github.com/octo/demo/issues/7",
};

describe("parseIssueReference", () => {
  test("accepts bare, hash, owner/repo, and github.com URL forms", () => {
    expect(parseIssueReference("42")).toEqual({ issue: 42, repo: null });
    expect(parseIssueReference("#7")).toEqual({ issue: 7, repo: null });
    expect(parseIssueReference("octo-org/example.repo#12")).toEqual({
      issue: 12,
      repo: "octo-org/example.repo",
    });
    expect(parseIssueReference("https://github.com/octo-org/example/issues/34")).toEqual({
      issue: 34,
      repo: "octo-org/example",
    });
  });

  test("rejects other hosts, pull URLs, smuggled queries, and junk", () => {
    for (const rejected of [
      "https://gitlab.com/octo/demo/issues/1",
      "https://github.evil.example/octo/demo/issues/1",
      "https://github.com/octo/demo/pull/5",
      "https://github.com/octo/demo/issues/5?ref=evil",
      "https://github.com/octo/demo/issues/5#comment",
      "https://user@github.com/octo/demo/issues/5",
      "http://github.com/octo/demo/issues/5",
      "https://github.com/octo/demo/issues/abc",
      "octo/demo#notanumber",
      "octo//demo#3",
      "0",
      "-3",
      "abc",
      "",
    ]) {
      expect(parseIssueReference(rejected), rejected).toBeNull();
    }
  });
});

describe("fetchIssueTask", () => {
  test("composes a bounded task from a well-formed gh response", async () => {
    const stub = stubOnPath({ response: JSON.stringify(ISSUE) });
    const result = await fetchIssueTask({ issue: 7, repo: null }, stub.dir, "Prefer a minimal fix");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe(ISSUE.url);
    expect(result.task).toContain("GitHub issue #7: Fix the flaky test");
    expect(result.task).toContain("State: OPEN");
    expect(result.task).toContain(`URL: ${ISSUE.url}`);
    expect(result.task).toContain(ISSUE.body);
    expect(result.task).toContain("Additional guidance from the user:\nPrefer a minimal fix");
    expect(stub.invocations()).toEqual([
      ["issue", "view", "7", "--json", "number,title,body,state,url"],
    ]);
  });

  test("passes --repo only for repository-qualified references", async () => {
    const stub = stubOnPath({ response: JSON.stringify(ISSUE) });
    const result = await fetchIssueTask({ issue: 7, repo: "octo/demo" }, stub.dir);
    expect(result.ok).toBe(true);
    expect(stub.invocations()).toEqual([
      ["issue", "view", "7", "--repo", "octo/demo", "--json", "number,title,body,state,url"],
    ]);
  });

  test("head-clips an over-bound body with the truncation marker", async () => {
    const stub = stubOnPath({
      response: JSON.stringify({ ...ISSUE, body: "x".repeat(13_000) }),
    });
    const result = await fetchIssueTask({ issue: 7, repo: null }, stub.dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task).toContain(ISSUE_BODY_TRUNCATION_MARKER);
    const longest = result.task.match(/x+/g)?.reduce((a, b) => (a.length >= b.length ? a : b));
    expect(longest?.length).toBe(12_000);
  });

  test("refuses malformed JSON with bounded detail", async () => {
    const stub = stubOnPath({ response: "gh: not json at all" });
    const result = await fetchIssueTask({ issue: 7, repo: null }, stub.dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/);
    expect(result.error.length).toBeLessThan(700);
  });

  test("refuses a response missing required fields", async () => {
    const stub = stubOnPath({ response: JSON.stringify({ number: 7, title: "t" }) });
    const result = await fetchIssueTask({ issue: 7, repo: null }, stub.dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/body/);
  });

  test("refuses a nonzero gh exit with the error detail", async () => {
    const stub = stubOnPath({
      response: "GraphQL: Could not resolve to an Issue",
      issueExit: 1,
    });
    const result = await fetchIssueTask({ issue: 999, repo: null }, stub.dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Could not resolve to an Issue");
  });

  test("reports a missing gh CLI plainly", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "forge-empty-path-"));
    cleanup.push(async () => rm(empty, { recursive: true, force: true }));
    vi.stubEnv("PATH", empty);
    const result = await fetchIssueTask({ issue: 7, repo: null }, empty);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("gh CLI not found");
  });
});

describe("credentials", () => {
  test("forwards GH_TOKEN to gh but never to model commands", async () => {
    const stub = stubOnPath({ response: JSON.stringify(ISSUE) });
    vi.stubEnv("GH_TOKEN", "tok-123");
    const result = await fetchIssueTask({ issue: 7, repo: null }, stub.dir);
    expect(result.ok).toBe(true);
    expect(stub.seenToken()).toBe("gh-token=tok-123");
    // Regression pin: the model-command allowlist must not learn the token.
    const modelEnv = commandEnvironment({
      GH_TOKEN: "tok-123",
      GITHUB_TOKEN: "tok-456",
      PATH: "p",
    });
    expect(modelEnv["GH_TOKEN"]).toBeUndefined();
    expect(modelEnv["GITHUB_TOKEN"]).toBeUndefined();
    expect(githubCliEnvironment({ GH_TOKEN: "a", GITHUB_TOKEN: "b", FORGE_API_KEY: "c" })).toEqual({
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
    });
  });
});

describe("pull request composition", () => {
  test("bounds the title and clips an over-long issue title", () => {
    expect(pullRequestTitle("Fix the bug\nSecond line ignored")).toBe("Fix the bug");
    expect(pullRequestTitle("y".repeat(400)).length).toBeLessThanOrEqual(101);
    expect(pullRequestTitle("")).not.toBe("");
    const task = composeIssueTask({ ...ISSUE, title: "t".repeat(400) });
    const heading = task.split("\n", 1)[0] ?? "";
    expect(heading.length).toBeLessThanOrEqual("GitHub issue #7: ".length + 301);
  });

  test("body carries the session id and a plain issue reference, never autoclose", () => {
    const body = composePullRequestBody("session-abc", "https://github.com/octo/demo/issues/7");
    expect(body).toContain("Session: session-abc");
    expect(body).toContain("Issue: https://github.com/octo/demo/issues/7");
    expect(body).toMatch(/verification/i);
    expect(body).not.toMatch(/closes|fixes|resolves/i);
    expect(composePullRequestBody("session-abc", null)).not.toContain("Issue:");
  });
});
