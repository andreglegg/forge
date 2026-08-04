# Forge architecture

This document describes the current TypeScript product. Historical Python designs live under `legacy/` and are not part of the executable.

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

Reads, listing, search, grep, anchored replacement, and command execution all operate inside one canonical `Workspace`. Edits follow:

```text
propose -> preview in memory -> approve -> revalidate revision -> commit
```

Approval therefore applies to a specific file revision and diff, not merely to a pathname.

## Repository context

`src/context.ts` compiles a bounded task-specific prompt and emits a receipt describing what was included or dropped. The current strategy combines lexical file scoring, small-file inlining, one-hop local-import following, repository instructions, and an optional exercise task packet.

`src/compaction.ts` bounds long transcripts deterministically. It retains stable setup, a recent contiguous tail, and selected omitted evidence such as verification failures, source locations, executed actions, and explicit user constraints. It deliberately labels compacted evidence as historical and never claims old file contents are current. No second model is used for summarization.

## Verification

`src/verify.ts` detects common project checks or uses the explicit `verify` array from `forge.json`. A successful completion is independently verified. Passing suites are repeated once to detect a non-reproducible pass. Without a test command, Forge performs a strict read-back review and fails closed if it cannot establish completion.

## Isolated execution and promotion

`src/isolation.ts` provides the first execution-backend boundary. `forge run --isolate` creates a detached temporary Git worktree from a fully clean repository root. The agent, verifier, session journal, traces, and retained objects operate inside that worktree.

Finalization captures tracked changes and non-ignored new files as a binary Git patch under the original repository's ignored `.forge/isolated/` directory. Evidence is transferred back before cleanup. `--promote` is allowed only after a successful verified run and rechecks the original commit, working-tree cleanliness, and `git apply --check` before applying the patch.

This isolates repository mutations, not processes. Commands still execute on the host until a container backend exists.

## Persistence and recovery

Every turn is recorded under `.forge/traces/`. Session journals are crash-tolerant append-only JSONL with final atomic repair. The CLI can list, show, resume into an interactive transcript, and safely undo committed mutations when the current file revision still matches the session record.

Current sessions restore observable transcript and tool evidence. They do not resume a provider request that was in flight when the process stopped.

## Commands and process execution

Commands are token arrays and run with `shell: false`. Time, output, environment, and process lifetime are bounded. A narrowly recognized `cd <repo-directory> && <one command>` form is translated into a validated `cwd` while preserving shell-free execution.

## Explicit headless hooks

`src/hooks.ts` runs opt-in `sessionStart`, `beforeVerify`, `afterVerify`, and `sessionEnd` command arrays for headless runs. They share Forge's shell-free bounded command executor, run sequentially, fail fast, and are recorded in final machine-readable results. Repository configuration alone never activates them; `--hooks` is required.

These are lifecycle commands, not a general plugin API. Interactive hooks, third-party tool registration, and versioned extension schemas remain planned.

## Evaluation

`src/bench.ts` and `src/polyglot.ts` provide reproducible evaluation with executable, model, endpoint, dataset, and configuration fingerprints. Infrastructure failures are persisted but excluded from scored coding results. Promotion claims require paired evidence rather than an isolated score.

## Known architectural gaps

The current TypeScript product does not yet provide an OS-level sandbox, MCP, a general plugin API, remote workers, interactive lifecycle hooks, or a full-screen TUI. These are roadmap items and must not be inferred from historical documents.
