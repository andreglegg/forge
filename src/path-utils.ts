import { realpathSync } from "node:fs";
import path from "node:path";

/** Canonical existing path while preserving the platform's display casing. */
export function canonicalFilesystemPath(candidate: string): string {
  try {
    return path.normalize(realpathSync.native(path.resolve(candidate)));
  } catch {
    return path.normalize(path.resolve(candidate));
  }
}

/** Stable identity key for an existing filesystem path across platform spellings. */
export function filesystemPathKey(candidate: string): string {
  const canonical = canonicalFilesystemPath(candidate);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathKey(left) === filesystemPathKey(right);
}
