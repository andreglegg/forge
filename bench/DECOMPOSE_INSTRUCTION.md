# "Work one file at a time": measured, rejected — 2026-08-04

## Decision

**Do not ship it.** It cost a task, introduced a false success, and lost the one
case it was predicted to help.

## What was tested

A single always-on entry dropped into each task repo's
`.forge/instructions/decompose.md`, riding the existing mechanism in
`src/instructions.ts`. No code change, no protocol-prompt change — the three
sentences were the only variable:

> Work one file at a time. Finish and verify a single file before starting the
> next, rather than composing several files in one reply. When a change is
> larger than one edit, do the smallest useful piece first and build on it.

The idea came from watching a live session fail on "make this 3D" and reasoning
that the model needed to decompose. It sounded obviously right.

## Result (local suite, 15 tasks, 3 trials each)

| | control | candidate |
|---|---|---|
| mean passed | **14.0** / 15 | **13.67** / 15 |
| per trial | 14, 14, 14 | 14, **13**, 14 |
| false successes | **0** | **1** (`09-refactor`) |
| damaged | 2 | 0 |
| turns | 254 | 221 |
| tool calls | 476 | 394 |
| `16-greenfield-tests` | **2 of 3 passed** | **0 of 3 passed** |

## Reading

No single difference here is significant at 3 trials. 14 vs 13.67 is inside
noise, and one false success could be chance. The decision rests on every
indicator pointing the same way with no measured setting where it wins — the
same structure as the task-packet rejection.

The false success carries the most weight. `09-refactor` failed while claiming
success, in an arm where the control had none across 45 task-runs. That is the
failure mode the whole harness exists to prevent.

**The mechanism is the interesting part.** Turns fell 254 -> 221 and tool calls
476 -> 394, so the instruction *did* change behaviour as intended: the model
worked in smaller pieces. It simply made outcomes slightly worse, most plausibly
by stopping short — "one file at a time" reads as permission to finish early.
That the greenfield task, which needs a module *and* its tests, went 2/3 -> 0/3
fits that reading exactly.

## The pattern this belongs to

Three plausible-sounding additions to a small model's context have now been
measured here, and all three lost:

| intervention | result |
|---|---|
| `--task-packet` (feed it the spec) | 22/42 vs 28/27 — `TASK_PACKET.md` |
| 18 turns instead of 12 | 24/42 vs 28/27 — same doc |
| "work one file at a time" | 13.67/15 vs 14.0, +1 false success — this doc |

Every improvement that *has* held was a mechanism rather than guidance: the
verification gate, confirming a pass before believing it, the stall breaker, and
allowing a read-then-replace.

Working hypothesis for the next person: **guidance dilutes, mechanism holds.**
`src/protocol.ts` already records the same thing from a different angle — padding
the protocol prompt by eight lines took a task from 2/3 to 0/3 and raised false
successes from 1 to 6. Treat any "just tell the model to..." idea as needing
evidence before it ships, not after.

## Reproduce

```sh
bin/forge bench bench --name decompose-control --trials 3 --json

cp -R bench /tmp/bench-decompose
for t in /tmp/bench-decompose/*/; do
  mkdir -p "$t/repo/.forge/instructions"
  cp decompose.md "$t/repo/.forge/instructions/"
done
bin/forge bench /tmp/bench-decompose --name decompose-candidate --trials 3 --json
```

## Note on the baseline

The suite is 14/15 on every trial, not 15/15. Which task fails varies —
`12-marker-collision` and `16-greenfield-tests` are each flaky at roughly 1 in 3
— but the total is stable, which makes this a usable instrument: a candidate
scoring 14 is neutral, 13 or 15 is a real shift.

An earlier single-trial run of the 14-task suite scored 14/14 and was reported
as solid. That was true of that run and overstated as a general claim; three
trials show a task failing every time. One run is not a measurement.
