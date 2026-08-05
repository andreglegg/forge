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
| Tests | **319 pass, 1 skip** | `npm run check` on 2026-08-05 |

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

The current working slice adds revision-bound TypeScript/JavaScript declaration and syntax-reference intelligence:

- `src/symbols.ts` uses a pinned TypeScript 5.9 compiler API while Forge itself
  remains compiled with TypeScript 7.
- `SYMBOL <name>` has text/native parity and reports exact top-level declarations
  plus named class/interface/enum members with line/column ranges, export status,
  and the revision of the parsed source.
- `REFERENCES <name>` has text/native parity and reports exact AST identifier use
  sites outside declaration positions, excluding comments and strings.
- Symbol scans share repository visibility rules and are bounded to 10,000
  supported files, 512 KiB per file, and 100 returned declarations.
- The parser runtime is lazy-loaded only when `SYMBOL` executes, so ordinary
  parallel CLI runs do not pay its startup and memory cost.
- This is syntax indexing, not a language server: semantic aliases, inferred
  types, overload identity, scope-aware callers, package imports, path aliases,
  and package exports remain explicitly unsupported.
- A scripted provider test proves the full tool loop on a 221-file deep project.
- `npm run check` passes 319 tests with one intentional pty skip. The focused
  symbol/protocol suite passes 52 tests.

### Historical verification-gate context

The completion gate still re-runs a *passing* suite
(`VERIFY_CONFIRMATIONS = 2`) and reports `flaky: true` when the pass does not
reproduce. A greenfield trial had produced two test files sharing one JSON file;
`node --test` ran them in parallel, one pass was accepted, and the suite later
failed 1 run in 6. Confirmation prevents that pass from laundering a bad change.

## Open, in product-plan order

1. **Semantic caller resolution and dependency-backed context selection.** Use
   exact declarations, syntax references, and bounded dependency evidence to
   distinguish true callers and automatically select relevant context.
2. **Change-impact analysis and focused verification planning.** Map run-mutated
   paths to packages, inbound dependency closure, and candidate tests while
   preserving the authoritative full completion gate.
3. **Failure-class-specific recovery.** Replace generic retry prompting with
   bounded strategies for syntax, type, test, timeout, infrastructure, and
   no-progress failures.
4. **Execution-backend interface and optional Docker/Podman isolation.** Current
   worktrees isolate repository mutations only; commands still run on the host.
5. **Versioned server/event contract**, followed by IDE clients, MCP, and a small
   permissioned extension API.
6. **Benchmark follow-up.** The second full-225 replication and current Little
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
