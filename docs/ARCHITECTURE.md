# Architecture

## Design objective

Forge treats weak-model coding as a systems problem. The base model supplies probabilistic proposals; the harness supplies state, constrained actions, retrieval, verification, and recovery.

## Execution pipeline

```text
User task
   |
   v
Repository mapper ---> lexical/symbol retriever ---> focused context
   |                                                |
   +-----------------------> Planner <--------------+
                                 |
                                 v
                         Structured task plan
                                 |
                                 v
                   Executor action loop (JSON)
                    | read/search/edit/command |
                    +-----------+--------------+
                                |
                                v
                       Verification commands
                                |
                                v
                    Reviewer: diff + evidence
                         | approved? |
                       no|           |yes
                         v           v
                     repair       final report
                         |
                         v
                   validated reflection
                         |
                         v
                repository-scoped memory
```

## Small-model reliability techniques

### Role decomposition

Planning, implementation, review, and reflection use independent prompts and calls. A single small model is less likely to preserve all constraints in one long generation.

### Explicit action protocol

The executor emits one JSON object per turn. Forge validates it against typed schemas and rejects unknown tools or malformed arguments. Native provider tool calling can be added later, but the portable protocol remains the baseline.

### Focused context

The repository mapper produces a compact file, symbol, import, call, and test
inventory. Retrieval blends normalized BM25 evidence with deterministic local
word/character n-gram embeddings; stronger embedding providers can implement the
same protocol without changing orchestration. Explicit `@path` references and
import/call/test neighborhoods expand the initial result set.

Selected chunks are merged by source range before rendering. Query-aware token
compression preserves signatures, diagnostics, matching lines, and nearby source
locations while replacing low-value bodies with explicit omission markers. The
same configured lexical/semantic weights and token calibration are used by chat,
planning, deep specialists, bridge queries, and coding agents.

Successful reflections do not silently modify prompts. A high-confidence lesson
from a verified, reviewer-approved run becomes an inactive convention candidate.
Only `forge conventions promote <id>` merges its deduplicated rules into
`.forge/conventions.md`, which is then loaded through the normal project-guidance
boundary.

### Closed-loop verification

Edits are followed by graph-selected impacted tests, the configured full suite,
and repository-native static analyzers whose exact command prefixes are already
approved. The impact graph follows imports and calls across supported Python,
Node, Rust, Go, and .NET test layouts. Failed impacted tests receive bounded
reruns only to classify stable failure versus flakiness; one observed failure is
still enough to keep the run fail-closed.

Verifier output is parsed into structured diagnostics and returned as repair
evidence rather than summarized away. Typed Python changes may also produce
inactive Hypothesis test proposals under the run evidence directory. These are
review material, not automatic source edits.

Deep candidate patches can be minimized after success. The reducer restores one
changed file to its baseline at a time, then requires the complete verification
set and a fresh reviewer approval. A reduction survives only when both gates
remain green; otherwise the candidate file is atomically restored.

### Bounded autonomy

Max steps, review rounds, changed files, file size, command duration, and output size are all capped. Exhausting a budget returns a truthful incomplete result.

## Product and renderer boundary

The coding core does not import Textual, Rich, or prompt-toolkit. Agent hooks
publish renderer-neutral events through `ui_events.py`:

```text
TaskStarted ─┐
PhaseChanged │
PlanUpdated  │
ToolStarted  ├──> EventHub ──> WorkspaceState ──> Textual workspace
Verification│                 └───────────────> future editor adapter
Review       └──> LegacyEventTranslator ──────> classic Rich renderer
```

`WorkspaceState` is a pure reducer. It owns plan status, grouped inspection,
activity density, verification, review, changed-file state, and the persistent
status summary. Textual widgets render that state but do not decide policy or
agent behavior.

The two product renderers are:

- `workspace.py`: full-screen Textual workspace for an interactive TTY;
- `chat.py` + `ui.py` + `composer.py`: classic scrollback-native Rich and
  prompt-toolkit renderer.

Renderer resolution is CLI, `FORGE_UI`, repository configuration, then terminal
capability. Non-interactive commands never start Textual. Both renderers share
`Chat`, `CodingAgent`, `Session`, `RepositoryPolicy`, verification, undo, and
run evidence.

Approvals remain policy decisions, not widget decisions. The workspace checks
permission mode before opening a modal, and the modal returns the same
`Decision` object consumed by the classic renderer. Session removal moves JSON
to repository-local recoverable trash; it is not permanent deletion.

## Run state and transaction boundary

Every normal coding task executes in an exact Git snapshot worktree managed by
`transactions.py`. Chat, `forge run`, and the typed bridge all use this same
boundary:

```text
user working tree ──snapshot tree──> isolated worktree
                                         │
                              agent events/checkpoints
                                         │
                         verify + review + safety gates
                           │                         │
                        pass                       fail
                           │                         │
                  atomic file promotion      preserve evidence,
                  with rollback snapshot     discard isolated edits
```

Every run has a transaction-owned stable ID and writes observable artifacts
beneath `.forge/runs/<run-id>/`:

- normalized task and configuration fingerprint;
- append-only, flushed `events.jsonl`;
- atomically replaced resume checkpoint and structured artifacts;
- planner output and completed-step state;
- verification outputs and reviewer verdicts;
- final promoted or discarded file set and summary.

An interruption leaves the isolated worktree and manifest intact. Resume validates
the original task and configuration fingerprint, reopens the same run directory,
loads bounded observable evidence, and continues against the current isolated
files. The user's working tree changes only after all gates pass. Promotion first
stages validated regular files, then uses atomic replacements and restores the
pre-promotion tree and index snapshot if any operation fails.

## Provider abstraction

`OpenAICompatibleClient` calls `/chat/completions`. The rest of the system consumes a simple `complete(messages, settings)` interface. Provider-specific reasoning fields and native tool formats must be normalized at the adapter boundary.

## Extension architecture

The remaining extension points are deliberately typed and optional: semantic
embedding providers, verification/analyzer adapters, evaluation exporters,
remote workers, MCP transports, GitHub workflow adapters, and editor protocols.
The terminal workspace remains the bundled human interface; external clients
consume the same bridge, policy, transaction, and evidence boundaries rather
than duplicating agent authority.
