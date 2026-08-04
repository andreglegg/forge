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

Long transcripts are bounded by retaining stable setup messages and the newest evidence. This is a context guard, not a semantic summarizer.

## Verification

`src/verify.ts` detects common project checks or uses the explicit `verify` array from `forge.json`. A successful completion is independently verified. Passing suites are repeated once to detect a non-reproducible pass. Without a test command, Forge performs a strict read-back review and fails closed if it cannot establish completion.

## Persistence and recovery

Every turn is recorded under `.forge/traces/`. Session journals are crash-tolerant append-only JSONL with final atomic repair. The CLI can list, show, resume into an interactive transcript, and safely undo committed mutations when the current file revision still matches the session record.

Current sessions restore observable transcript and tool evidence. They do not resume a provider request that was in flight when the process stopped.

## Commands and process execution

Commands are token arrays and run with `shell: false`. Time, output, environment, and process lifetime are bounded. A narrowly recognized `cd <repo-directory> && <one command>` form is translated into a validated `cwd` while preserving shell-free execution.

## Evaluation

`src/bench.ts` and `src/polyglot.ts` provide reproducible evaluation with executable, model, endpoint, dataset, and configuration fingerprints. Infrastructure failures are persisted but excluded from scored coding results. Promotion claims require paired evidence rather than an isolated score.

## Known architectural gaps

The current TypeScript product does not yet provide an OS-level sandbox, automatic Git-worktree transaction promotion, MCP, lifecycle hooks, plugins, remote workers, or a full-screen TUI. These are roadmap items and must not be inferred from historical documents.
