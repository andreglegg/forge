/**
 * The run actor: one writer, a typed event journal, and a command channel.
 *
 * Why an actor rather than an async generator that yields events and receives
 * decisions through `.next(value)`:
 *
 * - Approval has to flow *back* into the run. Bidirectional generators can do
 *   that, but the machinery is awkward and the failure is silent.
 * - Ending iteration on a generator cancels the run. A renderer that stops
 *   reading should never kill the work.
 * - There is more than one consumer: the TUI, the journal, a session recorder,
 *   a test. Generator consumers *compete* for values; observers must not.
 *
 * So: commands in through `send()`, events out through `events()` (an async
 * iterable, fannable to any number of subscribers), and one state machine that
 * is the only writer.
 *
 * Durable domain events are journalled. Token deltas are *not* -- they are
 * ephemeral presentation signals, coalesced and droppable under backpressure.
 * Journalling them would bloat the log by three orders of magnitude and make
 * replay meaningless, because a replay reconstructs decisions, not typing.
 */

import type { ActionProposal } from "./protocol.js";
import { describeProposal, mutates } from "./protocol.js";
import { MAX_REPOSITORY_READ_CHARS } from "./repository.js";
import type { EntryType, MutationOperation, Preview, Workspace } from "./workspace.js";

// ---------------------------------------------------------------------------
// Events and commands
// ---------------------------------------------------------------------------

export type RunEvent =
  | { type: "run.started"; seq: number; task: string }
  | { type: "turn.started"; seq: number; turn: number }
  /** Ephemeral: never journalled, safe to drop. */
  | { type: "model.delta"; seq: number; text: string }
  | { type: "model.text"; seq: number; text: string }
  | { type: "action.proposed"; seq: number; id: string; summary: string; proposal: ActionProposal }
  | {
      type: "approval.requested";
      seq: number;
      id: string;
      summary: string;
      preview: Preview | null;
    }
  | { type: "approval.resolved"; seq: number; id: string; decision: Decision }
  | { type: "action.started"; seq: number; id: string; summary: string }
  | { type: "action.finished"; seq: number; id: string; ok: boolean; output: string }
  | {
      type: "mutation.committed";
      seq: number;
      id: string;
      path: string;
      added: number;
      removed: number;
      /**
       * sha256 of the content this mutation replaced, or null for a creation.
       * The bytes live in the object store; this is what undo restores from,
       * and it is the same hash the stale-proposal check already needed.
       */
      beforeRevision: string | null;
      /**
       * sha256 of the content this mutation committed, or null when it deleted
       * the file. Optional only so journals written by older Forge versions
       * remain readable; unsafe legacy undo is refused by the CLI.
       */
      afterRevision?: string | null;
      /** Rich metadata for first-class filesystem operations. Optional for legacy journals. */
      operation?: MutationOperation;
      entryType?: EntryType;
      beforeMode?: number | null;
      afterMode?: number | null;
      action?: Preview["kind"];
      rootPath?: string;
      destinationPath?: string;
    }
  | { type: "run.finished"; seq: number; ok: boolean; summary: string }
  | { type: "run.reopened"; seq: number; reason: string }
  /**
   * Verification is a durable fact, not a print statement.
   *
   * It used to be written straight to stdout by the caller while the event
   * subscriber was still draining, so the line appeared *above* the approval
   * and commit it followed -- two writers, one stream, and a log that lied
   * about the order things happened in. Going through the same stream as
   * everything else fixes the ordering and puts it in the journal, where
   * `forge show` can replay it.
   */
  | { type: "verification.started"; seq: number; commands: readonly string[] }
  | { type: "verification.finished"; seq: number; passed: boolean; detail: string }
  | { type: "run.failed"; seq: number; reason: string }
  | { type: "run.cancelled"; seq: number };

export type Decision = "once" | "always" | "deny";

/** One action's outcome, returned to the caller rather than observed. */
export interface ActionResult {
  readonly id: string;
  readonly ok: boolean;
  readonly output: string;
}

export interface TurnResult {
  readonly results: ActionResult[];
  readonly finished: boolean;
  /**
   * The run has produced no action for several turns running and should stop.
   *
   * Distinct from `finished`, which means the work is done. This means the
   * opposite: nothing is happening and continuing would only spend the
   * remaining turn budget discovering that again.
   */
  readonly stalled?: boolean;
}

/**
 * Consecutive actionless turns tolerated before a run is declared stalled.
 *
 * Two, not one: a single reply that says only "let me look at the file" is
 * ordinary and self-corrects. Two in a row is a loop -- in the case this exists
 * for it ran eighteen times.
 */
const STALL_LIMIT = 2;

/**
 * `Omit` over a union collapses it to the keys every member shares, which for
 * `RunEvent` is just `type` and `seq`. Distributing first keeps each member's
 * own fields, so `emit({type: "action.started", id, summary})` typechecks
 * against the right variant instead of against their intersection.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EmittedEvent = DistributiveOmit<RunEvent, "seq">;

export type RunCommand = { type: "approve"; id: string; decision: Decision } | { type: "cancel" };

/** Presentation-only events, excluded from the journal. */
const EPHEMERAL = new Set<RunEvent["type"]>(["model.delta"]);

export function isDurable(event: RunEvent): boolean {
  return !EPHEMERAL.has(event.type);
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * Append-only, in memory, with a `replay` that reconstructs run state.
 *
 * Resume is always from a *committed boundary*. A partial model response is an
 * abandoned artifact, not resumable computation: the tokens are gone, the
 * provider will not continue them, and pretending otherwise produces a run that
 * believes it said something it did not.
 */
export class Journal {
  private readonly entries: RunEvent[] = [];

  append(event: RunEvent): void {
    if (isDurable(event)) {
      this.entries.push(event);
    }
  }

  all(): readonly RunEvent[] {
    return this.entries;
  }

  serialize(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  static deserialize(text: string): Journal {
    const journal = new Journal();
    for (const line of text.split("\n")) {
      if (line.trim()) {
        journal.entries.push(JSON.parse(line) as RunEvent);
      }
    }
    return journal;
  }
}

/** The state a journal reduces to. Pure, so replay and live agree by construction. */
export interface RunState {
  readonly task: string;
  readonly turn: number;
  readonly committed: Array<{ path: string; added: number; removed: number }>;
  readonly pendingApproval: string | null;
  readonly done: boolean;
  readonly ok: boolean;
  readonly summary: string;
  readonly cancelled: boolean;
}

export function initialState(): RunState {
  return {
    task: "",
    turn: 0,
    committed: [],
    pendingApproval: null,
    done: false,
    ok: false,
    summary: "",
    cancelled: false,
  };
}

export function reduce(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "run.started":
      return { ...state, task: event.task };
    case "turn.started":
      return { ...state, turn: event.turn };
    case "approval.requested":
      return { ...state, pendingApproval: event.id };
    case "approval.resolved":
      return { ...state, pendingApproval: null };
    case "mutation.committed":
      return {
        ...state,
        committed: [
          ...state.committed,
          { path: event.path, added: event.added, removed: event.removed },
        ],
      };
    case "run.finished":
      return { ...state, done: true, ok: event.ok, summary: event.summary };
    case "run.reopened":
      // Not done after all. The summary is kept so a reader can see what was
      // claimed alongside what contradicted it.
      return { ...state, done: false, ok: false };
    case "run.failed":
      return { ...state, done: true, ok: false, summary: event.reason };
    case "run.cancelled":
      return { ...state, done: true, ok: false, cancelled: true, summary: "cancelled" };
    default:
      return state;
  }
}

export function replay(journal: Journal): RunState {
  return journal.all().reduce(reduce, initialState());
}

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

/**
 * A multi-subscriber event bus with per-subscriber buffering.
 *
 * Each subscriber gets its own queue, so a slow renderer cannot stall the run
 * and cannot steal events from another subscriber. Ephemeral events are dropped
 * for a subscriber whose queue is over the high-water mark; durable ones never
 * are, because losing an `approval.requested` would deadlock the run.
 */
class EventBus {
  private readonly subscribers = new Set<{
    queue: RunEvent[];
    resolve: ((value: IteratorResult<RunEvent>) => void) | null;
    closed: boolean;
  }>();

  private static readonly HIGH_WATER = 1024;

  publish(event: RunEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      if (subscriber.resolve !== null) {
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve({ value: event, done: false });
        continue;
      }
      if (subscriber.queue.length >= EventBus.HIGH_WATER && !isDurable(event)) {
        continue; // Backpressure: drop presentation noise, never a decision.
      }
      subscriber.queue.push(event);
    }
  }

  close(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      if (subscriber.resolve !== null) {
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve({ value: undefined, done: true });
      }
    }
  }

  subscribe(): AsyncIterable<RunEvent> {
    const subscriber = {
      queue: [] as RunEvent[],
      resolve: null as ((value: IteratorResult<RunEvent>) => void) | null,
      closed: false,
    };
    this.subscribers.add(subscriber);
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<RunEvent>> => {
          const queued = subscriber.queue.shift();
          if (queued !== undefined) {
            return Promise.resolve({ value: queued, done: false });
          }
          if (subscriber.closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            subscriber.resolve = resolve;
          });
        },
      }),
    };
  }
}

/**
 * Standing approvals, scoped to an action class.
 *
 * Owned by the *session* rather than by one run: a user who says "always allow
 * edits" means for as long as they are sitting there, not until their next
 * message. Passed in so the interactive front end can share one across every
 * turn while a headless run gets a fresh one.
 */
export class ApprovalPolicy {
  private readonly always = new Set<string>();

  allows(actionClass: string): boolean {
    return this.always.has(actionClass);
  }

  allowAlways(actionClass: string): void {
    this.always.add(actionClass);
  }

  granted(): string[] {
    return [...this.always].sort();
  }
}

export interface Effects {
  readonly workspace: Workspace;
  /**
   * Optional capability gate evaluated before preview, approval, or execution.
   * Returning a reason refuses the action even when auto-approval is enabled.
   */
  readonly authorize?: (proposal: ActionProposal) => string | null;
  /** Executes a tool call that has no workspace preview/commit implementation. */
  readonly runTool: (proposal: ActionProposal) => Promise<{ ok: boolean; output: string }>;
  /**
   * Keeps the bytes a mutation replaced and returns their hash, so the change can
   * be undone later. Optional: a caller that does not want an undo history --
   * a test, an ephemeral sandbox -- simply does not supply it, and the events
   * record `null` rather than a hash pointing at nothing.
   */
  readonly retain?: (content: string | Buffer) => string;
}

/**
 * JSON with sorted keys, so `{path, start}` and `{start, path}` are one
 * proposal, not two. Every guard below counts by this key; insertion-order
 * stringify would let key order split the counts and quietly disable them.
 */
/** Bounded, so a large file cannot crowd the prompt out of its own budget. */
function clip(text: string, limit = 4000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… truncated …`;
}

function mutationResult(preview: Preview): string {
  switch (preview.kind) {
    case "delete":
      return `deleted ${preview.path}. The path no longer exists.`;
    case "mkdir":
      return `created directory ${preview.path}.`;
    case "move":
      return `moved ${preview.source ?? preview.path} to ${preview.destination ?? "the destination"}.`;
    case "copy":
      return `copied ${preview.source ?? preview.path} to ${preview.destination ?? "the destination"}.`;
    case "edit":
      return `applied ${preview.path}. It now contains:\n\n${clip(preview.after)}`;
  }
}

/** The repository path a mutating proposal targets, or "" if it names none. */
function mutationPathOf(proposal: ActionProposal): string {
  if (proposal.kind === "edit") return proposal.path;
  const target = proposal.arguments["path"];
  return typeof target === "string" ? target : "";
}

function canonicalKey(proposal: ActionProposal): string {
  const render = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(render).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${render(v)}`).join(",")}}`;
  };
  return render(proposal);
}

/**
 * The loop guard: what makes a small model terminate instead of burning the
 * step budget. Three rules, each from a measured failure mode, each *precise*
 * rather than absolute:
 *
 * - An exact read range at a revision already read is refused with advice --
 *   but another range of the same large file remains legitimate, and a
 *   mutation changes the revision. (The first live qwen-30b run demonstrated
 *   the need: turns 4 and 5 were identical re-reads of an unchanged file.)
 * - An identical proposal repeated more than three times is refused.
 * - A proposal that failed is refused unchanged until some mutation lands,
 *   because against an unchanged repository it will fail identically.
 */
class LoopGuard {
  private readonly readActions = new Set<string>();
  private readonly completeReadRevisions = new Set<string>();
  private readonly counts = new Map<string, number>();
  /** Keyed by action, valued by *why* it failed -- see `recordFailure`. */
  private readonly failed = new Map<string, string>();
  /** Paths whose next re-read is legitimate; see `allowReadAgain`. */
  private readonly readAgain = new Set<string>();

  check(proposal: ActionProposal, workspace: Workspace): string | null {
    const key = canonicalKey(proposal);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    const previousReason = this.failed.get(key);
    if (previousReason !== undefined) {
      // The reason is repeated, not just the fact. A live run met a directory
      // where it wanted a file and was told only "this already failed" four
      // times running; the one message that would have unstuck it -- what was
      // actually wrong -- was thrown away after the first attempt.
      return `This exact action already failed and nothing has changed since: ${previousReason} Change the arguments or take a different approach.`;
    }
    if (count > 3) {
      return `This exact action has been proposed ${count} times. Do something different.`;
    }
    if (proposal.kind === "call" && proposal.tool === "read") {
      const target = String(proposal.arguments["path"] ?? "");
      const revision = workspace.revision(target);
      if (revision !== null) {
        const revisionKey = `${target}@${revision}`;
        const start = proposal.arguments["start"];
        const end = proposal.arguments["end"];
        const rangeKey = `${typeof start === "number" ? start : ""}-${typeof end === "number" ? end : ""}`;
        const readActionKey = `${revisionKey}:${rangeKey}`;
        if (this.readActions.has(readActionKey)) {
          // Consumed, not merely checked: this excuses one re-read, so a model
          // that keeps asking without acting still meets the guard.
          if (this.readAgain.delete(target)) return null;
          return `${target}${rangeKey === "-" ? "" : `:${rangeKey}`} has not changed since you read that exact range; use another range or act on the contents above.`;
        }
      }
    }
    return null;
  }

  /**
   * Permit one repeat read of `target`, even at an unchanged revision.
   *
   * Used where the harness itself took away the model's look at a file -- it
   * refused an edit for arriving alongside its read -- so that complying is a
   * legal move rather than the second half of a deadlock.
   */
  allowReadAgain(target: string): void {
    if (target !== "") this.readAgain.add(target);
  }

  /** Record only a read the tool actually completed successfully. */
  recordReadSuccess(proposal: ActionProposal, workspace: Workspace): void {
    if (proposal.kind !== "call" || proposal.tool !== "read") return;
    const target = String(proposal.arguments["path"] ?? "");
    const revision = workspace.revision(target);
    if (revision === null) return;
    const revisionKey = `${target}@${revision}`;
    const start = proposal.arguments["start"];
    const end = proposal.arguments["end"];
    const rangeKey = `${typeof start === "number" ? start : ""}-${typeof end === "number" ? end : ""}`;
    this.readActions.add(`${revisionKey}:${rangeKey}`);
    const bytes = workspace.byteSize(target);
    if (
      start === undefined &&
      end === undefined &&
      bytes !== null &&
      bytes <= MAX_REPOSITORY_READ_CHARS
    ) {
      this.completeReadRevisions.add(revisionKey);
    }
  }

  /**
   * Whether the model has read this complete file as it currently stands.
   *
   * The signal that separates a considered whole-file replacement from a blind
   * clobber. Ranged or clipped reads do not count, and a read recorded against
   * an older revision does not count: the model must have seen every byte it is
   * about to replace.
   */
  hasReadCurrent(target: string, workspace: Workspace): boolean {
    const revision = workspace.revision(target);
    return revision !== null && this.completeReadRevisions.has(`${target}@${revision}`);
  }

  recordFailure(proposal: ActionProposal, reason = ""): void {
    this.failed.set(canonicalKey(proposal), reason.trim());
  }

  /**
   * A mutation invalidates prior failures *and* prior repeat counts: the world
   * changed, so an action that was pointless a moment ago may now be exactly
   * right. Counting without this is how a model that has just edited a file
   * gets refused permission to look at the result.
   */
  recordMutation(): void {
    this.failed.clear();
    this.counts.clear();
    this.readAgain.clear();
  }
}

/**
 * One run.
 *
 * Deliberately does not own the model loop -- `submit()` is driven by whatever
 * produces turns, so a scripted codec, a real provider and a replayed journal
 * all exercise the same state machine.
 */
export class Run {
  private readonly bus = new EventBus();
  readonly journal = new Journal();
  private seq = 0;
  private state = initialState();
  private readonly pending = new Map<string, (decision: Decision) => void>();
  private readonly guard = new LoopGuard();
  private cancelled = false;
  private counter = 0;
  /** Consecutive turns that produced no action. Reset by any action at all. */
  private stalls = 0;

  constructor(
    private readonly effects: Effects,
    /** Auto-approve everything. For headless and CI, never the default. */
    private readonly autoApprove = false,
    /** Shared across a chat session, so "always" outlives one message. */
    private readonly policy: ApprovalPolicy = new ApprovalPolicy(),
  ) {}

  events(): AsyncIterable<RunEvent> {
    return this.bus.subscribe();
  }

  snapshot(): RunState {
    return this.state;
  }

  send(command: RunCommand): void {
    if (command.type === "cancel") {
      this.cancelled = true;
      // Release anything waiting, so the run unwinds instead of hanging.
      for (const [, resolve] of this.pending) {
        resolve("deny");
      }
      this.pending.clear();
      return;
    }
    const resolve = this.pending.get(command.id);
    if (resolve === undefined) {
      return; // A decision for an action that is no longer pending is a no-op.
    }
    this.pending.delete(command.id);
    resolve(command.decision);
  }

  private emit(event: EmittedEvent): void {
    this.seq += 1;
    const full = { ...event, seq: this.seq } as RunEvent;
    this.journal.append(full);
    this.state = reduce(this.state, full);
    this.bus.publish(full);
  }

  start(task: string): void {
    this.emit({ type: "run.started", task });
  }

  /** Presentation only. Never journalled. */
  delta(text: string): void {
    this.emit({ type: "model.delta", text });
  }

  /**
   * Process one decoded turn: propose, approve, commit, report.
   *
   * Mutating proposals are handled one at a time and strictly in order. A
   * second edit to the same file must see the first one's result, and running
   * them concurrently would make the base-revision check meaningless.
   *
   * **Returns the results.** The caller must not reconstruct them by watching
   * the event stream: subscribers are asynchronous, so an array they populate
   * has not necessarily been filled when `await submit(...)` returns. That
   * exact race shipped once and was not theoretical -- the next turn was built
   * with "No action was taken" in place of the file the model had just read,
   * and qwen3-coder-30b duly invented file contents that had never existed.
   * Events are for *observing*; this return value is the causal result.
   */
  async submit(turn: {
    text: string;
    proposals: ActionProposal[];
    final: string | null;
    /** Decoder repairs for this turn. `truncated_edit_block` is the one that matters here. */
    repairs?: readonly string[];
  }): Promise<TurnResult> {
    this.emit({ type: "turn.started", turn: this.state.turn + 1 });
    if (turn.text) {
      this.emit({ type: "model.text", text: turn.text });
    }

    // A turn with nothing to do and nothing to report is the silent stall. Say
    // what went wrong -- the decoder already knows -- rather than letting the
    // model retry the identical oversized edit until the budget runs out.
    if (turn.proposals.length === 0 && turn.final === null) {
      this.stalls += 1;
      const truncated = turn.repairs?.includes("truncated_edit_block") === true;
      // Role confusion, and worth its own message: telling a model that
      // answered its own read to "send an action" does not tell it that the
      // file contents it just invented were never real.
      const fabricated = turn.repairs?.includes("hallucinated_tool_result") === true;
      const results: ActionResult[] = [];
      this.report(results, {
        id: `stall${this.stalls}`,
        ok: false,
        output: truncated
          ? "Your edit was cut off before it finished, so nothing could be applied: the change was larger than one reply can hold. Do not resend it. Make a smaller, targeted edit that quotes only the few lines that actually change, or build the result across several edits. For a whole-file rewrite, write a new file instead."
          : fabricated
            ? "That reply was the *result* of a tool call, not a tool call. You wrote out what you expected to see, including file contents that were never read -- treat none of it as true. Send the action itself on its own line, for example: READ package.json"
            : "That reply contained no action, so nothing happened. Send an action -- a read, a command, or an edit -- or report the task complete.",
      });
      if (this.stalls >= STALL_LIMIT) {
        this.emit({
          type: "run.finished",
          ok: false,
          summary: truncated
            ? "stopped: the same oversized edit was truncated on every attempt, so no change could be applied"
            : "stopped: several replies in a row contained no action",
        });
        return { results, finished: false, stalled: true };
      }
      return { results, finished: false };
    }
    this.stalls = 0;

    // A turn that both looks and mutates wrote its anchor blind: the model
    // composed the edit before it had seen the file it is editing. Observed
    // live against qwen3-coder-30b, which emitted `READ temperature.js` and a
    // SEARCH/REPLACE block in one reply; the read succeeded and the edit's
    // anchor did not exist. The reads are run, the mutations are deferred with
    // that reason, and the next turn writes the anchor from real content.
    const looksFirst = turn.proposals.some((proposal) => !mutates(proposal));
    const results: ActionResult[] = [];
    let sawObservation = false;
    let failedThisTurn = false;
    let committedThisTurn = false;

    for (let proposal of turn.proposals) {
      if (this.cancelled) {
        this.emit({ type: "run.cancelled" });
        return { results, finished: false };
      }
      this.counter += 1;
      const id = `a${this.counter}`;
      const summary = describeProposal(proposal);
      this.emit({ type: "action.proposed", id, summary, proposal });

      const authorizationFailure = this.effects.authorize?.(proposal) ?? null;
      if (authorizationFailure !== null) {
        this.report(results, { id, ok: false, output: authorizationFailure });
        failedThisTurn = true;
        continue;
      }

      if (looksFirst && sawObservation && mutates(proposal)) {
        // Deferring this edit costs the model its only look at the file, so
        // the re-read it will almost certainly ask for next is unblocked here.
        // Without that, the two guards deadlock: this one refuses the edit for
        // arriving with a read, and the unchanged-range guard then refuses the
        // read that would let the model comply. Observed live, and the largest
        // single consumer of turns in the session that surfaced it.
        this.guard.allowReadAgain(mutationPathOf(proposal));
        this.report(results, {
          id,
          ok: false,
          output:
            "You proposed this change in the same reply as a read, so it was written before you had seen the file. The result of the read is below. Send the change now, quoting the real text.",
        });
        failedThisTurn = true;
        continue;
      }

      // CREATE over an existing file is how a model spells "replace this
      // wholesale", and it is the only spelling that fits in one reply: a
      // SEARCH/REPLACE has to quote the original as well as its replacement.
      // Refusing it outright cost a live session eighteen turns. Allow it
      // exactly when the model has read the file as it now stands.
      if (proposal.kind === "edit" && proposal.create) {
        const exists = this.effects.workspace.revision(proposal.path) !== null;
        if (exists && !this.guard.hasReadCurrent(proposal.path, this.effects.workspace)) {
          this.report(results, {
            id,
            ok: false,
            output: `${proposal.path} already exists. Read the complete file first, then send this again to replace it wholesale. For a large or ranged file, use an anchored EDIT for only the part that changes.`,
          });
          failedThisTurn = true;
          continue;
        }
        if (exists) {
          proposal = { ...proposal, create: false, rewrite: true };
        }
      }

      const refusal = this.guard.check(proposal, this.effects.workspace);
      if (refusal !== null) {
        // Refused before approval, so the user is never asked about an action
        // that would be pointless, and the model gets advice instead of a
        // silent rerun.
        this.report(results, { id, ok: false, output: refusal });
        failedThisTurn = true;
        continue;
      }

      let preview: Preview | null = null;
      if (
        proposal.kind === "edit" ||
        (proposal.kind === "call" &&
          ["delete", "mkdir", "move", "copy", "rename"].includes(proposal.tool))
      ) {
        try {
          preview = this.previewMutation(proposal);
        } catch (error) {
          // A mutation that cannot be previewed cannot be approved. The reason
          // goes back to the model, which is how it corrects the target -- and
          // is retained, so a repeat of the same action repeats the reason.
          const reason = error instanceof Error ? error.message : String(error);
          this.guard.recordFailure(proposal, reason);
          failedThisTurn = true;
          this.report(results, {
            id,
            ok: false,
            output: reason,
          });
          continue;
        }
      }

      const decision = await this.decide(id, proposal, summary, preview);
      this.emit({ type: "approval.resolved", id, decision });
      if (decision === "deny") {
        failedThisTurn = true;
        this.report(results, {
          id,
          ok: false,
          output: "The user declined this action. Do something else or ask why.",
        });
        continue;
      }

      this.emit({ type: "action.started", id, summary });
      if (preview !== null) {
        // Retain destructive inputs before commit. Content-addressed orphan
        // blobs are harmless; deleting data and only then discovering that the
        // undo store is unavailable is not.
        const retainedRevisions = new Map<string, string | null>();
        try {
          for (const [relative, bytes] of preview.retained) {
            retainedRevisions.set(relative, this.effects.retain?.(bytes) ?? null);
          }
        } catch (error) {
          failedThisTurn = true;
          this.report(results, {
            id,
            ok: false,
            output: `could not retain undo data, so the mutation was not applied: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        try {
          this.effects.workspace.commit(preview);
        } catch (error) {
          failedThisTurn = true;
          this.report(results, {
            id,
            ok: false,
            output: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        this.guard.recordMutation();
        committedThisTurn = true;
        // Each entry receives its own event so move/copy trees can be undone in
        // exact reverse order without relying on Git or text-only snapshots.
        for (const change of preview.changes) {
          const retainedRevision = preview.retained.has(change.path)
            ? (retainedRevisions.get(change.path) ?? null)
            : change.beforeRevision;
          this.emit({
            type: "mutation.committed",
            id,
            path: change.path,
            added: change.added,
            removed: change.removed,
            beforeRevision: retainedRevision,
            afterRevision: change.afterRevision,
            operation: change.operation,
            entryType: change.entryType,
            beforeMode: change.beforeMode,
            afterMode: change.afterMode,
            action: preview.kind,
            rootPath: preview.path,
            ...(preview.destination === undefined ? {} : { destinationPath: preview.destination }),
          });
        }
        this.report(results, { id, ok: true, output: mutationResult(preview) });
        continue;
      }
      const result = await this.effects.runTool(proposal);
      if (!result.ok) {
        this.guard.recordFailure(proposal, result.output);
        failedThisTurn = true;
      } else {
        this.guard.recordReadSuccess(proposal, this.effects.workspace);
        sawObservation = true;
      }
      this.report(results, { id, ok: result.ok, output: result.output });
    }

    if (turn.final === null) {
      return { results, finished: false };
    }
    // A model does not get to declare victory in a turn whose own actions
    // failed. Observed live: the edit's anchor did not match, and the very
    // next reply was "Added fahrenheitToCelsius ... exported like the existing
    // function" -- with the file untouched. A false success is worse than a
    // failure, because nothing downstream ever checks again.
    if (failedThisTurn && !committedThisTurn) {
      this.report(results, {
        id: "final",
        ok: false,
        output:
          "You reported the task as done, but the action in that same reply failed and nothing changed. Fix the failure first; do not report completion until the change is actually applied.",
      });
      return { results, finished: false };
    }
    this.emit({ type: "run.finished", ok: true, summary: turn.final });
    return { results, finished: true };
  }

  private previewMutation(proposal: ActionProposal): Preview {
    if (proposal.kind === "edit") return this.effects.workspace.preview(proposal);
    const args = proposal.arguments;
    if (proposal.tool === "delete") {
      return this.effects.workspace.previewDelete(String(args["path"] ?? ""));
    }
    if (proposal.tool === "mkdir") {
      return this.effects.workspace.previewMkdir(String(args["path"] ?? ""));
    }
    const source = String(args["source"] ?? "");
    const destination = String(args["destination"] ?? "");
    if (proposal.tool === "copy") {
      return this.effects.workspace.previewCopy(source, destination);
    }
    if (proposal.tool === "move" || proposal.tool === "rename") {
      return this.effects.workspace.previewMove(source, destination);
    }
    throw new Error(`the ${proposal.tool} tool is not a previewed filesystem mutation`);
  }

  /** Emit an action result and record it for the caller in one place. */
  private report(results: ActionResult[], result: ActionResult): void {
    results.push(result);
    this.emit({ type: "action.finished", id: result.id, ok: result.ok, output: result.output });
  }

  /**
   * Withdraw a completion the run had accepted.
   *
   * Emitted when something outside the model contradicts its claim -- the
   * project's own verification failing is the case this exists for. The
   * `run.finished` already in the journal stays there, because it is a fact
   * about what happened; this records that it was retracted and why, so a
   * replay shows the disagreement rather than a clean success followed
   * inexplicably by more turns.
   */
  reopen(reason = "verification disagreed with the reported completion"): void {
    this.emit({ type: "run.reopened", reason });
  }

  /** Announce verification through the event stream, in order with everything else. */
  verifying(commands: readonly string[]): void {
    this.emit({ type: "verification.started", commands });
  }

  verified(passed: boolean, detail = ""): void {
    this.emit({ type: "verification.finished", passed, detail });
  }

  fail(reason: string): void {
    this.emit({ type: "run.failed", reason });
  }

  close(): void {
    this.bus.close();
  }

  /**
   * Ask, unless the answer is already known.
   *
   * "Always" is scoped to an action *class* for the session, not to everything:
   * approving one `edit` must not silently approve every `run`. A read-only
   * action is never asked about at all -- consent for reading is the decision
   * to start the run.
   */
  private async decide(
    id: string,
    proposal: ActionProposal,
    summary: string,
    preview: Preview | null,
  ): Promise<Decision> {
    if (!mutates(proposal)) {
      return "once";
    }
    const klass =
      proposal.kind === "edit"
        ? "edit"
        : ["delete", "mkdir", "move", "copy", "rename"].includes(proposal.tool)
          ? `filesystem:${proposal.tool}`
          : `run:${proposal.tool}`;
    if (this.autoApprove || this.policy.allows(klass)) {
      return "once";
    }
    this.emit({ type: "approval.requested", id, summary, preview });
    const decision = await new Promise<Decision>((resolve) => {
      this.pending.set(id, resolve);
    });
    if (decision === "always") {
      this.policy.allowAlways(klass);
    }
    return decision;
  }
}
