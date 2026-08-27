import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { filesystemPathKey, sameFilesystemPath } from "../src/path-utils.js";

test("canonical filesystem identity ignores equivalent path spellings", async () => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-path-key-")));
  try {
    mkdirSync(path.join(root, "nested"));
    const alternate = path.join(root, "nested", "..", "nested");

    expect(sameFilesystemPath(path.join(root, "nested"), alternate)).toBe(true);
    expect(filesystemPathKey(path.join(root, "nested"))).toBe(filesystemPathKey(alternate));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
