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
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
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

export function revisionOfBytes(content: Buffer): string {
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

export type EntryType = "file" | "directory" | "symlink";
export type MutationOperation = "create" | "write" | "delete";

export interface MutationChange {
  readonly operation: MutationOperation;
  readonly entryType: EntryType;
  readonly path: string;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
  readonly beforeMode: number | null;
  readonly afterMode: number | null;
  readonly added: number;
  readonly removed: number;
}

interface EntrySnapshot {
  readonly path: string;
  readonly entryType: EntryType;
  readonly revision: string | null;
  readonly mode: number;
}

interface PreviewGuard {
  readonly path: string;
  readonly expected: readonly EntrySnapshot[] | null;
}

export interface Preview {
  readonly kind: "edit" | "delete" | "mkdir" | "move" | "copy";
  readonly path: string;
  readonly source?: string;
  readonly destination?: string;
  readonly create: boolean;
  readonly baseRevision: string | null;
  readonly afterRevision: string | null;
  readonly before: string;
  readonly after: string;
  readonly hunks: Hunk[];
  readonly added: number;
  readonly removed: number;
  readonly changes: readonly MutationChange[];
  readonly guards: readonly PreviewGuard[];
  readonly createdParents: readonly string[];
  /** Binary-safe bytes retained for delete/move undo. Maps serialize as `{}` in journals. */
  readonly retained: ReadonlyMap<string, Buffer>;
}

const PROTECTED_ROOTS = new Set([".git", ".forge", ".codex-bridge"]);
/**
 * Names that read as a source file rather than a directory.
 *
 * Deliberately a closed list of code and config extensions, not "anything with
 * a dot": `.github`, `v1.2`, and `my.project` are ordinary directory names and
 * must stay legal.
 */
const SOURCE_FILE_NAME =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|json|ya?ml|toml|md|txt|html|css|scss)$/i;

/** Lines of real file shown around a failed anchor, and the most it may cost. */
const ANCHOR_CONTEXT_LINES = 3;
const ANCHOR_HINT_CHARS = 700;

/**
 * The text the model probably meant.
 *
 * A mis-quoted SEARCH anchor is the most common editing failure these models
 * have, and "read the file again and quote it exactly" is advice the model
 * already believes it followed -- observed live, a 14B re-sent the identical
 * failing anchor five times against `src/account.js`. Showing the closest real
 * lines turns a refusal into the correction, without a second model call:
 * the file is already in hand, and the comparison is deterministic.
 */
function nearestAnchor(content: string, search: string): string {
  const wanted = search.split("\n").find((line) => line.trim() !== "");
  if (wanted === undefined) return "";
  const target = normalizedTokens(wanted);
  if (target.size === 0) return "";
  const lines = content.split("\n");
  let bestIndex = -1;
  let bestScore = 0;
  for (const [index, line] of lines.entries()) {
    const score = tokenOverlap(target, normalizedTokens(line));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  // Below roughly a third shared, the "closest" line is noise, and printing
  // noise as a suggestion is worse than printing nothing.
  if (bestIndex === -1 || bestScore < 0.34) return "";
  const from = Math.max(0, bestIndex - ANCHOR_CONTEXT_LINES);
  const to = Math.min(lines.length, bestIndex + ANCHOR_CONTEXT_LINES + 1);
  const shown = lines
    .slice(from, to)
    .map((line, offset) => `${from + offset + 1}: ${line}`)
    .join("\n");
  return `\nThe closest text actually in the file is lines ${from + 1}-${to}:\n${shown.slice(0, ANCHOR_HINT_CHARS)}`;
}

function normalizedTokens(line: string): Set<string> {
  return new Set(line.split(/[^A-Za-z0-9_$]+/).filter((token) => token !== ""));
}

function tokenOverlap(wanted: Set<string>, candidate: Set<string>): number {
  if (candidate.size === 0) return 0;
  let shared = 0;
  for (const token of wanted) if (candidate.has(token)) shared += 1;
  return shared / Math.max(wanted.size, candidate.size);
}

const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_BYTES = 128 * 1024 * 1024;

function portableMode(mode: number): number {
  return process.platform === "win32" ? 0 : mode & 0o7777;
}

interface CapturedTree {
  readonly entries: readonly EntrySnapshot[];
  readonly retained: ReadonlyMap<string, Buffer>;
}

function normalizeMutationPath(
  root: string,
  candidate: string,
): { relative: string; absolute: string } {
  if (!candidate || candidate.includes("\0")) {
    throw new WorkspaceError(`${candidate || "the empty path"} is outside the workspace`);
  }
  if (/^[A-Za-z]:/.test(candidate) || /^[\\/]{2}[^\\/]+[\\/]/.test(candidate)) {
    throw new WorkspaceError(`${candidate} is outside the workspace`);
  }
  const relative = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (relative === "." || relative === "" || relative === ".." || relative.startsWith("../")) {
    throw new WorkspaceError("the repository root cannot be changed by a filesystem directive");
  }
  const first = relative.split("/")[0] ?? "";
  if (PROTECTED_ROOTS.has(first)) {
    throw new WorkspaceError(`${relative} is protected repository metadata`);
  }
  const parent = path.posix.dirname(relative);
  if (parent !== ".") {
    let current = root;
    let currentRelative = "";
    for (const part of parent.split("/").filter(Boolean)) {
      current = path.join(current, part);
      currentRelative = currentRelative ? `${currentRelative}/${part}` : part;
      if (!entryExists(current)) break;
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new WorkspaceError(
          `${relative} traverses symbolic-link parent ${currentRelative}; target the link or its real path explicitly`,
        );
      }
      if (!stat.isDirectory()) {
        throw new WorkspaceError(`${currentRelative} is not a real directory`);
      }
    }
  }
  const absolute = path.resolve(root, relative);
  const escaped = path.relative(root, absolute);
  if (escaped === ".." || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) {
    throw new WorkspaceError(`${relative} is outside the workspace`);
  }
  if (parent !== "." && resolveInside(root, parent) === null) {
    throw new WorkspaceError(`${relative} is outside the workspace`);
  }
  return { relative, absolute };
}

function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function depthOf(relative: string): number {
  return relative.split("/").filter(Boolean).length;
}

function entryTypeOf(target: string): EntryType {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  throw new WorkspaceError(`${target} is not a regular file, directory, or symlink`);
}

function captureTree(root: string, relativeInput: string): CapturedTree {
  const { relative, absolute } = normalizeMutationPath(root, relativeInput);
  if (!entryExists(absolute)) {
    throw new WorkspaceError(`${relative} does not exist`);
  }
  const entries: EntrySnapshot[] = [];
  const retained = new Map<string, Buffer>();
  let totalBytes = 0;
  const visit = (entryRelative: string, entryAbsolute: string): void => {
    if (entries.length >= MAX_TREE_ENTRIES) {
      throw new WorkspaceError(
        `${relative} contains more than ${MAX_TREE_ENTRIES} entries; use an explicitly approved command for a larger operation`,
      );
    }
    const type = entryTypeOf(entryAbsolute);
    const stat = lstatSync(entryAbsolute);
    const mode = portableMode(stat.mode);
    if (type === "directory") {
      entries.push({ path: entryRelative, entryType: type, revision: null, mode });
      for (const name of readdirSync(entryAbsolute).sort()) {
        visit(path.posix.join(entryRelative, name), path.join(entryAbsolute, name));
      }
      return;
    }
    const bytes =
      type === "symlink"
        ? Buffer.from(readlinkSync(entryAbsolute), "utf8")
        : readFileSync(entryAbsolute);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TREE_BYTES) {
      throw new WorkspaceError(
        `${relative} contains more than ${Math.floor(MAX_TREE_BYTES / (1024 * 1024))} MiB; use an explicitly approved command for a larger operation`,
      );
    }
    retained.set(entryRelative, bytes);
    entries.push({
      path: entryRelative,
      entryType: type,
      revision: revisionOfBytes(bytes),
      mode,
    });
  };
  visit(relative, absolute);
  return { entries, retained };
}

function snapshotsEqual(
  left: readonly EntrySnapshot[] | null,
  right: readonly EntrySnapshot[] | null,
): boolean {
  const canonical = (value: readonly EntrySnapshot[] | null): readonly EntrySnapshot[] | null =>
    value === null
      ? null
      : [...value].sort(
          (a, b) => a.path.localeCompare(b.path) || a.entryType.localeCompare(b.entryType),
        );
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function captureMaybe(root: string, relative: string): readonly EntrySnapshot[] | null {
  const { absolute } = normalizeMutationPath(root, relative);
  return entryExists(absolute) ? captureTree(root, relative).entries : null;
}

function asDeleteChanges(entries: readonly EntrySnapshot[]): MutationChange[] {
  const leaves = entries
    .filter((entry) => entry.entryType !== "directory")
    .sort((a, b) => a.path.localeCompare(b.path));
  const directories = entries
    .filter((entry) => entry.entryType === "directory")
    .sort((a, b) => depthOf(b.path) - depthOf(a.path) || a.path.localeCompare(b.path));
  return [...leaves, ...directories].map((entry) => ({
    operation: "delete" as const,
    entryType: entry.entryType,
    path: entry.path,
    beforeRevision: entry.revision,
    afterRevision: null,
    beforeMode: entry.mode,
    afterMode: null,
    added: 0,
    removed: 1,
  }));
}

function asCreateChanges(entries: readonly EntrySnapshot[]): MutationChange[] {
  const directories = entries
    .filter((entry) => entry.entryType === "directory")
    .sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path));
  const leaves = entries
    .filter((entry) => entry.entryType !== "directory")
    .sort((a, b) => a.path.localeCompare(b.path));
  return [...directories, ...leaves].map((entry) => ({
    operation: "create" as const,
    entryType: entry.entryType,
    path: entry.path,
    beforeRevision: null,
    afterRevision: entry.revision,
    beforeMode: null,
    afterMode: entry.mode,
    added: 1,
    removed: 0,
  }));
}

function remapEntries(
  entries: readonly EntrySnapshot[],
  sourceRoot: string,
  destinationRoot: string,
): EntrySnapshot[] {
  return entries.map((entry) => {
    const suffix = entry.path === sourceRoot ? "" : entry.path.slice(sourceRoot.length + 1);
    return {
      ...entry,
      path: suffix ? path.posix.join(destinationRoot, suffix) : destinationRoot,
    };
  });
}

function manifestHunks(changes: readonly MutationChange[]): Hunk[] {
  return changes.map((change) => ({
    kind: change.operation === "delete" ? ("remove" as const) : ("add" as const),
    text: `${change.entryType} ${change.path}`,
  }));
}

function missingParentDirectories(root: string, targetRelative: string): string[] {
  const parent = path.posix.dirname(targetRelative);
  if (parent === ".") return [];
  const parts = parent.split("/").filter(Boolean);
  const missing: string[] = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const { absolute } = normalizeMutationPath(root, current);
    if (!entryExists(absolute)) {
      missing.push(current);
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceError(`${current} is not a real directory`);
    }
  }
  return missing;
}

function directoryCreateChange(relative: string): MutationChange {
  return {
    operation: "create",
    entryType: "directory",
    path: relative,
    beforeRevision: null,
    afterRevision: null,
    beforeMode: null,
    afterMode: portableMode(0o755),
    added: 1,
    removed: 0,
  };
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
    const { relative, absolute: target } = normalizeMutationPath(this.root, proposal.path);
    const exists = entryExists(target);
    // What the entry *is* outranks whether it was supposed to be there. A live
    // run met a directory named `money.js`, was told "already exists; edit it
    // instead of creating it", and spent six turns trying to edit a directory
    // -- the advice was impossible, and the real obstacle was never named.
    if (exists) {
      const stat = lstatSync(target);
      if (stat.isDirectory()) {
        throw new WorkspaceError(
          `${relative} is a directory, not a file. Remove it with DELETE ${relative} or write to a different path.`,
        );
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new WorkspaceError(
          `${relative} is not a regular file; use a filesystem directive instead`,
        );
      }
    }
    if (proposal.create && exists) {
      throw new WorkspaceError(`${relative} already exists; edit it instead of creating it`);
    }
    if (!proposal.create && !exists) {
      throw new WorkspaceError(`${relative} does not exist; use CREATE to add it`);
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
          `the search text was not found in ${relative}. Read the file again and quote it exactly.${nearestAnchor(after, operation.search)}`,
        );
      }
      if (found !== operation.expectedMatches) {
        throw new WorkspaceError(
          `the search text appears ${found} times in ${relative}, expected ${operation.expectedMatches}. Include more surrounding lines so the anchor is unique.`,
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
        `that edit would leave ${relative} unchanged. If the change is already there, say so instead of re-applying it.`,
      );
    }
    const hunks = diffLines(before, after);
    const baseRevision = beforeBytes === null ? null : revisionOfBytes(beforeBytes);
    const afterRevision = revisionOfContent(after);
    const mode = exists ? portableMode(lstatSync(target).mode) : portableMode(0o644);
    const added = hunks.filter((h) => h.kind === "add").length;
    const removed = hunks.filter((h) => h.kind === "remove").length;
    const createdParents = proposal.create ? missingParentDirectories(this.root, relative) : [];
    const fileChange: MutationChange = {
      operation: proposal.create ? "create" : "write",
      entryType: "file",
      path: relative,
      beforeRevision: baseRevision,
      afterRevision,
      beforeMode: proposal.create ? null : mode,
      afterMode: mode,
      added,
      removed,
    };
    return {
      kind: "edit",
      path: relative,
      create: proposal.create,
      // Hash the bytes already read rather than opening the file again. A
      // second read could observe a concurrent save and pair that new hash
      // with a diff generated from the old contents.
      baseRevision,
      afterRevision,
      before,
      after,
      hunks,
      added,
      removed,
      changes: proposal.create
        ? [...createdParents.map(directoryCreateChange), fileChange]
        : [fileChange],
      guards: [
        {
          path: relative,
          expected: proposal.create
            ? null
            : [{ path: relative, entryType: "file", revision: baseRevision, mode }],
        },
        ...createdParents.map((created) => ({ path: created, expected: null })),
      ],
      createdParents,
      retained: beforeBytes === null ? new Map() : new Map([[relative, beforeBytes]]),
    };
  }

  /** Preview deletion of one file, symlink, or bounded directory tree. */
  previewDelete(relativeInput: string): Preview {
    const { relative } = normalizeMutationPath(this.root, relativeInput);
    const captured = captureTree(this.root, relative);
    const changes = asDeleteChanges(captured.entries);
    const only = captured.entries.length === 1 ? captured.entries[0] : undefined;
    const beforeBytes = only?.entryType === "file" ? captured.retained.get(relative) : undefined;
    const before = beforeBytes?.toString("utf8") ?? "";
    const hunks = beforeBytes === undefined ? manifestHunks(changes) : diffLines(before, "");
    return {
      kind: "delete",
      path: relative,
      create: false,
      baseRevision: only?.revision ?? null,
      afterRevision: null,
      before,
      after: "",
      hunks,
      added: 0,
      removed: hunks.filter((hunk) => hunk.kind === "remove").length,
      changes,
      guards: [{ path: relative, expected: captured.entries }],
      createdParents: [],
      retained: captured.retained,
    };
  }

  /** Preview recursive directory creation, recording only missing components. */
  previewMkdir(relativeInput: string): Preview {
    const { relative, absolute } = normalizeMutationPath(this.root, relativeInput);
    // Refused rather than obeyed, per the rule about deterministic validators
    // over recoverable ambiguity. A model that meant to write `src/money.js`
    // and said MKDIR gets one clear correction here; without it the directory
    // wins, shadows the file forever, and no later edit can succeed. A
    // directory genuinely named `*.js` is legal and vanishingly rare, and this
    // costs it one differently-spelled path.
    if (SOURCE_FILE_NAME.test(path.basename(relative))) {
      throw new WorkspaceError(
        `${relative} looks like a file, not a directory. Use CREATE ${relative} to write the file, or choose a directory name without a file extension.`,
      );
    }
    if (entryExists(absolute)) {
      throw new WorkspaceError(`${relative} already exists`);
    }
    const createdParents = [...missingParentDirectories(this.root, relative), relative];
    const changes = createdParents.map(directoryCreateChange);
    const hunks = manifestHunks(changes);
    return {
      kind: "mkdir",
      path: relative,
      create: true,
      baseRevision: null,
      afterRevision: null,
      before: "",
      after: "",
      hunks,
      added: changes.length,
      removed: 0,
      changes,
      guards: createdParents.map((created) => ({ path: created, expected: null })),
      createdParents,
      retained: new Map(),
    };
  }

  previewMove(sourceInput: string, destinationInput: string): Preview {
    return this.previewTransfer("move", sourceInput, destinationInput);
  }

  previewCopy(sourceInput: string, destinationInput: string): Preview {
    return this.previewTransfer("copy", sourceInput, destinationInput);
  }

  private previewTransfer(
    kind: "move" | "copy",
    sourceInput: string,
    destinationInput: string,
  ): Preview {
    const { relative: source } = normalizeMutationPath(this.root, sourceInput);
    const { relative: destination, absolute: destinationAbsolute } = normalizeMutationPath(
      this.root,
      destinationInput,
    );
    if (source === destination) {
      throw new WorkspaceError("source and destination are the same path");
    }
    if (entryExists(destinationAbsolute)) {
      throw new WorkspaceError(
        `${destination} already exists; delete it explicitly before replacing it`,
      );
    }
    const captured = captureTree(this.root, source);
    if (captured.entries[0]?.entryType === "directory" && destination.startsWith(`${source}/`)) {
      throw new WorkspaceError(`cannot ${kind} ${source} inside itself`);
    }
    const destinationEntries = remapEntries(captured.entries, source, destination);
    const createdParents = missingParentDirectories(this.root, destination);
    const parentChanges = createdParents.map(directoryCreateChange);
    const destinationChanges = asCreateChanges(destinationEntries);
    const changes =
      kind === "move"
        ? [...asDeleteChanges(captured.entries), ...parentChanges, ...destinationChanges]
        : [...parentChanges, ...destinationChanges];
    const hunks = manifestHunks(changes);
    return {
      kind,
      path: source,
      source,
      destination,
      create: kind === "copy",
      baseRevision: captured.entries[0]?.revision ?? null,
      afterRevision: destinationEntries[0]?.revision ?? null,
      before: "",
      after: "",
      hunks,
      added: hunks.filter((hunk) => hunk.kind === "add").length,
      removed: hunks.filter((hunk) => hunk.kind === "remove").length,
      changes,
      guards: [
        { path: source, expected: captured.entries },
        { path: destination, expected: null },
        ...createdParents.map((created) => ({ path: created, expected: null })),
      ],
      createdParents,
      retained: kind === "move" ? captured.retained : new Map(),
    };
  }

  /** Apply a previously approved mutation plan after exact snapshot revalidation. */
  commit(preview: Preview): void {
    this.assertGuards(preview);
    if (preview.kind === "edit") {
      this.commitEdit(preview);
      return;
    }
    if (preview.kind === "delete") {
      this.commitDelete(preview);
      return;
    }
    if (preview.kind === "mkdir") {
      this.commitMkdir(preview);
      return;
    }
    this.commitTransfer(preview);
  }

  private assertGuards(preview: Preview, guards: readonly PreviewGuard[] = preview.guards): void {
    for (const guard of guards) {
      let current: readonly EntrySnapshot[] | null;
      try {
        current = captureMaybe(this.root, guard.path);
      } catch {
        throw new WorkspaceError(
          `${guard.path} changed after it was approved, so the ${preview.kind} was not applied. Read or list it again.`,
        );
      }
      if (!snapshotsEqual(current, guard.expected)) {
        throw new WorkspaceError(
          `${guard.path} changed after it was approved, so the ${preview.kind} was not applied. Read or list it again.`,
        );
      }
    }
  }

  private commitEdit(preview: Preview): void {
    const { absolute: target } = normalizeMutationPath(this.root, preview.path);
    const createdParents: string[] = [];
    const temporary = `${target}.forge-tmp-${randomUUID()}`;
    try {
      for (const relative of preview.createdParents) {
        const { absolute } = normalizeMutationPath(this.root, relative);
        mkdirSync(absolute, { mode: 0o755 });
        createdParents.push(absolute);
      }
      writeFileSync(temporary, preview.after, "utf8");
      // Parent guards were intentionally changed by the mkdirs above. The
      // target itself must still be exactly the file/absence the user approved.
      this.assertGuards(preview, preview.guards.slice(0, 1));
      renameSync(temporary, target);
      const mode = preview.changes.find(
        (change) => change.path === preview.path && change.entryType === "file",
      )?.afterMode;
      if (process.platform !== "win32" && mode !== null && mode !== undefined) {
        chmodSync(target, mode);
      }
    } catch (error) {
      for (const absolute of createdParents.reverse()) {
        try {
          rmdirSync(absolute);
        } catch {
          // A non-empty parent may now contain concurrent user work and stays.
        }
      }
      throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private commitDelete(preview: Preview): void {
    const { absolute: source } = normalizeMutationPath(this.root, preview.path);
    // Stage beside the source so rename is same-filesystem and cannot be
    // redirected through a repository-controlled `.forge` symlink.
    const staged = `${source}.forge-delete-${randomUUID()}`;
    const stagedRelative = path.relative(this.root, staged).split(path.sep).join("/");
    renameSync(source, staged);
    try {
      const expected = preview.guards[0]?.expected;
      const stagedExpected =
        expected === null || expected === undefined
          ? expected
          : remapEntries(expected, preview.path, stagedRelative);
      if (!snapshotsEqual(captureTree(this.root, stagedRelative).entries, stagedExpected ?? null)) {
        throw new WorkspaceError(
          `${preview.path} changed while it was being deleted; the deletion was rolled back`,
        );
      }
      rmSync(staged, { recursive: true, force: true });
    } catch (error) {
      if (!entryExists(source) && entryExists(staged)) renameSync(staged, source);
      throw error;
    }
  }

  private commitMkdir(preview: Preview): void {
    const created: string[] = [];
    try {
      for (const relative of preview.createdParents) {
        const { absolute } = normalizeMutationPath(this.root, relative);
        mkdirSync(absolute, { mode: 0o755 });
        created.push(absolute);
      }
    } catch (error) {
      for (const absolute of created.reverse()) {
        try {
          rmdirSync(absolute);
        } catch {
          // Preserve a non-empty directory that may contain concurrent work.
        }
      }
      throw error;
    }
  }

  private commitTransfer(preview: Preview): void {
    const sourceRelative = preview.source;
    const destinationRelative = preview.destination;
    if (sourceRelative === undefined || destinationRelative === undefined) {
      throw new WorkspaceError(`${preview.kind} preview is missing source or destination`);
    }
    const { absolute: source } = normalizeMutationPath(this.root, sourceRelative);
    const { absolute: destination } = normalizeMutationPath(this.root, destinationRelative);
    const createdParents: string[] = [];
    try {
      for (const relative of preview.createdParents) {
        const { absolute } = normalizeMutationPath(this.root, relative);
        mkdirSync(absolute, { mode: 0o755 });
        createdParents.push(absolute);
      }
      if (preview.kind === "move") {
        renameSync(source, destination);
      } else {
        cpSync(source, destination, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      }
      const expectedDestination = preview.changes
        .filter(
          (change) =>
            change.operation === "create" &&
            (change.path === destinationRelative ||
              change.path.startsWith(`${destinationRelative}/`)),
        )
        .map((change) => ({
          path: change.path,
          entryType: change.entryType,
          revision: change.afterRevision,
          mode: change.afterMode ?? 0,
        }));
      const destinationMatches = snapshotsEqual(
        captureMaybe(this.root, destinationRelative),
        expectedDestination,
      );
      const sourceMatches =
        preview.kind === "move"
          ? captureMaybe(this.root, sourceRelative) === null
          : snapshotsEqual(
              captureMaybe(this.root, sourceRelative),
              preview.guards[0]?.expected ?? null,
            );
      if (!destinationMatches || !sourceMatches) {
        throw new WorkspaceError(
          `${preview.kind} changed while it was being committed; the operation was rolled back`,
        );
      }
    } catch (error) {
      if (preview.kind === "move") {
        if (!entryExists(source) && entryExists(destination)) {
          try {
            renameSync(destination, source);
          } catch {
            // Preserve the original causal error. The destination remains visible.
          }
        }
      } else {
        rmSync(destination, { recursive: true, force: true });
      }
      for (const absolute of createdParents.reverse()) {
        try {
          rmdirSync(absolute);
        } catch {
          // A non-empty parent now contains user work and must stay.
        }
      }
      throw error;
    }
  }

  /** The sha256 of a file right now, or null. For revision-keyed read guards. */
  revision(relative: string): string | null {
    const target = resolveInside(this.root, relative);
    return target === null ? null : revisionOf(target);
  }

  /** Exact regular-file size, or null for missing, escaped, or non-file paths. */
  byteSize(relative: string): number | null {
    const target = resolveInside(this.root, relative);
    if (target === null) return null;
    try {
      const stat = lstatSync(target);
      return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null;
    } catch {
      return null;
    }
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
