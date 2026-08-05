/**
 * The task named a file. The run did not create it. Forge said success.
 *
 * Observed 2026-08-05 on `nemotron-3-nano-30b-a3b`, asked to "Add an exported
 * function clamp(...) to src/index.js. Add tests/clamp.test.js with node:test
 * cases...". It added `clamp`, never wrote `tests/clamp.test.js`, claimed
 * completion, and the gate agreed: the pre-existing suite was green, because a
 * test file that does not exist breaks nothing. Exit 0, `ok: true`.
 *
 * Verification cannot catch this. A green suite proves the repository is not
 * broken, never that the request was met. But when the request *names a path*,
 * the check is deterministic and needs no second model: the path either exists
 * or it does not.
 *
 * Deliberately narrow. Only paths the user actually wrote are checked, and only
 * when they are still absent at completion -- a task that names an existing
 * file to edit says nothing about what should be created.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { missingDeliverables, namedPaths } from "../src/deliverables.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function repository(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-deliverables-")));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  return root;
}

describe("paths named in a task", () => {
  test("finds the ones a real task named", () => {
    expect(
      namedPaths(
        "Add an exported function clamp(value, low, high) to src/index.js. Add tests/clamp.test.js with node:test cases for below, inside, and above the range.",
      ),
    ).toEqual(["src/index.js", "tests/clamp.test.js"]);
  });

  test("finds a path introduced as a new file", () => {
    expect(
      namedPaths("Add titleCase(text) to src/index.js AND document it in a new file docs/api.md."),
    ).toEqual(["src/index.js", "docs/api.md"]);
  });

  test("ignores prose that is not a path", () => {
    // The discriminator is a separator plus a file extension, so ordinary
    // sentences, decimals, and bare module names cannot masquerade as one.
    expect(namedPaths("Refactor the account module and bump version to 2.0.")).toEqual([]);
    expect(namedPaths("Use node:test and assert/strict for the tests.")).toEqual([]);
    expect(namedPaths("Make it 3.5 times faster.")).toEqual([]);
  });

  test("ignores a URL", () => {
    expect(namedPaths("Follow the spec at https://example.com/docs/api.md exactly.")).toEqual([]);
  });

  test("does not repeat a path named twice", () => {
    expect(namedPaths("Edit src/a.js then re-read src/a.js.")).toEqual(["src/a.js"]);
  });
});

describe("what a finished run failed to deliver", () => {
  test("reports a named file that was never created", async () => {
    const root = await repository();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "index.js"), "export const clamp = () => 0;\n");

    const missing = missingDeliverables(
      root,
      "Add clamp to src/index.js. Add tests/clamp.test.js with cases.",
    );

    expect(missing).toEqual(["tests/clamp.test.js"]);
  });

  test("says nothing when every named path exists", async () => {
    const root = await repository();
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "tests"));
    writeFileSync(path.join(root, "src", "index.js"), "x\n");
    writeFileSync(path.join(root, "tests", "clamp.test.js"), "x\n");

    expect(
      missingDeliverables(root, "Add clamp to src/index.js. Add tests/clamp.test.js with cases."),
    ).toEqual([]);
  });

  test("a directory satisfies a named directory path", async () => {
    const root = await repository();
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "api.md"), "x\n");

    expect(missingDeliverables(root, "Document it in docs/api.md.")).toEqual([]);
  });

  test("never escapes the repository", async () => {
    const root = await repository();

    // A traversal in the task text must not become a filesystem question about
    // somewhere else, and must not be reported as a deliverable either.
    expect(missingDeliverables(root, "Write ../../etc/passwd and /etc/hosts.")).toEqual([]);
  });

  test("says nothing for a task that names no path at all", async () => {
    const root = await repository();
    expect(missingDeliverables(root, "Make the failing test pass.")).toEqual([]);
  });
});
