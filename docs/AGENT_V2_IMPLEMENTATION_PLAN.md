# Forge Agent V2 implementation plan

## Goal

Upgrade Forge from a single expensive planner/executor pipeline into an adaptive
local-model coding workbench that preserves Codex/Claude-class safety and UX
while minimizing model calls, prompt prefill, protocol failures, and time to the
first useful action.

The upgrade is divided into independently testable vertical slices. Every phase
must preserve the repository sandbox, approval semantics, truthful outcomes,
external verification, run artifacts, and provider neutrality.

## Product-level success criteria

Forge Agent V2 is complete when all of the following are demonstrated by
reproducible tests or benchmarks:

1. Observable repository facts use zero model calls.
2. Read-only repository questions use one model call in the normal case.
3. Explicit one-file micro-edits skip the planner and begin execution after one
   model call.
4. Standard tasks select the smallest reliable orchestration lane from task and
   model evidence.
5. Difficult tasks retain planning, repair, review, and verification.
6. The same repository snapshot is reused across a chat session and only changed
   files are reparsed.
7. Baseline verification is evidence-triggered and no command is run twice before
   the first executor action.
8. Every run records prompt-to-first-token, first-tool, first-mutation, calls and
   prompt tokens before first tool, total latency, protocol errors, and outcome.
9. Capability profiles adapt lane, protocol, context, and role policy only after
   minimum-sample evidence gates.
10. Public and private benchmarks show a better quality/latency Pareto frontier
    without increased false-success or safety-violation rates.

## Execution lanes

### Lane A: deterministic fact

Purpose: exact answers from Forge tools with no model.

Examples:

- directory contents;
- Git branch/status/diff;
- configured verification commands;
- changed files and recent run status.

Acceptance:

- zero provider calls;
- path policy applies;
- output is bounded;
- no repository mutation.

### Lane B: repository question

Purpose: one focused prose call for explanations and code questions.

Acceptance:

- no separate model router;
- one shared repository snapshot;
- focused context within the model budget;
- no mutation tools or reviewer call.

### Lane C: direct micro-edit

Purpose: the fastest safe path for one explicit, small file edit.

Acceptance:

- deterministic eligibility rules;
- planner skipped;
- exact edit protocol and approval preserved;
- targeted verification first;
- escalation to Lane D on failure or ambiguity.

### Lane D: standard agent

Purpose: multi-step work that needs investigation but not deep architecture.

Acceptance:

- concise plan or deterministic fallback;
- batched/parallel independent reads where the model supports them;
- bounded action loop;
- staged verification and semantic review only when deterministic evidence is
  insufficient.

### Lane E: deep agent

Purpose: architecture, security, migration, broad refactor, and unclear debugging.

Acceptance:

- full reconnaissance and baseline reproduction where relevant;
- planner/executor/reviewer separation;
- worktree-isolated candidates where configured;
- bounded repair and truthful partial results.

## Phase 0: measurement and fast front door

### Deliverables

- Deterministic lane selector.
- Zero-model repository fact recipes.
- Direct question path that bypasses the model router.
- Explicit `/ask`, `/do`, `/fast`, and `/deep` one-shot commands.
- Safe direct `!command` path for user-authored commands.
- Session-scoped incremental repository index.
- Evidence-triggered, deduplicated preflight verification.
- First-token/tool/mutation metrics.
- Capability persistence for lane outcome and first-action latency.

### Tests

- “what is in this directory?” performs no provider call.
- a normal question calls only the prose answer path.
- `/fast` forces planner-free execution.
- `/deep` forces complex orchestration.
- unchanged repository refresh reuses parsed entries.
- one changed file reparses only that file.
- baseline verification suppresses duplicate quick verification.
- first-tool metrics are populated from a scripted run.

## Phase 1: adaptive execution policy

### Deliverables

- Capability profile keyed by model, endpoint, quantization label, role, task
  class, and protocol.
- Minimum-sample and Bayesian-smoothed policy gates.
- Lane selection informed by observed planner validity, patch success,
  no-progress rate, and latency.
- Role-specific provider configuration.
- Model-sized context profiles.
- Targeted-test discovery and staged verification.

### Policy examples

- Skip planner after repeated planner-protocol failures on fast/standard tasks.
- Disable read batching only after enough observed malformed batches.
- Use a stronger configured reviewer for models with high false-approval rates.
- Reduce context when success degrades beyond a measured prompt-token range.
- Escalate a failed micro-edit to standard mode exactly once.

### Tests and gates

- no policy changes before minimum samples;
- deterministic replay from persisted capability evidence;
- per-lane benchmark comparison against a fixed baseline;
- no safety-policy weakening through adaptation.

## Phase 2: action graph and parallel observation

### Deliverables

- Typed action graph with dependencies.
- Concurrent execution of independent read-only nodes.
- Mutation and uncertainty barriers.
- Compact observation table returned to the model.
- Crash-safe graph checkpoints and resume.

### Invariants

- mutations remain serial and approved;
- commands remain policy-classified and bounded;
- no graph node may reference output from an unfinished dependency;
- cancellation stops all child work and leaves a resumable checkpoint.

### Metrics

- model turns saved versus sequential loop;
- graph critical-path time;
- redundant read/search rate;
- prompt tokens saved through compact observations.

## Phase 3: protocol portfolio

### Deliverables

- Existing typed JSON protocol retained.
- Restricted code-action/command protocol in an outer worktree/container
  sandbox.
- Direct patch protocol with deterministic validation.
- Endpoint capability probing for JSON schema, grammar, streaming, caching, and
  speculative decoding.
- Benchmark-gated protocol selection per model/task class.

### Safety

- never execute raw model text through an unrestricted shell;
- command protocol must parse into token arrays or run only inside an explicitly
  configured disposable outer sandbox;
- patch protocol must preserve path policy and atomic writes.

## Phase 4: repository intelligence

### Deliverables

- Persisted chunk-level lexical index.
- Optional Tree-sitter symbols/imports/calls.
- Import and test-neighborhood expansion.
- Stable project instruction discovery.
- Token-aware context compression preserving signatures, identifiers,
  diagnostics, tests, and invariants.

### Evaluation

- localization recall on held-out repository tasks;
- tokens per successful task;
- unnecessary-file rate;
- performance by model tier and context size.

## Phase 5: deep-task competitiveness

### Deliverables

- Worktree-isolated parallel patch candidates.
- Deterministic and semantic candidate ranking.
- Patch minimization after verification passes.
- Static analyzer and structured diagnostic adapters.
- Optional specialized subagents only for independent tasks.

### Exit gates

- measurable gain on deep-task benchmark subset;
- bounded resource use;
- no accidental merge of candidate worktrees;
- final patch remains reviewable and minimal.

## Phase 6: product parity and integrations

### Deliverables

- Sticky ask/code/plan/auto modes separate from permission level.
- `@path` context references.
- Skills and project workflows.
- Lifecycle hooks.
- Session browsing, checkpoint rewind, and crash-safe continuation.
- MCP/ACP integration boundary.
- Stable terminal composer and typed editor-integration boundary.

## Benchmark matrix

Run repeated trials for each major change across:

- repository fact;
- file/symbol explanation;
- one-file edit;
- named failing test;
- unclear bug;
- multi-file feature;
- architecture/security/refactor task.

Representative model groups:

- 5B–7B;
- 8B–14B;
- 20B–40B;
- optional remote reference model.

Required ablations:

- model router versus deterministic front door;
- always-plan versus adaptive lanes;
- unconditional versus evidence-triggered preflight;
- fresh versus incremental index;
- sequential actions versus action graph;
- JSON versus restricted code-action versus patch protocol;
- one provider versus role-specific providers;
- prefix caching and speculative decoding off/on.

## Release sequence

1. Merge Phase 0 only after focused tests, full checks, and an interactive smoke
   test prove the new front door.
2. Establish a frozen latency/quality baseline using the new measurements.
3. Add Phase 1 policy behind configuration flags and promote only through held-
   out benchmark evidence.
4. Land action graphs and protocol variants independently so regressions are
   attributable.
5. Treat product integrations as consumers of the stable core, not reasons to
   weaken its boundaries.

## Current implementation status

The core implementation now covers Phases 0-6 behind conservative defaults and
configuration gates:

- Phase 0: deterministic front door, explicit lanes, incremental indexing, and
  first-action metrics.
- Phase 1: evidence-gated adaptive policy, endpoint/model/quantization profiles,
  role-specific providers, measured context selection, and targeted verification.
- Phase 2: typed dependency graphs for concurrent read-only observations with
  crash-safe checkpoints and resume; mutations remain serial.
- Phase 3: typed JSON and exact-patch protocols, restricted command actions,
  endpoint capability probing, and benchmark-evidence protocol selection.
- Phase 4: persisted file/chunk retrieval, symbols/imports/calls, test-neighborhood
  expansion, project guidance, `@path`, query compression, and optional Tree-sitter.
- Phase 5: opt-in worktree candidates, deterministic minimal-patch ranking,
  structured diagnostics, patch audits, and independent read-only specialists.
- Phase 6: sticky modes, skills, lifecycle hooks, persisted sessions, rewind,
  process-restart recovery, a multiline terminal composer, and typed JSONL integration.

Defaults intentionally preserve the proven 9B path: one candidate, zero
specialists, no unlisted commands, and adaptation only after minimum-sample
evidence. Public benchmark gains and optional external IDE/MCP/ACP consumers
remain release-validation and integration work rather than claims made by the
core implementation itself.
