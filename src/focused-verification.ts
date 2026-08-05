import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChangeImpactPlan } from "./impact.js";

const MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;
const DEFAULT_MAX_COMMANDS = 4;
const DEFAULT_MAX_TESTS_PER_COMMAND = 8;

export interface FocusedVerificationOptions {
  readonly maxCommands?: number;
  readonly maxTestsPerCommand?: number;
}

export interface FocusedVerificationCommand {
  readonly command: readonly string[];
  readonly packageRoot: string;
  readonly tests: readonly string[];
  readonly reason: string;
}

export interface FocusedVerificationPlan {
  readonly commands: readonly FocusedVerificationCommand[];
  readonly truncated: boolean;
  readonly output: string;
}

interface ParsedTestCommand {
  readonly packageRoot: string;
  readonly manager: "npm" | "pnpm" | "yarn" | "bun";
  readonly prefix: readonly string[];
}

function normalized(candidate: string): string | null {
  if (!candidate || candidate.includes("\0")) return null;
  if (/^[A-Za-z]:/.test(candidate) || /^[\\/]{2}[^\\/]+[\\/]/.test(candidate)) return null;
  const value = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (value === "" || value === ".." || value.startsWith("../") || path.posix.isAbsolute(value)) {
    return null;
  }
  return value;
}

function manifestExists(root: string, packageRoot: string): boolean {
  return MANIFESTS.some((manifest) => {
    try {
      readFileSync(path.join(root, ...(packageRoot === "." ? [] : [packageRoot]), manifest));
      return true;
    } catch {
      return false;
    }
  });
}

function nearestPackageRoot(root: string, target: string): string | null {
  let directory = path.posix.dirname(target);
  while (true) {
    if (manifestExists(root, directory)) return directory;
    if (directory === ".") return null;
    directory = path.posix.dirname(directory);
  }
}

function parseTestCommand(command: readonly string[]): ParsedTestCommand | null {
  let packageRoot = ".";
  let tokens = command;
  if (tokens[0] === "cd" && tokens[2] === "&&") {
    const normalizedRoot = normalized(tokens[1] ?? "");
    if (normalizedRoot === null) return null;
    packageRoot = normalizedRoot;
    tokens = tokens.slice(3);
  }
  if (tokens.length < 2) return null;
  const manager = tokens[0];
  if (manager !== "npm" && manager !== "pnpm" && manager !== "yarn" && manager !== "bun") {
    return null;
  }
  if (manager === "npm") {
    if (tokens.length === 2 && tokens[1] === "test") {
      return { packageRoot, manager, prefix: [...command] };
    }
    if (tokens.length === 3 && tokens[1] === "run" && tokens[2] === "test") {
      return { packageRoot, manager, prefix: [...command] };
    }
    return null;
  }
  if (tokens.length !== 2 || tokens[1] !== "test") return null;
  return { packageRoot, manager, prefix: [...command] };
}

function relativeToPackage(testPath: string, packageRoot: string): string | null {
  if (packageRoot === ".") return testPath;
  if (!testPath.startsWith(`${packageRoot}/`)) return null;
  const relative = testPath.slice(packageRoot.length + 1);
  return relative || null;
}

function specializedCommand(parsed: ParsedTestCommand, tests: readonly string[]): string[] {
  const separator = parsed.manager === "bun" || parsed.manager === "yarn" ? [] : ["--"];
  return [...parsed.prefix, ...separator, ...tests];
}

function renderCommand(command: readonly string[]): string {
  return command.join(" ");
}

export function planFocusedVerification(
  root: string,
  impact: ChangeImpactPlan,
  authoritativeCommands: readonly (readonly string[])[],
  options: FocusedVerificationOptions = {},
): FocusedVerificationPlan {
  const maxCommands = Math.max(1, options.maxCommands ?? DEFAULT_MAX_COMMANDS);
  const maxTestsPerCommand = Math.max(
    1,
    options.maxTestsPerCommand ?? DEFAULT_MAX_TESTS_PER_COMMAND,
  );
  const commands: FocusedVerificationCommand[] = [];
  let truncated = impact.truncated;

  for (const authoritative of authoritativeCommands) {
    const parsed = parseTestCommand(authoritative);
    if (parsed === null || !manifestExists(root, parsed.packageRoot)) continue;
    const candidates = impact.tests
      .filter((testPath) => nearestPackageRoot(root, testPath) === parsed.packageRoot)
      .map((testPath) => ({
        absolute: testPath,
        relative: relativeToPackage(testPath, parsed.packageRoot),
      }))
      .filter((item): item is { absolute: string; relative: string } => item.relative !== null)
      .sort((left, right) => left.absolute.localeCompare(right.absolute));
    if (candidates.length === 0) continue;
    if (commands.length >= maxCommands) {
      truncated = true;
      break;
    }
    const selected = candidates.slice(0, maxTestsPerCommand);
    if (selected.length < candidates.length) truncated = true;
    const tests = selected.map((item) => item.absolute);
    commands.push({
      command: specializedCommand(
        parsed,
        selected.map((item) => item.relative),
      ),
      packageRoot: parsed.packageRoot,
      tests,
      reason: `candidate tests in ${parsed.packageRoot} derived from the configured package test command`,
    });
  }

  const output = [
    `Focused verification plan (${commands.length}):`,
    ...(commands.length === 0
      ? ["  (none — no configured test command could be narrowed deterministically)"]
      : commands.flatMap((entry) => [
          `  ${renderCommand(entry.command)}`,
          `    why: ${entry.reason}`,
        ])),
    "Focused checks are iteration evidence only; the configured authoritative completion gate remains mandatory and unchanged.",
    ...(truncated ? ["[focused verification plan truncated at the configured safety limit]"] : []),
  ].join("\n");

  return { commands, truncated, output };
}
