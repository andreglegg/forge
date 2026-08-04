/**
 * Turn accounting: what a turn cost, and whether the endpoint is still moving.
 *
 * Two questions, one state machine, because both are answered from the same
 * three facts -- when the turn started, when the last delta landed, and how
 * much text has arrived.
 *
 * The stall half exists because a local endpoint fails quietly. A saturated
 * llama.cpp server does not close the socket and does not return a 5xx; it
 * holds the stream open and stops emitting. To the `for await` loop in
 * `streamCompletion` that is indistinguishable from a model that is thinking,
 * so the run waits forever with nothing on screen. The only evidence available
 * at this layer is the size of the gap since the last delta, which is why this
 * module measures gaps rather than totals alone.
 *
 * Nothing here rounds. A report rounds for display; a measurement that has
 * already been rounded cannot be re-aggregated without compounding the error.
 */

/** A turn's cost, as measured. All durations are seconds. */
export interface TurnUsage {
  /** Characters by code point. See `countCodePoints`. */
  readonly chars: number;
  /** Non-empty deltas. Empty frames are not progress and are not counted. */
  readonly deltas: number;
  readonly seconds: number;
  readonly charsPerSecond: number;
  /**
   * Prefill: how long the endpoint took to emit anything at all.
   *
   * Kept separate from `seconds` because the two costs have different causes
   * and different fixes. Time to first delta is prompt processing -- it grows
   * with context length and with how much other work the server is doing.
   * The remainder is decode, which is roughly steady per token. On a loaded
   * local server the first is where a turn's wall-clock time actually goes,
   * and a single total hides that completely: a 40s turn that spent 35s in
   * prefill wants a smaller prompt, while one that spent 35s in decode wants
   * a smaller reply. Averaging them into one number answers neither.
   *
   * `null` means the measurement is unavailable, not zero: either no delta
   * arrived, or the meter was never started so there is no instant to measure
   * from. A zero here would read as "instant first token", which is a claim
   * this module has no evidence for.
   */
  readonly timeToFirstDeltaSeconds: number | null;
}

/** Totals across the turns of a session. */
export interface SessionUsage {
  readonly turns: number;
  readonly chars: number;
  readonly seconds: number;
  readonly charsPerSecond: number;
  readonly slowestTurnSeconds: number;
}

/**
 * Characters by code point, not by UTF-16 unit.
 *
 * `"🙂".length` is 2, because JavaScript's `.length` counts UTF-16 units and
 * every astral character -- emoji, CJK extension blocks, most mathematical
 * alphanumerics -- is stored as a surrogate pair. That would not matter if the
 * count were only ever printed, but it is divided: chars-per-second inflates on
 * astral-heavy output, and any chars-per-token ratio derived from `.length` is
 * overstated by however much of the reply was astral. The wrong number is
 * plausible-looking, which is what makes it dangerous.
 *
 * An unpaired surrogate counts as one, matching what the string iterator does.
 * The manual loop exists instead of `[...text].length` because that allocates
 * an array per call and this runs once per delta.
 */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      // A high surrogate followed by a low one is a single code point spelled
      // across two units; skip the low half so the pair is not counted twice.
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

/** True when the final UTF-16 unit is a high surrogate, which can only be unpaired. */
function endsOnLoneHighSurrogate(text: string): boolean {
  if (text.length === 0) return false;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

/**
 * Meters one streamed turn.
 *
 * The clock is a constructor argument and is never read from `Date.now()`
 * inside. Two reasons, and the second is the load-bearing one: a meter that
 * reads a real clock can only be tested by sleeping, which makes the suite slow
 * and flaky in the same change; and the stall threshold is the one number here
 * that must be exercised at its exact boundary, which is impossible to arrange
 * against wall time. There is deliberately no default clock -- a default is how
 * a caller ends up untestable without noticing.
 *
 * The clock returns milliseconds, so `Date.now` and `performance.now` are both
 * drop-in. Outputs are seconds because that is the unit a person reads.
 */
export class TurnMeter {
  private readonly now: () => number;
  private startedAt: number | null = null;
  /** False when the first delta started the clock, which leaves prefill unknowable. */
  private startedExplicitly = false;
  private firstDeltaAt: number | null = null;
  private lastDeltaAt: number | null = null;
  private charCount = 0;
  private deltaCount = 0;
  /**
   * A high surrogate held back from the previous delta.
   *
   * A server may split a stream anywhere, including between the two halves of
   * a surrogate pair. Counting each delta in isolation would then score one
   * emoji as two characters, so the same reply would cost a different number of
   * chars depending on how the transport happened to chunk it -- and a metric
   * that moves with chunking cannot be compared between runs.
   */
  private pendingHighSurrogate = "";
  /** Frozen at the first `finish()`; see `finish`. */
  private settled: TurnUsage | null = null;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Begins (or restarts) a turn, fixing the instant that prefill is measured from. */
  start(): void {
    this.startedAt = this.now();
    this.startedExplicitly = true;
    this.firstDeltaAt = null;
    this.lastDeltaAt = null;
    this.charCount = 0;
    this.deltaCount = 0;
    this.pendingHighSurrogate = "";
    this.settled = null;
  }

  /**
   * Records one streamed delta.
   *
   * An empty string returns without touching anything. Some endpoints emit
   * empty content frames as keepalives, and treating those as progress is
   * precisely backwards: a server sending empty frames while producing no text
   * is the stall this module exists to catch, and counting them would keep the
   * stall clock permanently reset.
   */
  delta(text: string): void {
    if (text === "") return;
    const at = this.now();
    if (this.startedAt === null) {
      // A delta before `start()` is a caller bug, but throwing from a metering
      // path would turn a bookkeeping mistake into a failed turn. Anchor the
      // clock here so no duration comes out negative, and leave
      // `startedExplicitly` false so prefill is reported as unknown rather
      // than as a fabricated zero.
      this.startedAt = at;
    }
    if (this.firstDeltaAt === null) this.firstDeltaAt = at;
    this.lastDeltaAt = at;
    this.deltaCount += 1;

    let counted = this.pendingHighSurrogate + text;
    this.pendingHighSurrogate = "";
    if (endsOnLoneHighSurrogate(counted)) {
      this.pendingHighSurrogate = counted.slice(-1);
      counted = counted.slice(0, -1);
    }
    this.charCount += countCodePoints(counted);
  }

  /**
   * Closes the turn and returns its cost.
   *
   * The result is frozen on the first call and returned unchanged afterwards.
   * A meter that kept accruing wall time after the turn ended would make a
   * session summary depend on when the report was rendered, so two reads of
   * the same finished turn would disagree.
   */
  finish(): TurnUsage {
    if (this.settled !== null) return this.settled;

    // A dangling high surrogate is still a unit of text that arrived; dropping
    // it would silently undercount a truncated stream.
    if (this.pendingHighSurrogate !== "") {
      this.charCount += 1;
      this.pendingHighSurrogate = "";
    }

    const startedAt = this.startedAt;
    if (startedAt === null) {
      this.settled = {
        chars: 0,
        deltas: 0,
        seconds: 0,
        charsPerSecond: 0,
        timeToFirstDeltaSeconds: null,
      };
      return this.settled;
    }

    const seconds = elapsed(startedAt, this.now());
    this.settled = {
      chars: this.charCount,
      deltas: this.deltaCount,
      seconds,
      charsPerSecond: rate(this.charCount, seconds),
      timeToFirstDeltaSeconds:
        this.firstDeltaAt === null || !this.startedExplicitly
          ? null
          : elapsed(startedAt, this.firstDeltaAt),
    };
    return this.settled;
  }

  /**
   * Seconds since the last sign of progress, as of `nowValue`.
   *
   * Shape note: this is an accessor taking the instant explicitly, plus the
   * free `stallSignal` below, rather than a `stallSignal(meter, seconds)` that
   * reads the meter's own clock. Two reasons. A test can then name the instant
   * it is asking about instead of arranging the injected clock to hold the
   * right value at the moment of the call, which is what makes the threshold
   * boundary checkable at all. And callers want the number, not only the
   * verdict: a status line renders "no output for 12s" long before anything
   * decides to give up. The boolean is then a one-line threshold over it.
   *
   * Before the first delta the gap is measured from the start of the turn: an
   * endpoint that accepted a request and has produced nothing is stalled in
   * exactly the way that matters, even though prefill legitimately takes time.
   * The threshold is what accounts for prefill, not the reference point.
   */
  stalledFor(nowValue: number): number {
    // A turn that never started, or that already finished, cannot stall. This
    // is what stops a completed meter left in a list from raising an alarm
    // that grows for as long as the process stays up.
    if (this.startedAt === null || this.settled !== null) return 0;
    return elapsed(this.lastDeltaAt ?? this.startedAt, nowValue);
  }
}

/**
 * Whether the endpoint has stopped making progress, as distinct from being slow.
 *
 * Slow is a low chars-per-second with deltas still arriving. Stalled is no
 * delta at all for longer than the caller is willing to wait, and only the
 * second one is worth interrupting a run over.
 *
 * Strictly greater than the threshold: at exactly `stallSeconds` the endpoint
 * has used its allowance and not yet exceeded it.
 */
export function stallSignal(meter: TurnMeter, stallSeconds: number, nowValue: number): boolean {
  return meter.stalledFor(nowValue) > stallSeconds;
}

/**
 * Totals across a session.
 *
 * The session rate is total chars over total seconds, not the mean of the
 * per-turn rates. Those differ whenever turns differ in length, and the mean of
 * rates weights a two-character turn the same as a two-thousand-character one,
 * which is how a session of mostly tiny turns reports a throughput the endpoint
 * never achieved.
 */
export function summarize(usages: readonly TurnUsage[]): SessionUsage {
  let chars = 0;
  let seconds = 0;
  let slowestTurnSeconds = 0;
  for (const usage of usages) {
    chars += usage.chars;
    seconds += usage.seconds;
    if (usage.seconds > slowestTurnSeconds) slowestTurnSeconds = usage.seconds;
  }
  return {
    turns: usages.length,
    chars,
    seconds,
    charsPerSecond: rate(chars, seconds),
    slowestTurnSeconds,
  };
}

/**
 * Characters per second, or 0 when no time has passed.
 *
 * Never the raw division. `0 / 0` is NaN and `n / 0` is Infinity, and neither
 * one throws -- they propagate through every sum and comparison downstream and
 * surface in a report as if they were measurements. "NaN chars/s" reads as a
 * broken tool; worse, `Infinity` compares as the fastest turn and wins any
 * "best" ranking built on top of this. A zero-length turn produced no
 * observable throughput, so 0 is both safe and true.
 */
function rate(chars: number, seconds: number): number {
  if (seconds <= 0) return 0;
  return chars / seconds;
}

/**
 * Seconds between two clock readings, never negative.
 *
 * `Date.now()` is not monotonic -- an NTP correction or a manual clock change
 * can step it backwards mid-turn -- and a negative duration would print as a
 * negative measurement and make a stall gap compare as healthy forever.
 */
function elapsed(from: number, to: number): number {
  const delta = (to - from) / 1000;
  return delta > 0 ? delta : 0;
}
