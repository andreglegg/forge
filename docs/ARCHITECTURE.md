# Forge architecture

This document describes the current TypeScript product. Cross-language files in
`bench/` are evaluation fixtures and are not part of the Forge executable.

## Product boundary

Forge is a local-first coding-agent CLI. It talks to OpenAI-compatible endpoints and can also translate native OpenAI or Anthropic tool streams into the same internal action format.

```text
user task
  -> task-specific repository context
  -> provider stream
  -> incremental text or native codec
  -> bounded ActionProposal values
  -> Run actor
  -> preview / approval / revalidation / commit
  -> independent verification
  -> durable session journal and trace
```

## Run actor

`src/runtime.ts` owns the state machine and is the sole authority for effects. Renderers subscribe to events; they do not infer causal results from those events. `submit()` returns the authoritative action results.

Durable decisions are appended to a journal. Token deltas are presentation-only and are not journalled. Replaying the journal reconstructs the same `RunState`.

## Tool protocol

`src/protocol.ts` defines one semantic tool registry. The text codec and native provider codec both decode into `ActionProposal` values. Actions are bounded before execution so a malformed model turn cannot schedule unbounded effects.

Reads, listing, search, grep, static relationship and declaration inspection, anchored replacement, recursive deletion, directory creation, move/rename, copy, and command execution all operate inside one canonical `Workspace`. First-class mutations follow:

```text
propose -> preview in memory -> approve -> revalidate revision -> commit
```

An edit preview contains the resulting file. Tree operations contain a bounded manifest of file, directory, and symlink changes. Approval therefore applies to exact source, destination, and planned-parent snapshots rather than merely to path strings. Destructive bytes are retained before commit, and each affected entry is journalled with its type, mode, and before/after revision. Reverse replay can restore recursive deletes and moves or remove copied/created trees while refusing to overwrite later user work.

The workspace refuses implicit overwrite, repository-root or metadata mutation, and trees above 10,000 entries or 128 MiB. Symlinks are handled as entries and never followed during recursive traversal. Specialized operations outside this boundary can still use separately approved shell-free commands, but those commands do not receive the structured preview or per-entry undo contract.

## Repository context

`src/repository.ts` builds a deterministic bounded project index. Git repositories use `git ls-files -co --exclude-standard` through a fixed shell-free invocation, so tracked files and non-ignored untracked files are visible without indexing dependencies or build output. Non-Git directories use a bounded recursive fallback. The index is capped at 50,000 entries and excludes common credentials, generated/cache directories, `.docs`, and `.meta` from ordinary context.

The same module powers one-level `LIST`, deep `GLOB`, regex `GREP`, literal `SEARCH`, and exact ranged `READ` operations. Search skips binary files and files above 2 MiB; reads return at most 16,000 characters with an explicit continuation range. All paths pass through canonical repository containment.

`src/relationships.ts` builds a bounded static graph for relative TypeScript and JavaScript imports, export-from declarations, `require`, and string-literal dynamic imports. It resolves exact files, common source extensions, TypeScript `.js` specifiers, and directory indexes. `RELATED <path>` reports the nearest package manifest, direct dependencies, inbound dependents, and nearby tests. One graph scan considers at most 10,000 supported source files and 512 KiB per file. Package imports, TypeScript path aliases, and package exports are deliberately not inferred.

`src/symbols.ts` uses a separately pinned TypeScript 5.9 compiler API while Forge itself remains compiled with TypeScript 7. `SYMBOL <name>` reports exact declarations, `REFERENCES <name>` reports bounded syntax occurrences, and `CALLERS <name>` uses the TypeScript checker to resolve direct calls and constructor calls across relative-import aliases and lexical scopes. Results include exact source ranges and revisions and share the 10,000-file/512-KiB bounds. Dynamic dispatch, reflection, package/path aliases, inferred runtime targets, and untyped calls are not inferred.

`src/impact.ts` derives a bounded post-mutation impact plan from actual committed paths. `src/focused-verification.ts` narrows only recognized configured Node test commands to candidate tests owned by the same package. The focused run executes once during iteration, is fed back to the model, and is retained in headless results with its rationale and report. Unsupported commands produce no automatic execution; the configured authoritative completion gate remains mandatory and unchanged.

`src/context.ts` compiles a bounded task-specific prompt and emits a receipt describing what was included or dropped. The current strategy combines a compact project map, lexical file scoring over the complete index, small-file inlining, one-hop dependency following, repository instructions, and an optional exercise task packet. When a task explicitly names a code-shaped TypeScript/JavaScript symbol, `taskContext` lazily adds exact declaration, checker-resolved caller, syntax-reference, and module-dependency evidence before applying the same content budget. Ordinary prose and repositories above 200 supported source files stay on the lightweight lexical path; explicit semantic tools retain their larger scan limits. The old depth-three/200-file discovery ceiling no longer defines what the model can locate.

`src/compaction.ts` bounds long transcripts deterministically. It retains stable setup, a recent contiguous tail, and selected omitted evidence such as verification failures, source locations, executed actions, and explicit user constraints. It deliberately labels compacted evidence as historical and never claims old file contents are current. No second model is used for summarization.

## Verification

`src/verify.ts` detects common project checks or uses the explicit `verify` array from `forge.json`. Node detection understands npm, pnpm, Yarn, and Bun, prefers a root `check` script, and falls back to `test`. Configured checks can use the constrained `cd <repository-directory> && <one command>` form to verify individual monorepo packages without a shell. A successful completion is independently verified. Passing suites are repeated once to detect a non-reproducible pass. Without a test command, Forge performs a strict read-back review and fails closed if it cannot establish completion.

## Isolated execution and promotion

`src/isolation.ts` provides the first execution-backend boundary. `forge run --isolate` creates a detached temporary Git worktree from a fully clean repository root. The agent, verifier, session journal, traces, and retained objects operate inside that worktree.

Finalization captures tracked changes and non-ignored new files as a binary Git patch under the original repository's ignored `.forge/isolated/` directory. Evidence is transferred back before cleanup. `--promote` is allowed only after a successful verified run and rechecks the original commit, working-tree cleanliness, and `git apply --check` before applying the patch.

This isolates repository mutations, not processes.

`src/backend.ts` covers the process gap. An execution backend decides *where* a command runs; `src/exec.ts` still decides how. The host backend is the default and is the previous behaviour exactly. A container backend builds `docker run` / `podman run` argv -- repository mounted at `/workspace`, `--network none` unless asked, no host path variables, `--rm --init`, invoking uid under Docker -- and hands that argv to the same `execBounded`, so timeout, process-group kill, merged output and output clipping are one implementation rather than two. A timed-out container is force-removed, since killing the client does not stop it. Backends are selected by `--sandbox` / `--image` / `--sandbox-network` or the `execution` block in `forge.json`, and cover model `run` commands, the completion gate, and focused verification.

## Retry budgets

`src/retry.ts` bounds the repair loop the gate opens. `src/recovery.ts` classifies a verification failure and adds one directive; the budget decides how many times that is worth repeating. Repairable classes (syntax, type, test) get four retries, flaky two, unknown two, and the classes whose cause lies outside the repository (timeout, toolchain, infrastructure) get one, matching their directives. A failure whose command and normalized output are identical three times running stops the run earlier than any budget, on the grounds that the last attempts changed nothing observable. Exhausting a budget can only end a run as failed; there is no path from a spent budget to an accepted change, and promotion still requires a verified gate.

## The event contract

`src/contract.ts` versions what external clients read. `--stream-json` runs emit a `contract` record as their first line, before anything that can fail, and the `--json` result document carries the same version. `forge contract` prints it without starting a run or needing a repository. Versioning is major.minor: a minor bump is additive and unknown event types must be skipped rather than treated as fatal; a major bump is anything a client could misread and must be refused. The registry of event types is checked against the `RunEvent` union in `runtime.ts` by a test, so adding an event without declaring it fails the suite.

## Persistence and recovery

Every turn is recorded under `.forge/traces/`. Session journals are crash-tolerant append-only JSONL with final atomic repair. The CLI can list, show, resume into an interactive transcript, and safely undo committed text and filesystem mutations when current entry state still matches the session record.

Current sessions restore observable transcript and tool evidence. They do not resume a provider request that was in flight when the process stopped.

## Commands and process execution

Commands are token arrays and run with `shell: false`. Time, output, environment, and process lifetime are bounded. A narrowly recognized `cd <repo-directory> && <one command>` form is translated into a validated `cwd` while preserving shell-free execution.

## Explicit headless hooks

`src/hooks.ts` runs opt-in `sessionStart`, `beforeVerify`, `afterVerify`, and `sessionEnd` command arrays for headless runs. They share Forge's shell-free bounded command executor, run sequentially, fail fast, and are recorded in final machine-readable results. Repository configuration alone never activates them; `--hooks` is required.

These are lifecycle commands, not a general plugin API. Interactive hooks, third-party tool registration, and versioned extension schemas remain planned.

## Evaluation

`src/bench.ts` and `src/polyglot.ts` provide reproducible evaluation with executable, model, endpoint, dataset, and configuration fingerprints. Infrastructure failures are persisted but excluded from scored coding results. Promotion claims require paired evidence rather than an isolated score.

## Known architectural gaps

The current TypeScript product does not yet provide full language-server references, dynamic-dispatch resolution, path-alias or package-export resolution, change-aware test selection, an OS-level sandbox, MCP, a general plugin API, remote workers, interactive lifecycle hooks, or a full-screen TUI. These are roadmap items and must not be inferred from historical documents.
