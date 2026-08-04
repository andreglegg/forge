/**
 * Session persistence: a run's event journal on disk.
 *
 * A run is only interesting after it ends -- to show the user what happened, to
 * resume from a committed boundary, to compare two attempts at the same task.
 * All of that needs the journal to outlive the process, so this module is the
 * one place that maps `Journal` to and from a file.
 *
 * The format is one JSON object per line (`.jsonl`), which is not a decorative
 * choice: it is the only serialization that can be *appended to* one event at a
 * time. A run that is killed halfway through must still leave everything it had
 * done on disk, and a JSON array cannot express that -- the closing bracket is
 * written last, so a crashed process leaves a file no parser will accept.
 *
 * Nothing here interprets an event. Summaries come from `replay()`, so a listing
 * and a live run cannot disagree about what a journal means.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDurable, Journal, type RunEvent, replay } from "./runtime.js";

/** Relative to the workspace root, so a session travels with the repository. */
const SESSIONS_SUBDIRECTORY = path.join(".forge", "sessions");
const EXTENSION = ".jsonl";

/** Bounded well under every filesystem's per-component limit. */
const MAX_ID_LENGTH = 128;

/**
 * A session id may become a filename and may arrive from a command line, so it
 * is validated as one. Rejecting `/`, `\` and a leading `.` is what stops
 * `forge replay ../../../etc/passwd` from being a path at all: there is no
 * traversal to normalize away, because a separator is never a legal character.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionSummary {
  readonly id: string;
  readonly task: string;
  readonly turns: number;
  readonly committed: number;
  readonly finished: boolean;
  readonly ok: boolean;
}

export function isSessionId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && SAFE_ID.test(id);
}

/**
 * A new session id: sortable, filesystem-safe, collision-resistant.
 *
 * Both inputs are parameters rather than ambient reads. A function that calls
 * `Date.now()` and `randomBytes()` internally cannot be asserted on, so the
 * property that actually matters -- that a later run always sorts after an
 * earlier one -- becomes untestable and quietly rots.
 *
 * The timestamp is ISO 8601 with `:` and `.` swapped for `-`, because both are
 * hostile in a filename (a drive separator on Windows, an extension boundary
 * everywhere). The layout is fixed-width and zero-padded, so lexicographic
 * order *is* chronological order and listing never has to stat a file.
 *
 * The random discriminator exists because two runs can start in the same
 * millisecond; without it the second one would silently overwrite the first.
 */
export function newSessionId(
  now: Date = new Date(),
  discriminator: string = randomBytes(3).toString("hex"),
): string {
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${stamp}-${discriminator}`;
}

/**
 * One line to one event, or null if the line is not a plausible event.
 *
 * The check is structural (`type` is a string, `seq` is a number) rather than a
 * full zod schema of the `RunEvent` union. Restating that union here would put
 * the authoritative list of event shapes in two files, and the copy would drift
 * the first time `runtime.ts` gains an event -- turning a valid new journal into
 * an unreadable one. Rejecting garbage is this layer's job; knowing every
 * variant is not.
 */
function parseEvent(line: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["type"] !== "string" || typeof record["seq"] !== "number") {
    return null;
  }
  return value as RunEvent;
}

/**
 * Parse a whole journal file, tolerating exactly one kind of damage.
 *
 * A bad *final* line is the expected shape of a crash: the process died between
 * the write of an event and its terminating newline, so the last record is torn.
 * Everything before it is intact and is the whole point of appending as we go --
 * dropping it would throw away the run to save the half-event that ended it.
 *
 * A bad line anywhere *else* is different. It means something other than this
 * store wrote to the file, or the storage handed back garbage; the records after
 * it cannot be trusted to belong to this run, and replaying a subset would show
 * the user a run that never happened. That is a lost session, reported as null,
 * not a silently shortened one.
 */
export function parseJournal(text: string): Journal | null {
  const lines = text.split("\n");
  const events: RunEvent[] = [];
  let sawContent = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") {
      continue;
    }
    sawContent = true;
    const event = parseEvent(line);
    if (event !== null) {
      events.push(event);
      continue;
    }
    const isLastRecord = lines.slice(index + 1).every((rest) => rest.trim() === "");
    if (isLastRecord) {
      break;
    }
    return null;
  }

  // Content that yielded nothing readable is not an empty session -- it is a
  // file whose every line was rejected, which the caller must be told about.
  if (sawContent && events.length === 0) {
    return null;
  }
  const journal = new Journal();
  for (const event of events) {
    journal.append(event);
  }
  return journal;
}

/**
 * Reads and writes journals under `<root>/.forge/sessions/`.
 *
 * ## Why there are two write paths
 *
 * `appendTo` and `save` are not alternatives; they cover different failures and
 * a complete implementation has both.
 *
 * - **`appendTo` is for the run that is still happening.** Each durable event
 *   reaches the disk at the moment it occurs, so a process that is killed,
 *   OOMed, or hits Ctrl-C still leaves every event up to the last completed
 *   write. Nothing else gives that: a store that only wrote at the end would
 *   lose the entire session precisely when the user most wants to know what the
 *   agent did. Its cost is that history is immutable and the tail can be torn,
 *   which `parseJournal` handles.
 *
 * - **`save` is for when an in-memory journal is authoritative.** At the end of
 *   a run, after a resume, or after redacting or compacting a journal, the
 *   correct file is the whole journal rather than a suffix of it -- and
 *   appending cannot remove or repair a line already written. The rewrite is
 *   atomic (temp file, then `renameSync`) because rewriting in place is the one
 *   operation that can destroy a session that was previously fine: a crash
 *   partway through leaves a truncated file where a complete one used to be.
 *   With a rename, a reader sees either the old file or the new one.
 *
 * Practical rule: append during the run, save when you hold the finished
 * journal. Saving after appending is also the repair path -- it replaces a torn
 * tail with the authoritative history.
 *
 * `renameSync` protects against a crashing *process*. It is not an fsync and
 * does not claim to survive power loss; paying an fsync per event would put a
 * disk flush in the run loop, and a session is a record, not a ledger.
 */
export class SessionStore {
  readonly root: string;
  readonly directory: string;

  constructor(root: string) {
    this.root = root;
    this.directory = path.join(root, SESSIONS_SUBDIRECTORY);
  }

  /** Created on first write, so merely constructing a store touches no disk. */
  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true });
  }

  private fileFor(id: string): string {
    if (!isSessionId(id)) {
      throw new SessionError(
        `invalid session id ${JSON.stringify(id)}: expected letters, digits, dot, dash or underscore`,
      );
    }
    return path.join(this.directory, `${id}${EXTENSION}`);
  }

  save(id: string, journal: Journal): void {
    const file = this.fileFor(id);
    this.ensureDirectory();
    const body = journal.serialize();
    // `serialize()` joins with newlines and does not terminate the last one, so
    // a later `appendTo` would splice its event onto the final record and
    // destroy both. The terminator makes the two writers compose.
    const text = body === "" ? "" : `${body}\n`;
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, file);
  }

  appendTo(id: string, event: RunEvent): void {
    // Ephemeral events are dropped here as well as in `Journal.append`, because
    // this path takes a raw event straight off the run's stream and never sees a
    // Journal. `Journal.deserialize` does not filter, so a token delta written
    // here would be resurrected as a durable entry on load and replay would
    // stop matching the run it came from.
    if (!isDurable(event)) {
      return;
    }
    const file = this.fileFor(id);
    this.ensureDirectory();
    appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  }

  /**
   * Null when the session is absent or unreadable, never a throw. A damaged
   * file is one lost session; letting it propagate would take down the listing,
   * and with it every session that is still fine.
   */
  load(id: string): Journal | null {
    if (!isSessionId(id)) {
      return null;
    }
    let text: string;
    try {
      text = readFileSync(path.join(this.directory, `${id}${EXTENSION}`), "utf8");
    } catch {
      return null;
    }
    return parseJournal(text);
  }

  /**
   * Newest first, ordered by id rather than by mtime. The id carries the start
   * time; mtime carries the last *append*, so an old session that resumed would
   * sort ahead of a newer one, and a restored or copied directory would sort by
   * whenever it was copied.
   */
  list(): SessionSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return []; // No directory yet means no sessions, not an error.
    }
    const summaries: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(EXTENSION)) {
        continue; // Skips leftover `.tmp` files from an interrupted save.
      }
      const id = name.slice(0, -EXTENSION.length);
      const journal = this.load(id);
      if (journal === null) {
        continue;
      }
      const state = replay(journal);
      summaries.push({
        id,
        task: state.task,
        turns: state.turn,
        committed: state.committed.length,
        finished: state.done,
        ok: state.ok,
      });
    }
    summaries.sort((a, b) => descending(a.id, b.id));
    return summaries;
  }

  /** Idempotent: deleting a session that is not there is not a failure. */
  delete(id: string): void {
    rmSync(this.fileFor(id), { force: true });
  }
}

function descending(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}
