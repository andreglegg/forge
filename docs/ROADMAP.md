# Roadmap

## Delivered since the initial MVP

- Streaming transport with stall detection, retry classification, and per-role
  token/latency accounting.
- `forge bench`: same suite, same policy, several models, with false-success
  and protocol-error rates alongside the score.
- Whole-prompt budgeting against the model's declared context window.
- Case-folded and structurally enforced path policy; deny list applied to
  listing, search, and retrieval as well as reads.
- Process-group termination so command timeouts are real bounds.
- Incremental, atomic persistence for `bench` and `improve`, with partial
  reports marked and refused for promotion.
- A mature dual-renderer terminal product: full-screen Textual workspace on an
  interactive TTY and a scrollback-native Rich/prompt-toolkit fallback.
- Renderer-neutral UI events, persistent plan/activity/status surfaces,
  consequence-first approval dialogs, tracked/untracked diff browsing,
  expandable evidence, and searchable session management with rename, fork,
  and recoverable trash.
- Crash-safe append-only event streams, atomic checkpoints and artifacts, and
  resumable normal runs that reopen the same isolated worktree and evidence.
- Worktree-isolated transactions for chat, CLI, and bridge runs. Only verified,
  reviewer-approved changes are atomically promoted; failed changes are recorded
  as discarded and never touch the user's working tree.
- Cross-platform path enforcement for POSIX, Windows drive, UNC, traversal, and
  case-folding semantics.
- Polyglot verification discovery for Python, Node package managers, Rust, Go,
  .NET, Maven/Gradle, and Swift, with attended approval before newly detected
  commands become active.

## Phase 1 — harden the MVP — complete

All Phase 1 exit conditions are covered by automated tests and the common
transaction boundary used by interactive, non-interactive, and bridge runs.

## Phase 2 — improve repository understanding — complete

- Optional Tree-sitter symbol graph with deterministic AST/regex fallback.
- Configurable hybrid BM25 and local hashed n-gram embedding retrieval, with an
  injectable embedding-provider boundary for stronger semantic backends.
- Call graph, import-neighborhood, test-neighborhood, and explicit `@path`
  expansion.
- Overlap deduplication and query-aware token compression that preserves
  signatures, diagnostics, and relevant source locations.
- High-confidence conventions are generated only as inactive candidates from
  verified, reviewer-approved runs. `forge conventions promote <id>` is the
  explicit human gate that activates deduplicated project guidance.

## Phase 3 — stronger search and repair — complete

- Parallel candidate patches execute concurrently in exact snapshot worktrees;
  only a verified, safe winner is promoted.
- Graph-based test impact selection follows import/call neighborhoods across
  Python, Node, Rust, Go, and .NET instead of relying on filenames alone.
- Failed impacted tests receive bounded reruns for explicit stable-fail versus
  flaky classification. Any observed failure remains fail-closed evidence.
- Typed Python functions can produce inactive Hypothesis regression candidates
  stored with run evidence; generated tests never silently enter the patch.
- Repository-native Ruff, mypy, TypeScript, ESLint, Clippy, Go vet, and .NET
  analyzer adapters run only when their exact token prefix is already approved.
  Existing structured diagnostics drive repair prompts.
- Successful deep candidates receive bounded file-level patch minimization.
  Every attempted reduction must pass the full verifier and a fresh reviewer
  verdict before the smaller patch remains eligible.

## Phase 4 — evaluation and learning — complete

- Checkpointed repeated-trial evaluation with score confidence intervals, task
  attempts, safety violations, timeout rates, wall time, and token accounting.
- Separate development and held-out baselines/candidates with fingerprint
  matching and non-overlapping confidence-bound promotion gates.
- Quality/latency/token/timeout/safety Pareto scoring, with dominated candidates
  excluded from promotion when configured.
- Observable trajectory export to SFT, DPO/preference, router, and manifest
  datasets without exporting hidden reasoning.
- Deterministic task-lane router candidates, explicit promotion, and runtime
  model/profile resolution that fails closed when a promoted target is missing.

## Phase 5 — integrations

- MCP client and server adapters.
- GitHub issue/PR workflows.
- Remote execution workers.
- Editor protocol adapters built on the typed bridge; no bundled web dashboard.

## Exit criteria for “production ready”

- No known repository escape or shell injection path.
- Reproducible evaluations across supported platforms.
- Crash-safe run recovery.
- Audit trail for every write and command.
- Statistically defensible promotion process.
- Demonstrated gains on public and private held-out tasks.
