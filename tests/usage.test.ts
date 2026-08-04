/**
 * Turn metering: the numbers a report is built from, and the stall signal.
 *
 * Every timing here comes from a clock this file controls. No test sleeps, and
 * no assertion is written as a range or a tolerance -- if a duration were
 * measured against wall time, the only honest assertion would be a loose one,
 * and a loose assertion cannot pin the stall threshold at its boundary, which
 * is the single behaviour most worth pinning.
 */

import { describe, expect, test } from "vitest";
import {
  countCodePoints,
  stallSignal,
  summarize,
  TurnMeter,
  type TurnUsage,
} from "../src/usage.js";

/** A clock the test advances by hand. Milliseconds, like `Date.now`. */
function fakeClock(): { now: () => number; advance: (seconds: number) => void; at: () => number } {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    advance: (seconds: number) => {
      milliseconds += seconds * 1000;
    },
    at: () => milliseconds,
  };
}

function usage(fields: Partial<TurnUsage>): TurnUsage {
  return {
    chars: 0,
    deltas: 0,
    seconds: 0,
    charsPerSecond: 0,
    timeToFirstDeltaSeconds: null,
    ...fields,
  };
}

describe("the injected clock drives every timing", () => {
  test("elapsed time is exactly what the clock was advanced by", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    clock.advance(2);
    meter.delta("hello");
    clock.advance(3);
    const result = meter.finish();

    expect(result.seconds).toBe(5);
    expect(result.timeToFirstDeltaSeconds).toBe(2);
    expect(result.chars).toBe(5);
    expect(result.deltas).toBe(1);
    expect(result.charsPerSecond).toBe(1);
  });

  test("a meter reads nothing but the clock it was given", () => {
    // Freezing the clock proves no internal Date.now() leaks in: a real clock
    // would make these durations non-zero on any machine slow enough to matter.
    const meter = new TurnMeter(() => 1_000_000);

    meter.start();
    meter.delta("abc");
    const result = meter.finish();

    expect(result.seconds).toBe(0);
    expect(result.timeToFirstDeltaSeconds).toBe(0);
  });

  test("time to first delta separates prefill from decode", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    clock.advance(30); // Prompt processing on a loaded server.
    meter.delta("a");
    clock.advance(2); // Decode.
    meter.delta("b");
    const result = meter.finish();

    expect(result.timeToFirstDeltaSeconds).toBe(30);
    expect(result.seconds).toBe(32);
  });

  test("a clock that steps backwards never yields a negative duration", () => {
    // Date.now() is not monotonic; an NTP correction mid-turn must not produce
    // a negative measurement, nor a stall gap that compares as healthy.
    let milliseconds = 10_000;
    const meter = new TurnMeter(() => milliseconds);

    meter.start();
    meter.delta("a");
    milliseconds = 4_000;

    expect(meter.stalledFor(milliseconds)).toBe(0);
    expect(meter.finish().seconds).toBe(0);
  });
});

describe("an unavailable measurement is null, never a fabricated zero", () => {
  test("time to first delta is null when nothing arrives", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    clock.advance(60);
    const result = meter.finish();

    expect(result.timeToFirstDeltaSeconds).toBeNull();
    expect(result.seconds).toBe(60);
    expect(result.deltas).toBe(0);
    expect(result.chars).toBe(0);
  });

  test("a delta arriving before start does not invent a prefill time", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.delta("text");
    clock.advance(4);
    const result = meter.finish();

    // The text still counts; only the prefill measurement is unavailable,
    // because nothing told the meter when the request went out.
    expect(result.chars).toBe(4);
    expect(result.timeToFirstDeltaSeconds).toBeNull();
    expect(result.seconds).toBe(4);
  });

  test("finishing a meter that never started reports zeros, not NaN", () => {
    const result = new TurnMeter(fakeClock().now).finish();

    expect(result).toEqual(usage({}));
    expect(Number.isNaN(result.seconds)).toBe(false);
  });
});

describe("no division by zero anywhere", () => {
  test("a turn with no elapsed time reports zero chars per second", () => {
    const meter = new TurnMeter(() => 0);

    meter.start();
    meter.delta("some text that took no measurable time");
    const result = meter.finish();

    // The raw division would be Infinity here. Infinity does not throw: it
    // propagates into the session totals and wins any "fastest turn" ranking.
    expect(result.charsPerSecond).toBe(0);
    expect(Number.isFinite(result.charsPerSecond)).toBe(true);
  });

  test("an empty turn reports zero chars per second, not NaN", () => {
    const meter = new TurnMeter(() => 0);

    meter.start();
    const result = meter.finish();

    // 0 / 0 is NaN, and a NaN reaching a report reads as a real measurement.
    expect(result.charsPerSecond).toBe(0);
    expect(Number.isNaN(result.charsPerSecond)).toBe(false);
  });

  test("summarizing no turns divides by nothing and returns zeros", () => {
    expect(summarize([])).toEqual({
      turns: 0,
      chars: 0,
      seconds: 0,
      charsPerSecond: 0,
      slowestTurnSeconds: 0,
    });
  });

  test("summarizing turns that took no time returns a finite rate", () => {
    const summary = summarize([usage({ chars: 100 }), usage({ chars: 50 })]);

    expect(summary.charsPerSecond).toBe(0);
    expect(Number.isFinite(summary.charsPerSecond)).toBe(true);
    expect(summary.chars).toBe(150);
  });
});

describe("characters are counted by code point", () => {
  test("an astral character counts as one, not two", () => {
    const meter = new TurnMeter(fakeClock().now);

    meter.start();
    meter.delta("🙂");

    // "🙂".length is 2 -- one surrogate pair -- so `.length` would inflate
    // every rate derived from an emoji-bearing reply.
    expect("🙂".length).toBe(2);
    expect(meter.finish().chars).toBe(1);
  });

  test("mixed text counts each visible character once", () => {
    const text = "ok 🙂 done 𝕏";
    const meter = new TurnMeter(fakeClock().now);

    meter.start();
    meter.delta(text);

    expect(meter.finish().chars).toBe([...text].length);
    expect(meter.finish().chars).toBeLessThan(text.length);
  });

  test("an astral character split across two deltas still counts as one", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);
    const high = "🙂".slice(0, 1);
    const low = "🙂".slice(1);

    meter.start();
    meter.delta(high);
    meter.delta(low);

    // Otherwise the same reply would cost a different number of chars purely
    // because the transport chunked it differently.
    expect(meter.finish().chars).toBe(1);
  });

  test("a stream truncated mid-character still counts what arrived", () => {
    const meter = new TurnMeter(fakeClock().now);

    meter.start();
    meter.delta("hi");
    meter.delta("🙂".slice(0, 1)); // Stream cut between the surrogates.

    expect(meter.finish().chars).toBe(3);
  });

  test("the counter agrees with the string iterator", () => {
    for (const sample of ["", "plain", "🙂", "a🙂b", "𝕏𝕐𝕑", "héllo", "汉字"]) {
      expect(countCodePoints(sample)).toBe([...sample].length);
    }
  });
});

describe("stall detection fires only past the threshold", () => {
  test("a gap exactly at the threshold is not yet a stall", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    meter.delta("a");
    clock.advance(5);

    expect(meter.stalledFor(clock.at())).toBe(5);
    expect(stallSignal(meter, 5, clock.at())).toBe(false);
  });

  test("a gap past the threshold is a stall", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    meter.delta("a");
    clock.advance(5.001);

    expect(stallSignal(meter, 5, clock.at())).toBe(true);
  });

  test("a slow endpoint that keeps emitting is not stalled", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    for (let index = 0; index < 10; index += 1) {
      clock.advance(4);
      meter.delta("x");
    }

    // 40 seconds and 10 characters is slow -- 0.25 chars/s -- but every gap is
    // under the threshold, and slow is not the same failure as stopped.
    expect(stallSignal(meter, 5, clock.at())).toBe(false);
    expect(meter.finish().charsPerSecond).toBe(0.25);
  });

  test("the gap is measured from the last delta, not from the start", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    clock.advance(100);
    meter.delta("a");
    clock.advance(1);

    expect(meter.stalledFor(clock.at())).toBe(1);
    expect(stallSignal(meter, 5, clock.at())).toBe(false);
  });

  test("silence before the first delta is measured from the start", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    clock.advance(30);

    // An endpoint that accepted the request and produced nothing has stopped
    // making progress, whatever it is doing internally.
    expect(meter.stalledFor(clock.at())).toBe(30);
    expect(stallSignal(meter, 20, clock.at())).toBe(true);
  });

  test("an empty keepalive frame does not reset the stall clock", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    meter.delta("a");
    clock.advance(4);
    meter.delta("");
    clock.advance(4);
    meter.delta("");

    // Empty frames are exactly what a stalled server keeps sending; counting
    // them as progress would hold the gap at zero forever.
    expect(meter.stalledFor(clock.at())).toBe(8);
    expect(stallSignal(meter, 5, clock.at())).toBe(true);
    expect(meter.finish().deltas).toBe(1);
  });

  test("a meter that never started cannot be stalled", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    clock.advance(600);

    expect(meter.stalledFor(clock.at())).toBe(0);
    expect(stallSignal(meter, 5, clock.at())).toBe(false);
  });

  test("a finished turn cannot be stalled however long the process lives", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    meter.delta("done");
    meter.finish();
    clock.advance(3600);

    expect(meter.stalledFor(clock.at())).toBe(0);
    expect(stallSignal(meter, 5, clock.at())).toBe(false);
  });
});

describe("a finished turn is frozen", () => {
  test("finishing twice returns the same numbers", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    meter.delta("abc");
    const first = meter.finish();
    clock.advance(120);
    const second = meter.finish();

    // A meter that kept accruing wall time would make a session report depend
    // on when it was rendered.
    expect(second).toEqual(first);
    expect(second.seconds).toBe(0);
  });

  test("starting again clears the previous turn", () => {
    const clock = fakeClock();
    const meter = new TurnMeter(clock.now);

    meter.start();
    meter.delta("first turn text");
    meter.finish();

    meter.start();
    clock.advance(1);
    meter.delta("ab");
    const second = meter.finish();

    expect(second.chars).toBe(2);
    expect(second.deltas).toBe(1);
    expect(second.seconds).toBe(1);
  });
});

describe("session totals aggregate from the totals, not from the rates", () => {
  test("the session rate is total chars over total seconds", () => {
    const summary = summarize([
      usage({ chars: 2, seconds: 1, charsPerSecond: 2 }),
      usage({ chars: 998, seconds: 99, charsPerSecond: 10.08 }),
    ]);

    // The mean of the per-turn rates would be about 6 chars/s, weighting a
    // two-character turn as heavily as a thousand-character one.
    expect(summary.turns).toBe(2);
    expect(summary.chars).toBe(1000);
    expect(summary.seconds).toBe(100);
    expect(summary.charsPerSecond).toBe(10);
  });

  test("the slowest turn is reported, because an average hides the outlier", () => {
    const summary = summarize([
      usage({ seconds: 1 }),
      usage({ seconds: 47 }),
      usage({ seconds: 2 }),
    ]);

    expect(summary.slowestTurnSeconds).toBe(47);
  });

  test("metered turns feed the summary unchanged", () => {
    const clock = fakeClock();
    const turns: TurnUsage[] = [];
    for (const seconds of [1, 3]) {
      const meter = new TurnMeter(clock.now);
      meter.start();
      clock.advance(seconds);
      meter.delta("abcd");
      turns.push(meter.finish());
    }

    const summary = summarize(turns);

    expect(summary.turns).toBe(2);
    expect(summary.chars).toBe(8);
    expect(summary.seconds).toBe(4);
    expect(summary.charsPerSecond).toBe(2);
    expect(summary.slowestTurnSeconds).toBe(3);
  });
});
