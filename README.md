# forge — a coding agent for local and small models

<p align="center">
  <img src="docs/assets/forge-wordmark.png" alt="Forge" width="420">
</p>

[![CI](https://github.com/andreglegg/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/andreglegg/forge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/forge-agent)](https://www.npmjs.com/package/forge-agent)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A local-first, chat-first coding-agent CLI written in TypeScript and optimized
for local and small language models.

**New here? Read [`USING_FORGE.md`](USING_FORGE.md).**

## Install

Forge requires Node.js 22.12 or newer. From npm:

```sh
npm install --global forge-agent
forge --version
forge doctor
```

From this repository:

```sh
npm ci
npm run build
node bin/forge --version
```

Forge is a **0.1 public alpha**. See [`docs/STATUS.md`](docs/STATUS.md) for the exact shipped/planned boundary, [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md) for the ordered product milestones, and [`docs/SECURITY.md`](docs/SECURITY.md) before using autonomous approval on valuable code.

Forge never silently updates a global installation. Check the installed version
with `forge --version` and upgrade explicitly with:

```sh
npm install --global forge-agent@latest
```

## Status

`forge` on PATH runs this. It indexes bounded Git-aware project trees, can
navigate deep monorepos with scoped list/glob/search, ranged reads, static
TypeScript/JavaScript module relationships, and revision-bound symbol declarations, supports read-only and plan modes,
and applies anchored edits plus transactional file and directory operations. It also runs approved commands, verifies completion, and
asks before workspace effects unless explicitly automated. Driven end to end
against local Qwen coder models.

**Measured, as of 2026-08-04:**

| what | result |
|------|--------|
| Aider Polyglot, 225 cases | **60.00%** (135/225), +14.4 pp over Little Coder's published 45.56%, one-sided exact binomial `p=9.5e-06` |
| Paired head-to-head vs Little Coder, 42 pinned cases | **28/42 vs 19/42** (`p=0.012`) and 27/42 (`p=0.008`) |
| Local multi-file suite, 14 tasks | **14/14**, 0 false successes, 0 damaged |
| Greenfield project, unsupervised | **builds it, then over-reports** — see `bench/PROJECT_TRIAL.md` |
| Model floor | 30B-MoE 64-67%, 14B 12-14%, 7B 4.8% — a cliff, not a gradient |

**To use it on a real project, read [`USING_FORGE.md`](USING_FORGE.md).** It
covers setup, what the numbers above do and do not license, and the failure
modes to watch for.

Full evidence, including two interventions that were measured and rejected, is
in [`bench/`](bench/).

The honest caveat: the pty test that drives the approval prompt through a real
terminal **skips** where no controlling terminal is available — including the
shell it was developed in. On such a machine that one path is genuinely
unverified, and the test says so rather than passing emptily.

## Development approach

Forge is designed, maintained, and evaluated by Andre Glegg using AI-assisted
development under a test-first, benchmark-gated workflow. The maintainer owns
the architecture, safety constraints, evaluation methodology, and release
decisions. Contributions are judged by observable behavior, tests, security
invariants, and reproducible evidence—not by who or what typed the first draft.

## The instrument

Every run records what the model actually said, to `.forge/traces/`. `forge
replay` re-decodes that fixed text through the current decoder and reports how
much of it became a usable action:

```
$ forge replay
9 of 9 replies converted (100.00%), 1 repaired
repairs applied
  orphan_search_block      1
  stray_marker             1
```

No model is contacted, no repository is read, nothing is timed. So any movement
in that number is this code's doing and nothing else — which makes it something
you can run per commit and bisect on. A coding benchmark cannot do that: it
moves the model and the harness together, and its own variance swamps the
difference you were looking for.

Recording is unconditional rather than behind a flag, because a corpus you have
to remember to switch on is empty exactly when you need it: after the run that
went wrong.

What it measures is *conversion* — did the reply become an action. Not whether
the resulting edit was any good. A confident, wrong patch counts as converted.
Conversion is a floor on quality, not a substitute for it.

## Running it

```
forge                     interactive chat in the current directory
forge run "<task>"        one shot, exit 0 on success
forge run "<task>" --yes  approve workspace effects (CI, batch)
forge run "<task>" --yes --isolate
                          run in a detached clean Git worktree and retain a patch
forge run "<task>" --yes --isolate --promote
                          apply the verified patch after conflict/risk checks
forge plan "<task>"       inspect and return a plan without effects
forge run "<question>" --read-only
forge doctor              provider/model/verifier diagnostics
forge init                create an idempotent forge.json
forge config --json       resolved configuration
forge profiles            list named local-model profiles
forge continue [id]       reopen interactive chat with retained history
forge replay              score the decoder on everything recorded here
forge sessions            what has been run here
forge show <id>           replay a recorded session
forge undo [id]           put back what a session changed
forge --version            print the installed version
forge polyglot <dataset> --name <run>
                          run/resume Aider's 225-case Polyglot benchmark
forge compare <a> <b>     paired comparison of two Polyglot report files
forge compare-little-coder <forge-report> <little-coder-report> <case-manifest>
                          normalize and compare a Little Coder paired run

  --profile <name>        select a named profile from forge.json
  --native                use the provider's tool-calling instead of the text
                          protocol (OpenAI and Anthropic wires, auto-detected)
  --task-packet           include bounded student-facing exercise docs
  --batch-actions         invite bounded independent reads/known-file edits
  --isolate               require a clean Git root and protect the original checkout
  --promote               apply a verified isolated patch to the original
  --allow-risk            override reviewed critical patch-risk findings
  --hooks                 explicitly enable project lifecycle hooks (headless)
  --mode <mode>           workspace, read-only, or plan
  --stream-json           durable Run events as JSONL plus a final result
```

It defaults to `http://127.0.0.1:8790/v1` and asks the endpoint what it serves
via `/v1/models`. Coding commands also perform a minimal completion preflight,
so a gateway that advertises an inactive model profile fails before the agent
starts. Override with `--url` / `FORGE_URL` and `--model` / `FORGE_MODEL`.

Named profiles keep local-model-specific settings together:

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
    }
  },
  "verify": [["npm", "test"]]
}
```

Use `forge profiles`, `forge config --json`, or override for one run with
`--profile <name>`. Explicit CLI flags and `FORGE_URL` / `FORGE_MODEL` take
precedence over a profile.

Verification detection understands npm, pnpm, Yarn, and Bun root projects. It
prefers a root `check` script when present and otherwise uses `test`. Monorepos
can configure package-specific checks without a shell:

```json
{
  "verify": [
    ["cd", "packages/api", "&&", "pnpm", "test"],
    ["cd", "apps/web", "&&", "pnpm", "check"]
  ]
}
```

The `cd <repository-directory> && <one command>` spelling is parsed into a
validated working directory and a token-array command; it is never passed to a
shell.

`--isolate` is the safest headless repository mode currently shipped. It requires
the selected path to be the Git root and completely clean, including untracked
files. The model and verifier run in a detached temporary worktree. Forge writes
the resulting binary patch to `.forge/isolated/`; without `--promote`, the
original remains unchanged. Promotion requires verification and rechecks HEAD,
cleanliness, and `git apply --check`. Added patch lines are also scanned for
likely credentials/private keys, package install lifecycle scripts, dangerous
workflows, and dependency metadata changes. Critical findings retain the patch
and block promotion unless you inspect it and explicitly add `--allow-risk`.
This heuristic scan is not proof that a patch is safe. Worktree isolation
protects repository mutations but is not an OS, network, or process sandbox.

Headless project hooks never run merely because a repository defines them.
Enable them explicitly with `--hooks`:

```json
{
  "hooks": {
    "sessionStart": [["node", "scripts/forge-start.mjs"]],
    "beforeVerify": [["npm", "run", "format:check"]],
    "afterVerify": [["node", "scripts/forge-audit.mjs"]],
    "sessionEnd": [["node", "scripts/forge-notify.mjs"]]
  }
}
```

Hooks are sequential shell-free token arrays with a scrubbed environment,
60-second timeout, bounded output, and fail-closed exit semantics. They receive
`FORGE_HOOK_EVENT`, `FORGE_SESSION_ID`, and post-verification hooks receive
`FORGE_VERIFIED`. Hooks remain arbitrary repository-controlled programs;
inspect them before opting in.

`FORGE_TRACE=<path>` writes every turn's exact bytes plus the decoded proposals
and repairs, one JSON object per line. Reach for it first when a run misbehaves:
every early guess about a live failure in this package has been wrong, and the
trace has settled each one in a single run.

## The path past Little Coder

The target is not “one run scored higher.” It is a paired, reproducible gain on
the same cases, model weights, endpoint, budgets, verifier and dataset commit.
Every Polyglot run writes those inputs plus a fingerprint of the built Forge
executable to `.forge/benchmarks/polyglot/<name>/run.json`; a changed setting
cannot resume into an old run.

Install the language toolchains required by the selected cases. Python
verification uses `uv` to provide an isolated cached pytest. Java needs a JDK
and a valid `JAVA_HOME`; Forge contains `GRADLE_USER_HOME` inside the run so a
broken or shared user cache cannot corrupt the verdict. CMake, Go, npm and Cargo
must likewise be on `PATH` for their language cases.

Start with a deterministic 42-case screen: seven evenly spaced exercises from
each of the six official languages. Run the conservative control first, then
the candidate profile:

```
npm run build

forge polyglot /path/to/polyglot-benchmark \
  --name model-screen-control --per-language 7 --model-digest <weights-digest>

forge polyglot /path/to/polyglot-benchmark \
  --name model-screen-candidate --per-language 7 --model-digest <weights-digest> \
  --task-packet --batch-actions

forge compare \
  .forge/benchmarks/polyglot/model-screen-control/report.json \
  .forge/benchmarks/polyglot/model-screen-candidate/report.json
```

For idea generation, do not pay for a paired 42-case screen after every edit.
`--discover` defaults to two evenly spaced cases per language, one attempt and
eight turns. Narrow it further with `--case` when a change targets a retained
failure; explicit selection and budget flags override the preset:

```
forge polyglot /path/to/polyglot-benchmark \
  --name idea-context-v1 --discover --task-packet --jobs 2
```

This mode is evidence for choosing the next experiment, not for making a score
claim. Use the paired 42-case screen only when a candidate survives its focused
failure replays and discovery sample. `--jobs N` runs isolated cases concurrently;
start with two and watch model-server memory and throughput. A single-GPU server
that serializes requests will not benefit, so the default remains one worker.

`--task-packet` admits only a small allowlist of student-facing specifications,
including `.docs/instructions.md`; `.meta` reference solutions are never copied
into the worktree. `--batch-actions` changes prompting, not mutation safety:
reads can be proposed together, while edits still go through preview, approval,
revision revalidation and serialized commit.

Promote a candidate only when it has more paired gains than regressions, does
not increase false-success attempts, and does not trade a small score gain for
a large runtime regression. Then run all 225 official cases by omitting
`--per-language`. Long runs are atomic and resumable. `--batch-size 6` processes
six pending cases per invocation if the endpoint needs short supervised batches.
The default protocol matches Little Coder's published shape: a 12-turn first
attempt, independent verification, then a fresh eight-turn retry using the test
failure. The final claim should require a positive paired delta, an exact
McNemar p-value below 0.05, and a score above the 104/225 Little Coder reference
on the same model and hardware.

Failures retain the worktree, agent logs, verification output, timeout state,
failure class, turns, actions and elapsed time. Inspect classes and paired
regressions before changing prompts. Syntax/protocol failures call for codec
work; no-progress cases call for retrieval or steering; test failures call for
language-level guidance. That containment is important: broad prompt growth is
usually a context and latency regression for a small model.

Project-specific guidance can live in root `AGENTS.md` or `CLAUDE.md`. Small
reusable instruction packs go in `.forge/instructions/*.md`:

```
---
keywords: [rust, borrow, lifetime]
---
Prefer the smallest ownership change. Re-run the narrow failing test first.
```

At most two keyword-matched packs are included. Add one only after retained
failures show a repeated, general error class, then rerun the same paired screen.

## Project-scale repository navigation

Forge builds a deterministic repository index before each task. In a Git
repository it uses tracked plus non-ignored untracked paths; outside Git it uses
a bounded filesystem walk. The initial prompt receives a compact project map
with top-level areas and important manifests instead of a shallow file dump.

The text and native protocols expose the same inspection operations:

```text
LIST packages/api
GLOB **/*.test.ts
GREP RequestHandler
SEARCH exact literal text
RELATED packages/api/src/server.ts
SYMBOL RequestHandler
REFERENCES RequestHandler
CALLERS RequestHandler
READ packages/api/src/server.ts:120-220
```

`LIST` shows one directory level. `GLOB`, `GREP`, and `SEARCH` operate across the
complete bounded index, including paths deeper than three levels and beyond 200
files. `RELATED` reports the nearest package root, direct relative module
dependencies, inbound dependents, and related tests for TypeScript/JavaScript
files. Tasks that explicitly name code-shaped symbols automatically rank and inline matching declaration, caller, reference, and one-hop dependency files, even when filenames do not share the task wording. This automatic pre-turn analysis is capped at 200 supported source files; larger repositories keep the lightweight lexical path and can use the explicit semantic tools. `SYMBOL` reports exact declarations, `REFERENCES` reports syntax occurrences, and `CALLERS` uses the TypeScript checker to resolve direct calls and constructor calls across relative-import aliases and lexical scopes. Every result carries an exact range and source revision. `READ path:start-end` gives an exact line range, while an unrestricted
large read is clipped with a continuation instruction. Search skips binary files
and files above 2 MiB; reads are bounded to 16,000 characters per action. A
ranged, clipped, or failed read never authorizes a wholesale replacement of an
existing file; large files must be changed with anchored edits. The index is
capped at 50,000 entries.

Relationship and symbol scans are bounded to 10,000 supported source files and 512 KiB per
file. Module relationships resolve relative imports, export-from declarations, `require`, string-literal dynamic imports, common source extensions, TypeScript `.js` specifiers, and directory indexes. `CALLERS` resolves direct checker-visible calls and constructor calls, but not dynamic dispatch, reflection, package/path aliases, inferred runtime targets, or untyped calls.

Generated dependency/build/cache directories, common credential files,
`.docs`, and `.meta` are excluded from ordinary context. Exercise specifications
under `.docs` remain available only through the explicit `--task-packet` mode.
All resolved paths remain constrained to the selected repository.

## Filesystem operations

The text and native protocols expose the same first-class workspace operations:

```text
DELETE path/to/file-or-directory
MKDIR path/to/new/directory
MOVE source/path -> destination/path
COPY source/path -> destination/path
RENAME old/path -> new/path
```

`DELETE` can remove a file, symlink, empty directory, or bounded non-empty
directory tree. `MOVE`, `COPY`, and `RENAME` accept files, directories, binary
content, and symlinks without following them. A final symlink may be targeted
as an entry; structured mutations never traverse a symlinked parent directory.
Destinations must not already exist; replacement requires a separately visible
`DELETE` first.

Every operation is previewed before approval, revalidates exact source and
destination snapshots before commit, and records each affected entry for
binary-safe guarded `forge undo`. The repository root and protected metadata
roots `.git`, `.forge`, and `.codex-bridge` cannot be targeted. First-class tree
operations are bounded to 10,000 entries and 128 MiB of retained content. Larger
or specialized operations require an explicitly approved `RUN` command and do
not gain the same structured preview or per-entry undo guarantees.

## The shape

```
Commands ──▶ Run actor (single writer) ──▶ Effects
   ▲               │                          │
   │               ▼                          ▼
approve/cancel  durable event journal    model / tools / fs
   │               │                          │
   └───────────────┴───── results ◀───────────┘
                   │
        projections (pure, many)
        ├─ interactive renderer
        └─ headless renderer
```

An **actor**, not an async generator. A generator that yields events and takes
approvals through `.next(value)` makes approval awkward, cancels the run when a
consumer stops iterating, and forces consumers to *compete* for values — but the
renderer, the journal and a session recorder all need to watch independently.

Durable domain events are journalled and replay to identical `RunState`. Token
deltas are ephemeral presentation signals: coalesced, droppable under
backpressure, never journalled. A replay reconstructs decisions, not typing.

**`submit()` returns its results.** Callers must never rebuild them by watching
the event stream — subscribers are asynchronous, so an array they populate has
not necessarily been filled when the `await` returns. Events are for observing;
the return value is causal.

## One semantic protocol, several codecs

```
provider bytes → deltas → text codec | native codec → ActionProposal → …
```

The boundary is `ActionProposal`. A SEARCH/REPLACE block and a native tool call
are two spellings of one intent, and a test asserts they decode identically.
Drift is prevented structurally, not by discipline: both codec surfaces *and*
the prompt that teaches them are generated from one `TOOLS` registry, so a tool
cannot exist in one and not the other.

Both codecs are incremental and neither emits until a terminator arrives. Half an
edit must never become an action.

## The seam everything else composes onto

```
propose → preview (in memory, nothing touched) → approve → revalidate → commit
```

The preview computes the diff without writing, so the user approves something
that exists before it happens. The commit re-checks the file's sha256 and refuses
a stale proposal: approval is consent for a *specific version*, and a file can
move between proposing and committing.

`always` is scoped to an action class for the session. Approving an edit must
never silently approve command execution.

## What live small models taught this code

Each of these is a defect that unit tests could not see and a frontier model
would probably have hidden.

- **The model will declare victory over a failed edit.** A `final` in a turn
  whose own actions failed and committed nothing is rejected. A false success is
  worse than a failure, because nothing downstream checks again.
- **It writes anchors before it looks.** A turn that both reads and mutates has
  the mutation deferred — the anchor was composed before the file was seen.
- **It cannot tell whether an edit landed.** A commit returns the resulting file,
  not just "applied". Without that it edits again; it once appended the same
  function four times and called the run a success.
- **Loop safety must be precise, not absolute.** Reads are keyed by path *plus
  content revision*, so re-reading an unchanged file is refused with advice while
  re-reading after an edit is allowed. A mutation resets the repeat counts too:
  the world changed.
- **Never feed the raw reply back.** The transcript carries a canonical
  re-rendering of the decoded turn. Otherwise a malformed marker teaches the
  model the malformation is fine, and an invented SEARCH body stays in the
  conversation and anchors every later attempt to the invention.
- **Marker direction is noise.** `>>>>>>> SEARCH` is accepted as readily as
  `<<<<<<< SEARCH` and counted as a repair. There is nothing else that line
  could mean.

## Commands

```
npm run check    lint + typecheck + test
npm test
npm run build
```
