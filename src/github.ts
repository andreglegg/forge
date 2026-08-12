/**
 * GitHub integration: issue-driven tasks and draft-PR publication.
 *
 * Two trust rules govern this file. Issue text is untrusted task input: it is
 * composed into the prompt under hard bounds and never into a command. And
 * `gh`/`git` here run only argv Forge itself composed, through the same
 * bounded shell-free executor as every other command, with the user's
 * GH_TOKEN/GITHUB_TOKEN forwarded into gh alone — never into model commands,
 * whose environment allowlist is untouched. Forge never reads, parses, or
 * stores the token itself; gh carries its own auth.
 *
 * Publication is structurally narrow: the branch namespace is fixed to
 * `forge/<sessionId>`, an existing remote branch refuses rather than reuses,
 * no composed argv contains `--force`, and the default branch is unreachable
 * because only `refs/heads/forge/…` is ever named.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execBounded } from "./exec.js";
import type { IsolatedWorktree } from "./isolation.js";

export interface IssueReference {
  readonly issue: number;
  readonly repo: string | null;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

function referenceFrom(owner: string, repo: string, issue: string): IssueReference | null {
  if (!OWNER.test(owner) || !REPO.test(repo) || !ISSUE_NUMBER.test(issue)) return null;
  return { issue: Number(issue), repo: `${owner}/${repo}` };
}

/** github.com and `/issues/` only; anything else is refused, never guessed. */
export function parseIssueReference(text: string): IssueReference | null {
  const trimmed = text.trim();
  const bare = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (ISSUE_NUMBER.test(bare)) return { issue: Number(bare), repo: null };
  const short = /^([^\s/#]+)\/([^\s/#]+)#([0-9]+)$/.exec(trimmed);
  if (short !== null) return referenceFrom(short[1] ?? "", short[2] ?? "", short[3] ?? "");
  if (!trimmed.startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Credentials, ports, queries, and fragments are smuggling surface, not
  // spelling variety.
  if (url.hostname !== "github.com" || url.port !== "") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/.exec(url.pathname);
  if (match === null) return null;
  return referenceFrom(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

/** Only gh's own credential crosses; the model-command allowlist never learns it. */
export function githubCliEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface GithubInvocation {
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly ok: boolean;
  readonly output: string;
}

export const GH_MISSING_MESSAGE =
  "gh CLI not found; --from-issue and --pr require the GitHub CLI on PATH";

/**
 * A credentialed remote (`https://user:token@…`) is common in CI setups, and
 * `git remote get-url` and push errors echo it verbatim. Strip URL userinfo
 * everywhere recorded output or a refusal message can travel: the result
 * document and the session journal both persist.
 */
function redactUrlCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^@/\s]+@/g, "$1***@");
}

function detail(output: string): string {
  const trimmed = redactUrlCredentials(output.trim());
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
}

/** Audit records leave this module clipped and credential-free. */
function sanitized(audit: readonly GithubInvocation[]): GithubInvocation[] {
  return audit.map((entry) => ({ ...entry, output: detail(entry.output) }));
}

async function recorded(
  argv: readonly string[],
  cwd: string,
  audit: GithubInvocation[],
): Promise<GithubInvocation> {
  let record: GithubInvocation;
  try {
    const result = await execBounded(argv, {
      cwd,
      timeoutSeconds: 30,
      maxOutputChars: 200_000,
      extraEnv: argv[0] === "gh" ? githubCliEnvironment() : undefined,
    });
    record = {
      argv,
      code: result.code,
      ok: result.code === 0 && !result.timedOut,
      output: result.output,
    };
  } catch (error) {
    const missing =
      argv[0] === "gh" &&
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    record = {
      argv,
      code: null,
      ok: false,
      output: missing ? GH_MISSING_MESSAGE : error instanceof Error ? error.message : String(error),
    };
  }
  audit.push(record);
  return record;
}

export const ISSUE_TITLE_LIMIT = 300;
export const ISSUE_BODY_LIMIT = 12_000;
export const ISSUE_BODY_TRUNCATION_MARKER = `[issue body truncated at ${ISSUE_BODY_LIMIT} characters]`;

export interface IssueDetails {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly url: string;
}

function parseIssueDetails(text: string): IssueDetails | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "gh issue view did not return JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "gh issue view returned a non-object JSON value";
  }
  const record = value as Record<string, unknown>;
  const number = record["number"];
  if (typeof number !== "number" || !Number.isInteger(number)) {
    return "gh issue view JSON is missing a numeric `number`";
  }
  for (const key of ["title", "body", "state", "url"]) {
    if (typeof record[key] !== "string") return `gh issue view JSON is missing a string \`${key}\``;
  }
  return {
    number,
    title: record["title"] as string,
    body: record["body"] as string,
    state: record["state"] as string,
    url: record["url"] as string,
  };
}

export function composeIssueTask(issue: IssueDetails, guidance = ""): string {
  const title =
    issue.title.length <= ISSUE_TITLE_LIMIT
      ? issue.title
      : `${issue.title.slice(0, ISSUE_TITLE_LIMIT)}…`;
  const body =
    issue.body === ""
      ? "(the issue has no body)"
      : issue.body.length <= ISSUE_BODY_LIMIT
        ? issue.body
        : `${issue.body.slice(0, ISSUE_BODY_LIMIT)}\n${ISSUE_BODY_TRUNCATION_MARKER}`;
  const lines = [
    `GitHub issue #${issue.number}: ${title}`,
    `State: ${issue.state}`,
    `URL: ${issue.url}`,
    "",
    body,
  ];
  if (guidance !== "") lines.push("", "Additional guidance from the user:", guidance);
  return lines.join("\n");
}

export type IssueTaskResult =
  | { readonly ok: true; readonly task: string; readonly url: string }
  | { readonly ok: false; readonly error: string };

export async function fetchIssueTask(
  reference: IssueReference,
  cwd: string,
  guidance = "",
): Promise<IssueTaskResult> {
  const audit: GithubInvocation[] = [];
  const argv = [
    "gh",
    "issue",
    "view",
    String(reference.issue),
    ...(reference.repo === null ? [] : ["--repo", reference.repo]),
    "--json",
    "number,title,body,state,url",
  ];
  const invocation = await recorded(argv, cwd, audit);
  if (!invocation.ok) {
    return { ok: false, error: `could not fetch the issue: ${detail(invocation.output)}` };
  }
  const parsed = parseIssueDetails(invocation.output);
  if (typeof parsed === "string") {
    return { ok: false, error: `${parsed}: ${detail(invocation.output)}` };
  }
  return { ok: true, task: composeIssueTask(parsed, guidance), url: parsed.url };
}

export const PULL_REQUEST_TITLE_LIMIT = 100;

export function pullRequestTitle(task: string): string {
  const first = (task.split("\n", 1)[0] ?? "").trim();
  const bounded =
    first.length <= PULL_REQUEST_TITLE_LIMIT
      ? first
      : `${first.slice(0, PULL_REQUEST_TITLE_LIMIT)}…`;
  return bounded === "" ? "Forge isolated change" : bounded;
}

/** Session id, a verification statement, and a plain issue line — no autoclose keyword. */
export function composePullRequestBody(sessionId: string, issueUrl: string | null): string {
  const lines = [
    "Draft pull request published by Forge from an isolated worktree.",
    "",
    `Session: ${sessionId}`,
    "Verification: the project's own verification gate passed before publication.",
  ];
  if (issueUrl !== null) lines.push(`Issue: ${issueUrl}`);
  return `${lines.join("\n")}\n`;
}

export interface PullRequestPublication {
  readonly ok: boolean;
  readonly branch: string;
  readonly pushed: boolean;
  readonly url: string | null;
  readonly error: string | null;
  readonly invocations: readonly GithubInvocation[];
}

export async function publishPullRequest(
  worktree: IsolatedWorktree,
  details: { readonly sessionId: string; readonly title: string; readonly body: string },
): Promise<PullRequestPublication> {
  const audit: GithubInvocation[] = [];
  const branch = `forge/${details.sessionId}`;
  const refuse = (error: string, pushed = false): PullRequestPublication => ({
    ok: false,
    branch,
    pushed,
    url: null,
    error,
    invocations: sanitized(audit),
  });

  // Identity comes from the repository's own git configuration; an unset one
  // is a hard error before anything is committed, and the patch stays behind.
  for (const key of ["user.name", "user.email"]) {
    const identity = await recorded(["git", "config", key], worktree.root, audit);
    if (!identity.ok || identity.output.trim() === "") {
      return refuse(`git identity is not configured (${key}); set it before using --pr`);
    }
  }
  const staged = await recorded(["git", "add", "-A"], worktree.root, audit);
  if (!staged.ok) return refuse(`could not stage the isolated changes: ${detail(staged.output)}`);
  const committed = await recorded(["git", "commit", "-m", details.title], worktree.root, audit);
  if (!committed.ok) {
    return refuse(`could not commit the isolated changes: ${detail(committed.output)}`);
  }
  const origin = await recorded(["git", "remote", "get-url", "origin"], worktree.root, audit);
  if (!origin.ok) {
    return refuse("the repository has no `origin` remote; --pr publishes only to origin");
  }
  const existing = await recorded(
    ["git", "ls-remote", "--heads", "origin", branch],
    worktree.root,
    audit,
  );
  if (!existing.ok)
    return refuse(`could not check origin for ${branch}: ${detail(existing.output)}`);
  if (existing.output.trim() !== "") {
    return refuse(`origin already has ${branch}; Forge never force-pushes or reuses a branch`);
  }
  const push = await recorded(
    ["git", "push", "origin", `HEAD:refs/heads/${branch}`],
    worktree.root,
    audit,
  );
  if (!push.ok) return refuse(`could not push ${branch} to origin: ${detail(push.output)}`);

  // The body travels by file so issue-derived text is never itself an argument
  // parsed by anything; the scratch file lives in the OS temp dir, not the
  // repository.
  const scratch = mkdtempSync(path.join(tmpdir(), "forge-pr-"));
  try {
    const bodyFile = path.join(scratch, "body.md");
    writeFileSync(bodyFile, details.body, "utf8");
    const created = await recorded(
      [
        "gh",
        "pr",
        "create",
        "--draft",
        "--head",
        branch,
        "--title",
        details.title,
        "--body-file",
        bodyFile,
      ],
      worktree.root,
      audit,
    );
    if (!created.ok) {
      // The enumerated partial state: the branch exists remotely and is
      // reported, never deleted or retried.
      return refuse(
        `pushed ${branch}, but draft PR creation failed; the branch is kept for manual follow-up: ${detail(created.output)}`,
        true,
      );
    }
    const url =
      created.output
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /^https:\/\/\S+$/.test(line)) ?? null;
    return { ok: true, branch, pushed: true, url, error: null, invocations: sanitized(audit) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
