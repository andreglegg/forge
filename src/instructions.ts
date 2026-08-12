/** Deterministic project-instruction discovery for small prompt budgets. */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContextItem } from "./context.js";

interface ParsedInstruction {
  readonly body: string;
  readonly keywords: readonly string[];
  readonly always: boolean;
}

const ROOT_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_SELECTED_INSTRUCTIONS = 2;
// One skill, never more: measured guidance additions dilute, so a skill earns
// its budget only by matching the task, and never rides along with another.
const MAX_SELECTED_SKILLS = 1;
// Below the 900+ scoped-instruction band, so instructions win budget contention.
const SKILL_BASE_SCORE = 700;

export function projectInstructionItems(root: string, task: string): ContextItem[] {
  const items: ContextItem[] = [];
  for (const relative of ROOT_INSTRUCTIONS) {
    const file = path.join(root, relative);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    const parsed = parseInstruction(readFileSync(file, "utf8"));
    items.push(instructionItem(relative, parsed.body, 1_000, "root project instructions"));
  }

  const directory = path.join(root, ".forge", "instructions");
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return items;
  const lowered = task.toLowerCase();
  const selected = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .flatMap((name) => {
      const relative = path.posix.join(".forge", "instructions", name);
      const file = path.join(directory, name);
      if (!lstatSync(file).isFile()) return [];
      const parsed = parseInstruction(readFileSync(file, "utf8"));
      const matches = parsed.keywords.filter((keyword) => matchesKeyword(lowered, keyword));
      if (!parsed.always && matches.length === 0) return [];
      return [
        instructionItem(
          relative,
          parsed.body,
          900 + matches.length * 10 + (parsed.always ? 1 : 0),
          parsed.always
            ? "always-on Forge instruction"
            : `matched task keywords: ${matches.join(", ")}`,
        ),
      ];
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_SELECTED_INSTRUCTIONS);
  return [...items, ...selected];
}

/**
 * Deterministic discovery of `.forge/skills/*.md` as opt-in context.
 *
 * Skills are read-only file content selected by the same frontmatter keyword
 * mechanism as scoped instructions, with two deliberate restrictions: at most
 * one skill per run, and no `always:` path -- an always-on skill is guidance,
 * which is what instructions are for. Same bytes in, same selection out.
 */
export function projectSkillItems(root: string, task: string): ContextItem[] {
  const directory = path.join(root, ".forge", "skills");
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return [];
  const lowered = task.toLowerCase();
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .flatMap((name) => {
      const relative = path.posix.join(".forge", "skills", name);
      const file = path.join(directory, name);
      if (!lstatSync(file).isFile()) return [];
      const parsed = parseInstruction(readFileSync(file, "utf8"));
      // `always: true` disqualifies the skill outright rather than being
      // ignored: rejected by design, not an oversight.
      if (parsed.always) return [];
      const matches = parsed.keywords.filter((keyword) => matchesKeyword(lowered, keyword));
      if (matches.length === 0) return [];
      return [
        {
          id: `skill:${relative}`,
          kind: "instruction" as const,
          path: relative,
          text: `${relative} — project skill:\n${parsed.body.trim()}`,
          mandatory: false,
          score: SKILL_BASE_SCORE + matches.length * 10,
          reason: `matched task keywords: ${matches.join(", ")}`,
        },
      ];
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_SELECTED_SKILLS);
}

function instructionItem(
  relative: string,
  body: string,
  score: number,
  reason: string,
): ContextItem {
  return {
    id: `instruction:${relative}`,
    kind: "instruction",
    path: relative,
    text: `${relative} — project instructions:\n${body.trim()}`,
    mandatory: false,
    score,
    reason,
  };
}

function parseInstruction(text: string): ParsedInstruction {
  text = text.replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) return { body: text, keywords: [], always: false };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { body: text, keywords: [], always: false };
  const frontmatter = text.slice(4, end);
  const body = text.slice(end + 5);
  const keywords = field(frontmatter, "keywords");
  const always = /^always\s*:\s*true\s*$/im.test(frontmatter);
  return { body, keywords, always };
}

function matchesKeyword(loweredTask: string, keyword: string): boolean {
  const lowered = keyword.toLowerCase().trim();
  if (!lowered) return false;
  if (/\s/.test(lowered)) return loweredTask.includes(lowered);
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(lowered)}(?:$|[^a-z0-9])`).test(loweredTask);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function field(frontmatter: string, name: string): string[] {
  const raw = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im").exec(frontmatter)?.[1]?.trim();
  if (!raw) return [];
  const value = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return value
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}
