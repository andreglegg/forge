/**
 * The two decoders. Both produce a `TurnIntent` and nothing else.
 *
 * They are in one file on purpose: the invariant that matters is that they
 * *agree*, and a reviewer should be able to see both without navigating. The
 * conformance test drives equivalent inputs through each and asserts identical
 * output.
 *
 * Both are incremental. `feed()` may be called with arbitrary chunk boundaries
 * -- a streaming provider will split a SEARCH marker across two deltas -- and
 * `complete` marks the last one. A proposal is only ever emitted once its
 * terminator has been seen, so a truncated turn yields nothing rather than half
 * an edit. Truncation was 100% of the unrecoverable failures in the recorded
 * corpus; applying half of a replacement corrupts a file where dropping it
 * merely wastes a turn.
 */

import {
  type ActionProposal,
  ActionProposal as ActionProposalSchema,
  type TurnIntent,
  toolNamed,
} from "./protocol.js";

/**
 * The block markers, matched tolerantly.
 *
 * Small models get the bracket *direction* wrong routinely -- qwen3-coder-30b
 * opens with `>>>>>>> SEARCH` about as often as `<<<<<<< SEARCH`. The word is
 * what carries the meaning, so the direction and the run length are both
 * accepted and the correction is counted as a repair rather than costing the
 * turn. Being strict here buys nothing: there is no other thing a line reading
 * `>>>>>>> SEARCH` could be.
 */
const SEARCH_MARKER = /^[<>]{3,}\s*SEARCH\s*$/;
const DIVIDER_MARKER = /^={3,}$/;
const REPLACE_MARKER = /^[<>]{3,}\s*REPLACE\s*$/;
const CANONICAL_SEARCH = "<<<<<<< SEARCH";

export interface Codec {
  /** Push a chunk. Returns proposals that became complete with this chunk. */
  feed(chunk: string): ActionProposal[];
  /** Finish. Returns the assembled turn, including any trailing prose. */
  finish(): TurnIntent;
}

// ---------------------------------------------------------------------------
// Text codec
// ---------------------------------------------------------------------------

type Section = "none" | "search" | "replace";

/**
 * SEARCH/REPLACE plus one-line directives.
 *
 * Line-oriented, because that is what makes it robust for a weak model: there
 * is no nesting, no escaping, and a malformed line costs one directive rather
 * than the whole turn.
 */
export class TextCodec implements Codec {
  private buffer = "";
  private prose: string[] = [];
  private readonly proposals: ActionProposal[] = [];
  private readonly repairs = new Set<string>();
  private final: string | null = null;

  // Edit-block assembly state.
  private section: Section = "none";
  private path = "";
  private creating = false;
  private search: string[] = [];
  private replace: string[] = [];

  feed(chunk: string): ActionProposal[] {
    this.buffer += chunk;
    const emitted: ActionProposal[] = [];
    // Only consume up to the last newline: the tail may be a partial line, and
    // a partial `>>>>>>> REPL` must not be mistaken for prose.
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const proposal = this.line(line);
      if (proposal !== null) {
        this.proposals.push(proposal);
        emitted.push(proposal);
      }
      newline = this.buffer.indexOf("\n");
    }
    return emitted;
  }

  finish(): TurnIntent {
    if (this.buffer.length > 0) {
      const proposal = this.line(this.buffer);
      this.buffer = "";
      if (proposal !== null) {
        this.proposals.push(proposal);
      }
    }
    if (this.section !== "none") {
      // An unterminated block is a truncated turn. Recorded as a repair
      // category so the reliability ledger can count it, and dropped.
      this.repairs.add("truncated_edit_block");
    }
    return {
      text: this.prose.join("\n").trim(),
      proposals: this.proposals,
      final: this.final,
      repairs: [...this.repairs].sort(),
    };
  }

  private line(raw: string): ActionProposal | null {
    const trimmed = raw.trim();

    // Inside a block, a nested SEARCH marker means the text being quoted is
    // itself a conflict example -- a merge guide, a README about this very
    // protocol. Such an example is balanced: it opens with SEARCH and ends with
    // REPLACE. Counting depth keeps its inner `=======` and `>>>>>>> REPLACE`
    // as content instead of letting them cut the anchor in half, which used to
    // apply an edit built from the first half and damage the file.
    if (this.section === "search") {
      if (SEARCH_MARKER.test(trimmed)) {
        this.depth += 1;
        this.search.push(raw);
        return null;
      }
      if (this.depth > 0) {
        if (REPLACE_MARKER.test(trimmed)) {
          this.depth -= 1;
        }
        this.search.push(raw);
        return null;
      }
      if (DIVIDER_MARKER.test(trimmed)) {
        this.section = "replace";
        return null;
      }
      this.search.push(raw);
      return null;
    }
    if (this.section === "replace") {
      if (SEARCH_MARKER.test(trimmed)) {
        this.depth += 1;
        this.replace.push(raw);
        return null;
      }
      if (this.depth > 0) {
        if (REPLACE_MARKER.test(trimmed)) {
          this.depth -= 1;
        }
        this.replace.push(raw);
        return null;
      }
      if (REPLACE_MARKER.test(trimmed)) {
        return this.closeBlock();
      }
      this.replace.push(raw);
      return null;
    }

    // A fenced reply is common and harmless; strip the fences rather than
    // treating them as prose the user has to read.
    if (trimmed.startsWith("```")) {
      this.repairs.add("fences");
      return null;
    }
    if (SEARCH_MARKER.test(trimmed)) {
      if (trimmed !== CANONICAL_SEARCH) {
        this.repairs.add("marker_direction");
      }
      if (!this.path) {
        // A block with no EDIT above it names no file. Dropped, and counted.
        this.repairs.add("orphan_search_block");
        return null;
      }
      this.section = "search";
      this.search = [];
      this.replace = [];
      this.depth = 0;
      return null;
    }

    const edit = /^(EDIT|CREATE)\s+(\S.*?)\s*$/.exec(trimmed);
    if (edit) {
      this.path = edit[2] ?? "";
      this.creating = edit[1] === "CREATE";
      return null;
    }
    const done = /^DONE\b\s*(.*)$/.exec(trimmed);
    if (done) {
      this.final = (done[1] ?? "").trim() || "done";
      return null;
    }
    const directive = this.directive(trimmed);
    if (directive !== null) {
      return directive;
    }
    if (DIVIDER_MARKER.test(trimmed) || REPLACE_MARKER.test(trimmed)) {
      // A closing marker with no block open is debris from a malformed reply.
      // It is not prose: showing it to the user is showing them the model's
      // syntax error rendered as if it were an explanation.
      this.repairs.add("stray_marker");
      return null;
    }
    if (trimmed) {
      this.prose.push(raw);
    }
    return null;
  }

  /** `READ x`, `RUN a b c`, ... matched against the registry, not hard-coded. */
  private directive(trimmed: string): ActionProposal | null {
    const match = /^([A-Z]+)\b\s*(.*)$/.exec(trimmed);
    if (!match) {
      return null;
    }
    const name = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();
    const tool = toolNamed(name);
    if (tool === undefined || tool.textForm === undefined) {
      return null;
    }
    const args: Record<string, unknown> =
      name === "run"
        ? { command: splitArgv(rest) }
        : name === "read"
          ? readArguments(rest)
          : name === "grep"
            ? { pattern: rest }
            : name === "glob"
              ? { pattern: rest, path: "." }
              : name === "search" || name === "symbol"
                ? { query: rest, path: "." }
                : name === "list"
                  ? { path: rest || "." }
                  : ["move", "copy", "rename"].includes(name)
                    ? pathPair(rest)
                    : { path: rest };
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      this.repairs.add(`bad_directive:${name}`);
      return null;
    }
    return { kind: "call", tool: name, arguments: parsed.data };
  }

  /** Nested marker depth inside the current block. See `line`. */
  private depth = 0;

  private closeBlock(): ActionProposal | null {
    const search = this.search.join("\n");
    const replace = this.replace.join("\n");
    const path = this.path;
    const create = this.creating || search.trim() === "";
    this.section = "none";
    this.path = "";
    this.creating = false;
    this.depth = 0;
    const candidate = ActionProposalSchema.safeParse({
      kind: "edit",
      path,
      create,
      operations: [{ search, replace }],
    });
    if (!candidate.success) {
      this.repairs.add("invalid_edit_block");
      return null;
    }
    return candidate.data;
  }
}

/**
 * POSIX-ish argv splitting for `RUN`.
 *
 * Quote handling only -- no variable expansion, no operators, no globbing.
 * The result is a token array passed to `spawn` with `shell: false`, so there
 * is nothing for a `;` or a `$(...)` to mean.
 */
function readArguments(text: string): Record<string, unknown> {
  const ranged = /^(.*):(\d+)(?:-(\d+))?$/.exec(text);
  if (ranged === null || !(ranged[1] ?? "").trim()) return { path: text };
  const start = Number.parseInt(ranged[2] ?? "", 10);
  const end = ranged[3] === undefined ? start : Number.parseInt(ranged[3], 10);
  return { path: (ranged[1] ?? "").trim(), start, end };
}

function pathPair(text: string): Record<string, unknown> {
  const arrow = /\s+->\s+/.exec(text);
  if (arrow !== null && arrow.index > 0) {
    const source = text.slice(0, arrow.index).trim();
    const destination = text.slice(arrow.index + arrow[0].length).trim();
    return { source, destination };
  }
  const tokens = splitArgv(text);
  return tokens.length === 2
    ? { source: tokens[0] ?? "", destination: tokens[1] ?? "" }
    : { source: "", destination: "" };
}

export function splitArgv(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
  }
  if (started || current) {
    out.push(current);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Native codec
// ---------------------------------------------------------------------------

/** One streamed native tool-call fragment, provider-normalized. */
export interface NativeDelta {
  readonly text?: string;
  readonly call?: {
    readonly id: string;
    readonly name?: string;
    /** Arguments arrive as a JSON string, in pieces. */
    readonly argumentsDelta?: string;
  };
  readonly finish?: boolean;
}

/**
 * Native tool calls, assembled by call id.
 *
 * A tool call does not exist until its arguments are complete and parse. The
 * provider streams them as JSON fragments, and running against half-parsed
 * arguments is the native-codec equivalent of applying half an edit.
 */
export class NativeCodec {
  private readonly pending = new Map<string, { name: string; args: string }>();
  private readonly order: string[] = [];
  private readonly proposals: ActionProposal[] = [];
  private readonly repairs = new Set<string>();
  private prose = "";
  private final: string | null = null;

  feed(delta: NativeDelta): ActionProposal[] {
    if (delta.text !== undefined) {
      this.prose += delta.text;
    }
    if (delta.call !== undefined) {
      const existing = this.pending.get(delta.call.id);
      if (existing === undefined) {
        this.pending.set(delta.call.id, {
          name: delta.call.name ?? "",
          args: delta.call.argumentsDelta ?? "",
        });
        this.order.push(delta.call.id);
      } else {
        if (delta.call.name) {
          existing.name = delta.call.name;
        }
        existing.args += delta.call.argumentsDelta ?? "";
      }
    }
    // Nothing is emitted mid-stream: a native call is only complete when the
    // provider says the message is.
    return delta.finish === true ? this.drain() : [];
  }

  finish(): TurnIntent {
    if (this.pending.size > 0) {
      this.drain();
    }
    return {
      text: this.prose.trim(),
      proposals: this.proposals,
      final: this.final,
      repairs: [...this.repairs].sort(),
    };
  }

  private drain(): ActionProposal[] {
    const emitted: ActionProposal[] = [];
    for (const id of this.order) {
      const call = this.pending.get(id);
      if (call === undefined) {
        continue;
      }
      this.pending.delete(id);
      const proposal = this.assemble(call.name, call.args);
      if (proposal !== null) {
        this.proposals.push(proposal);
        emitted.push(proposal);
      }
    }
    this.order.length = 0;
    if (this.final === null && emitted.length === 0 && this.prose.trim()) {
      // A native model that stops calling tools and just talks is finished.
      this.final = this.prose.trim();
    }
    return emitted;
  }

  private assemble(name: string, argsText: string): ActionProposal | null {
    let args: unknown;
    try {
      args = JSON.parse(argsText || "{}");
    } catch {
      this.repairs.add("unparseable_native_arguments");
      return null;
    }
    // `edit` is expressed natively as a call, and normalizes to exactly the
    // same EditProposal the text codec builds. This is the whole point of the
    // boundary: one shape, two spellings.
    if (name === "edit") {
      const parsed = ActionProposalSchema.safeParse({ kind: "edit", ...(args as object) });
      if (!parsed.success) {
        this.repairs.add("invalid_native_edit");
        return null;
      }
      return parsed.data;
    }
    const tool = toolNamed(name);
    if (tool === undefined) {
      this.repairs.add(`unknown_native_tool:${name}`);
      return null;
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      this.repairs.add(`invalid_native_arguments:${name}`);
      return null;
    }
    return { kind: "call", tool: name, arguments: parsed.data };
  }
}
