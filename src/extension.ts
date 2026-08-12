/**
 * The versioned extension API, v1.0: third-party review of a run's lifecycle.
 *
 * An extension is an executable named in forge.json, never code loaded into the
 * Forge process. Every invocation crosses the same subprocess boundary as
 * built-in commands -- token array, `shell: false`, allowlisted environment
 * without provider credentials, group-kill timeout, bounded output -- and the
 * request/result files live in a fresh OS tempdir outside the repository, so
 * neither repository content nor a model edit can precreate or read them.
 *
 * The power gradient is one-way: an extension can tighten an outcome (reject a
 * completion into a bounded reopen, or fail the run) but can never approve,
 * loosen, or silently pass one. Anything that is not an explicit accept or a
 * well-formed reject -- timeout, nonzero exit, missing or malformed result
 * file -- fails closed with a stated cause.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ExecResult, execBounded } from "./exec.js";
import type { ProjectExtensions } from "./product.js";

export const EXTENSION_API_VERSION = "1.0";

/** Rejects tolerated per run before the budget fails the run closed. */
export const EXTENSION_REJECT_LIMIT = 2;

/** Bound on a reject reason: it becomes model input and must stay one. */
export const EXTENSION_REASON_LIMIT = 2_000;

export type ExtensionEvent = "beforeCompletion";

/** What an invoked extension reads from FORGE_EXTENSION_REQUEST. */
export interface ExtensionRequest {
  readonly api: string;
  readonly event: ExtensionEvent;
  readonly sessionId: string;
  /** The model's claimed completion summary. A claim, not a fact. */
  readonly summary: string;
  readonly mutatedPaths: readonly string[];
  readonly verification: ExtensionVerificationOutcome | null;
}

export interface ExtensionVerificationOutcome {
  readonly passed: boolean;
  readonly commands: readonly string[];
}

export interface ExtensionContext {
  readonly repository: string;
  readonly sessionId: string;
  readonly event: ExtensionEvent;
  readonly summary: string;
  readonly mutatedPaths: readonly string[];
  readonly verification: ExtensionVerificationOutcome | null;
  readonly signal?: AbortSignal | undefined;
}

export interface ExtensionResolution {
  readonly name: string;
  readonly event: ExtensionEvent;
  readonly command: readonly string[];
  readonly decision: "accept" | "reject" | "failed";
  /** The reject reason, or the protocol-failure cause. Empty for accept. */
  readonly reason: string;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly seconds: number;
}

export interface ExtensionRunReport {
  /** True only when every subscribed extension explicitly accepted. */
  readonly ok: boolean;
  readonly rejected: ExtensionResolution | null;
  readonly failed: ExtensionResolution | null;
  readonly resolutions: readonly ExtensionResolution[];
}

/** Observers for the journal: one `invoked` per crossing, one `resolved` after. */
export interface ExtensionAudit {
  readonly invoked?: (invocation: {
    readonly name: string;
    readonly event: ExtensionEvent;
    readonly command: readonly string[];
  }) => void;
  readonly resolved?: (resolution: ExtensionResolution) => void;
}

export type ExtensionExecutor = typeof execBounded;

function parseApi(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Whether this Forge implements the api an extension declares: exact major,
 * declared minor no newer than implemented. Returns the refusal text, or null
 * when compatible. A mismatch is a startup hard error, never a silent skip --
 * skipping would let a reviewer the user configured quietly not review.
 */
export function checkExtensionApi(name: string, declared: string): string | null {
  const implemented = parseApi(EXTENSION_API_VERSION);
  const requested = parseApi(declared);
  if (implemented === null || requested === null) {
    return `extension ${name} declares unreadable api "${declared}"; this Forge implements extension api ${EXTENSION_API_VERSION}`;
  }
  if (requested.major !== implemented.major || requested.minor > implemented.minor) {
    return `extension ${name} requires extension api ${declared}, which this Forge does not implement; it implements ${EXTENSION_API_VERSION}`;
  }
  return null;
}

/** First incompatible manifest entry in name order, or null when all fit. */
export function checkExtensionsApi(extensions: ProjectExtensions | undefined): string | null {
  const entries = extensions ?? {};
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    if (entry === undefined) continue;
    const error = checkExtensionApi(name, entry.api);
    if (error !== null) return error;
  }
  return null;
}

type ParsedDecision =
  | { readonly ok: true; readonly decision: "accept" }
  | { readonly ok: true; readonly decision: "reject"; readonly reason: string }
  | { readonly ok: false; readonly cause: string };

function parseResult(raw: string): ParsedDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, cause: "the result file is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, cause: "the result file is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record["decision"] === "accept") return { ok: true, decision: "accept" };
  if (record["decision"] === "reject") {
    const reason = record["reason"];
    if (typeof reason !== "string" || reason.trim() === "") {
      return { ok: false, cause: "a reject decision requires a non-empty reason string" };
    }
    return {
      ok: true,
      decision: "reject",
      reason:
        reason.length > EXTENSION_REASON_LIMIT ? reason.slice(0, EXTENSION_REASON_LIMIT) : reason,
    };
  }
  return { ok: false, cause: 'the decision must be "accept" or "reject"' };
}

function resolve(
  name: string,
  event: ExtensionEvent,
  command: readonly string[],
  result: ExecResult,
  resultFile: string,
): ExtensionResolution {
  const base = {
    name,
    event,
    command,
    code: result.code,
    timedOut: result.timedOut,
    seconds: result.seconds,
  };
  if (result.timedOut) {
    return { ...base, decision: "failed", reason: `timed out after ${result.seconds.toFixed(1)}s` };
  }
  // Exit 0 is part of an accept: a crashing reviewer that had already written
  // its verdict did not finish reviewing.
  if (result.code !== 0) {
    return { ...base, decision: "failed", reason: `exited ${String(result.code)} instead of 0` };
  }
  let raw: string;
  try {
    raw = readFileSync(resultFile, "utf8");
  } catch {
    return {
      ...base,
      decision: "failed",
      reason: "wrote no result file to FORGE_EXTENSION_RESULT",
    };
  }
  const parsed = parseResult(raw);
  if (!parsed.ok) return { ...base, decision: "failed", reason: parsed.cause };
  if (parsed.decision === "accept") return { ...base, decision: "accept", reason: "" };
  return { ...base, decision: "reject", reason: parsed.reason };
}

/**
 * Invoke every extension subscribed to `context.event`, sorted by name, and
 * stop at the first outcome that is not an accept: a reject or a protocol
 * failure makes the remaining reviews moot, because the run is not finishing.
 */
export async function invokeExtensions(
  extensions: ProjectExtensions | undefined,
  context: ExtensionContext,
  audit: ExtensionAudit = {},
  exec: ExtensionExecutor = execBounded,
): Promise<ExtensionRunReport> {
  const resolutions: ExtensionResolution[] = [];
  const entries = extensions ?? {};
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    if (entry === undefined || !entry.events.includes(context.event)) continue;
    const resolution = await (async (): Promise<ExtensionResolution> => {
      const dir = mkdtempSync(path.join(tmpdir(), "forge-extension-"));
      try {
        const requestFile = path.join(dir, "request.json");
        const resultFile = path.join(dir, "result.json");
        const request: ExtensionRequest = {
          api: EXTENSION_API_VERSION,
          event: context.event,
          sessionId: context.sessionId,
          summary: context.summary,
          mutatedPaths: context.mutatedPaths,
          verification: context.verification,
        };
        writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);
        audit.invoked?.({ name, event: context.event, command: entry.command });
        const result = await exec(entry.command, {
          cwd: context.repository,
          timeoutSeconds: entry.timeoutSeconds ?? 60,
          maxOutputChars: entry.maxOutputChars ?? 8_000,
          signal: context.signal,
          extraEnv: {
            FORGE_EXTENSION_REQUEST: requestFile,
            FORGE_EXTENSION_RESULT: resultFile,
          },
        });
        return resolve(name, context.event, entry.command, result, resultFile);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    resolutions.push(resolution);
    audit.resolved?.(resolution);
    if (resolution.decision === "reject") {
      return { ok: false, rejected: resolution, failed: null, resolutions };
    }
    if (resolution.decision === "failed") {
      return { ok: false, rejected: null, failed: resolution, resolutions };
    }
  }
  return { ok: true, rejected: null, failed: null, resolutions };
}
