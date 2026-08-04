import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveInside } from "./workspace.js";

export type RepositoryEntryType = "file" | "directory" | "symlink";

export interface RepositoryEntry {
  readonly path: string;
  readonly type: RepositoryEntryType;
  readonly bytes: number | null;
}

export interface RepositoryIndex {
  readonly entries: readonly RepositoryEntry[];
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly truncated: boolean;
  readonly source: "git" | "filesystem";
}

export interface RepositoryRead {
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface RepositorySearchOptions {
  readonly path?: string;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly literal?: boolean;
  readonly context?: number;
  readonly maxHits?: number;
  readonly maxFiles?: number;
}

export interface RepositorySearchResult {
  readonly output: string;
  readonly hits: number;
  readonly filesScanned: number;
  readonly truncated: boolean;
}

const DEFAULT_INDEX_LIMIT = 50_000;
export const MAX_REPOSITORY_READ_CHARS = 16_000;
const DEFAULT_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".forge",
  ".codex-bridge",
  ".docs",
  ".meta",
  ".cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "bower_components",
  "vendor",
  "target",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  ".idea",
]);

const IMPORTANT_BASENAMES = new Set([
  "agents.md",
  "claude.md",
  "readme.md",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "jest.config.js",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "makefile",
  "cmakelists.txt",
  "dockerfile",
  "docker-compose.yml",
  "compose.yml",
]);

function normalizedRelative(candidate: string): string | null {
  if (!candidate || candidate.includes("\0")) return null;
  if (/^[A-Za-z]:/.test(candidate) || /^[\\/]{2}[^\\/]+[\\/]/.test(candidate)) return null;
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (normalized === ".") return ".";
  if (
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function hiddenSecret(relative: string): boolean {
  const parts = relative.toLowerCase().split("/");
  if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) return true;
  const base = parts.at(-1) ?? "";
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base.endsWith(".pem") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    base.endsWith(".key") ||
    base === "credentials" ||
    base === "credentials.json"
  );
}

function assertVisiblePath(
  root: string,
  candidate: string,
): { relative: string; absolute: string } {
  const relative = normalizedRelative(candidate);
  if (relative === null || hiddenSecret(relative)) {
    throw new Error(`${candidate || "the empty path"} is not available in repository context`);
  }
  const resolved = resolveInside(root, relative);
  if (resolved === null) throw new Error(`${relative} is outside the repository`);
  const canonicalRoot = realpathSync(root);
  const canonicalRelative = path.relative(canonicalRoot, resolved).split(path.sep).join("/");
  if (canonicalRelative !== "" && hiddenSecret(canonicalRelative)) {
    throw new Error(`${relative} resolves to a path that is not available in repository context`);
  }
  return { relative, absolute: resolved };
}

function typeOf(absolute: string): RepositoryEntryType | null {
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return null;
  } catch {
    return null;
  }
}

function gitTrackedAndUntracked(root: string): string[] | null {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    shell: false,
    maxBuffer: DEFAULT_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.stdout === null) return null;
  return result.stdout
    .toString("utf8")
    .split("\0")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
}

function filesystemPaths(root: string, limit: number): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let truncated = false;
  const visit = (relativeDirectory: string): void => {
    if (paths.length >= limit) {
      truncated = true;
      return;
    }
    const absoluteDirectory =
      relativeDirectory === "." ? root : path.join(root, ...relativeDirectory.split("/"));
    let names: string[];
    try {
      names = readdirSync(absoluteDirectory).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (paths.length >= limit) {
        truncated = true;
        return;
      }
      const relative = relativeDirectory === "." ? name : `${relativeDirectory}/${name}`;
      if (hiddenSecret(relative)) continue;
      const absolute = path.join(absoluteDirectory, name);
      const type = typeOf(absolute);
      if (type === null) continue;
      paths.push(relative);
      if (type === "directory") visit(relative);
    }
  };
  visit(".");
  return { paths, truncated };
}

function entryFor(root: string, relative: string): RepositoryEntry | null {
  if (hiddenSecret(relative)) return null;
  const absolute = path.join(root, ...relative.split("/"));
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return { path: relative, type: "symlink", bytes: null };
    if (stat.isDirectory()) return { path: relative, type: "directory", bytes: null };
    if (stat.isFile()) return { path: relative, type: "file", bytes: stat.size };
    return null;
  } catch {
    return null;
  }
}

function withDerivedDirectories(paths: readonly string[]): string[] {
  const all = new Set<string>();
  for (const candidate of paths) {
    const relative = normalizedRelative(candidate);
    if (relative === null || relative === "." || hiddenSecret(relative)) continue;
    all.add(relative);
    let parent = path.posix.dirname(relative);
    while (parent !== "." && parent !== "") {
      if (hiddenSecret(parent)) break;
      all.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...all];
}

export function indexRepository(rootInput: string, limit = DEFAULT_INDEX_LIMIT): RepositoryIndex {
  const root = realpathSync(rootInput);
  const gitPaths = gitTrackedAndUntracked(root);
  const fallback = gitPaths === null ? filesystemPaths(root, limit) : null;
  const candidates = withDerivedDirectories(gitPaths ?? fallback?.paths ?? []).sort();
  const truncated = (fallback?.truncated ?? false) || candidates.length > limit;
  const entries = candidates
    .slice(0, limit)
    .map((candidate) => entryFor(root, candidate))
    .filter((entry): entry is RepositoryEntry => entry !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    entries,
    fileCount: entries.filter((entry) => entry.type !== "directory").length,
    directoryCount: entries.filter((entry) => entry.type === "directory").length,
    truncated,
    source: gitPaths === null ? "filesystem" : "git",
  };
}

function insideScope(relative: string, scope: string): boolean {
  return scope === "." || relative === scope || relative.startsWith(`${scope}/`);
}

export function repositoryFiles(index: RepositoryIndex, scopeInput = "."): string[] {
  const scope = normalizedRelative(scopeInput);
  if (scope === null) throw new Error(`${scopeInput} is outside the repository`);
  return index.entries
    .filter((entry) => entry.type !== "directory" && insideScope(entry.path, scope))
    .map((entry) => entry.path);
}

export function listRepository(
  root: string,
  scopeInput = ".",
  maxEntries = 500,
): { output: string; entries: number; truncated: boolean } {
  const { relative: scope, absolute } = assertVisiblePath(root, scopeInput || ".");
  const scopeType = typeOf(absolute);
  if (scopeType === null) throw new Error(`${scope} does not exist`);
  if (scopeType !== "directory") {
    const stat = lstatSync(absolute);
    const suffix =
      scopeType === "symlink" ? ` -> ${readlinkSync(absolute)}` : ` (${stat.size} bytes)`;
    return { output: `${scopeType} ${scope}${suffix}`, entries: 1, truncated: false };
  }
  const index = indexRepository(root);
  const children = index.entries.filter((entry) => {
    if (!insideScope(entry.path, scope) || entry.path === scope) return false;
    const suffix = scope === "." ? entry.path : entry.path.slice(scope.length + 1);
    return !suffix.includes("/");
  });
  const shown = children.slice(0, maxEntries);
  const output = shown
    .map((entry) => {
      if (entry.type === "directory") return `directory ${entry.path}/`;
      if (entry.type === "symlink") {
        const target = path.join(root, ...entry.path.split("/"));
        let destination = "?";
        try {
          destination = readlinkSync(target);
        } catch {
          // Keep the entry visible even if the link changes during listing.
        }
        return `symlink ${entry.path} -> ${destination}`;
      }
      return `file ${entry.path} (${entry.bytes ?? 0} bytes)`;
    })
    .join("\n");
  const truncated = children.length > shown.length || index.truncated;
  return {
    output: `${output || `(empty directory ${scope})`}\n${shown.length} entr${shown.length === 1 ? "y" : "ies"}${truncated ? " shown; listing truncated" : ""}`,
    entries: shown.length,
    truncated,
  };
}

function globToRegExp(patternInput: string): RegExp {
  const pattern = patternInput.replaceAll("\\", "/");
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      const after = pattern[index + 2] ?? "";
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source);
}

export function globRepository(
  root: string,
  pattern: string,
  scopeInput = ".",
  maxEntries = 500,
): { output: string; matches: number; truncated: boolean } {
  const scope = normalizedRelative(scopeInput);
  if (scope === null) throw new Error(`${scopeInput} is outside the repository`);
  const matcher = globToRegExp(pattern);
  const index = indexRepository(root);
  const matches = index.entries.filter((entry) => {
    if (!insideScope(entry.path, scope)) return false;
    const relative = scope === "." ? entry.path : entry.path.slice(scope.length + 1);
    return matcher.test(relative) || matcher.test(entry.path);
  });
  const shown = matches.slice(0, maxEntries);
  return {
    output:
      shown.map((entry) => `${entry.type} ${entry.path}`).join("\n") ||
      `no paths matched ${JSON.stringify(pattern)}`,
    matches: matches.length,
    truncated: matches.length > shown.length || index.truncated,
  };
}

function looksBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8192));
  return sample.includes(0);
}

export function readRepositoryText(
  root: string,
  relativeInput: string,
  options: { readonly start?: number; readonly end?: number; readonly maxChars?: number } = {},
): RepositoryRead {
  const { relative, absolute } = assertVisiblePath(root, relativeInput);
  const stat = lstatSync(absolute);
  if (stat.isDirectory()) throw new Error(`${relative} is a directory; use LIST ${relative}`);
  const bytes = readFileSync(absolute);
  if (looksBinary(bytes)) throw new Error(`${relative} is binary and cannot be read as text`);
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  const totalLines = lines.length;
  const requestedStart = options.start ?? 1;
  const requestedEnd = options.end ?? totalLines;
  if (requestedStart < 1 || requestedEnd < requestedStart) {
    throw new Error(`invalid line range ${requestedStart}-${requestedEnd} for ${relative}`);
  }
  const startLine = Math.min(requestedStart, totalLines);
  let endLine = Math.min(requestedEnd, totalLines);
  const maxChars = options.maxChars ?? MAX_REPOSITORY_READ_CHARS;
  let content = lines.slice(startLine - 1, endLine).join("\n");
  let truncated = requestedEnd < totalLines || requestedStart > 1;
  if (content.length > maxChars) {
    const selected: string[] = [];
    let used = 0;
    for (let line = startLine - 1; line < endLine; line += 1) {
      const next = lines[line] ?? "";
      const cost = next.length + (selected.length === 0 ? 0 : 1);
      if (used + cost > maxChars) break;
      selected.push(next);
      used += cost;
    }
    content = selected.join("\n");
    endLine = startLine + Math.max(0, selected.length - 1);
    truncated = true;
  }
  return { path: relative, content, startLine, endLine, totalLines, truncated };
}

export function searchRepository(
  root: string,
  pattern: string,
  options: RepositorySearchOptions = {},
): RepositorySearchResult {
  const scope = normalizedRelative(options.path ?? ".");
  if (scope === null) throw new Error(`${options.path ?? "."} is outside the repository`);
  const flags = options.ignoreCase === true ? "i" : "";
  let matcher: RegExp;
  try {
    matcher = new RegExp(options.literal === true ? escapeRegExp(pattern) : pattern, flags);
  } catch (error) {
    throw new Error(
      `not a valid regular expression: ${error instanceof Error ? error.message : "invalid"}. Use literal search for plain text.`,
    );
  }
  const glob = options.glob === undefined ? null : globToRegExp(options.glob);
  const context = Math.min(10, Math.max(0, options.context ?? 0));
  const maxHits = Math.max(1, options.maxHits ?? 200);
  const maxFiles = Math.max(1, options.maxFiles ?? 10_000);
  const index = indexRepository(root);
  const candidates = index.entries.filter((entry) => {
    if (entry.type !== "file" || !insideScope(entry.path, scope)) return false;
    if ((entry.bytes ?? 0) > DEFAULT_SEARCH_FILE_BYTES) return false;
    if (glob === null) return true;
    const relative = scope === "." ? entry.path : entry.path.slice(scope.length + 1);
    return glob.test(relative) || glob.test(entry.path);
  });
  const output: string[] = [];
  let hits = 0;
  let filesScanned = 0;
  const emitted = new Set<string>();
  for (const entry of candidates.slice(0, maxFiles)) {
    const absolute = path.join(root, ...entry.path.split("/"));
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      continue;
    }
    if (looksBinary(bytes)) continue;
    filesScanned += 1;
    const lines = bytes.toString("utf8").split("\n");
    for (let line = 0; line < lines.length; line += 1) {
      matcher.lastIndex = 0;
      if (!matcher.test(lines[line] ?? "")) continue;
      hits += 1;
      const from = Math.max(0, line - context);
      const to = Math.min(lines.length - 1, line + context);
      for (let current = from; current <= to; current += 1) {
        const key = `${entry.path}:${current + 1}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        output.push(
          `${entry.path}:${current + 1}${current === line ? ":" : "-"} ${lines[current] ?? ""}`,
        );
      }
      if (hits >= maxHits) break;
    }
    if (hits >= maxHits) break;
  }
  const truncated = hits >= maxHits || candidates.length > maxFiles || index.truncated;
  return {
    output:
      output.join("\n") ||
      `no match for ${JSON.stringify(pattern)} in ${scope === "." ? "the repository" : scope}`,
    hits,
    filesScanned,
    truncated,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function topLevelSummary(index: RepositoryIndex): string[] {
  const counts = new Map<string, number>();
  for (const entry of index.entries) {
    const top = entry.path.split("/")[0] ?? entry.path;
    counts.set(top, (counts.get(top) ?? 0) + (entry.type === "directory" ? 0 : 1));
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 80)
    .map(([name, count]) => `${name}${count > 0 ? ` (${count} files)` : "/"}`);
}

export function projectMap(index: RepositoryIndex, maxChars = 8_000): string {
  const important = index.entries
    .filter((entry) => {
      if (entry.type === "directory") return false;
      const lower = entry.path.toLowerCase();
      const base = path.posix.basename(lower);
      return IMPORTANT_BASENAMES.has(base) || lower.startsWith(".github/workflows/");
    })
    .map((entry) => entry.path)
    .slice(0, 120);
  const lines = [
    `Repository index: ${index.fileCount} files, ${index.directoryCount} directories (${index.source}${index.truncated ? ", truncated at safety limit" : ""}).`,
    "Top-level project map:",
    ...topLevelSummary(index).map((entry) => `  ${entry}`),
    ...(important.length > 0
      ? ["Important project files:", ...important.map((entry) => `  ${entry}`)]
      : []),
    "Use LIST/GLOB/GREP/SEARCH to navigate, RELATED for local module relationships, and READ path:start-end for large files.",
  ];
  let output = "";
  for (const line of lines) {
    const next = output ? `${output}\n${line}` : line;
    if (next.length > maxChars) return `${output}\n… project map truncated`;
    output = next;
  }
  return output;
}
