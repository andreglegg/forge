/**
 * A content-addressed store for the bytes an edit replaced.
 *
 * Undo needs the previous contents of every file it touched. Two obvious
 * places to keep them are both wrong:
 *
 * - **In the journal event.** The journal is read on every `forge show` and
 *   replayed to reconstruct state; carrying whole file bodies through it makes
 *   a metadata read cost as much as a checkout, and the same unchanged header
 *   is stored again on every edit to the same file.
 * - **Nowhere, and rely on git.** Most of what an agent touches between commits
 *   is uncommitted, which is exactly the window where undo matters.
 *
 * So: the bytes go in a blob keyed by their own sha256, and the event carries
 * the hash. Identical content is stored once however many times it recurs, and
 * the hash the event already needed for the stale-proposal check is the same
 * hash that addresses the blob — there is no second identifier to keep in step.
 *
 * Blobs are never deleted here. Pruning is a decision about how far back undo
 * should reach, and silently discarding history to save a few kilobytes is the
 * kind of helpfulness that is only noticed when it has cost something.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OBJECTS_SUBDIRECTORY = path.join(".forge", "objects");

export function hashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Write content and return its hash. Idempotent: storing the same bytes twice
 * is a no-op, which is what makes the "unchanged header" case free.
 */
export function store(root: string, content: string): string {
  const hash = hashOf(content);
  const file = fileFor(root, hash);
  if (existsSync(file)) {
    return hash;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  // Temp-then-rename, so a reader can never observe a partially written blob
  // under a name that claims to be the hash of complete content.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, file);
  return hash;
}

/**
 * Read content back, or null.
 *
 * Null rather than throwing: a missing blob means undo cannot restore that one
 * file, which is worth reporting precisely, not worth taking down the whole
 * undo of everything else that is recoverable.
 */
export function load(root: string, hash: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return null;
  }
  try {
    return readFileSync(fileFor(root, hash), "utf8");
  } catch {
    return null;
  }
}

/**
 * Sharded by the first two hex characters.
 *
 * One flat directory with a blob per edit is fine until it is not; some
 * filesystems degrade badly past a few tens of thousands of entries, and this
 * costs one `substring` to avoid finding out which ones.
 */
function fileFor(root: string, hash: string): string {
  return path.join(root, OBJECTS_SUBDIRECTORY, hash.slice(0, 2), hash.slice(2));
}
