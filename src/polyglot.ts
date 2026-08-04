/**
 * A resumable Aider Polyglot adapter for this agent.
 *
 * The upstream repository is benchmark data, not an agent API. This adapter
 * preserves its 225-case denominator, excludes reference solutions, enables
 * the complete Exercism test suites, and judges the work with a fresh process
 * after Forge exits. Published Little Coder results use two attempts, so the
 * default here is the same: 12 turns, external verification, then a fresh
 * eight-turn process driven by the failure output.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fingerprintExecutable } from "./bench.js";
import { execBounded } from "./exec.js";

export const POLYGLOT_LANGUAGES = ["cpp", "go", "java", "javascript", "python", "rust"] as const;
export type PolyglotLanguage = (typeof POLYGLOT_LANGUAGES)[number];

export interface PolyglotCase {
  readonly language: PolyglotLanguage;
  readonly name: string;
  readonly source: string;
  readonly solutionFiles: readonly string[];
  readonly supportFiles: readonly string[];
  readonly testFiles: readonly string[];
  readonly exampleFiles: readonly string[];
}

export interface PolyglotAttempt {
  readonly number: number;
  readonly turnsBudget: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly claimedSuccess: boolean;
  readonly turns: number | null;
  readonly actions: number | null;
  readonly seconds: number;
  readonly output: string;
}

export interface PolyglotCaseResult {
  readonly id: string;
  readonly language: PolyglotLanguage;
  readonly exercise: string;
  readonly passed: boolean;
  readonly passedFirstAttempt: boolean;
  readonly attemptOutcomes: readonly boolean[];
  readonly infrastructureError: boolean;
  readonly timedOut: boolean;
  readonly falseSuccessAttempts: number;
  readonly failureClass: PolyglotFailureClass | null;
  readonly attempts: readonly PolyglotAttempt[];
  readonly verification: string;
  readonly seconds: number;
  readonly worktreeRetained: boolean;
}

export type PolyglotFailureClass =
  | "infrastructure"
  | "timeout"
  | "protocol"
  | "syntax"
  | "type_or_compile"
  | "test_failure"
  | "no_progress"
  | "hang_or_deadlock"
  | "unknown";

export const POLYGLOT_VERIFIER_TIMEOUTS: Readonly<Record<PolyglotLanguage, number>> = {
  python: 60,
  go: 60,
  rust: 180,
  javascript: 90,
  cpp: 240,
  java: 300,
};

const TEST_AUTHORING_VERIFIER = ".forge-test-authoring-verifier.mjs";
const TEST_AUTHORING_VERIFIER_SOURCE = `import { spawnSync } from "node:child_process";

const expected = new Map([["1", false], ["2", false], ["3", false], ["4", true]]);
let ok = true;
for (const [implementation, shouldPass] of expected) {
  const result = spawnSync("go", ["test", "-timeout=10s", "-count=1", "./..."], {
    encoding: "utf8",
    env: { ...process.env, COUNTER_IMPL: implementation },
    timeout: 12_000,
  });
  const passed = result.status === 0 && result.error === undefined;
  const verdict = passed === shouldPass ? "ok" : "MISMATCH";
  process.stdout.write(
    "COUNTER_IMPL=" + implementation + ": " +
      (passed ? "tests passed" : "tests rejected implementation") +
      " (expected " + (shouldPass ? "pass" : "reject") + ") — " + verdict + "\\n",
  );
  if (passed !== shouldPass) {
    ok = false;
    const detail = (String(result.stdout ?? "") + "\\n" + String(result.stderr ?? "")).trim();
    if (detail) process.stdout.write(detail.slice(-2400) + "\\n");
  }
}
process.exitCode = ok ? 0 : 1;
`;

export interface PolyglotRunIdentity {
  readonly benchmark: "aider-polyglot";
  readonly version: 1;
  readonly profile: "standard" | "discovery";
  readonly datasetCommit: string;
  readonly executableFingerprint: string | null;
  readonly model: string;
  readonly modelDigest: string | null;
  readonly endpoint: string;
  readonly temperature: number;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly nativeProtocol: boolean;
  readonly taskPacket: boolean;
  readonly batchActions: boolean;
  readonly caseConcurrency: number;
  readonly tries: number;
  readonly firstTurns: number;
  readonly retryTurns: number;
  readonly attemptTimeoutSeconds: number;
  readonly verifierTimeouts: Readonly<Record<PolyglotLanguage, number>>;
  readonly selection: {
    readonly languages: readonly string[];
    readonly cases: readonly string[];
    readonly smoke: boolean;
    readonly limit: number;
    readonly perLanguage: number;
  };
}

export interface PolyglotOptions {
  readonly dataset: string;
  readonly output: string;
  readonly binary: string;
  readonly model: string;
  readonly modelDigest?: string | undefined;
  readonly endpoint: string;
  readonly temperature: number;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly nativeProtocol: boolean;
  readonly taskPacket?: boolean | undefined;
  readonly batchActions?: boolean | undefined;
  readonly discovery?: boolean | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly cases?: readonly string[] | undefined;
  readonly smoke?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly perLanguage?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly jobs?: number | undefined;
  readonly tries?: number | undefined;
  readonly firstTurns?: number | undefined;
  readonly retryTurns?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly onProgress?: ((line: string) => void) | undefined;
}

export interface PolyglotReport {
  readonly identity: PolyglotRunIdentity;
  readonly identityFingerprint: string;
  readonly officialCaseCount: number;
  readonly selectedCaseCount: number;
  readonly completedCaseCount: number;
  readonly passedCaseCount: number;
  readonly firstAttemptPassCount: number;
  readonly passRate1: number;
  readonly passRateFinal: number;
  readonly scoreSelected: number;
  readonly incomplete: boolean;
  readonly infrastructureErrorCount: number;
  readonly timeoutCount: number;
  readonly falseSuccessAttemptCount: number;
  readonly totalTurns: number | null;
  readonly totalActions: number | null;
  readonly totalSeconds: number;
  readonly failureClasses: Readonly<Record<string, number>>;
  readonly perLanguage: Readonly<
    Record<
      string,
      { selected: number; completed: number; passed: number; firstAttemptPassed: number }
    >
  >;
  readonly results: readonly PolyglotCaseResult[];
}

export function resolvedPolyglotProfile(options: PolyglotOptions): {
  readonly profile: "standard" | "discovery";
  readonly perLanguage: number;
  readonly tries: number;
  readonly firstTurns: number;
  readonly retryTurns: number;
} {
  const discovery = options.discovery === true;
  return {
    profile: discovery ? "discovery" : "standard",
    perLanguage: options.perLanguage ?? ((options.cases?.length ?? 0) > 0 ? 0 : discovery ? 2 : 0),
    tries: options.tries ?? (discovery ? 1 : 2),
    firstTurns: options.firstTurns ?? (discovery ? 8 : 12),
    retryTurns: options.retryTurns ?? 8,
  };
}

interface CaseFilesConfig {
  readonly files?: {
    readonly solution?: unknown;
    readonly test?: unknown;
    readonly example?: unknown;
  };
}

export function caseId(candidate: PolyglotCase): string {
  return `${candidate.language}/${candidate.name}`;
}

export function discoverPolyglotCases(dataset: string): PolyglotCase[] {
  const found: PolyglotCase[] = [];
  for (const language of POLYGLOT_LANGUAGES) {
    const practice = path.join(dataset, language, "exercises", "practice");
    if (!existsSync(practice)) {
      throw new Error(`missing Polyglot language directory: ${practice}`);
    }
    for (const name of readdirSync(practice).sort()) {
      const source = path.join(practice, name);
      const metadata = path.join(source, ".meta", "config.json");
      if (!lstatSync(source).isDirectory() || !existsSync(metadata)) continue;
      const parsed = JSON.parse(readFileSync(metadata, "utf8")) as CaseFilesConfig;
      const solutionFiles = relativeFiles(parsed.files?.solution, metadata, "solution");
      const testFiles = relativeFiles(parsed.files?.test, metadata, "test");
      const exampleFiles = relativeFiles(parsed.files?.example ?? [], metadata, "example");
      const supportFiles = discoverSupportFiles(source, language, solutionFiles, testFiles);
      found.push({
        language,
        name,
        source,
        solutionFiles,
        supportFiles,
        testFiles,
        exampleFiles,
      });
    }
  }
  if (found.length === 0) throw new Error(`no Polyglot cases found under ${dataset}`);
  return found;
}

function discoverSupportFiles(
  source: string,
  language: PolyglotLanguage,
  solutions: readonly string[],
  tests: readonly string[],
): string[] {
  const excluded = new Set([...solutions, ...tests]);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if ([".meta", ".docs", ".git", "node_modules", "build"].includes(name)) continue;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) continue;
      const relative = path.relative(source, absolute).split(path.sep).join("/");
      if (excluded.has(relative) || !isLanguageSource(language, relative)) continue;
      found.push(relative);
    }
  };
  walk(source);
  return found;
}

function isLanguageSource(language: PolyglotLanguage, relative: string): boolean {
  const base = path.posix.basename(relative);
  if (language === "python") return relative.endsWith(".py") && !base.endsWith("_test.py");
  if (language === "go") return relative.endsWith(".go") && !base.endsWith("_test.go");
  if (language === "rust") return relative.startsWith("src/") && relative.endsWith(".rs");
  if (language === "java") {
    return relative.startsWith("src/main/java/") && relative.endsWith(".java");
  }
  if (language === "javascript") {
    return relative.endsWith(".js") && !base.endsWith(".spec.js") && base !== "babel.config.js";
  }
  return (
    !relative.includes("/") &&
    (relative.endsWith(".cpp") || relative.endsWith(".h")) &&
    !base.endsWith("_test.cpp")
  );
}

function relativeFiles(value: unknown, metadata: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid ${field} files in ${metadata}`);
  }
  const files = value as string[];
  for (const file of files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      throw new Error(`unsafe ${field} path in ${metadata}: ${file}`);
    }
  }
  return files;
}

export function selectPolyglotCases(
  all: readonly PolyglotCase[],
  options: Pick<PolyglotOptions, "languages" | "cases" | "smoke" | "limit" | "perLanguage">,
): PolyglotCase[] {
  const requested = new Set((options.languages ?? []).map((item) => item.toLowerCase()));
  const unknown = [...requested].filter(
    (item) => !POLYGLOT_LANGUAGES.includes(item as PolyglotLanguage),
  );
  if (unknown.length > 0) throw new Error(`unknown Polyglot language(s): ${unknown.join(", ")}`);
  const needles = (options.cases ?? []).map((item) => item.toLowerCase());
  let selected = all.filter((candidate) => {
    const id = caseId(candidate).toLowerCase();
    return (
      (requested.size === 0 || requested.has(candidate.language)) &&
      (needles.length === 0 || needles.some((needle) => id.includes(needle)))
    );
  });
  const perLanguage = options.perLanguage ?? 0;
  if (perLanguage > 0) {
    selected = POLYGLOT_LANGUAGES.flatMap((language) =>
      evenlySpaced(
        selected.filter((candidate) => candidate.language === language),
        perLanguage,
      ),
    );
  }
  if (options.smoke === true) {
    selected = POLYGLOT_LANGUAGES.flatMap((language) => {
      const first = selected.find((candidate) => candidate.language === language);
      return first === undefined ? [] : [first];
    });
  }
  const limit = options.limit ?? 0;
  if (limit > 0) selected = selected.slice(0, limit);
  if (selected.length === 0) throw new Error("no Polyglot cases matched the requested filters");
  return selected;
}

function evenlySpaced<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)] as T];
  return Array.from(
    { length: count },
    (_, index) => items[Math.round((index * (items.length - 1)) / (count - 1))] as T,
  );
}

export function firstAttemptPrompt(candidate: PolyglotCase, repository: string): string {
  const absolute = (files: readonly string[]): string =>
    files.map((file) => path.join(repository, file)).join(", ");
  const testAuthoring = isTestAuthoringExercise(candidate);
  return [
    testAuthoring
      ? `Please complete the '${candidate.name}' test-authoring exercise.`
      : `Please implement the '${candidate.name}' exercise.`,
    `The working directory is ${repository}.`,
    candidate.solutionFiles.length === 0
      ? ""
      : `The primary implementation file(s) are: ${absolute(candidate.solutionFiles)}.`,
    candidate.supportFiles.length === 0
      ? ""
      : `Related source or interface file(s) to inspect are: ${absolute(candidate.supportFiles)}.`,
    candidate.testFiles.length === 0 ? "" : `The tests are in: ${absolute(candidate.testFiles)}.`,
    testAuthoring
      ? `The specification makes the test file the primary deliverable: design tests that pass against the supplied correct implementation and detect each supplied defective implementation. Inspect every implementation variant before editing. Run node ${TEST_AUTHORING_VERIFIER} to verify that complete contract; plain go test is not sufficient.`
      : "Read the listed implementation and related source files before deciding what to edit. If the implementation is non-stub, run the tests before editing and preserve it if they already pass. A missing test runner is setup failure, not a code failure: install the project's existing dependencies and rerun the tests before editing. Otherwise implement the solution, then run the tests to verify.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function retryPrompt(candidate: PolyglotCase, verification: string): string {
  const testAuthoring = isTestAuthoringExercise(candidate);
  return [
    `The tests for '${candidate.name}' failed. Here is a bounded diagnostic packet:`,
    "",
    "```",
    diagnosticExcerpt(verification),
    "```",
    "",
    candidate.solutionFiles.length === 0
      ? ""
      : `Primary implementation file(s): ${candidate.solutionFiles.join(", ")}.`,
    candidate.supportFiles.length === 0
      ? ""
      : `Related source or interface file(s): ${candidate.supportFiles.join(", ")}.`,
    candidate.testFiles.length === 0 ? "" : `Test file(s): ${candidate.testFiles.join(", ")}.`,
    testAuthoring
      ? `Treat the verifier as authoritative. Fix the authored test suite so the correct implementation passes and every supplied defective implementation is detected. Run node ${TEST_AUTHORING_VERIFIER} after each repair.`
      : "Treat the verifier as authoritative. Inspect the named project source locations before editing, do not weaken existing tests, and fix the implementation so the tests pass.",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

export function isTestAuthoringExercise(candidate: PolyglotCase): boolean {
  const instructions = path.join(candidate.source, ".docs", "instructions.md");
  if (!existsSync(instructions)) return false;
  const text = readFileSync(instructions, "utf8");
  return /special exercise/i.test(text) && /design a test suite/i.test(text);
}

export function diagnosticExcerpt(output: string, limit = 2_400): string {
  const lines = output.split(/\r?\n/);
  const useful = lines.findIndex((line) =>
    /panic: test timed out|syntaxerror|assertionerror|(?:^|\s)error:|exception|--- fail:|\bfailed\b|expected .+ (?:got|but)|no (?:method|member) named|cannot find symbol|could not compile/i.test(
      line,
    ),
  );
  const primary = useful < 0 ? [] : lines.slice(Math.max(0, useful - 1), useful + 3);
  const locations = lines.filter(
    (line) =>
      /\.(?:py|go|rs|java|js|cpp|h):\d+/.test(line) &&
      !/(?:node_modules|catch\.hpp|\/build\/|gradle\/)/.test(line),
  );
  const tail = lines.slice(-14);
  const sections = [
    primary.length > 0 ? ["Primary diagnostic:", ...primary] : [],
    locations.length > 0 ? ["Relevant project locations:", ...locations.slice(0, 6)] : [],
    ["Output tail:", ...tail],
  ];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const line of sections.flat()) {
    const clipped = line.length > 360 ? `${line.slice(0, 357)}...` : line;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    selected.push(clipped);
  }
  const joined = selected.join("\n");
  if (joined.length <= limit) return joined;
  const head = Math.floor(limit * 0.7);
  const tailChars = limit - head - 45;
  return `${joined.slice(0, head)}\n… diagnostic packet clipped …\n${joined.slice(-tailChars)}`;
}

export function verificationCommands(candidate: PolyglotCase): string[][] {
  if (candidate.language === "python") {
    const test = candidate.testFiles[0] ?? ".";
    // The benchmark checkout intentionally has no Python environment. `uv`
    // supplies an isolated, cached pytest instead of depending on whichever
    // global Python happened to launch this Node CLI (or whether it has pytest).
    return [["uv", "run", "--with", "pytest", "pytest", test, "-q", "--tb=short"]];
  }
  if (candidate.language === "go") {
    if (isTestAuthoringExercise(candidate)) return [["node", TEST_AUTHORING_VERIFIER]];
    return [["go", "test", "-timeout=55s", "-count=1", "./..."]];
  }
  if (candidate.language === "rust") return [["cargo", "test", "--", "--include-ignored"]];
  if (candidate.language === "java") {
    return [["./gradlew", "test", "--no-daemon", "--console=plain", "--info"]];
  }
  if (candidate.language === "javascript") {
    return [
      ["npm", "install", "--silent", "--no-audit", "--no-fund"],
      ["npm", "test", "--silent"],
    ];
  }
  return [
    ["cmake", "-S", ".", "-B", "build", "-DCMAKE_CXX_FLAGS=-DEXERCISM_RUN_ALL_TESTS"],
    ["cmake", "--build", "build"],
  ];
}

export function preparePolyglotCase(candidate: PolyglotCase, repository: string): void {
  rmSync(repository, { recursive: true, force: true });
  copyWithoutMetadata(candidate.source, repository);
  if (isTestAuthoringExercise(candidate)) {
    writeFileSync(path.join(repository, TEST_AUTHORING_VERIFIER), TEST_AUTHORING_VERIFIER_SOURCE);
  }
  writeFileSync(
    path.join(repository, "forge.json"),
    `${JSON.stringify({ verify: verificationCommands(candidate) }, null, 2)}\n`,
    "utf8",
  );
  if (candidate.language === "javascript") {
    for (const relative of candidate.testFiles) {
      rewriteIfPresent(path.join(repository, relative), (text) =>
        text.replace(/\b(xit|xtest|xdescribe)\s*\(/g, (_whole, marker: string) => {
          if (marker === "xit") return "it(";
          if (marker === "xtest") return "test(";
          return "describe(";
        }),
      );
    }
  }
  if (candidate.language === "java") {
    for (const relative of candidate.testFiles) {
      rewriteIfPresent(path.join(repository, relative), (text) =>
        text.replace(/^[ \t]*@Disabled\b.*$/gm, ""),
      );
    }
  }
  const gradle = path.join(repository, "gradlew");
  if (existsSync(gradle)) chmodSync(gradle, 0o755);
}

function rewriteIfPresent(file: string, rewrite: (text: string) => string): void {
  if (!existsSync(file)) return;
  const before = readFileSync(file, "utf8");
  const after = rewrite(before);
  if (after !== before) writeFileSync(file, after, "utf8");
}

function copyWithoutMetadata(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source).sort()) {
    if (name === ".meta" || name === ".git" || name === "node_modules" || name === "build")
      continue;
    const from = path.join(source, name);
    const to = path.join(target, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) copyWithoutMetadata(from, to);
    else if (stat.isFile()) copyFileSync(from, to);
  }
}

const NO_TESTS = [
  "[no tests to run]",
  "no tests ran",
  "collected 0 items",
  "no tests were found",
  ":test no-source",
];

async function externallyVerify(
  candidate: PolyglotCase,
  repository: string,
  timeoutSeconds: number,
  cacheRoot = path.join(repository, ".forge-tool-cache"),
): Promise<{ passed: boolean; output: string; timedOut: boolean }> {
  const output: string[] = [];
  let passed = true;
  let timedOut = false;
  for (const command of verificationCommands(candidate)) {
    const commandTimeout =
      candidate.language === "javascript" && command[0] === "npm" && command[1] === "install"
        ? Math.max(120, timeoutSeconds)
        : timeoutSeconds;
    const result = await execBounded(command, {
      cwd: repository,
      timeoutSeconds: commandTimeout,
      maxOutputChars: 12_000,
      extraEnv: { GRADLE_USER_HOME: path.join(cacheRoot, "gradle") },
    });
    const ranNothing =
      result.code === 0 &&
      (NO_TESTS.some((marker) => result.output.toLowerCase().includes(marker)) ||
        /tests?\s+run:\s*0\b/i.test(result.output));
    const testTimedOut =
      result.timedOut || /(?:tests?|build) timed out|panic: test timed out/i.test(result.output);
    passed = passed && result.code === 0 && !testTimedOut && !ranNothing;
    timedOut = timedOut || testTimedOut;
    output.push(`$ ${command.join(" ")}\n${result.output.slice(-6_000)}`);
  }
  return { passed, output: output.join("\n\n").slice(-12_000), timedOut };
}

function parseAttempt(
  number: number,
  turnsBudget: number,
  output: string,
  result: {
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly seconds: number;
  },
): PolyglotAttempt {
  let claimedSuccess = false;
  let turns: number | null = null;
  let actions: number | null = null;
  try {
    const brace = output.lastIndexOf("\n{");
    const parsed = JSON.parse(output.slice(brace >= 0 ? brace + 1 : 0)) as {
      readonly ok?: boolean;
      readonly usage?: { readonly turns?: number; readonly actions?: number };
    };
    claimedSuccess = parsed.ok === true;
    turns = parsed.usage?.turns ?? null;
    actions = parsed.usage?.actions ?? null;
  } catch {
    // The independent verifier still decides the case. Missing metrics stay null.
  }
  return {
    number,
    turnsBudget,
    exitCode: result.code,
    timedOut: result.timedOut,
    claimedSuccess,
    turns,
    actions,
    seconds: result.seconds,
    output,
  };
}

async function runAttempt(
  prompt: string,
  repository: string,
  number: number,
  turnsBudget: number,
  options: PolyglotOptions,
): Promise<PolyglotAttempt> {
  const command = [
    process.execPath,
    options.binary,
    "run",
    prompt,
    "--repo",
    repository,
    "--yes",
    "--json",
    "--max-turns",
    String(turnsBudget),
    "--url",
    options.endpoint,
    "--model",
    options.model,
    "--temperature",
    String(options.temperature),
    ...(options.contextWindow > 0 ? ["--context", String(options.contextWindow)] : []),
    ...(options.maxTokens > 0 ? ["--max-tokens", String(options.maxTokens)] : []),
    ...(options.nativeProtocol ? ["--native"] : []),
    ...(options.taskPacket === true ? ["--task-packet"] : []),
    ...(options.batchActions === true ? ["--batch-actions"] : []),
  ];
  const result = await execBounded(command, {
    cwd: repository,
    timeoutSeconds: options.timeoutSeconds ?? 900,
    maxOutputChars: 200_000,
    extraEnv: { GRADLE_USER_HOME: path.join(options.output, "tool-cache", "gradle") },
  });
  return parseAttempt(number, turnsBudget, result.output, result);
}

function datasetCommit(dataset: string): string {
  const head = path.join(dataset, ".git", "HEAD");
  if (!existsSync(head)) return "unknown";
  const value = readFileSync(head, "utf8").trim();
  if (!value.startsWith("ref: ")) return value;
  const ref = path.join(dataset, ".git", value.slice(5));
  return existsSync(ref) ? readFileSync(ref, "utf8").trim() : "unknown";
}

function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temporary, file);
  } catch {
    // Windows does not consistently replace an existing target. The complete
    // temporary document still prevents a torn JSON file; resume safely
    // rebuilds a report if interrupted in this fallback's brief gap.
    rmSync(file, { force: true });
    renameSync(temporary, file);
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function identityFor(
  options: PolyglotOptions,
  selection: PolyglotRunIdentity["selection"],
): PolyglotRunIdentity {
  const profile = resolvedPolyglotProfile(options);
  return {
    benchmark: "aider-polyglot",
    version: 1,
    profile: profile.profile,
    datasetCommit: datasetCommit(options.dataset),
    executableFingerprint: fingerprintExecutable(options.binary),
    model: options.model,
    modelDigest: options.modelDigest ?? null,
    endpoint: options.endpoint,
    temperature: options.temperature,
    contextWindow: options.contextWindow,
    maxTokens: options.maxTokens,
    nativeProtocol: options.nativeProtocol,
    taskPacket: options.taskPacket === true,
    batchActions: options.batchActions === true,
    caseConcurrency: Math.max(1, options.jobs ?? 1),
    tries: profile.tries,
    firstTurns: profile.firstTurns,
    retryTurns: profile.retryTurns,
    attemptTimeoutSeconds: options.timeoutSeconds ?? 900,
    verifierTimeouts: Object.fromEntries(
      POLYGLOT_LANGUAGES.map((language) => [
        language,
        options.timeoutSeconds ?? POLYGLOT_VERIFIER_TIMEOUTS[language],
      ]),
    ) as Record<PolyglotLanguage, number>,
    selection,
  };
}

function identityFingerprint(identity: PolyglotRunIdentity): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}

function buildReport(
  identity: PolyglotRunIdentity,
  all: readonly PolyglotCase[],
  selected: readonly PolyglotCase[],
  completed: ReadonlyMap<string, PolyglotCaseResult>,
  infrastructureErrorCount: number,
): PolyglotReport {
  const results = selected.flatMap((candidate) => {
    const result = completed.get(caseId(candidate));
    return result === undefined ? [] : [result];
  });
  const passed = results.filter((result) => result.passed).length;
  const first = results.filter((result) => result.passedFirstAttempt).length;
  const perLanguage: Record<
    string,
    { selected: number; completed: number; passed: number; firstAttemptPassed: number }
  > = {};
  for (const language of POLYGLOT_LANGUAGES) {
    const languageResults = results.filter((result) => result.language === language);
    perLanguage[language] = {
      selected: selected.filter((candidate) => candidate.language === language).length,
      completed: languageResults.length,
      passed: languageResults.filter((result) => result.passed).length,
      firstAttemptPassed: languageResults.filter((result) => result.passedFirstAttempt).length,
    };
  }
  const allAttempts = results.flatMap((result) => result.attempts);
  const failureClasses: Record<string, number> = {};
  for (const result of results) {
    if (result.failureClass === null) continue;
    failureClasses[result.failureClass] = (failureClasses[result.failureClass] ?? 0) + 1;
  }
  return {
    identity,
    identityFingerprint: identityFingerprint(identity),
    officialCaseCount: all.length,
    selectedCaseCount: selected.length,
    completedCaseCount: results.length,
    passedCaseCount: passed,
    firstAttemptPassCount: first,
    passRate1: results.length === 0 ? 0 : first / results.length,
    passRateFinal: results.length === 0 ? 0 : passed / results.length,
    scoreSelected: selected.length === 0 ? 0 : passed / selected.length,
    incomplete: results.length < selected.length,
    infrastructureErrorCount,
    timeoutCount: results.filter((result) => result.timedOut).length,
    falseSuccessAttemptCount: results.reduce((sum, result) => sum + result.falseSuccessAttempts, 0),
    totalTurns: sumKnown(allAttempts.map((attempt) => attempt.turns)),
    totalActions: sumKnown(allAttempts.map((attempt) => attempt.actions)),
    totalSeconds: results.reduce((sum, result) => sum + result.seconds, 0),
    failureClasses,
    perLanguage,
    results,
  };
}

function sumKnown(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function classifyPolyglotFailure(
  passed: boolean,
  infrastructureError: boolean,
  timedOut: boolean,
  verification: string,
  attempts: readonly PolyglotAttempt[],
): PolyglotFailureClass | null {
  if (passed) return null;
  if (infrastructureError) return "infrastructure";
  if (timedOut) return "timeout";
  const evidence = verification.toLowerCase();
  if (/deadlock|test timed out|tests timed out|panic: test timed out/.test(evidence)) {
    return "hang_or_deadlock";
  }
  if (/syntaxerror|syntax error|parse error|unexpected token/.test(evidence)) return "syntax";
  if (
    /assertionfailederror|--- fail:|tests completed, \d+ failed|expect\(received\)|assertion `left == right` failed/.test(
      evidence,
    )
  ) {
    return "test_failure";
  }
  if (
    /type mismatch|typeerror|cannot find symbol|cannot find name|undefined (symbol|reference)|no (method|member) named|incompatible types|cannot be applied|trait bound|compilation failed|could not compile|build failed/.test(
      evidence,
    )
  ) {
    return "type_or_compile";
  }
  if (/assert|expected|failures?:|tests? failed|not equal|panicked at/.test(evidence)) {
    return "test_failure";
  }
  if (attempts.every((attempt) => attempt.actions === null)) return "protocol";
  if (attempts.every((attempt) => (attempt.actions ?? 0) === 0)) return "no_progress";
  return "unknown";
}

export function isPolyglotInfrastructureFailure(output: string): boolean {
  return /connection refused|fetch failed|econnrefused|could not resolve host|temporary failure in name resolution|network is unreachable|failed to download|could not create parent directory for lock file|could not find tools\.jar|valid jdk installation|no space left on device|bad option:\s*-m|no module named pytest/i.test(
    output,
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface PolyglotDependencies {
  readonly runAttempt?: typeof runAttempt;
  readonly verify?: typeof externallyVerify;
  /** Test seam; production always performs the authoritative preflight. */
  readonly preflightVerify?: typeof externallyVerify;
}

export async function runPolyglot(
  options: PolyglotOptions,
  dependencies: PolyglotDependencies = {},
): Promise<PolyglotReport> {
  const all = discoverPolyglotCases(path.resolve(options.dataset));
  const profile = resolvedPolyglotProfile(options);
  const isFullSelection =
    (options.languages?.length ?? 0) === 0 &&
    (options.cases?.length ?? 0) === 0 &&
    options.smoke !== true &&
    (options.limit ?? 0) === 0 &&
    profile.perLanguage === 0;
  if (isFullSelection && all.length !== 225) {
    throw new Error(`full Polyglot run requires exactly 225 official cases; found ${all.length}`);
  }
  const selected = selectPolyglotCases(all, { ...options, perLanguage: profile.perLanguage });
  const selection = {
    languages: [...(options.languages ?? [])].map((item) => item.toLowerCase()).sort(),
    cases: [...(options.cases ?? [])].map((item) => item.toLowerCase()).sort(),
    smoke: options.smoke === true,
    limit: options.limit ?? 0,
    perLanguage: profile.perLanguage,
  };
  const identity = identityFor(options, selection);
  const identityFile = path.join(options.output, "run.json");
  const existingIdentity = readJson(identityFile);
  if (existingIdentity !== null && !sameJson(existingIdentity, identity)) {
    throw new Error(
      "Polyglot run identity differs; choose a new --name or restore the original configuration",
    );
  }
  if (existingIdentity === null) atomicJson(identityFile, identity);

  const completed = new Map<string, PolyglotCaseResult>();
  const infrastructureErrors = new Set<string>();
  for (const candidate of selected) {
    const resultFile = path.join(
      options.output,
      "cases",
      candidate.language,
      candidate.name,
      "result.json",
    );
    const parsed = readJson(resultFile) as PolyglotCaseResult | null;
    if (parsed?.id !== caseId(candidate)) continue;
    if (parsed.infrastructureError) infrastructureErrors.add(parsed.id);
    else completed.set(parsed.id, parsed);
  }

  let report = buildReport(identity, all, selected, completed, infrastructureErrors.size);
  atomicJson(path.join(options.output, "report.json"), report);
  const pending = selected.filter((candidate) => !completed.has(caseId(candidate)));
  const batchSize = options.batchSize ?? 0;
  const scheduled = batchSize > 0 ? pending.slice(0, batchSize) : pending;
  const runCandidate = async (candidate: PolyglotCase, index: number): Promise<void> => {
    const id = caseId(candidate);
    infrastructureErrors.delete(id);
    options.onProgress?.(`[${index + 1}/${scheduled.length}] ${id} · started`);
    const caseRoot = path.join(options.output, "cases", candidate.language, candidate.name);
    const repository = path.join(caseRoot, "worktree", candidate.name);
    preparePolyglotCase(candidate, repository);
    const started = Date.now();
    const attempts: PolyglotAttempt[] = [];
    const attemptOutcomes: boolean[] = [];
    let verification = "";
    let passed = false;
    let timedOut = false;
    let infrastructureError = false;
    const verifier = dependencies.verify ?? externallyVerify;
    // Injected runAttempt dependencies are unit-test seams and opt out unless
    // they explicitly provide a preflight verifier. Production always checks
    // the prepared case before spending model turns or allowing mutations.
    const preflightVerifier =
      dependencies.preflightVerify ??
      (dependencies.runAttempt === undefined ? verifier : undefined);
    if (preflightVerifier !== undefined) {
      const checked = await preflightVerifier(
        candidate,
        repository,
        options.timeoutSeconds ?? POLYGLOT_VERIFIER_TIMEOUTS[candidate.language],
        path.join(options.output, "tool-cache"),
      );
      const preflightInfrastructure = isPolyglotInfrastructureFailure(checked.output);
      if (checked.passed || preflightInfrastructure) {
        const result: PolyglotCaseResult = {
          id,
          language: candidate.language,
          exercise: candidate.name,
          passed: checked.passed,
          passedFirstAttempt: checked.passed,
          attemptOutcomes: [],
          infrastructureError: preflightInfrastructure,
          timedOut: checked.timedOut,
          falseSuccessAttempts: 0,
          failureClass: classifyPolyglotFailure(
            checked.passed,
            preflightInfrastructure,
            checked.timedOut,
            checked.output,
            [],
          ),
          attempts: [],
          verification: checked.output,
          seconds: (Date.now() - started) / 1_000,
          worktreeRetained: !checked.passed,
        };
        atomicJson(path.join(caseRoot, "result.json"), result);
        if (preflightInfrastructure) infrastructureErrors.add(id);
        else completed.set(id, result);
        if (checked.passed) {
          rmSync(path.join(caseRoot, "worktree"), { recursive: true, force: true });
        }
        report = buildReport(identity, all, selected, completed, infrastructureErrors.size);
        atomicJson(path.join(options.output, "report.json"), report);
        options.onProgress?.(
          `${id}: ${checked.passed ? "preflight pass" : "infrastructure error"} · ${report.passedCaseCount}/${report.completedCaseCount}`,
        );
        return;
      }
    }
    const tries = identity.tries;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      const turnsBudget = attempt === 1 ? identity.firstTurns : identity.retryTurns;
      const prompt =
        attempt === 1
          ? firstAttemptPrompt(candidate, repository)
          : retryPrompt(candidate, verification);
      const outcome = await (dependencies.runAttempt ?? runAttempt)(
        prompt,
        repository,
        attempt,
        turnsBudget,
        options,
      );
      writeFileSync(path.join(caseRoot, `attempt-${attempt}.log`), outcome.output, "utf8");
      const recorded = { ...outcome, output: outcome.output.slice(-4_000) };
      attempts.push(recorded);
      atomicJson(path.join(caseRoot, `attempt-${attempt}.json`), recorded);
      const checked = await verifier(
        candidate,
        repository,
        options.timeoutSeconds ?? POLYGLOT_VERIFIER_TIMEOUTS[candidate.language],
        path.join(options.output, "tool-cache"),
      );
      verification = checked.output;
      passed = checked.passed;
      attemptOutcomes.push(passed);
      timedOut = timedOut || outcome.timedOut || checked.timedOut;
      if (passed) break;
      infrastructureError = isPolyglotInfrastructureFailure(`${verification}\n${outcome.output}`);
      if (infrastructureError) break;
    }
    infrastructureError =
      infrastructureError ||
      (attempts.length > 0 &&
        attempts.every((attempt) => attempt.turns === null && attempt.actions === null) &&
        attempts.some((attempt) => isPolyglotInfrastructureFailure(attempt.output)));
    const result: PolyglotCaseResult = {
      id,
      language: candidate.language,
      exercise: candidate.name,
      passed,
      passedFirstAttempt: passed && attempts.length === 1,
      attemptOutcomes,
      infrastructureError,
      timedOut,
      falseSuccessAttempts: attempts.filter(
        (attempt, index) => attempt.claimedSuccess && attemptOutcomes[index] !== true,
      ).length,
      failureClass: classifyPolyglotFailure(
        passed,
        infrastructureError,
        timedOut,
        verification,
        attempts,
      ),
      attempts,
      verification,
      seconds: (Date.now() - started) / 1_000,
      worktreeRetained: !passed,
    };
    atomicJson(path.join(caseRoot, "result.json"), result);
    if (infrastructureError) infrastructureErrors.add(id);
    else completed.set(id, result);
    if (passed) rmSync(path.join(caseRoot, "worktree"), { recursive: true, force: true });
    report = buildReport(identity, all, selected, completed, infrastructureErrors.size);
    atomicJson(path.join(options.output, "report.json"), report);
    options.onProgress?.(
      `${id}: ${passed ? "pass" : infrastructureError ? "infrastructure error" : "FAIL"} · ${report.passedCaseCount}/${report.completedCaseCount}`,
    );
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < scheduled.length) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = scheduled[index];
      if (candidate !== undefined) await runCandidate(candidate, index);
    }
  };
  const workerCount = Math.min(identity.caseConcurrency, scheduled.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return report;
}
