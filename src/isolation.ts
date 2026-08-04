import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execBounded } from "./exec.js";

export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationError";
  }
}

export interface IsolatedWorktree {
  readonly repository: string;
  readonly root: string;
  readonly id: string;
  readonly baseCommit: string;
}

export interface CapturedPatch {
  readonly file: string;
  readonly bytes: number;
  readonly changed: boolean;
}

async function git(
  repository: string,
  args: readonly string[],
  timeoutSeconds = 60,
): Promise<string> {
  const result = await execBounded(["git", ...args], {
    cwd: repository,
    timeoutSeconds,
    maxOutputChars: 200_000,
  });
  if (result.code !== 0 || result.timedOut) {
    const detail = result.output.trim() || `git ${args.join(" ")} exited ${String(result.code)}`;
    throw new IsolationError(detail);
  }
  return result.output.trim();
}

function safeRunId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new IsolationError(
      "isolation id must contain only letters, digits, dot, dash, or underscore",
    );
  }
  return id;
}

/**
 * Create a detached worktree from the repository's current HEAD.
 *
 * A dirty tree is refused because a detached worktree starts from a commit;
 * silently dropping staged, modified, or untracked work would make the isolated
 * run inspect a different project than the user selected.
 */
export async function createIsolatedWorktree(
  repository: string,
  id: string,
): Promise<IsolatedWorktree> {
  const safeId = safeRunId(id);
  const top = await git(repository, ["rev-parse", "--show-toplevel"]);
  const canonicalRepository = path.resolve(repository);
  if (path.resolve(top) !== canonicalRepository) {
    throw new IsolationError(
      `isolated runs require the repository root; selected ${canonicalRepository}, Git root is ${top}`,
    );
  }
  const workingStatus = await git(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (workingStatus !== "") {
    throw new IsolationError(
      "isolated runs require a clean working tree; commit, ignore, or stash all changes first",
    );
  }
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
  const repositoryKey = createHash("sha256").update(canonicalRepository).digest("hex").slice(0, 12);
  const parent = path.join(tmpdir(), "forge-worktrees", repositoryKey);
  const root = path.join(parent, safeId);
  mkdirSync(parent, { recursive: true });
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  await git(repository, ["worktree", "add", "--detach", root, baseCommit], 120);
  return { repository: canonicalRepository, root, id: safeId, baseCommit };
}

/** Capture tracked edits and non-ignored new files as one portable Git patch. */
export async function captureIsolatedPatch(worktree: IsolatedWorktree): Promise<CapturedPatch> {
  // Intent-to-add makes ordinary untracked files visible to `git diff` without
  // staging their contents or affecting the original worktree's index.
  await git(worktree.root, ["add", "-N", "--", "."]);
  const patch = await git(worktree.root, ["diff", "--binary", "--no-ext-diff", "HEAD"]);
  const directory = path.join(worktree.repository, ".forge", "isolated");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${worktree.id}.patch`);
  const body = patch === "" ? "" : `${patch}\n`;
  writeFileSync(file, body, "utf8");
  return { file, bytes: Buffer.byteLength(body), changed: body.length > 0 };
}

/**
 * Apply a captured patch only if the selected repository is still the same
 * clean tracked checkout from which the isolated worktree was created.
 */
export async function promoteIsolatedPatch(
  worktree: IsolatedWorktree,
  patch: CapturedPatch,
): Promise<void> {
  if (!patch.changed) return;
  const currentHead = await git(worktree.repository, ["rev-parse", "HEAD"]);
  if (currentHead !== worktree.baseCommit) {
    throw new IsolationError(
      `repository HEAD changed during the isolated run (${worktree.baseCommit.slice(0, 12)} -> ${currentHead.slice(0, 12)})`,
    );
  }
  const workingStatus = await git(worktree.repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (workingStatus !== "") {
    throw new IsolationError(
      "the original working tree changed during the isolated run; patch retained but not promoted",
    );
  }
  await git(worktree.repository, ["apply", "--check", "--whitespace=nowarn", patch.file]);
  await git(worktree.repository, ["apply", "--whitespace=nowarn", patch.file]);
}

/** Copy the durable evidence needed by sessions, traces, and guarded undo. */
export function transferIsolatedArtifacts(worktree: IsolatedWorktree, sessionId: string): void {
  const isolatedForge = path.join(worktree.root, ".forge");
  const destinationForge = path.join(worktree.repository, ".forge");
  const copyOne = (subdirectory: string, extension: string): void => {
    const source = path.join(isolatedForge, subdirectory, `${sessionId}${extension}`);
    if (!existsSync(source)) return;
    const destination = path.join(destinationForge, subdirectory, `${sessionId}${extension}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  };
  copyOne("sessions", ".jsonl");
  copyOne("traces", ".jsonl");
  const objects = path.join(isolatedForge, "objects");
  if (existsSync(objects)) {
    cpSync(objects, path.join(destinationForge, "objects"), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
}

export async function removeIsolatedWorktree(worktree: IsolatedWorktree): Promise<void> {
  try {
    await git(worktree.repository, ["worktree", "remove", "--force", worktree.root], 120);
    await git(worktree.repository, ["worktree", "prune"]);
  } catch (error) {
    // Try to remove the ordinary directory while preserving the original error;
    // the linked-worktree administrative record may still need manual pruning.
    rmSync(worktree.root, { recursive: true, force: true });
    throw error;
  }
}

export function readCapturedPatch(patch: CapturedPatch): string {
  return readFileSync(patch.file, "utf8");
}
