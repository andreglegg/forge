import path from "node:path";
import { buildRepositoryRelationships, type RepositoryRelationships } from "./relationships.js";
import { indexRepository, type RepositoryIndex, repositoryFiles } from "./repository.js";

const PACKAGE_MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;
const DEFAULT_MAX_AFFECTED = 500;
const DEFAULT_MAX_TESTS = 100;

export interface ChangeImpactOptions {
  readonly index?: RepositoryIndex;
  readonly graph?: RepositoryRelationships;
  readonly maxAffected?: number;
  readonly maxTests?: number;
}

export interface ChangeImpactPlan {
  readonly changed: readonly string[];
  readonly unanalyzable: readonly string[];
  readonly affected: readonly string[];
  readonly packages: readonly string[];
  readonly tests: readonly string[];
  readonly truncated: boolean;
  readonly output: string;
}

function normalize(candidate: string): string | null {
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
  return path.posix
    .basename(relative)
    .toLowerCase()
    .replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "")
    .replace(/\.(?:test|spec)$/, "")
    .replace(/_(?:test|spec)$/, "");
}

function nearestPackageRoot(files: ReadonlySet<string>, target: string): string | null {
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

function insidePackage(relative: string, packageRoot: string | null): boolean {
  return packageRoot === null || packageRoot === "."
    ? true
    : relative === packageRoot || relative.startsWith(`${packageRoot}/`);
}

function renderSection(title: string, values: readonly string[]): string[] {
  return [
    `${title} (${values.length}):`,
    ...(values.length === 0 ? ["  (none)"] : values.map((value) => `  ${value}`)),
  ];
}

export function planChangeImpact(
  root: string,
  changedInputs: readonly string[],
  options: ChangeImpactOptions = {},
): ChangeImpactPlan {
  const index = options.index ?? indexRepository(root);
  const graph = options.graph ?? buildRepositoryRelationships(root, index);
  const files = repositoryFiles(index);
  const fileSet = new Set(files);
  const normalized = [
    ...new Set(changedInputs.map(normalize).filter((item): item is string => item !== null)),
  ].sort();
  const changed = normalized.filter((candidate) => fileSet.has(candidate));
  const unanalyzable = normalized.filter((candidate) => !fileSet.has(candidate));
  const maxAffected = Math.max(1, options.maxAffected ?? DEFAULT_MAX_AFFECTED);
  const affectedSet = new Set(changed);
  const queue = [...changed];
  let truncated = graph.truncated;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const dependent of graph.incoming.get(current) ?? []) {
      if (affectedSet.has(dependent)) continue;
      if (affectedSet.size >= maxAffected) {
        truncated = true;
        queue.length = 0;
        break;
      }
      affectedSet.add(dependent);
      queue.push(dependent);
    }
  }

  const affected = [...affectedSet].sort();
  const packageRoots = new Set<string>();
  for (const candidate of affected) {
    const packageRoot = nearestPackageRoot(fileSet, candidate);
    if (packageRoot !== null) packageRoots.add(packageRoot);
  }
  const packages = [...packageRoots].sort();
  const stems = new Set(changed.map(logicalStem));
  const maxTests = Math.max(1, options.maxTests ?? DEFAULT_MAX_TESTS);
  const allTests = files
    .filter((candidate) => {
      if (!isTestPath(candidate)) return false;
      if (affectedSet.has(candidate)) return true;
      if (stems.has(logicalStem(candidate))) return true;
      return packages.some((packageRoot) => insidePackage(candidate, packageRoot));
    })
    .sort((left, right) => {
      const leftDirect = affectedSet.has(left) ? 0 : stems.has(logicalStem(left)) ? 1 : 2;
      const rightDirect = affectedSet.has(right) ? 0 : stems.has(logicalStem(right)) ? 1 : 2;
      return leftDirect - rightDirect || left.localeCompare(right);
    });
  const tests = allTests.slice(0, maxTests);
  if (allTests.length > tests.length) truncated = true;

  const output = [
    "Change-impact plan",
    ...renderSection("Committed indexed paths", changed),
    ...renderSection("Affected inbound closure", affected),
    ...renderSection("Owning packages", packages),
    ...renderSection("Candidate focused tests", tests),
    ...(unanalyzable.length === 0
      ? []
      : [
          ...renderSection("Unanalyzable committed paths", unanalyzable),
          "  These paths are absent from the current repository index, usually because they were deleted or moved away.",
        ]),
    "Planning only: candidate tests are evidence for iteration; the configured authoritative completion gate remains mandatory.",
    `Analysis: static relative TypeScript/JavaScript dependency closure; package imports, path aliases, and dynamic dispatch are not resolved.`,
    `Scan: ${graph.scannedFiles}/${graph.candidateFiles} supported files.`,
    ...(truncated ? ["[impact analysis truncated at the configured safety limit]"] : []),
  ].join("\n");

  return { changed, unanalyzable, affected, packages, tests, truncated, output };
}
