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

`verify` is worth setting explicitly. Forge auto-detects npm, pnpm, Yarn, Bun,
Python, Rust, and Go root checks; for JavaScript projects it prefers a root
`check` script and falls back to `test`. Naming the commands still removes the
guess — and the verifier is what stops a confident wrong finish. Monorepo checks
can safely select a package without a shell:

```json
{
  "verify": [
    ["cd", "packages/api", "&&", "pnpm", "test"],
    ["cd", "apps/web", "&&", "pnpm", "check"]
  ]
}
```

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
session, anything else skips. Text edits, each filesystem verb, and commands are
separate approval classes. `plan` and `read-only` are capability restrictions
inside the Run actor: `--yes`, native tool calls, and malformed model output
cannot bypass them.

For automation, `--json` writes one final document. `--stream-json` writes one
JSON object per durable Run event and ends with a `{"type":"result",...}` record.
Do not combine the two modes.

`forge serve` serves that same stream bidirectionally over stdio for a client
that spawns the process: the contract header is the first line and now
advertises the accepted request types, then the client submits NDJSON requests —
`{"type":"run.start","task":...}`, `{"type":"approve","id":...,"decision":
"once"|"always"|"deny"}`, `{"type":"cancel"}`, `{"type":"shutdown"}` — and runs
execute serially through the same orchestration, permission modes, gate, and
session journals as `forge run`. Without `--yes`, approvals are resolved by the
client's `approve` request instead of being auto-denied. Malformed or unknown
requests get an error envelope and never affect an active run; client disconnect
denies pending approvals, cancels the active run, and exits nonzero.

Headless lifecycle hooks are explicit opt-in repository code. Define token-array
commands under `hooks.sessionStart`, `hooks.beforeVerify`, `hooks.afterVerify`,
and `hooks.sessionEnd`, then add `--hooks` to `forge run` or `forge plan`.
Hooks execute sequentially with no shell, a scrubbed environment, bounded output,
and a 60-second timeout. Failures block the run or final exit and appear in JSON
results. Inspect hook commands before enabling them; they can execute arbitrary
repository-controlled programs.

## 3. How Forge sees a real project

Forge indexes the complete bounded repository instead of stopping at a shallow
200-file listing. Git repositories use tracked plus non-ignored untracked paths;
non-Git directories use a bounded recursive walk. The task starts with a compact
map of top-level areas and important manifests, then the model can navigate with:

```text
LIST packages/api
GLOB **/*.test.ts
GREP RequestHandler
SEARCH exact literal text
RELATED packages/api/src/server.ts
SYMBOL RequestHandler
READ packages/api/src/server.ts:120-220
```

`LIST` is one directory level. Glob and search operate over paths at any depth.
`RELATED` reports a TypeScript/JavaScript file's nearest package root, direct
relative dependencies, inbound dependents, and nearby tests. When a task explicitly names a code-shaped symbol, Forge automatically includes matching declaration, direct caller, syntax-reference, and one-hop dependency files under the normal context budget. Automatic pre-turn semantic analysis is capped at 200 supported source files; larger repositories retain the explicit tools. `SYMBOL` reports exact TypeScript/JavaScript declarations and named members with line/column ranges, export status, and a source revision. Ranged reads make
large source files usable without flooding the model context. Ordinary context
also follows one dependency hop through the same resolver. It excludes
dependency/build/cache directories, common credential
files, `.docs`, and `.meta`; hidden exercise instructions remain opt-in through
`--task-packet`.

The current safety bounds are 50,000 indexed entries, 2 MiB per searched file,
200 regex GREP matches, 100 literal SEARCH matches, and 16,000 characters per
read action. Ranged, clipped, and failed reads do not authorize whole-file
replacement; large files require anchored edits. Relationship and symbol scans consider at
most 10,000 supported TypeScript/JavaScript files and 512 KiB per file. They
resolve relative imports, export-from declarations, `require`, string-literal
dynamic imports, common source extensions, TypeScript `.js` specifiers, and
directory indexes. Symbol lookup uses a pinned TypeScript compiler syntax parser and is exact but not semantic: aliases, inferred types, overload identity, locals, package imports, path aliases, package exports, and language-server references remain planned.

## 4. What it is good at

| task | evidence |
|------|----------|
| implement a function against existing tests | 60.0% on 225-case Polyglot (`bench/POLYGLOT_FULL225.md`) |
| small multi-file edits in an existing repo | **14/14** on the local suite, 0 false successes, 0 damaged |
| find and fix a bug with no file named | included in that 14/14 (`07-cross-file`) |
| refactor with behaviour preserved | included (`09-refactor`) |
| thread a field through several files | included (`15-three-files`) |

This is the sweet spot: **a repo that already exists, with tests that already
exist.** Give it a task at that scale and it is genuinely useful.

## 5. What it is bad at, concretely

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

## 6. How to actually use it safely

1. **Prefer `--isolate` for headless changes.** It requires the selected path
   to be the Git root and completely clean, including untracked files. The run
   happens in a detached temporary worktree and leaves a patch under
   `.forge/isolated/`. Add `--promote` only when you want a successful verified
   run applied after HEAD, cleanliness, and `git apply --check` are revalidated.
   This protects repository mutations, not the host from repository scripts.
2. **Set `verify` in `forge.json`.** A run with no verification command reports
   that it could not verify rather than pretending — but you get far more from
   a real command.
3. **Review filesystem previews carefully.** Forge supports `DELETE`, `MKDIR`,
   `MOVE`, `COPY`, and `RENAME` for files, directories, binary data, and symlinks.
   Recursive operations revalidate the complete bounded tree before commit and
   retain binary-safe undo data first. Destinations must be absent, and the
   repository root plus `.git`, `.forge`, and `.codex-bridge` are protected.
   First-class tree operations stop above 10,000 entries or 128 MiB; larger or
   specialized work requires an explicitly approved command without structured
   per-entry undo.
4. **Use `--sandbox` on a repository you do not trust.** `--sandbox docker
   --image node:22` (or `podman`) runs the model's commands and the
   verification gate inside a container: only the repository is mounted, at
   `/workspace`, with no network unless you add `--sandbox-network` and none of
   your host's PATH, HOME, or credentials. This is the control that addresses
   repository-controlled build and test scripts, which `--isolate` does not.
   The image must have your toolchain in it; Forge will not guess one. Set it
   permanently with an `execution` block in `forge.json`.
5. **Do not enable unfamiliar hooks.** Forge never auto-runs configured hooks;
   `--hooks` is your explicit consent to execute those repository commands.
6. **Read the diff.** Its self-report is not evidence. The one measured failure
   mode that matters is a confident wrong finish, and the defence is your eyes.
7. **Prefer many small tasks to one large one.** The 14/14 tasks are all
   single-purpose. Nothing suggests a 10-step request behaves as well.
8. **Re-run your tests yourself after it finishes.** Since 2026-08-04 the
   completion gate re-runs a passing suite to confirm it (`bench/PROJECT_TRIAL.md`),
   but your suite is yours.

## 7. A first test run

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

## 8. Reading the numbers honestly

The 42-case screen has **±5 cases of run-to-run variance** on an unchanged
system (observed 28, 27, 23). Treat any single 42-case difference smaller than
that as noise; the 225-case number is the one with a confidence bound on it.

Two interventions have been measured and **rejected**, both of which sounded
obviously good beforehand:

- `--task-packet` (feed the model the spec) — `bench/TASK_PACKET.md`
- raising the turn budget to 18 — same doc

That is the house style: measure, then decide. Plausibility has lost twice.
