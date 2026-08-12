import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { projectSkillItems } from "../src/instructions.js";

async function withRepo<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "skills-")));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeSkill(root: string, name: string, contents: string): void {
  const directory = path.join(root, ".forge", "skills");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), contents);
}

describe("project skill selection", () => {
  test("a task matching one skill's keywords selects exactly that skill, scored below instructions", async () => {
    await withRepo(async (root) => {
      writeSkill(
        root,
        "deploy.md",
        "---\nkeywords: [deploy, canary]\n---\nRun the canary first.\n",
      );
      writeSkill(root, "migrate.md", "---\nkeywords: [migration]\n---\nBack up the schema.\n");

      const items = projectSkillItems(root, "deploy the new service");

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe("skill:.forge/skills/deploy.md");
      expect(items[0]?.text).toContain("Run the canary first.");
      expect(items[0]?.reason).toBe("matched task keywords: deploy");
      // Below the 900+ scoped-instruction band, so instructions win contention.
      expect(items[0]?.score).toBe(710);
      expect(items[0]?.mandatory).toBe(false);
    });
  });

  test("two matching skills select only one: more keyword matches, then id order", async () => {
    await withRepo(async (root) => {
      writeSkill(root, "release.md", "---\nkeywords: [deploy, rollout]\n---\nStage the rollout.\n");
      writeSkill(root, "deploy.md", "---\nkeywords: [deploy]\n---\nRun the canary first.\n");

      const scored = projectSkillItems(root, "deploy the rollout");
      expect(scored).toHaveLength(1);
      expect(scored[0]?.id).toBe("skill:.forge/skills/release.md");

      writeSkill(root, "alpha.md", "---\nkeywords: [rollout]\n---\nAlpha procedure.\n");
      const tied = projectSkillItems(root, "plan the rollout");
      expect(tied).toHaveLength(1);
      // Equal scores tie-break on id code-unit order, deterministically.
      expect(tied[0]?.id).toBe("skill:.forge/skills/alpha.md");
    });
  });

  test("a skill with no keywords, or with always: true, is never selected", async () => {
    await withRepo(async (root) => {
      writeSkill(root, "bare.md", "No frontmatter at all.\n");
      writeSkill(root, "empty.md", "---\nkeywords: []\n---\nUnreachable.\n");
      writeSkill(root, "always.md", "---\nalways: true\nkeywords: [deploy]\n---\nUnreachable.\n");

      expect(projectSkillItems(root, "deploy everything always")).toEqual([]);
    });
  });

  test("absent directory, non-file entries, and malformed frontmatter degrade to empty selection", async () => {
    await withRepo(async (root) => {
      expect(projectSkillItems(root, "deploy the service")).toEqual([]);

      writeSkill(root, "broken.md", "---\nkeywords: [deploy\nno closing fence");
      mkdirSync(path.join(root, ".forge", "skills", "directory.md"));

      expect(projectSkillItems(root, "deploy the service")).toEqual([]);
    });
  });

  test("CRLF frontmatter parses and the frontmatter never reaches the item text", async () => {
    await withRepo(async (root) => {
      writeSkill(root, "crlf.md", "---\r\nkeywords: [deploy]\r\n---\r\nUse the deploy script.\r\n");

      const items = projectSkillItems(root, "deploy the service");
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toContain("Use the deploy script.");
      expect(items[0]?.text).not.toContain("keywords:");
    });
  });
});
