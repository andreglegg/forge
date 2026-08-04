# Forge handoff

**To use Forge on a project, read `USING_FORGE.md`.** This file is the
engineering state.

## Where things stand

| what | result | evidence |
|------|--------|----------|
| Aider Polyglot, 225 cases | **135/225 = 60.00%**, +14.44 pp over Little Coder's published 45.56%, one-sided exact binomial `p=9.5e-06`, 95% lower bound 54.33% | `bench/POLYGLOT_FULL225.md` |
| Paired vs Little Coder, pinned 42 | **28/42** and **27/42** vs **19/42** (`p=0.012`, `p=0.008`) | same |
| Local suite (15 tasks, 3 trials) | **14/15** every trial, 0 false successes | `bench/DECOMPOSE_INSTRUCTION.md` |
| Greenfield build | works, then over-reports | same |
| Model scaling | 7B 4.8% / 14B 11.9-14.3% / 30B-MoE 64-67% | `bench/MODEL_SCALING.md` |
| Tests | 197 pass, 1 skip | `npm run check` |

## Measurement discipline (read before running an experiment)

**The 42-case screen has +/-5 cases of run-to-run variance.** Observed on an
unchanged system: **28, 27, 23**. Any single 42-case difference smaller than
that is noise. This was learned late, and it weakens — without overturning —
score-gap arguments made earlier from 42-case runs. Prefer the mechanism
(turn counts, flip asymmetry, failure classes) over the score gap, or use the
full 225.

**Guidance dilutes; mechanism holds.** Three plausible additions to the model's
context have been measured and all three lost (`bench/DECOMPOSE_INSTRUCTION.md`
has the table). Every improvement that held was a mechanism instead: the
verification gate, confirming a pass before believing it, the stall breaker,
allowing a read-then-replace. Treat any "just tell the model to..." idea as
needing evidence before it ships.

Interventions measured and **rejected**, all of which sounded obviously right
beforehand:

- **`--task-packet`** (feed the model the exercise spec): 22/42 vs 28/27. The
  diagnosis was correct — 0 of 59 attempts ever opened `.docs/instructions.md`,
  and `transpose` fails in all four languages that ship it — but it loses by
  **turn exhaustion** and only reaches parity when given more turns. Keep off.
  Do **not** re-add spec discovery to `src/instructions.ts`; that was tried and
  reverted (duplicates `taskPacketItems`, breaks `tests/cli-context.test.ts:49`).
- **18 turns instead of 12**: 24/42 vs 28/27. Mildly negative. Keep 12.
- **"work one file at a time"** as an always-on instruction: 13.67/15 vs 14.0
  and a false success the control never had. It did change behaviour (turns 254
  -> 221) — it just made outcomes worse, most plausibly by stopping short.
  `bench/DECOMPOSE_INSTRUCTION.md`.

Both in `bench/TASK_PACKET.md`.

## Landed since the last handoff

- `feat(verify): confirm a pass before believing it` — the completion gate
  re-runs a *passing* suite (`VERIFY_CONFIRMATIONS = 2`) and reports
  `flaky: true` when the pass does not reproduce, phrased to the model as
  nondeterminism rather than a broken build. Failing suites are never re-run,
  so cost is bounded; measured on the pinned 42 it cost **no** wall-clock.
- `bench: add a greenfield task that scores determinism` —
  `bench/16-greenfield-tests`. The agent writes the module *and* its tests; the
  judge asserts behaviour independently and runs the suite 3 times.

### Why that gate change exists

A greenfield trial produced a project whose two test files shared one JSON file.
`node --test` runs files in parallel, so the suite raced, passed once, was
accepted, and failed 1 run in 6 afterwards. The gate had run the verifier once
and treated a pass as proof. It also guards candidate promotion, so an
unconfirmed pass could launder a bad change into an accepted one.

Regression check: `forge-verifyconfirm-42-v1` scored 23/42. **Not attributable
to the change** — zero FLAKY verdicts fired in the whole run, and all three
consistently-lost cases ended `turns=12, claimed=false`, i.e. never reached
verification. That run is effectively a third baseline sample, which is where
the +/-5 variance figure above comes from.

## Open, in rough priority order

1. **Test-isolation instruction.** The agent writes tests that share mutable
   state. `src/instructions.ts` supports always-on entries, so this needs no
   code. Measure it against `16-greenfield-tests` — that task exists precisely
   because neither Polyglot nor the old local suite could score it.
2. **Retry weakness.** The second attempt recovered 13 of 103 first-attempt
   failures on the full run, and nothing at all in java.
3. **Second full-225 replication**, if a two-replication gate matters for
   publication.
4. **Little Coder at 7B/14B is unmeasured.** "Forge beats Little Coder" is
   established at 30B only. At 4.8% and ~13% neither is a usable agent, so a
   42-case comparison there would be underpowered; the full 225 would be needed.

## Constraints

- `bin/forge` exits 2 when any `src/**/*.ts` is newer than `dist/**/*.js`, and a
  fresh `bin/forge run` is spawned per benchmark case. **Editing `src/` during a
  run fails every remaining case.** Check `pgrep -f 'forge polyglot'` first.
  Docs are always safe. Run `npm run build` after any source change.
- **One benchmark suite per GPU.** Runs are GPU-bound (A40 at 100% while the
  host sat at 5/11 cores). Sharing inflates timeouts, and timeouts score as
  failures — contention manufactures bad results.
- Changing a run's endpoint fails with "Polyglot run identity differs". Correct
  guard; use a new name or delete the stale directory.
- Benchmark output lives under `.forge/`, which `.gitignore` excludes. Distil
  into `bench/*.md` or it is lost.
- Local ports 8791/8792 hold long-lived `/tmp/fakemodel*.mjs` stubs answering
  `{"model":"scripted"}`. **Assert the model id after opening any tunnel.**
- The only unrelated worktree item is `../uv.lock`; do not add or modify it.

## Infrastructure

- Pod `forge-30b-c` (A40) serves the 30B on 43829, plus 14B on 44101 and 7B on
  44102, reached via SSH tunnel to `127.0.0.1:8790`. **Billing at ~$0.49/hr.**
- Pod `forge-14b-b` (A40, eu-se) was created for the 14B and **stopped**.
- `runpodctl user` for balance; `runpodctl pod stop <id>` when idle. An idle pod
  cost ~$3.70 during this work — stop pods when a run finishes.
