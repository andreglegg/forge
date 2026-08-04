/** Paired comparison for two completed Polyglot reports. */

import { readFileSync } from "node:fs";
import type { PolyglotCaseResult, PolyglotReport } from "./polyglot.js";

export interface PolyglotComparison {
  readonly baselineFingerprint: string;
  readonly candidateFingerprint: string;
  readonly cases: number;
  readonly baselinePassed: number;
  readonly candidatePassed: number;
  readonly passDelta: number;
  readonly passRateDelta: number;
  readonly bothPassed: number;
  readonly bothFailed: number;
  readonly gains: number;
  readonly regressions: number;
  readonly discordant: number;
  readonly exactMcNemarP: number;
  readonly baselineSeconds: number;
  readonly candidateSeconds: number;
  readonly secondsDelta: number;
  readonly turnsDelta: number | null;
  readonly actionsDelta: number | null;
  readonly falseSuccessAttemptDelta: number;
}

interface LittleCoderDetail {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly time?: unknown;
  readonly turns?: unknown;
}

interface LittleCoderReport {
  readonly languages?: Record<string, { readonly details?: readonly LittleCoderDetail[] }>;
}

export interface CrossAgentComparison {
  readonly cases: number;
  readonly littleCoderPassed: number;
  readonly forgePassed: number;
  readonly passDelta: number;
  readonly passRateDelta: number;
  readonly bothPassed: number;
  readonly bothFailed: number;
  /** Cases Forge passed and Little Coder failed. */
  readonly forgeOnly: readonly string[];
  /** Cases Little Coder passed and Forge failed. */
  readonly littleCoderOnly: readonly string[];
  readonly exactMcNemarP: number;
  readonly littleCoderSeconds: number;
  readonly forgeSeconds: number;
  readonly littleCoderTurns: number;
  readonly forgeTurns: number | null;
}

export function loadPolyglotReport(file: string): PolyglotReport {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PolyglotReport>;
  if (
    parsed.identity?.benchmark !== "aider-polyglot" ||
    typeof parsed.identityFingerprint !== "string" ||
    !Array.isArray(parsed.results)
  ) {
    throw new Error(`not a Polyglot report: ${file}`);
  }
  return parsed as PolyglotReport;
}

export function comparePolyglotReports(
  baseline: PolyglotReport,
  candidate: PolyglotReport,
): PolyglotComparison {
  if (baseline.incomplete || candidate.incomplete) {
    throw new Error("paired comparison requires two complete reports");
  }
  if (baseline.identity.datasetCommit !== candidate.identity.datasetCommit) {
    throw new Error("Polyglot dataset commits differ");
  }
  if (
    JSON.stringify(baseline.identity.selection) !== JSON.stringify(candidate.identity.selection)
  ) {
    throw new Error("Polyglot selections differ");
  }

  const baselineResults = uniqueResults(baseline.results, "baseline");
  const candidateResults = uniqueResults(candidate.results, "candidate");
  const baselineIds = [...baselineResults.keys()].sort();
  const candidateIds = [...candidateResults.keys()].sort();
  if (JSON.stringify(baselineIds) !== JSON.stringify(candidateIds)) {
    throw new Error("Polyglot case IDs differ");
  }

  let bothPassed = 0;
  let bothFailed = 0;
  let gains = 0;
  let regressions = 0;
  for (const id of baselineIds) {
    const before = baselineResults.get(id)?.passed === true;
    const after = candidateResults.get(id)?.passed === true;
    if (before && after) bothPassed += 1;
    else if (!before && !after) bothFailed += 1;
    else if (after) gains += 1;
    else regressions += 1;
  }
  const baselinePassed = bothPassed + regressions;
  const candidatePassed = bothPassed + gains;
  const cases = baselineIds.length;
  return {
    baselineFingerprint: baseline.identityFingerprint,
    candidateFingerprint: candidate.identityFingerprint,
    cases,
    baselinePassed,
    candidatePassed,
    passDelta: candidatePassed - baselinePassed,
    passRateDelta: cases === 0 ? 0 : (candidatePassed - baselinePassed) / cases,
    bothPassed,
    bothFailed,
    gains,
    regressions,
    discordant: gains + regressions,
    exactMcNemarP: exactMcNemar(gains, regressions),
    baselineSeconds: baseline.totalSeconds,
    candidateSeconds: candidate.totalSeconds,
    secondsDelta: candidate.totalSeconds - baseline.totalSeconds,
    turnsDelta: nullableDelta(baseline.totalTurns, candidate.totalTurns),
    actionsDelta: nullableDelta(baseline.totalActions, candidate.totalActions),
    falseSuccessAttemptDelta:
      candidate.falseSuccessAttemptCount - baseline.falseSuccessAttemptCount,
  };
}

/** Compare Forge with Little Coder on an explicit, ordered case manifest. */
export function comparePolyglotWithLittleCoder(
  forge: PolyglotReport,
  littleCoderFile: string,
  manifestFile: string,
): CrossAgentComparison {
  if (forge.incomplete) throw new Error("cross-agent comparison requires a complete Forge report");
  const manifest = readManifest(manifestFile);
  const forgeResults = uniqueResults(forge.results, "Forge");
  assertExactCases([...forgeResults.keys()], manifest, "Forge");

  const raw = JSON.parse(readFileSync(littleCoderFile, "utf8")) as LittleCoderReport;
  if (raw.languages === undefined || typeof raw.languages !== "object") {
    throw new Error(`not a Little Coder Polyglot report: ${littleCoderFile}`);
  }
  const little = new Map<string, { passed: boolean; seconds: number; turns: number }>();
  for (const [language, entry] of Object.entries(raw.languages)) {
    if (!Array.isArray(entry.details)) continue;
    for (const detail of entry.details) {
      if (typeof detail.name !== "string" || typeof detail.status !== "string") continue;
      const id = `${language}/${detail.name}`;
      if (little.has(id)) throw new Error(`Little Coder report has duplicate case: ${id}`);
      little.set(id, {
        passed: detail.status === "pass_1" || detail.status === "pass_2",
        seconds: typeof detail.time === "number" ? detail.time : 0,
        turns: typeof detail.turns === "number" ? detail.turns : 0,
      });
    }
  }
  assertExactCases([...little.keys()], manifest, "Little Coder");

  const forgeOnly: string[] = [];
  const littleCoderOnly: string[] = [];
  let bothPassed = 0;
  let bothFailed = 0;
  let littleCoderSeconds = 0;
  let littleCoderTurns = 0;
  for (const id of manifest) {
    const forgePassed = forgeResults.get(id)?.passed === true;
    const littleResult = little.get(id);
    if (littleResult === undefined) throw new Error(`Little Coder report is missing case: ${id}`);
    littleCoderSeconds += littleResult.seconds;
    littleCoderTurns += littleResult.turns;
    if (forgePassed && littleResult.passed) bothPassed += 1;
    else if (!forgePassed && !littleResult.passed) bothFailed += 1;
    else if (forgePassed) forgeOnly.push(id);
    else littleCoderOnly.push(id);
  }
  const littleCoderPassed = bothPassed + littleCoderOnly.length;
  const forgePassed = bothPassed + forgeOnly.length;
  return {
    cases: manifest.length,
    littleCoderPassed,
    forgePassed,
    passDelta: forgePassed - littleCoderPassed,
    passRateDelta: manifest.length === 0 ? 0 : (forgePassed - littleCoderPassed) / manifest.length,
    bothPassed,
    bothFailed,
    forgeOnly,
    littleCoderOnly,
    exactMcNemarP: exactMcNemar(forgeOnly.length, littleCoderOnly.length),
    littleCoderSeconds,
    forgeSeconds: forge.totalSeconds,
    littleCoderTurns,
    forgeTurns: forge.totalTurns,
  };
}

function readManifest(file: string): string[] {
  const cases = readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (new Set(cases).size !== cases.length) throw new Error("case manifest has duplicates");
  return cases;
}

function assertExactCases(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    const missing = e.filter((id) => !a.includes(id));
    const extra = a.filter((id) => !e.includes(id));
    throw new Error(
      `${label} cases differ from manifest (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
}

function uniqueResults(
  results: readonly PolyglotCaseResult[],
  label: string,
): Map<string, PolyglotCaseResult> {
  const found = new Map<string, PolyglotCaseResult>();
  for (const result of results) {
    if (found.has(result.id)) throw new Error(`${label} report has duplicate case: ${result.id}`);
    found.set(result.id, result);
  }
  return found;
}

function nullableDelta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : after - before;
}

/** Exact two-sided McNemar test, equivalent to a binomial test on discordant pairs. */
export function exactMcNemar(gains: number, regressions: number): number {
  const discordant = gains + regressions;
  if (discordant === 0) return 1;
  const tail = Math.min(gains, regressions);
  let term = 0.5 ** discordant;
  let cumulative = term;
  for (let successes = 1; successes <= tail; successes += 1) {
    term *= (discordant - successes + 1) / successes;
    cumulative += term;
  }
  return Math.min(1, 2 * cumulative);
}

export function formatPolyglotComparison(comparison: PolyglotComparison): string {
  const signed = (value: number): string => `${value >= 0 ? "+" : ""}${value}`;
  const percent = (value: number): string => `${signed(Number((value * 100).toFixed(2)))}pp`;
  return [
    `${comparison.baselinePassed}/${comparison.cases} → ${comparison.candidatePassed}/${comparison.cases} (${signed(comparison.passDelta)}, ${percent(comparison.passRateDelta)})`,
    `paired: ${comparison.gains} gained · ${comparison.regressions} regressed · ${comparison.bothPassed} both passed · ${comparison.bothFailed} both failed`,
    `exact McNemar p=${comparison.exactMcNemarP.toPrecision(4)}`,
    `runtime: ${comparison.baselineSeconds.toFixed(1)}s → ${comparison.candidateSeconds.toFixed(1)}s (${signed(Number(comparison.secondsDelta.toFixed(1)))}s)`,
    `false-success attempts: ${signed(comparison.falseSuccessAttemptDelta)}`,
  ].join("\n");
}

export function formatCrossAgentComparison(comparison: CrossAgentComparison): string {
  const signed = (value: number): string => `${value >= 0 ? "+" : ""}${value}`;
  const percent = `${signed(Number((comparison.passRateDelta * 100).toFixed(2)))}pp`;
  return [
    `Little Coder ${comparison.littleCoderPassed}/${comparison.cases} → Forge ${comparison.forgePassed}/${comparison.cases} (${signed(comparison.passDelta)}, ${percent})`,
    `paired: ${comparison.forgeOnly.length} Forge-only · ${comparison.littleCoderOnly.length} Little-Coder-only · ${comparison.bothPassed} both passed · ${comparison.bothFailed} both failed`,
    `exact McNemar p=${comparison.exactMcNemarP.toPrecision(4)}`,
    `runtime: Little Coder ${comparison.littleCoderSeconds.toFixed(1)}s · Forge ${comparison.forgeSeconds.toFixed(1)}s`,
    `Forge-only: ${comparison.forgeOnly.join(", ") || "none"}`,
    `Little-Coder-only: ${comparison.littleCoderOnly.join(", ") || "none"}`,
  ].join("\n");
}
