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
| Tests | **419 pass, 3 skip** | `npm run check` on 2026-08-05 |
| This session's changes, paired 42 | **27/42 → 28/42, McNemar p=1.000 — no measurable difference** | `bench/PAIRED_42_SESSION_CHANGES.md` |
| Dogfood build, 10 sessions, 14B | 6 harness defects found and fixed, incl. a false success | `bench/DOGFOOD_LEDGER.md` |

**A pass-rate screen cannot measure a completion-honesty change.** The session
that added the no-change rule, named-deliverable check, and retry budgets
measured them paired on the 42: p=1.000, and the rules fired on 1 of 42 cases
between them. That is structural, not bad luck -- every Polyglot case starts
with a failing test, so "committed nothing and the suite is still green" is
unreachable, and the prompts name files by absolute path, which the deliverable
check excludes by construction. Those changes claim no score gain. Measuring
that class of change needs a suite whose cases can be satisfied by doing
nothing, which does not exist yet.

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

The TypeScript product has moved from a benchmark harness toward a public-alpha
developer tool. Recent committed slices include release packaging, provider
preflight and product commands, permission modes, JSONL events, durable resume,
Git-worktree isolation and verified promotion, named model profiles,
evidence-preserving compaction, promotion risk scanning, and explicit bounded
headless lifecycle hooks.

Three slices landed on top of that, each with tests and a green `npm run check`:

**Bounded retry (`src/retry.ts`).** `recovery.ts` classified failures but nothing
consumed the classification, so a model that could not repair a failure
re-reported completion every turn until the turn cap, paying a full suite run
each time. The budget is per class -- four for syntax/type/test, two for
flaky/unknown, one for timeout/toolchain/infrastructure, matching what each
class's directive already tells the model. A failure whose command and
normalized output repeat identically three times stops the run before any budget
runs out. `gate()` now returns its report alongside its objection so the caller
can budget against what failed; hook refusals and the no-test read-back path stay
unbudgeted, since neither is a verification failure. Exhausting a budget leaves
`code = 1` and calls `run.fail`, so a stopped run cannot promote (`result.ok`
gates promotion) and cannot be read as success.

One bug worth remembering: the no-progress signature was clipped *after* joining
command and output, so a long inline `node -e` verification command filled the
bound by itself and every failure hashed identical. Found by the CLI-level test,
not the unit tests. The bound is now per run's output.

**Execution backends (`src/backend.ts`).** The gap worktrees left: a worktree
contains repository mutations, but the verification suite is arbitrary project
code the model can edit, and it ran on the host. A backend decides *where*;
`exec.ts` still decides how. The container backend is a command transform, not a
second executor -- it builds `docker run`/`podman run` argv and hands it to the
same `execBounded`, so timeout, group kill, merged output and clipping have one
implementation. Repository mounted at `/workspace`, `--network none` unless
asked, no host path variables (forwarding PATH/HOME/TMPDIR into an image
replaces working container defaults with host paths that do not exist there),
`--rm --init`, invoking uid under Docker only (rootless podman maps it already).
A timed-out container is force-removed, because killing the client does not stop
it. Selected by `--sandbox`/`--image`/`--sandbox-network` or `execution` in
`forge.json`; a runtime without an image is a hard error before provider
preflight, never a silent host fallback. Covers model `run`, the gate, and
focused verification; benchmarks, hooks, and Git stay on the host deliberately.

**Event contract (`src/contract.ts`).** `--stream-json` was the surface a client
would build on and had no version. Runs now emit a `contract` record as the
first line, before anything that can fail, the `--json` result carries the same
version, and `forge contract` prints it without a run or a repository.
Major.minor: minor is additive and unknown events must be skipped, major must be
refused. The event registry is checked against the `RunEvent` union in
`runtime.ts` by a test, so adding an event without registering it fails the
suite.

Not verified here: the two real-container tests skip when no runtime is present,
and this machine had none. They run wherever Docker or Podman exists.

**Then Forge was pointed at a real build** -- ten headless sessions against a
14B, building a small ledger library -- which found six defects the unit suite
could not. The worst: a run that committed nothing exited 0 with `ok: true`,
because the pre-existing suite was green and a green suite was read as evidence
of work. That is the false-success failure mode this project treats as the most
dangerous one, and it was structural rather than a slip. Also fixed: an
unrecoverable directory/file confusion, a deadlock between the read-before-edit
and unchanged-read guards, `Cannot find module` on a repository path
misclassified as a toolchain failure, a repetition guard that dropped the
reason, and a failed SEARCH anchor that carried no hint. All six are in
`bench/DOGFOOD_LEDGER.md` with the observed transcripts, and each was reproduced
as a test before being fixed. The before/after there is n=1 per row and is not
a measured improvement.

The earlier recovery slice, unchanged:

- `src/recovery.ts` classifies failures as syntax, type, test, timeout, toolchain, infrastructure, flaky, or unknown.
- Classification is deterministic and based only on retained command metadata and bounded output; it never executes code or asks a model to classify its own failure.
- `formatForModel` names the detected class and appends exactly one bounded recovery directive.

### Historical verification-gate context

The completion gate still re-runs a *passing* suite
(`VERIFY_CONFIRMATIONS = 2`) and reports `flaky: true` when the pass does not
reproduce. A greenfield trial had produced two test files sharing one JSON file;
`node --test` ran them in parallel, one pass was accepted, and the suite later
failed 1 run in 6. Confirmation prevents that pass from laundering a bad change.

## Open, in product-plan order

1. **Container backend hardening.** Resource limits (CPU, memory, process count,
   disk) and read-only host mounts; the current backend bounds time and output
   only. The real-container tests need a run on a machine that has a runtime.
2. **Retry budgets under measurement.** The budgets are reasoned from each
   class's directive, not measured. Whether they help, hurt, or do nothing on
   the 225 is unknown -- and per the discipline below, a plausible-sounding
   number is exactly the kind of thing that has lost before. Mechanism first:
   the run no longer burns twelve turns on an unrepairable failure, which is
   true regardless of score.
3. **The server on top of the contract.** The contract versions the stream;
   there is still no server. Then IDE clients, MCP, and a small permissioned
   extension API.
4. **Benchmark follow-up.** The second full-225 replication and current Little
   Coder comparison remain useful, but no new product slice should claim a score
   gain without paired evidence.

## Constraints

- `bin/forge` exits 2 when any `src/**/*.ts` is newer than `dist/**/*.js`, and a
  fresh `bin/forge run` is spawned per benchmark case. **Editing `src/` during a
  run fails every remaining case.** Check `pgrep -f 'forge polyglot'` first.
  Docs are always safe. Run `npm run build` after any source change.
- **One benchmark suite per GPU.** Runs are GPU-bound (A40 at 100% while the
  host sat at 5/11 cores). Sharing inflates timeouts, and timeouts score as
  failures — contention manufactures bad results. The local-dev bridge currently
  denies `pgrep`, so process checks must use an allowed repository command or be
  reported as unavailable; do not bypass the bridge.
- Changing a run's endpoint fails with "Polyglot run identity differs". Correct
  guard; use a new name or delete the stale directory.
- Benchmark output lives under `.forge/`, which `.gitignore` excludes. Distil
  into `bench/*.md` or it is lost.
- Local ports 8791/8792 hold long-lived `/tmp/fakemodel*.mjs` stubs answering
  `{"model":"scripted"}`. **Assert the model id after opening any tunnel.**
- The only unrelated worktree item is the untracked repository-root `uv.lock`;
  do not add or modify it.

## Infrastructure

- Pod `forge-30b-c` (A40) serves the 30B on 43829, plus 14B on 44101 and 7B on
  44102, reached via SSH tunnel to `127.0.0.1:8790`. **Billing at ~$0.49/hr.**
- Pod `forge-14b-b` (A40, eu-se) was created for the 14B and **stopped**.
- `runpodctl user` for balance; `runpodctl pod stop <id>` when idle. An idle pod
  cost ~$3.70 during this work — stop pods when a run finishes.
