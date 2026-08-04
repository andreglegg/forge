# Task packet (`--task-packet`): measured, rejected — 2026-08-03

> **Variance caveat, added 2026-08-04.** A later run of the *unchanged* system
> on this same 42-case screen scored 23/42, giving an observed baseline spread of
> 28 / 27 / 23. A 5-6 case gap on 42 cases is therefore near the edge of normal
> run-to-run variation, and the score comparisons below are weaker than they
> first appear. What survives is the **mechanism** — every lost case pinned at
> exactly the 12-turn cap after finishing in 5-7 turns, and 18 turns recovering
> 5 while losing 0 — plus the fact that no measured setting shows the packet
> winning. The decision stands; the confidence in the raw score gap does not.

## Decision

**Do not enable `--task-packet` by default.** It is harmful at the default turn
budget and merely neutral when given enough turns. There is no measured setting
in which it wins.

## Background

`src/cli.ts:491` `taskPacketItems()` injects `.docs/introduction.md`,
`.docs/instructions.md` and `.docs/instructions.append.md` — the student-facing
exercise specification — into the initial context. It is gated behind
`--task-packet` and defaults to off.

The motivating observation was strong: all 225 exercises ship a specification,
0 of 59 attempts ever opened one, and `transpose` failed in **all four**
languages that ship it (predicted for python in advance, and confirmed). The
diagnosis — the model cannot infer rules stated only in prose — was correct.
The intervention still lost.

## The 2x2 (30B, pinned 42 cases, paired)

| | 12 turns | 18 turns |
|-----------|---------------|--------------|
| packet off | **28**, **27** | **24** (clean re-run) |
| packet on  | **22**         | **27**       |

Paired exact McNemar on the identical case list:

| comparison | discordant | p |
|------------|-----------|---|
| packet on: 18 turns vs 12 turns | 5 gained, **0 lost** | 0.0625 |
| packet on @18 vs control @12 (v1) | 2 vs 3 | 1.0000 |
| packet on @18 vs control @12 (v2) | 3 vs 3 | 1.0000 |

## Mechanism: turn exhaustion, not context displacement

The first hypothesis — that the spec evicts source files from the context
budget — was **wrong**, and checking it directly is what found the real cause.
Measured with the built `taskContext` on a lost case:

```
packet=false  chars=3124/24000  dropped=0
packet=true   chars=4562/24000  dropped=0
```

Nothing is evicted; the budget is 19% used.

The real mechanism is visible in the turn counts. Every case that flipped
pass -> fail ran to the 12-turn cap, having finished comfortably without the
spec:

| case | turns (control -> packet) | actions |
|------|---------------------------|---------|
| javascript/affine-cipher | 5 -> 12 | 4 -> 29 |
| python/zipper | 5 -> 12 | 13 -> 22 |
| cpp/zebra-puzzle | 6 -> 12 | 12 -> 4 |
| go/tree-building | 7 -> 12 | 17 -> 25 |

The specification enumerates edge cases; the model tries to handle all of them;
a fixed budget converts the extra exploration into failure. Raising the budget
to 18 turns recovers **5 cases and loses 0** — as clean a confirmation as this
sample size allows.

But recovery only restores parity: packet-on @18 (27) is indistinguishable from
packet-off @12 (28, 27), p = 1.0 both ways. The spec buys exploration that costs
turns and returns nothing net.

Flip asymmetry says the same thing. Of the 24 cases passing both controls, 5
were lost; of the 11 failing both controls, **0** were gained.

## Caveat on the packet-off / 18-turn arm

`forge-turns18-42-v1` recorded **14 timeouts**, against 0-2 for every other run.
It executed while three benchmark suites shared one A40, and the contention
inflated per-case latency past the verifier timeouts. Its 27/42 was a floor, not
a measurement. The clean re-run `forge-turns18-42-v2` (1 timeout) scored
**24/42**.

**Raising the turn budget is not a free win — it is mildly negative.** Paired
against the 12-turn controls: 0 wins for 18 turns vs 4 for 12 (`p=0.125`), and 1
vs 4 (`p=0.375`). Not significant, but consistently directional with no hint of
upside: more turns give the model more opportunity to damage code that already
worked. Keep the default at 12.

This arm does not affect the decision above (which rests on the packet-on
comparisons, both of which had 1-2 timeouts). It matters for a **separate**
question worth answering on its own: whether raising the default turn budget is
a free win independent of the packet.

**Lesson for future runs: never share a GPU across concurrent benchmark suites.**
Timeouts are scored as failures, so resource contention silently manufactures
them.

## Reproduce

```sh
bin/forge polyglot .forge/datasets/polyglot-benchmark --name <name> \
  --per-language 7 [--task-packet] [--first-turns 18] \
  --model-digest 90169a9caa025170 --jobs 2
```

`--per-language 7` is deterministic and evenly spaced; it reproduces the pinned
42-case selection in `polyglot-paired-42.txt` exactly.

## What was NOT done, and why

An earlier attempt added spec discovery to `src/instructions.ts`. It was
written test-first, then **reverted**: it duplicated `taskPacketItems` and broke
`tests/cli-context.test.ts:49`, which deliberately asserts the default packet
excludes the spec. No source change was needed to answer this question — it was
a configuration measurement, per CLAUDE.md rule 5.
