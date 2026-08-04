# Can Forge build and fix a real project? — 2026-08-04

Three trials with the 30B (`qwen3-coder-30b-a3b`, digest `90169a9caa025170`),
all verified independently rather than by the agent's own report.

## Summary

| trial | result |
|-------|--------|
| Local multi-file suite (14 tasks, existing repo) | **14/14**, 0 false successes, 0 damaged, 233s |
| Greenfield build (empty repo -> working CLI project) | **structure correct, suite broken** — claimed success |
| Bug fix (diagnose its own race, fresh session) | **symptom fixed, root cause missed** — claimed success |

**Verdict: usable for work inside a repo; not yet trustworthy unsupervised on
greenfield projects.** The gap is not code generation — it is that a single
passing test run is accepted as proof.

## Trial 1 — multi-file work in an existing repo

`bin/forge bench bench --name proof-multifile-30b`

14/14 including the hard ones: `07-cross-file` ("the tests fail — find and fix
the bug", no file named), `09-refactor` (extract duplicated validation),
`15-three-files` (thread a new field through type, constructor and index).
`falseSuccesses: 0`, `damaged: 0` — the independent judge found no unearned
success claim and no broken working code. 67 turns, 153 tool calls total.

This is the strongest evidence Forge has for practical use.

## Trial 2 — greenfield build

Empty git repo. Task: a Node ESM CLI todo manager, no dependencies —
`package.json`, `src/store.js`, `src/cli.js`, `bin/todo.js`, and tests in
`test/` using `node:test`.

Forge produced all six files in **14 turns / 62 seconds** (budget was 40 turns,
so turn budget is not the constraint for project creation). It went beyond the
brief and exercised the CLI end to end — `add`, `list`, `done`, `remove`. That
part genuinely works.

**It then reported `ok: true` on a project whose test suite fails.**

The session log shows it did *not* skip verification. It ran a disciplined
edit -> test loop five times and finished on `# pass 6 # fail 0` **after** its
last edit. By its own observation it was green.

The defect: both generated test files read and write the same `todo.json` in the
working directory, and `node --test` runs test *files* in parallel. The suite
races.

| mode | result |
|------|--------|
| `node --test --test-concurrency=1` (serial) | 6 pass, 0 fail |
| `npm test` (parallel, the default) | 5 pass, 1 fail — 3 of 3 runs |

The agent hit a lucky interleaving once; the verification gate accepted it.

## Trial 3 — fix the race, fresh session

Task: "npm test fails. Investigate and fix the root cause so the suite passes
reliably every time. Do not delete or weaken any test."

13 turns, 37 actions, 114s. It edited **only `src/store.js`**, hardening
`loadTasks` against empty and malformed JSON. That is a real robustness
improvement and a correct reading of the crash.

But it fixed the *symptom*, not the cause. Test isolation was never addressed.

| runs | outcome |
|------|---------|
| 6 parallel runs after the fix | **5 pass, 1 still fails (17% flaky)** |
| serial | 6 pass |

It claimed success against a task that explicitly demanded "reliably every
time," while a 1-in-6 failure remained.

## Improvements, ranked by leverage

### 1. Verification must not trust a single run (highest value)

Both false successes have one cause: the gate executes the verifier **once** and
treats a pass as proof. One run cannot distinguish "correct" from "won the race
this time."

This is not only a UX problem. The same gate decides candidate promotion in the
self-improvement loop (CLAUDE.md rules 5-6), so a flaky suite can launder a bad
change into an accepted one.

Cheapest effective change: when a run passes, re-run the verifier N times (2-3)
before accepting, and report *flaky* rather than *pass* on disagreement. Cost is
bounded — it only applies on the success path.

Worth scoping: whether to re-run always, or only when the suite looks
nondeterministic (parallel runner, shared files, no temp dirs).

**Note the nuance:** `falseSuccessAttemptCount` was **0 across all 225** Polyglot
cases. The gate is sound for deterministic suites. It fails specifically where
the project under test is itself flaky — which is exactly the case in greenfield
work, where the agent also authored the tests.

### 2. Bias the retry prompt toward root cause on nondeterministic failure

`retryPrompt` tells the model to "fix the implementation so the tests pass" and
treats the verifier as authoritative. That framing rewards symptom patching —
precisely what trial 3 did. When failure is intermittent, the prompt should say
so and ask for the cause of the *nondeterminism*, not for green tests.

### 3. Teach test isolation via the existing instructions mechanism

**Blocked on measurement until now, and that was the real gap.** Every one of the
14 local tasks edits a repo whose tests already exist, and Polyglot ships tests
with each exercise — so in neither suite does the agent author tests, and
neither could ever score a test-isolation change. The improvement was
unmeasurable, not merely unmeasured.

`16-greenfield-tests` now closes that hole: the agent must write both the module
and its tests, and the judge (a) asserts behaviour independently rather than
trusting `npm test` to mean anything, and (b) runs the agent's suite 3 times and
requires every run to pass. The judge is validated in both directions — it
accepts a correct solution and rejects the exact shared-state defect trial 2
produced.

With that instrument in place the instruction can be measured rather than
assumed. Do measure it: the task-packet result is the cautionary tale.

The agent writes tests that share mutable global state. Forge already has
`.forge/instructions/*.md` with keyword gating (`src/instructions.ts`) — a
short always-on entry ("tests must not share mutable state; use a temp
directory or unique file per test") is a no-code-change intervention.

**Measure it before shipping it.** The task-packet result (`TASK_PACKET.md`) is
the cautionary tale: a well-reasoned context addition cost 6 cases because it
consumed turns. Same class of change, same risk.

### 4. Not a problem: turn budget for greenfield

The build used 14 of 40 available turns and the fix 13 of 25. Project creation
is not turn-starved, so raising the default is not the lever here — consistent
with the 2x2 result that 18 turns scores 24/42 against 28 and 27 at 12.

## Reproduce

```sh
bin/forge bench bench --name proof-multifile-30b --json
bin/forge run "<task>" --repo <empty-git-repo> --yes --json --max-turns 40
```

Artifacts are in the session scratchpad, not committed; the project trial repo
is disposable by design.
