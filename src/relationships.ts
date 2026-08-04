import path from "node:path";
import type { RepositoryIndex } from "./repository.js";
import { indexRepository, readRepositoryText, repositoryFiles } from "./repository.js";

const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;
const SOURCE_EXTENSIONS = new Set<string>(
  MODULE_EXTENSIONS.filter((extension) => extension !== ".json"),
);
const PACKAGE_MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULTS = 50;

export interface RepositoryRelationships {
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  readonly scannedFiles: number;
  readonly candidateFiles: number;
  readonly skippedLargeFiles: number;
  readonly truncated: boolean;
}

export interface RelatedRepositoryResult {
  readonly path: string;
  readonly packageRoot: string | null;
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly tests: readonly string[];
  readonly output: string;
  readonly truncated: boolean;
}

export interface RelationshipBuildOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

export interface RelatedRepositoryOptions {
  readonly index?: RepositoryIndex;
  readonly graph?: RepositoryRelationships;
  readonly maxResults?: number;
}

function normalizedRepositoryPath(candidate: string): string | null {
  if (!candidate || candidate.includes("\0")) return null;
  if (/^[A-Za-z]:/.test(candidate) || /^[\\/]{2}[^\\/]+[\\/]/.test(candidate)) return null;
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function sourceExtension(relative: string): string {
  const lower = relative.toLowerCase();
  if (lower.endsWith(".d.ts")) return ".ts";
  return path.posix.extname(lower);
}

function isSupportedSource(relative: string): boolean {
  return SOURCE_EXTENSIONS.has(sourceExtension(relative));
}

/**
 * Remove comments while retaining quoted module specifiers.
 *
 * This is deliberately a lexer, not a parser. It prevents commented-out import
 * examples from becoming dependency edges without pretending to understand
 * JavaScript syntax, template expressions, path aliases, or package exports.
 */
function withoutComments(source: string): string {
  type State = "code" | "single" | "double" | "template" | "line" | "block";
  let state: State = "code";
  let escaped = false;
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        output += "\n";
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        output += "  ";
        index += 1;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state !== "code") {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (
        (state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line";
      output += "  ";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block";
      output += "  ";
      index += 1;
      continue;
    }
    if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "template";
    output += char;
  }
  return output;
}

export function relativeModuleSpecifiers(source: string): string[] {
  const cleaned = withoutComments(source);
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
    /\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const specifier = raw.split(/[?#]/, 1)[0]?.trim();
      if (specifier?.startsWith(".")) found.add(specifier);
    }
  }
  return [...found].sort();
}

function moduleCandidates(importer: string, specifier: string): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return [];
  const candidates: string[] = [base];
  const explicitExtension = path.posix.extname(base);
  const extensionless = explicitExtension ? base.slice(0, -explicitExtension.length) : base;
  for (const extension of MODULE_EXTENSIONS) {
    candidates.push(`${extensionless}${extension}`);
  }
  for (const extension of MODULE_EXTENSIONS) {
    candidates.push(`${base}/index${extension}`);
    if (explicitExtension) candidates.push(`${extensionless}/index${extension}`);
  }
  return [...new Set(candidates)];
}

function resolveDependenciesAgainst(
  files: ReadonlySet<string>,
  importerInput: string,
  source: string,
): string[] {
  const importer = normalizedRepositoryPath(importerInput);
  if (importer === null) return [];
  const resolved = new Set<string>();
  for (const specifier of relativeModuleSpecifiers(source)) {
    const target = moduleCandidates(importer, specifier).find((candidate) => files.has(candidate));
    if (target !== undefined) resolved.add(target);
  }
  return [...resolved].sort();
}

export function resolveRelativeModuleDependencies(
  index: RepositoryIndex,
  importerInput: string,
  source: string,
): string[] {
  return resolveDependenciesAgainst(new Set(repositoryFiles(index)), importerInput, source);
}

export function buildRepositoryRelationships(
  root: string,
  index: RepositoryIndex = indexRepository(root),
  options: RelationshipBuildOptions = {},
): RepositoryRelationships {
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const sizeByPath = new Map(
    index.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, entry.bytes ?? 0] as const),
  );
  const indexedFiles = repositoryFiles(index);
  const files = new Set(indexedFiles);
  const candidates = indexedFiles.filter(isSupportedSource);
  const selected = candidates.slice(0, maxFiles);
  const outgoingMutable = new Map<string, string[]>();
  const incomingMutable = new Map<string, Set<string>>();
  let skippedLargeFiles = 0;
  let scannedFiles = 0;

  for (const sourcePath of selected) {
    if ((sizeByPath.get(sourcePath) ?? 0) > maxFileBytes) {
      skippedLargeFiles += 1;
      continue;
    }
    let source: string;
    try {
      source = readRepositoryText(root, sourcePath, { maxChars: maxFileBytes }).content;
    } catch {
      continue;
    }
    scannedFiles += 1;
    const dependencies = resolveDependenciesAgainst(files, sourcePath, source);
    outgoingMutable.set(sourcePath, dependencies);
    for (const dependency of dependencies) {
      const incoming = incomingMutable.get(dependency) ?? new Set<string>();
      incoming.add(sourcePath);
      incomingMutable.set(dependency, incoming);
    }
  }

  const outgoing = new Map<string, readonly string[]>();
  for (const [source, dependencies] of [...outgoingMutable].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    outgoing.set(source, [...dependencies].sort());
  }
  const incoming = new Map<string, readonly string[]>();
  for (const [target, dependents] of [...incomingMutable].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    incoming.set(target, [...dependents].sort());
  }

  return {
    outgoing,
    incoming,
    scannedFiles,
    candidateFiles: candidates.length,
    skippedLargeFiles,
    truncated: index.truncated || candidates.length > selected.length,
  };
}

function nearestPackageRoot(index: RepositoryIndex, target: string): string | null {
  const files = new Set(repositoryFiles(index));
  let directory = path.posix.dirname(target);
  while (true) {
    for (const manifest of PACKAGE_MANIFESTS) {
      const candidate = directory === "." ? manifest : `${directory}/${manifest}`;
      if (files.has(candidate)) return directory;
    }
    if (directory === ".") return null;
    directory = path.posix.dirname(directory);
  }
}

function isTestPath(relative: string): boolean {
  const lower = relative.toLowerCase();
  return (
    /(?:^|\/)(?:test|tests|__tests__)\//.test(lower) ||
    /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/.test(lower) ||
    /(?:^|\/)test_[^/]+\.py$/.test(lower) ||
    /_test\.go$/.test(lower)
  );
}

function logicalStem(relative: string): string {
  const base = path.posix.basename(relative).toLowerCase();
  return base
    .replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "")
    .replace(/\.(?:test|spec)$/, "")
    .replace(/_(?:test|spec)$/, "");
}

function insidePackage(relative: string, packageRoot: string | null): boolean {
  return packageRoot === null || packageRoot === "."
    ? true
    : relative === packageRoot || relative.startsWith(`${packageRoot}/`);
}

function renderSection(title: string, values: readonly string[], limit: number): string[] {
  const shown = values.slice(0, limit);
  return [
    `${title} (${values.length}):`,
    ...(shown.length === 0 ? ["  (none)"] : shown.map((value) => `  ${value}`)),
    ...(values.length > shown.length ? [`  … ${values.length - shown.length} more`] : []),
  ];
}

export function relatedRepository(
  root: string,
  targetInput: string,
  options: RelatedRepositoryOptions = {},
): RelatedRepositoryResult {
  const target = normalizedRepositoryPath(targetInput);
  if (target === null)
    throw new Error(`${targetInput || "the empty path"} is outside the repository`);
  const index = options.index ?? indexRepository(root);
  const files = new Set(repositoryFiles(index));
  if (!files.has(target)) throw new Error(`${target} is not an indexed repository file`);
  const graph = options.graph ?? buildRepositoryRelationships(root, index);
  const packageRoot = nearestPackageRoot(index, target);
  const dependencies = [...(graph.outgoing.get(target) ?? [])].sort();
  const dependents = [...(graph.incoming.get(target) ?? [])].sort();
  const stem = logicalStem(target);
  const tests = repositoryFiles(index)
    .filter((candidate) => {
      if (!isTestPath(candidate) || !insidePackage(candidate, packageRoot)) return false;
      return dependents.includes(candidate) || logicalStem(candidate) === stem;
    })
    .sort();
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const truncated =
    graph.truncated ||
    dependencies.length > maxResults ||
    dependents.length > maxResults ||
    tests.length > maxResults;
  const packageLabel = packageRoot ?? "(no package manifest found)";
  const output = [
    `Relationships for ${target}`,
    `Package: ${packageLabel}`,
    ...renderSection("Direct dependencies", dependencies, maxResults),
    ...renderSection("Inbound dependents", dependents, maxResults),
    ...renderSection("Related tests", tests, maxResults),
    `Analysis: static relative TypeScript/JavaScript imports only; package imports and path aliases are not resolved.`,
    `Scan: ${graph.scannedFiles}/${graph.candidateFiles} supported files${graph.skippedLargeFiles > 0 ? `; ${graph.skippedLargeFiles} oversized files skipped` : ""}.`,
    ...(graph.truncated ? ["[relationship scan truncated at the configured safety limit]"] : []),
  ].join("\n");
  return { path: target, packageRoot, dependencies, dependents, tests, output, truncated };
}
