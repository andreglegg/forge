import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type IO, main } from "../src/cli.js";
import { publishPullRequest } from "../src/github.js";
import { createIsolatedWorktree, removeIsolatedWorktree } from "../src/isolation.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function capturedIO(): { readonly io: IO; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

interface ScriptedChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

const NOTE_CHANGE: ScriptedChange = { file: "note.txt", before: "old\n", after: "new\n" };

async function repository(
  change: ScriptedChange = NOTE_CHANGE,
  verify?: string[][],
): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-github-cli-")));
  git(root, "init");
  git(root, "config", "user.email", "forge-tests@example.invalid");
  git(root, "config", "user.name", "Forge Tests");
  writeFileSync(path.join(root, ".gitignore"), ".forge/\n");
  writeFileSync(path.join(root, change.file), change.before);
  writeFileSync(
    path.join(root, "forge.json"),
    `${JSON.stringify(
      {
        verify: verify ?? [
          [
            process.execPath,
            "-e",
            `const fs=require('node:fs'); if(fs.readFileSync(${JSON.stringify(change.file)},'utf8')!==${JSON.stringify(change.after)}) process.exit(1)`,
          ],
        ],
      },
      null,
      2,
    )}\n`,
  );
  git(root, "add", ".gitignore", change.file, "forge.json");
  git(root, "commit", "-m", "initial");
  return root;
}

function bareOrigin(root: string): string {
  const bare = mkdtempSync(path.join(tmpdir(), "forge-github-bare-"));
  git(bare, "init", "--bare");
  git(root, "remote", "add", "origin", bare);
  return bare;
}

function bareBranches(bare: string): string[] {
  return git(bare, "for-each-ref", "refs/heads", "--format=%(refname)")
    .split("\n")
    .filter((line) => line !== "");
}

interface ScriptedProvider {
  readonly server: Server;
  readonly url: string;
  readonly requests: number[];
  readonly userMessages: string[];
}

async function scriptedProvider(change: ScriptedChange = NOTE_CHANGE): Promise<ScriptedProvider> {
  let streamingTurn = 0;
  const requests: number[] = [];
  const userMessages: string[] = [];
  const server = createServer((request, response) => {
    requests.push(1);
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "scripted" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        stream?: boolean;
        messages?: Array<{ role: string; content: string }>;
      };
      for (const message of body.messages ?? []) {
        if (message.role === "user") userMessages.push(message.content);
      }
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
        );
        return;
      }
      streamingTurn += 1;
      const text =
        streamingTurn % 2 === 1
          ? [
              `EDIT ${change.file}`,
              "<<<<<<< SEARCH",
              change.before.trimEnd(),
              "=======",
              change.after.trimEnd(),
              ">>>>>>> REPLACE",
              "",
            ].join("\n")
          : `DONE changed ${change.file}\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider did not bind");
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests, userMessages };
}

interface GhStub {
  readonly dir: string;
  readonly bodyCopy: string;
  readonly invocations: () => string[][];
}

function installGhStub(config: { response?: string } = {}): GhStub {
  const dir = mkdtempSync(path.join(tmpdir(), "forge-gh-stub-"));
  const log = path.join(dir, "argv.log");
  const response = path.join(dir, "response.json");
  const bodyCopy = path.join(dir, "pr-body.md");
  writeFileSync(response, config.response ?? "{}", "utf8");
  const script = `#!/bin/sh
{
  for arg in "$@"; do printf '%s\\n' "$arg"; done
  printf '%s\\n' '==='
} >> '${log}'
prev=''
for arg in "$@"; do
  if [ "$prev" = '--body-file' ]; then cp "$arg" '${bodyCopy}'; fi
  prev="$arg"
done
case "$1" in
  issue) cat '${response}'; exit 0 ;;
  pr) printf 'https://github.com/example/repo/pull/17\\n'; exit 0 ;;
esac
exit 0
`;
  const gh = path.join(dir, "gh");
  writeFileSync(gh, script, "utf8");
  chmodSync(gh, 0o755);
  return {
    dir,
    bodyCopy,
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
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function stubOnPath(config: { response?: string } = {}): GhStub {
  const stub = installGhStub(config);
  cleanup.push(async () => rm(stub.dir, { recursive: true, force: true }));
  vi.stubEnv("PATH", `${stub.dir}${path.delimiter}${process.env["PATH"] ?? ""}`);
  return stub;
}

const testWithPosixGhStub = test.skipIf(process.platform === "win32");

function trackRepo(root: string): void {
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
}

function trackServer(provider: ScriptedProvider): void {
  cleanup.push(
    async () =>
      new Promise<void>((resolve, reject) =>
        provider.server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
}

interface GithubBlock {
  readonly requested: boolean;
  readonly branch: string | null;
  readonly pushed: boolean;
  readonly pullRequest: string | null;
  readonly blocked: string | null;
  readonly error: string | null;
  readonly invocations: Array<{ readonly argv: string[]; readonly ok: boolean }>;
}

interface ResultDocument {
  readonly ok: boolean;
  readonly session: string;
  readonly github?: GithubBlock;
  readonly isolation?: { readonly riskOverride: boolean; readonly patch: string };
}

describe("GitHub issue tasks", () => {
  testWithPosixGhStub(
    "feeds a fetched issue and positional guidance into the provider prompt",
    async () => {
      const issue = {
        number: 7,
        title: "note.txt is stale",
        body: "note.txt should say new instead of old.",
        state: "OPEN",
        url: "https://github.com/octo/demo/issues/7",
      };
      const stub = stubOnPath({ response: JSON.stringify(issue) });
      const root = await repository();
      trackRepo(root);
      const provider = await scriptedProvider();
      trackServer(provider);

      const captured = capturedIO();
      const code = await main(
        [
          "run",
          "Prefer the smallest change.",
          "--repo",
          root,
          "--url",
          provider.url,
          "--model",
          "scripted",
          "--from-issue",
          "7",
          "--yes",
          "--json",
        ],
        captured.io,
      );

      expect(code).toBe(0);
      expect(stub.invocations()).toEqual([
        ["issue", "view", "7", "--json", "number,title,body,state,url"],
      ]);
      const prompt = provider.userMessages.find((message) =>
        message.includes("GitHub issue #7: note.txt is stale"),
      );
      expect(prompt).toBeDefined();
      expect(prompt).toContain(issue.body);
      expect(prompt).toContain("Additional guidance from the user:\nPrefer the smallest change.");
    },
    30_000,
  );
});

describe("publication refusals", () => {
  test("exits 2 on the flag refusal matrix before any provider contact", async () => {
    const root = await repository();
    trackRepo(root);
    const provider = await scriptedProvider();
    trackServer(provider);
    const base = ["run", "task", "--repo", root, "--url", provider.url, "--model", "scripted"];

    const withoutIsolate = capturedIO();
    expect(await main([...base, "--pr", "--yes"], withoutIsolate.io)).toBe(2);
    expect(withoutIsolate.err.join("\n")).toContain("--pr requires --isolate");

    const withoutVerify = capturedIO();
    expect(
      await main([...base, "--isolate", "--pr", "--no-verify", "--yes"], withoutVerify.io),
    ).toBe(2);
    expect(withoutVerify.err.join("\n")).toMatch(/--pr requires verification/);

    const badReference = capturedIO();
    expect(
      await main(
        [...base, "--from-issue", "https://gitlab.com/octo/demo/issues/3", "--yes"],
        badReference.io,
      ),
    ).toBe(2);
    expect(badReference.err.join("\n")).toMatch(/--from-issue needs/);

    expect(provider.requests.length).toBe(0);
  });

  test("refuses a pre-existing remote branch without force", async () => {
    const root = await repository();
    trackRepo(root);
    const bare = bareOrigin(root);
    cleanup.push(async () => rm(bare, { recursive: true, force: true }));
    git(root, "push", "origin", "HEAD:refs/heads/forge/collision");
    const worktree = await createIsolatedWorktree(root, "wt-collision");
    cleanup.push(async () => removeIsolatedWorktree(worktree).catch(() => undefined));
    writeFileSync(path.join(worktree.root, "note.txt"), "changed\n");

    const result = await publishPullRequest(worktree, {
      sessionId: "collision",
      title: "collision test",
      body: "body",
    });

    expect(result.ok).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.error).toMatch(/already has forge\/collision/);
    expect(result.invocations.some((entry) => entry.argv[1] === "push")).toBe(false);
    expect(result.invocations.flatMap((entry) => [...entry.argv])).not.toContain("--force");
    expect(bareBranches(bare)).toEqual(["refs/heads/forge/collision"]);
  });

  test("never publishes .forge run artifacts, even when the repository does not ignore them", async () => {
    // Every other fixture gitignores .forge/, which is exactly how this class
    // of leak hides: a repository on its first Forge run has no such entry.
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-github-noignore-")));
    trackRepo(root);
    git(root, "init");
    git(root, "config", "user.email", "forge-tests@example.invalid");
    git(root, "config", "user.name", "Forge Tests");
    writeFileSync(path.join(root, "note.txt"), "old\n");
    git(root, "add", "note.txt");
    git(root, "commit", "-m", "initial");
    const bare = bareOrigin(root);
    cleanup.push(async () => rm(bare, { recursive: true, force: true }));
    const worktree = await createIsolatedWorktree(root, "wt-noignore");
    cleanup.push(async () => removeIsolatedWorktree(worktree).catch(() => undefined));
    writeFileSync(path.join(worktree.root, "note.txt"), "changed\n");
    mkdirSync(path.join(worktree.root, ".forge", "sessions"), { recursive: true });
    writeFileSync(path.join(worktree.root, ".forge", "sessions", "leak.jsonl"), "{}\n");

    const result = await publishPullRequest(worktree, {
      sessionId: "noignore",
      title: "forge ignore test",
      body: "body",
    });

    expect(result.pushed).toBe(true);
    const pushed = git(bare, "ls-tree", "-r", "--name-only", "refs/heads/forge/noignore");
    expect(pushed).toContain("note.txt");
    expect(pushed).not.toMatch(/\.forge\//);
  }, 60_000);

  test("never discloses credentials embedded in the origin URL", async () => {
    const root = await repository();
    trackRepo(root);
    // A credentialed remote is common in CI setups; every recorded invocation
    // and refusal message must survive serialization without the secret.
    git(root, "remote", "add", "origin", "https://user:sekret123@127.0.0.1:1/repo.git");
    const worktree = await createIsolatedWorktree(root, "wt-credentials");
    cleanup.push(async () => removeIsolatedWorktree(worktree).catch(() => undefined));
    writeFileSync(path.join(worktree.root, "note.txt"), "changed\n");

    const result = await publishPullRequest(worktree, {
      sessionId: "credentials",
      title: "credential redaction test",
      body: "body",
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sekret123");
  });

  test("refuses a repository without an origin remote", async () => {
    const root = await repository();
    trackRepo(root);
    const worktree = await createIsolatedWorktree(root, "wt-no-origin");
    cleanup.push(async () => removeIsolatedWorktree(worktree).catch(() => undefined));
    writeFileSync(path.join(worktree.root, "note.txt"), "changed\n");

    const result = await publishPullRequest(worktree, {
      sessionId: "no-origin",
      title: "no origin test",
      body: "body",
    });

    expect(result.ok).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.error).toMatch(/origin/);
  });

  test("refuses an unset git identity before committing", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-github-cli-")));
    trackRepo(root);
    git(root, "init");
    writeFileSync(path.join(root, "note.txt"), "old\n");
    git(root, "add", "note.txt");
    git(
      root,
      "-c",
      "user.email=forge-tests@example.invalid",
      "-c",
      "user.name=Forge Tests",
      "commit",
      "-m",
      "initial",
    );
    const worktree = await createIsolatedWorktree(root, "wt-no-identity");
    cleanup.push(async () => removeIsolatedWorktree(worktree).catch(() => undefined));
    writeFileSync(path.join(worktree.root, "note.txt"), "changed\n");
    const home = mkdtempSync(path.join(tmpdir(), "forge-empty-home-"));
    cleanup.push(async () => rm(home, { recursive: true, force: true }));
    vi.stubEnv("HOME", home);

    const result = await publishPullRequest(worktree, {
      sessionId: "no-identity",
      title: "identity test",
      body: "body",
    });

    expect(result.ok).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.error).toMatch(/git identity/);
    expect(result.invocations.some((entry) => entry.argv[1] === "commit")).toBe(false);
  });
});

describe("draft pull request publication", () => {
  testWithPosixGhStub(
    "publishes a verified isolated run as one fresh draft branch and PR",
    async () => {
      const stub = stubOnPath();
      const root = await repository();
      trackRepo(root);
      const bare = bareOrigin(root);
      cleanup.push(async () => rm(bare, { recursive: true, force: true }));
      const provider = await scriptedProvider();
      trackServer(provider);

      const captured = capturedIO();
      const code = await main(
        [
          "run",
          "Change note.txt from old to new.",
          "--repo",
          root,
          "--url",
          provider.url,
          "--model",
          "scripted",
          "--yes",
          "--isolate",
          "--pr",
          "--json",
        ],
        captured.io,
      );
      const result = JSON.parse(captured.out.join("\n")) as ResultDocument;

      expect(code).toBe(0);
      const branch = `forge/${result.session}`;
      expect(result.github).toMatchObject({
        requested: true,
        branch,
        pushed: true,
        blocked: null,
        error: null,
      });
      expect(result.github?.pullRequest).toMatch(/^https:\/\//);
      expect(bareBranches(bare)).toEqual([`refs/heads/${branch}`]);
      expect(git(bare, "show", `refs/heads/${branch}:note.txt`)).toBe("new");

      const prInvocation = stub.invocations().find((argv) => argv[0] === "pr");
      expect(prInvocation?.slice(0, 5)).toEqual(["pr", "create", "--draft", "--head", branch]);
      const audit = result.github?.invocations ?? [];
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.flatMap((entry) => entry.argv)).not.toContain("--force");
      expect(stub.invocations().flat()).not.toContain("--force");

      const body = readFileSync(stub.bodyCopy, "utf8");
      expect(body).toContain(`Session: ${result.session}`);
      expect(body).not.toMatch(/closes|fixes|resolves/i);
      // Published, not promoted: the original checkout is untouched.
      expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("old\n");
    },
    30_000,
  );

  test("publishes nothing when verification never passes", async () => {
    const stub = stubOnPath();
    const root = await repository(NOTE_CHANGE, [[process.execPath, "-e", "process.exit(1)"]]);
    trackRepo(root);
    const bare = bareOrigin(root);
    cleanup.push(async () => rm(bare, { recursive: true, force: true }));
    const provider = await scriptedProvider();
    trackServer(provider);

    const captured = capturedIO();
    const code = await main(
      [
        "run",
        "Change note.txt from old to new.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--isolate",
        "--pr",
        "--json",
        "--max-turns",
        "3",
      ],
      captured.io,
    );
    const result = JSON.parse(captured.out.join("\n")) as ResultDocument;

    expect(code).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.github?.pushed).toBe(false);
    expect(result.github?.pullRequest).toBeNull();
    expect(result.github?.blocked).toMatch(/nothing was published/);
    expect(result.github?.invocations).toEqual([]);
    expect(bareBranches(bare)).toEqual([]);
    expect(stub.invocations()).toEqual([]);
  }, 30_000);

  testWithPosixGhStub(
    "blocks a critical-risk patch until --allow-risk and records the override",
    async () => {
      const change: ScriptedChange = {
        file: "config.ts",
        before: 'export const apiKey = "safe";\n',
        after: 'export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";\n',
      };
      const stub = stubOnPath();
      const root = await repository(change);
      trackRepo(root);
      const bare = bareOrigin(root);
      cleanup.push(async () => rm(bare, { recursive: true, force: true }));
      const provider = await scriptedProvider(change);
      trackServer(provider);

      const base = [
        "run",
        "Update config.ts.",
        "--repo",
        root,
        "--url",
        provider.url,
        "--model",
        "scripted",
        "--yes",
        "--isolate",
        "--pr",
        "--json",
      ];

      const blocked = capturedIO();
      const blockedCode = await main(base, blocked.io);
      const blockedResult = JSON.parse(blocked.out.join("\n")) as ResultDocument;
      expect(blockedCode).toBe(2);
      expect(blockedResult.github?.pushed).toBe(false);
      expect(blockedResult.github?.blocked).toMatch(/critical patch risk/i);
      expect(bareBranches(bare)).toEqual([]);
      expect(stub.invocations()).toEqual([]);
      // The patch survives the refusal for inspection.
      expect(blockedResult.isolation?.patch).toBeDefined();

      const overridden = capturedIO();
      const overriddenCode = await main([...base, "--allow-risk"], overridden.io);
      const overriddenResult = JSON.parse(overridden.out.join("\n")) as ResultDocument;
      expect(overriddenCode).toBe(0);
      expect(overriddenResult.isolation?.riskOverride).toBe(true);
      expect(overriddenResult.github?.pullRequest).toMatch(/^https:\/\//);
      expect(bareBranches(bare)).toEqual([`refs/heads/forge/${overriddenResult.session}`]);
    },
    60_000,
  );
});
