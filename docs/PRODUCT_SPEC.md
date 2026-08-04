# Product specification

## Product vision

Forge Harness is a local-first, provider-neutral coding agent that converts a relatively weak language model into a more dependable software-engineering system by surrounding it with deterministic repository tools, focused context, role separation, verification, memory, and measured policy optimization.

The product is not defined by a single model. The harness must continue to work when the user changes from a 5B local model to a 40B model, a remote API, or a routed mixture of models.

## Primary users

- Individual developers with consumer GPUs or Apple Silicon.
- Teams that need private, on-premises coding assistance.
- Researchers comparing local coding models under one agent policy.
- Product builders embedding a coding agent into another system.

## Core user journeys

### Repository task

The user points Forge at a Git repository and gives a goal. Forge maps the repository, retrieves relevant context, plans the task, performs bounded edits and commands, verifies the result, obtains an independent review, and returns an evidence-backed status.

### Failure recovery

When tests fail or the reviewer rejects the patch, Forge feeds the exact evidence back to the executor and performs a bounded repair round. It reports incomplete work truthfully when budgets are exhausted.

### Harness evaluation

The user runs a versioned suite of repository fixtures and tasks. Forge isolates every task, records task-level outcomes, and produces a score with timeout and safety metrics.

### Policy improvement

The user asks Forge to evaluate bounded policy candidates. Forge compares them against the baseline on the same suite and marks only evidence-qualified candidates as eligible. The user explicitly promotes a candidate and can roll back to the previous policy.

## Functional requirements

### Provider layer

- OpenAI-compatible chat-completions transport.
- Configurable base URL, model, API-key environment variable, timeout, and retry count.
- Thin adapter boundary so native tool calling or other APIs can be added later.
- No provider-specific assumptions in repository, tool, evaluation, or memory modules.

### Repository understanding

- Ignore generated and dependency directories by default.
- Produce a compact file/symbol map.
- Retrieve task-relevant files within a hard context budget.
- Read text safely with size limits and replacement decoding.
- Future: language-aware syntax graph and hybrid retrieval.

### Agent loop

- Separate planner, executor, reviewer, and reflector roles.
- Strict JSON schemas with unknown-field rejection.
- Bounded correction attempts for malformed planner/reviewer output.
- One executor tool action per model turn.
- Hard limits on steps, review rounds, changed files, output, and runtime.
- No hidden-chain-of-thought persistence; only concise decision summaries.

### Tools

- List files, read line ranges, literal search, atomic full-file write, exact replacement, command execution, git status, and complete diff including untracked files.
- Canonical repository-root enforcement.
- Denied secret and Git-internal paths.
- Token-array commands with `shell=False` and prefix allowlisting.
- Bounded command environment, time, and output.

### Verification and review

- Ordered configured verification commands.
- Full output returned to the agent within output caps.
- External reviewer receives task, plan, claim, status, diff, and verification evidence.
- Success requires reviewer approval, verification success, and no safety violations.

### Memory

- Repository-scoped SQLite store.
- Deduplicated concise lessons with confidence and source run.
- Persist lessons only from successful, verified runs.
- Never store secrets, hidden reasoning, or large code excerpts.

### Evaluation

- YAML suites with isolated repository fixtures.
- External verification independent from the agent's claim.
- Weighted score, timeout rate, and safety-violation count.
- Suite fingerprint stored with every result.
- Future: repeated trials, confidence intervals, and container isolation.

### Self-improvement

- Deterministic bounded candidate generation.
- Same-suite comparison against a frozen baseline.
- Minimum tasks, score-gain, timeout-regression, and zero-safety-violation gates.
- Explicit promotion only.
- Persist the complete promoted profile and evidence location.
- Automatically load the active profile for later runs.
- Never permit a candidate to change its own evaluator or promotion rules.

## Non-functional requirements

### Safety

- No repository escape through absolute paths, traversal, or symlinks.
- No shell interpolation of model-controlled strings.
- No silent destructive Git actions.
- No network access by default in the eventual production sandbox.

### Reliability

- Every side effect represented in an event record.
- Idempotent or atomic writes where possible.
- Crash-safe resume is required before production-ready status.
- Truthful incomplete outcomes instead of fabricated success.

### Portability

- Python 3.11+.
- macOS, Linux, and Windows support.
- Model server can run locally or remotely.
- No mandatory CUDA or vendor-specific runtime.

### Observability

- Stable run identifier.
- Persist task, configuration fingerprint, plan, raw role outputs, tool events, verification, reviews, final diff, and final status.
- Future: OpenTelemetry traces and structured terminal streaming.

### Performance

- Repository mapping should remain usable on large repositories through ignores, size limits, and future incremental indexes.
- Context must be budgeted before provider calls.
- Repeated unchanged context should eventually use provider prompt caching where available.

## Definition of done for a coding run

A run is successful only when all conditions hold:

1. The agent produced a task-scoped patch.
2. Configured verification commands passed.
3. The independent reviewer approved the evidence.
4. Changed-file limits were respected.
5. No policy or safety violation occurred.
6. Final status, diff, and evidence were persisted.

## Explicit non-goals for the MVP

- Autonomous source-code self-rewriting.
- Unattended production deployment.
- Arbitrary host-computer control.
- Training or modifying model weights inside the CLI.
- Claiming benchmark superiority without reproducible evidence.
- Supporting every language-specific build system automatically.
