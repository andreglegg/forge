import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { projectInstructionItems } from "../src/instructions.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "instructions-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("project instruction selection", () => {
  test("always includes root instructions and only relevant scoped guidance", async () => {
    await withRepo(async (root) => {
      writeFileSync(path.join(root, "AGENTS.md"), "Run the focused test first.\n");
      const directory = path.join(root, ".forge", "instructions");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "rust.md"),
        "---\nkeywords: [rust, cargo, borrow checker]\n---\nPrefer owned return values.\n",
      );
      writeFileSync(
        path.join(directory, "python.md"),
        "---\nkeywords: [python, pytest]\n---\nKeep annotations precise.\n",
      );

      const items = projectInstructionItems(root, "fix the Rust borrow checker error");

      expect(items.map((item) => item.path)).toEqual(["AGENTS.md", ".forge/instructions/rust.md"]);
      expect(items.map((item) => item.text).join("\n")).not.toContain("annotations precise");
    });
  });

  test("a short keyword matches a word, not a substring", async () => {
    await withRepo(async (root) => {
      const directory = path.join(root, ".forge", "instructions");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "go.md"), "---\nkeywords: [go]\n---\nUse gofmt.\n");

      expect(projectInstructionItems(root, "keep doing the TypeScript work")).toEqual([]);
      expect(projectInstructionItems(root, "fix the Go package")).toHaveLength(1);
    });
  });

  test("supports CRLF frontmatter and always-on instructions", async () => {
    await withRepo(async (root) => {
      const directory = path.join(root, ".forge", "instructions");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "style.md"),
        "---\r\nalways: true\r\n---\r\nDo not rewrite unrelated code.\r\n",
      );

      const items = projectInstructionItems(root, "anything");
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toContain("Do not rewrite unrelated code.");
      expect(items[0]?.text).not.toContain("always: true");
    });
  });
});
