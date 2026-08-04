/**
 * Everything that touches the filesystem, and the only place that does.
 *
 * Two rules make this layer worth having separately:
 *
 * 1. **A proposal is previewed in memory, never applied to see what happens.**
 *    The user approves a diff, so the diff must exist before the approval, and
 *    computing it must not modify anything. `preview()` reads and returns; it
 *    does not write.
 * 2. **A commit revalidates the base revision.** Approval is consent for a
 *    specific version of a file. Between proposing and committing the file can
 *    change -- an earlier edit in the same turn, a verification command, a
 *    human saving in their editor. Committing without re-checking applies the
 *    edit to something the user never saw.
 *
 * Path containment is component-wise and symlink-aware. `path.resolve` is not
 * enough: with an in-repo symlink pointing outward it returns a path that still
 * looks inside, so the model can read and write anywhere on the host. And
 * `realpathSync` alone cannot be used because a new file has no realpath yet.
 * `resolveInside` walks to the longest existing ancestor, realpaths that, then
 * resolves the remainder lexically.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { EditProposal } from "./protocol.js";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** sha256 of a file's bytes, or null if it does not exist. */
export function revisionOf(file: string): string | null {
  try {
    return revisionOfBytes(readFileSync(file));
  } catch {
    return null;
  }
}

/** sha256 of the exact text bytes used to build a preview. */
export function revisionOfContent(content: string): string {
  return revisionOfBytes(Buffer.from(content, "utf8"));
}

function revisionOfBytes(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * CPython `Path.resolve()` semantics: follow symlinks as far as the filesystem
 * knows, resolve the rest lexically, never fail on a path that does not exist.
 */
export function resolveInside(root: string, candidate: string): string | null {
  if (!candidate || candidate.includes("\0")) {
    return null;
  }
  // A Windows drive or UNC path is an ordinary relative filename on POSIX, so
  // it would otherwise be treated as a file inside the repository.
  if (/^[A-Za-z]:/.test(candidate) || /^[\\/]{2}[^\\/]+[\\/]/.test(candidate)) {
    return null;
  }
  // The root must be realpath'd before anything is compared against it. On
  // macOS the OS temp dir is `/var/...` symlinked to `/private/var/...`, and
  // the containment check below is component-wise, so the two spellings share
  // no prefix and every contained path would read as an escape.
  let base: string;
  try {
    base = realpathSync(path.resolve(root));
  } catch {
    base = path.resolve(root);
  }
  const normalized = candidate.replaceAll("\\", "/");
  const absolute = path.resolve(base, normalized);
  const { root: fsRoot } = path.parse(absolute);
  const parts = absolute.slice(fsRoot.length).split(path.sep).filter(Boolean);

  let prefix = fsRoot;
  let index = 0;
  for (; index < parts.length; index += 1) {
    try {
      prefix = realpathSync(path.join(prefix, parts[index] ?? ""));
    } catch {
      break;
    }
  }
  const tail: string[] = [];
  for (; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (part === ".") continue;
    if (part === "..") {
      if (tail.length > 0) tail.pop();
      else prefix = path.dirname(prefix);
      continue;
    }
    tail.push(part);
  }
  const resolved = tail.length > 0 ? path.join(prefix, ...tail) : prefix;

  // Component-wise, never a string prefix: "/x/repo-evil".startsWith("/x/repo").
  const relative = path.relative(base, resolved);
  if (
    relative !== "" &&
    (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  ) {
    return null;
  }
  return resolved;
}

export interface Hunk {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

export interface Preview {
  readonly kind: "edit" | "delete";
  readonly path: string;
  readonly create: boolean;
  readonly baseRevision: string | null;
  readonly afterRevision: string | null;
  readonly before: string;
  readonly after: string;
  readonly hunks: Hunk[];
  readonly added: number;
  readonly removed: number;
}

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    // Realpath the root itself, and do it directly rather than through
    // `resolveInside`, which compares its answer *against* the root it was
    // given. On macOS the OS temp dir is `/var/...` symlinked to
    // `/private/var/...`, so an un-realpathed root makes every contained path
    // look like an escape -- the containment check is component-wise, and the
    // two spellings share no prefix.
    try {
      this.root = realpathSync(path.resolve(root));
    } catch {
      this.root = path.resolve(root);
    }
  }

  /**
   * Compute what an edit would do, without doing it.
   *
   * Throws rather than returning a partial preview: a proposal that cannot be
   * previewed cannot be approved, and the model needs the reason so it can fix
   * the anchor. The messages here are model-facing.
   */
  preview(proposal: EditProposal): Preview {
    const target = resolveInside(this.root, proposal.path);
    if (target === null) {
      throw new WorkspaceError(`${proposal.path} is outside the workspace`);
    }
    const exists = existsSync(target);
    if (proposal.create && exists) {
      throw new WorkspaceError(`${proposal.path} already exists; edit it instead of creating it`);
    }
    if (!proposal.create && !exists) {
      throw new WorkspaceError(`${proposal.path} does not exist; use CREATE to add it`);
    }
    const beforeBytes = exists ? readFileSync(target) : null;
    const before = beforeBytes?.toString("utf8") ?? "";
    let after = before;
    for (const operation of proposal.operations) {
      // A wholesale replacement of a file the model has read. Same shape as a
      // creation -- only the new text, no quoted original -- which is why it
      // fits in one reply where a SEARCH/REPLACE of the whole file does not.
      if (proposal.create || proposal.rewrite) {
        after = operation.replace;
        continue;
      }
      const found = countOf(after, operation.search);
      if (found === 0) {
        throw new WorkspaceError(
          `the search text was not found in ${proposal.path}. Read the file again and quote it exactly.`,
        );
      }
      if (found !== operation.expectedMatches) {
        throw new WorkspaceError(
          `the search text appears ${found} times in ${proposal.path}, expected ${operation.expectedMatches}. Include more surrounding lines so the anchor is unique.`,
        );
      }
      after = after.replace(operation.search, () => operation.replace);
    }
    if (after === before) {
      // A no-op edit is not progress, and counting it as progress is worse
      // than refusing it: it lets a model satisfy the "something committed"
      // check without changing anything, which is precisely the false-success
      // shape the rest of this package exists to catch. Seen in a real run as
      // `committed src/math.js +0 -0`.
      throw new WorkspaceError(
        `that edit would leave ${proposal.path} unchanged. If the change is already there, say so instead of re-applying it.`,
      );
    }
    const hunks = diffLines(before, after);
    return {
      kind: "edit",
      path: proposal.path,
      create: proposal.create,
      // Hash the bytes already read rather than opening the file again. A
      // second read could observe a concurrent save and pair that new hash
      // with a diff generated from the old contents.
      baseRevision: beforeBytes === null ? null : revisionOfBytes(beforeBytes),
      afterRevision: revisionOfContent(after),
      before,
      after,
      hunks,
      added: hunks.filter((h) => h.kind === "add").length,
      removed: hunks.filter((h) => h.kind === "remove").length,
    };
  }

  /**
   * Preview deletion of one regular file. Directories and final-component
   * symlinks are deliberately excluded: recursive removal is too broad for a
   * one-line model directive, and deleting through a symlink can target a file
   * other than the path the user approved.
   */
  previewDelete(relative: string): Preview {
    const target = resolveInside(this.root, relative);
    if (target === null) {
      throw new WorkspaceError(`${relative} is outside the workspace`);
    }
    const lexical = path.resolve(this.root, relative.replaceAll("\\", "/"));
    if (!existsSync(lexical)) {
      throw new WorkspaceError(`${relative} does not exist`);
    }
    if (lstatSync(lexical).isSymbolicLink()) {
      throw new WorkspaceError(`${relative} is a symbolic link; Forge deletes regular files only`);
    }
    if (!statSync(target).isFile()) {
      throw new WorkspaceError(
        `${relative} is not a regular file; Forge does not delete directories`,
      );
    }
    const beforeBytes = readFileSync(target);
    const before = beforeBytes.toString("utf8");
    const hunks = diffLines(before, "");
    return {
      kind: "delete",
      path: relative,
      create: false,
      baseRevision: revisionOfBytes(beforeBytes),
      afterRevision: null,
      before,
      after: "",
      hunks,
      added: 0,
      removed: hunks.filter((h) => h.kind === "remove").length,
    };
  }

  /**
   * Apply a previewed mutation, refusing if the file moved underneath it.
   *
   * The write is temp-file-then-rename, which is the same POSIX `rename(2)`
   * the rest of the world relies on: a crash mid-write leaves the previous
   * file intact rather than a truncated one.
   */
  commit(preview: Preview): void {
    const target = resolveInside(this.root, preview.path);
    if (target === null) {
      throw new WorkspaceError(`${preview.path} is outside the workspace`);
    }
    const current = revisionOf(target);
    if (current !== preview.baseRevision) {
      const mutation = preview.kind === "delete" ? "deletion" : "edit";
      throw new WorkspaceError(
        `${preview.path} changed after it was approved, so the ${mutation} was not applied. Read it again.`,
      );
    }
    if (preview.kind === "delete") {
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new WorkspaceError(
          `${preview.path} changed after it was approved, so the deletion was not applied. Read it again.`,
        );
      }
      // Re-check immediately before removal. This mirrors the edit path's
      // second revision check immediately before its atomic rename.
      if (revisionOf(target) !== preview.baseRevision) {
        throw new WorkspaceError(
          `${preview.path} changed after it was approved, so the deletion was not applied. Read it again.`,
        );
      }
      rmSync(target);
      return;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.forge-tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, preview.after, "utf8");
      // Writing the temporary file can take long enough for an editor or
      // formatter to save the target. Re-check immediately before the atomic
      // replace so that change is not overwritten.
      if (revisionOf(target) !== preview.baseRevision) {
        throw new WorkspaceError(
          `${preview.path} changed after it was approved, so the edit was not applied. Read it again.`,
        );
      }
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** The sha256 of a file right now, or null. For revision-keyed read guards. */
  revision(relative: string): string | null {
    const target = resolveInside(this.root, relative);
    return target === null ? null : revisionOf(target);
  }

  read(relative: string): string {
    const target = resolveInside(this.root, relative);
    if (target === null) {
      throw new WorkspaceError(`${relative} is outside the workspace`);
    }
    return readFileSync(target, "utf8");
  }
}

function countOf(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Line diff, longest-common-subsequence.
 *
 * Written rather than depended on: the output feeds an approval prompt, so it
 * has to be exact and stable, and it is forty lines. `diffLines` from jsdiff
 * would also work but brings a dependency for one function whose behaviour we
 * want pinned.
 */
export function diffLines(before: string, after: string): Hunk[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lengths[i];
      const next = lengths[i + 1];
      if (row === undefined || next === undefined) continue;
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      hunks.push({ kind: "context", text: a[i] ?? "" });
      i += 1;
      j += 1;
      continue;
    }
    const down = lengths[i + 1]?.[j] ?? 0;
    const right = lengths[i]?.[j + 1] ?? 0;
    if (down >= right) {
      hunks.push({ kind: "remove", text: a[i] ?? "" });
      i += 1;
    } else {
      hunks.push({ kind: "add", text: b[j] ?? "" });
      j += 1;
    }
  }
  while (i < a.length) {
    hunks.push({ kind: "remove", text: a[i] ?? "" });
    i += 1;
  }
  while (j < b.length) {
    hunks.push({ kind: "add", text: b[j] ?? "" });
    j += 1;
  }
  return hunks;
}
