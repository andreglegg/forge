/**
 * The reliability laboratory: score the harness against recorded model output.
 *
 * The problem this exists for. When a run goes badly you cannot tell whether
 * the model was weak or the harness dropped what it said, and the usual
 * instrument -- run a coding benchmark and compare scores -- cannot tell you
 * either, because it moves the model and the harness at once and its own
 * variance swamps the difference. A benchmark that costs hours and dollars per
 * data point is also not something anyone runs per commit.
 *
 * So: record every turn the model actually produced, and replay that fixed text
 * through the current decoder. The model side is frozen, no network is touched
 * and no repository is read, so any movement in the number is this code's doing
 * and nothing else. It costs nothing and runs in milliseconds.
 *
 * What it measures is conversion: of N real replies, how many became a usable
 * action. That is the harness's actual job, stated as a number you can track
 * across commits and bisect on.
 *
 * What it deliberately does NOT measure is whether the resulting edit was any
 * good. A reply that decodes into a confident, wrong patch counts as converted.
 * Conversion is a floor on quality, not a substitute for it, and reporting it as
 * anything else would be exactly the kind of borrowed credibility this package
 * refuses elsewhere.
 */

import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { TextCodec } from "./codecs.js";

export const TRACES_SUBDIRECTORY = path.join(".forge", "traces");

/** One recorded turn: exactly what the model emitted, and what we made of it. */
export interface TraceRecord {
  readonly raw: string;
  /** Repairs the decoder applied at record time. Kept for drift comparison. */
  readonly repairs?: readonly string[];
}

export interface ReplayFailure {
  readonly index: number;
  readonly category: string;
  readonly chars: number;
  /** The first line, so a report is diagnosable without the whole reply. */
  readonly excerpt: string;
}

export interface ReplayReport {
  readonly total: number;
  readonly converted: number;
  readonly conversionRate: number;
  readonly repaired: number;
  readonly byRepair: Record<string, number>;
  readonly byCategory: Record<string, number>;
  readonly failures: readonly ReplayFailure[];
}

/**
 * Why a reply produced nothing actionable.
 *
 * These strings are an API. They are the axis a regression is read along, so
 * renaming one silently invalidates every recorded comparison against it --
 * the number still moves, and the reason it moved becomes unattributable.
 */
export function categorize(repairs: readonly string[], raw: string): string {
  if (repairs.includes("truncated_edit_block")) return "truncated";
  if (repairs.includes("orphan_search_block")) return "orphan_block";
  if (repairs.some((repair) => repair.startsWith("bad_directive"))) return "bad_directive";
  if (repairs.includes("invalid_edit_block")) return "invalid_edit";
  if (raw.trim() === "") return "empty";
  return "no_action";
}

/**
 * Re-decode one recorded reply.
 *
 * Fed in a single chunk on purpose. The streaming path is exercised by the
 * codec's own tests with adversarial chunk boundaries; what this measures is
 * the decoder's verdict on complete text, so that a change in the number is
 * attributable to decoding rather than to how a provider happened to split it.
 */
export function score(records: readonly TraceRecord[]): ReplayReport {
  const byRepair: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const failures: ReplayFailure[] = [];
  let converted = 0;
  let repaired = 0;

  records.forEach((record, index) => {
    const codec = new TextCodec();
    codec.feed(record.raw);
    const turn = codec.finish();

    for (const repair of turn.repairs) {
      byRepair[repair] = (byRepair[repair] ?? 0) + 1;
    }
    if (turn.repairs.length > 0) {
      repaired += 1;
    }
    // A turn is converted if it yielded something to act on. `final` counts:
    // "I am done" is a usable answer, and a harness that scored it as a failure
    // would report its own successful runs as losses.
    if (turn.proposals.length > 0 || turn.final !== null) {
      converted += 1;
      return;
    }
    const category = categorize(turn.repairs, record.raw);
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    failures.push({
      index,
      category,
      chars: record.raw.length,
      excerpt: (record.raw.split("\n")[0] ?? "").slice(0, 120),
    });
  });

  return {
    total: records.length,
    converted,
    conversionRate: records.length === 0 ? 0 : converted / records.length,
    repaired,
    byRepair,
    byCategory,
    failures,
  };
}

/**
 * Read every recorded turn under a directory, or from one file.
 *
 * Streamed rather than read whole: a corpus grows without bound as sessions
 * accumulate, and the point of a metric you can run on every commit is that it
 * stays cheap when it is large.
 *
 * A malformed line is skipped rather than fatal. A trace is written by a
 * process that may have been killed mid-line, and losing the corpus because one
 * run was interrupted would defeat the reason for keeping it.
 */
export async function* loadTraces(source: string): AsyncGenerator<TraceRecord> {
  const files: string[] = [];
  if (!existsSync(source)) {
    return;
  }
  const entries = safeReaddir(source);
  if (entries === null) {
    files.push(source);
  } else {
    for (const name of entries.sort()) {
      if (name.endsWith(".jsonl")) files.push(path.join(source, name));
    }
  }

  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed === "object" && parsed !== null && "raw" in parsed) {
          const raw = (parsed as { raw: unknown }).raw;
          if (typeof raw === "string") {
            const repairs = (parsed as { repairs?: unknown }).repairs;
            yield {
              raw,
              ...(Array.isArray(repairs) ? { repairs: repairs as string[] } : {}),
            };
          }
        }
      }
    } finally {
      lines.close();
    }
  }
}

function safeReaddir(target: string): string[] | null {
  try {
    return readdirSync(target);
  } catch {
    return null;
  }
}

/** Where a session's turns are recorded, created on first write. */
export function traceFileFor(root: string, sessionId: string): string {
  const directory = path.join(root, TRACES_SUBDIRECTORY);
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${sessionId}.jsonl`);
}

/** A report as the lines a human reads. Pure, so it is testable without a terminal. */
export function formatReport(report: ReplayReport): string {
  if (report.total === 0) {
    return "No recorded turns. Run something first — every run records its turns.";
  }
  const lines = [
    `${report.converted} of ${report.total} replies converted (${(report.conversionRate * 100).toFixed(2)}%), ${report.repaired} repaired`,
  ];
  const repairs = Object.entries(report.byRepair).sort(([a], [b]) => (a < b ? -1 : 1));
  if (repairs.length > 0) {
    lines.push("repairs applied");
    for (const [name, count] of repairs) {
      lines.push(`  ${name.padEnd(24)} ${count}`);
    }
  }
  const categories = Object.entries(report.byCategory).sort(([a], [b]) => (a < b ? -1 : 1));
  if (categories.length > 0) {
    lines.push("failures");
    for (const [name, count] of categories) {
      lines.push(`  ${name.padEnd(24)} ${count}`);
    }
  }
  return lines.join("\n");
}

/**
 * Rebuild the conversation of a recorded session.
 *
 * The journal holds decisions, not dialogue -- deliberately, because bodies of
 * model text in it would make every metadata read cost a checkout. The traces
 * hold the dialogue. So a resume reads both: the assistant turns come from the
 * trace's `raw`, and what the tools said back comes from the journal's
 * `action.finished` events, interleaved in sequence.
 *
 * Faithful rather than exact, and worth saying which. The reconstruction
 * produces the same *content* the model saw, not necessarily the same bytes:
 * the observations are re-joined from recorded results rather than replayed
 * verbatim. That is enough to continue a conversation and not enough to claim
 * a byte-identical replay, so it is not claimed.
 */
export function resumeTranscript(
  turns: readonly TraceRecord[],
  observations: readonly string[],
): Array<{ role: "assistant" | "user"; content: string }> {
  const messages: Array<{ role: "assistant" | "user"; content: string }> = [];
  turns.forEach((turn, index) => {
    messages.push({ role: "assistant", content: turn.raw });
    const observation = observations[index];
    if (observation !== undefined) {
      messages.push({ role: "user", content: observation });
    }
  });
  return messages;
}
