/**
 * Did the run produce what the task asked for by name?
 *
 * The completion gate runs the project's own commands, and a green suite proves
 * the repository is not broken -- never that the request was met. Observed
 * live: a model asked to add a function *and* `tests/clamp.test.js` added the
 * function, wrote no test file, claimed completion, and was believed, because a
 * test file that does not exist breaks no suite. Exit 0.
 *
 * Verification cannot close that gap, and a second model judging "was the task
 * done" is a different, unmeasured thing. But part of it is decidable without
 * either: when the task *names a path*, the path either exists or it does not.
 * That is the whole of what this module claims.
 *
 * Deliberately narrow, because a false objection costs a turn and teaches the
 * model to distrust the harness:
 *
 * - only paths written by the user, never inferred ones;
 * - only paths still absent when the run reports completion, so naming an
 *   existing file to edit is silent;
 * - nothing outside the repository, so a traversal in a task string is not a
 *   filesystem question about somewhere else.
 */

import { existsSync } from "node:fs";
import { resolveInside } from "./workspace.js";

/**
 * A path-shaped token: at least one separator and a short lowercase extension.
 *
 * Both halves are load-bearing. Without the separator, `version` and `2.0` are
 * paths; without the extension, every `and/or` is one. Trailing punctuation is
 * excluded so a path ending a sentence does not absorb the full stop.
 */
const PATH_TOKEN =
  /(?:^|[\s"'`([])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z]{1,6})(?=$|[\s"'`)\].,;:!?])/g;

/** Anything inside one of these is addressing a server, not this repository. */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Directories whose contents are produced, never requested.
 *
 * A task string is not always only the user's words: a retry prompt embeds the
 * failing build or test output, and a compiler names paths inside its own
 * artifact tree. Measured against 300 recorded benchmark retry prompts, exactly
 * one would have produced a false objection, for
 * `CMakeFiles/complex-numbers.dir/complex_numbers.cpp` -- a file nobody asked
 * for and whose absence means nothing. A false objection costs a turn and
 * teaches the model that the harness is unreliable, so the cheap exclusion is
 * worth more than the case it gives up.
 */
const GENERATED_DIRECTORY =
  /(?:^|\/)(?:CMakeFiles|node_modules|__pycache__|\.git|\.forge|target|build|dist|obj|out|coverage|\.gradle|\.venv|venv)(?:\/|$)/i;

/**
 * Repository-relative paths the task text names, in the order written.
 *
 * Exported for its own tests: the parsing is the part most likely to be wrong,
 * and it is worth being able to see what it thinks a task asked for.
 */
export function namedPaths(task: string): string[] {
  const withoutUrls = task.replace(URL_LIKE, " ");
  const found: string[] = [];
  for (const match of withoutUrls.matchAll(PATH_TOKEN)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    // Absolute and traversing paths are dropped here rather than resolved:
    // they are never a deliverable this run is responsible for.
    if (candidate.startsWith("/") || candidate.split("/").includes("..")) continue;
    if (GENERATED_DIRECTORY.test(candidate)) continue;
    if (!found.includes(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Named paths that do not exist under `root`.
 *
 * A directory counts as existing, so a task naming `docs/api.md` is satisfied
 * by the file and a task naming a directory by the directory.
 */
export function missingDeliverables(root: string, task: string): string[] {
  return namedPaths(task).filter((candidate) => {
    const resolved = resolveInside(root, candidate);
    // Unresolvable means outside the repository, which is not this run's to
    // deliver -- silent rather than reported as missing.
    return resolved !== null && !existsSync(resolved);
  });
}

/** The objection handed back when a named deliverable is absent. */
export function missingDeliverablesNotice(missing: readonly string[]): string {
  const list = missing.map((entry) => `  - ${entry}`).join("\n");
  return [
    `You reported the task as complete, but ${missing.length === 1 ? "this path the task named does not exist" : "these paths the task named do not exist"}:`,
    list,
    "Verification only runs the project's existing commands; it cannot notice a file that was never written.",
    "Create what is missing, or say plainly why it should not exist.",
  ].join("\n");
}
