# Using Forge on a real project

Practical guide. What it does well, what it does badly, and how to drive it
without getting hurt. Everything here is backed by measurements in `bench/`.

## 1. Point it at a model

Forge talks to any OpenAI-compatible endpoint and asks `/v1/models` what is
served. Before an interactive, run, plan, or resumed coding session, it also
performs a one-token completion preflight. This catches gateways that advertise
a model whose runtime profile is not actually active.

```sh
export FORGE_URL=http://127.0.0.1:8790/v1      # default
export FORGE_MODEL=qwen3-coder-30b-a3b-instruct-q4_k_m
forge doctor                                    # models, active runtime, verifier
```

Per-project, commit a `forge.json` at the repo root. Named profiles let one
project switch between local models without repeating fragile flags:

```json
{
  "profile": "local-30b",
  "profiles": {
    "local-30b": {
      "url": "http://127.0.0.1:44100/v1",
      "model": "qwen3-coder-30b-a3b-instruct-q4_k_m",
      "contextWindow": 65536,
      "maxTokens": 4096,
      "temperature": 0.1,
      "native": false,
      "maxTurns": 12
    },
    "quick-9b": {
      "url": "http://127.0.0.1:44100/v1",
      "model": "qwen3.5-9b-q4_k_m",
      "contextWindow": 32768,
      "maxTurns": 8
    }
  },
  "verify": [["npm", "test"]]
}
```

Use `forge profiles` to list them and `--profile quick-9b` for a one-run
override. Explicit CLI flags and `FORGE_URL` / `FORGE_MODEL` win over profiles.
Legacy top-level `url` and `model` keys remain supported below profiles in the
precedence order.

`verify` is worth setting explicitly. Forge auto-detects a test command, but
naming it removes the guess — and the verifier is what stops a confident wrong
finish.

**Model size matters more than anything else you will configure.** Measured on
the pinned 42-case screen: 7B **4.8%**, 14B **11.9-14.3%**, 30B-MoE
**64-67%**. There is a cliff, not a gradient. Below roughly 30B-MoE capability
the harness runs correctly and still loses, because orchestration cannot rescue
a model that does not emit compiling code. See `bench/MODEL_SCALING.md`.

## 2. Drive it

```sh
forge                          # interactive, in the current directory
forge run "<task>"             # one shot, exits 0 on success
forge run "<task>" --yes       # approve workspace effects (CI, batch)
forge run "<task>" --yes --isolate
                               # clean detached worktree; original unchanged
forge run "<task>" --yes --isolate --promote
                               # verify, conflict-check, then apply the patch
forge plan "<task>"            # read/search and return a plan; no effects
forge run "<question>" --read-only
forge continue [id]            # reopen interactive chat with retained history
forge doctor                   # provider/model/verifier health
forge init                     # create forge.json from detected checks
forge config --json            # resolved project/profile/provider settings
forge profiles                 # list named local-model profiles
forge sessions                 # what has been run here
forge show <id>                # replay a recorded session
forge undo [id]                # put back what a session changed
```

Useful in-chat: `/context` (what went into the last prompt, and what just
missed), `/verify` (the verification command it detected), `/replay`,
`/approvals`.

At an approval prompt: enter or `a` applies, `always` approves that kind for the
session, anything else skips. `plan` and `read-only` are capability restrictions
inside the Run actor: `--yes`, native tool calls, and malformed model output
cannot bypass them.

For automation, `--json` writes one final document. `--stream-json` writes one
JSON object per durable Run event and ends with a `{"type":"result",...}` record.
Do not combine the two modes.

## 3. What it is good at

| task | evidence |
|------|----------|
| implement a function against existing tests | 60.0% on 225-case Polyglot (`bench/POLYGLOT_FULL225.md`) |
| small multi-file edits in an existing repo | **14/14** on the local suite, 0 false successes, 0 damaged |
| find and fix a bug with no file named | included in that 14/14 (`07-cross-file`) |
| refactor with behaviour preserved | included (`09-refactor`) |
| thread a field through several files | included (`15-three-files`) |

This is the sweet spot: **a repo that already exists, with tests that already
exist.** Give it a task at that scale and it is genuinely useful.

## 4. What it is bad at, concretely

**Greenfield projects, unsupervised.** It will build the thing — a from-scratch
CLI project took 14 turns and 62 seconds, correct structure, working commands.
Then it reported success on a suite that failed. It had written two test files
sharing one JSON file, and `node --test` runs files in parallel, so the suite
raced and it won the race once. Full account in `bench/PROJECT_TRIAL.md`.

**Root causes, when a symptom is easier.** Asked to fix that race, it hardened
JSON parsing — a real improvement at the wrong layer — and left 1 run in 6
failing, against a task that said "reliably every time."

**Anything long-horizon or architectural.** Nothing measured here requires
deciding *what* to build. Do not assume it transfers.

## 5. How to actually use it safely

1. **Prefer `--isolate` for headless changes.** It requires the selected path
   to be the Git root and completely clean, including untracked files. The run
   happens in a detached temporary worktree and leaves a patch under
   `.forge/isolated/`. Add `--promote` only when you want a successful verified
   run applied after HEAD, cleanliness, and `git apply --check` are revalidated.
   This protects repository mutations, not the host from repository scripts.
2. **Set `verify` in `forge.json`.** A run with no verification command reports
   that it could not verify rather than pretending — but you get far more from
   a real command.
3. **Read the diff.** Its self-report is not evidence. The one measured failure
   mode that matters is a confident wrong finish, and the defence is your eyes.
4. **Prefer many small tasks to one large one.** The 14/14 tasks are all
   single-purpose. Nothing suggests a 10-step request behaves as well.
5. **Re-run your tests yourself after it finishes.** Since 2026-08-04 the
   completion gate re-runs a passing suite to confirm it (`bench/PROJECT_TRIAL.md`),
   but your suite is yours.

## 6. A first test run

```sh
cd ~/some/project
git switch -c forge-trial
# commit or stash every tracked and untracked change first

forge run "add <one small, well-specified thing>" --yes --isolate
cat .forge/isolated/*.patch    # inspect the retained patch; checkout unchanged

forge run "add <one small, well-specified thing>" --yes --isolate --promote
git diff                       # read the promoted result
npm test                       # your tests, not its claim

forge undo                     # if you dislike a promoted session
```

Then try interactive `forge` for something exploratory, and use `/context` when
an answer looks like it missed a file — that shows what was in the prompt and
what just missed the budget.

## 7. Reading the numbers honestly

The 42-case screen has **±5 cases of run-to-run variance** on an unchanged
system (observed 28, 27, 23). Treat any single 42-case difference smaller than
that as noise; the 225-case number is the one with a confidence bound on it.

Two interventions have been measured and **rejected**, both of which sounded
obviously good beforehand:

- `--task-packet` (feed the model the spec) — `bench/TASK_PACKET.md`
- raising the turn budget to 18 — same doc

That is the house style: measure, then decide. Plausibility has lost twice.
