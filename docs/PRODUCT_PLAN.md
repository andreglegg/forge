# Forge product plan

## Product objective

Forge should make local 5B–40B coding models useful on real repositories by supplying the repository understanding, bounded execution, verification, recovery, and auditability that the model does not provide reliably on its own.

The product is successful when a user can point Forge at a maintained multi-package repository, give it a bounded engineering task, review or isolate the resulting work, and trust that Forge located the relevant code, changed only what it understood, ran the right checks, retained evidence, and did not report success over a failing project.

## Product principles

1. Mechanisms before prompt growth. Repository indexes, dependency edges, test selection, typed retries, and isolation are preferred over adding more prose to the model context.
2. One semantic action boundary. Text directives, native provider tools, future MCP tools, and IDE clients must normalize into the same permissioned and journalled action model.
3. Evidence before completion. The model's claim is advisory; repository state, verification, and retained events are authoritative.
4. Safe autonomy is graduated. Read-only, plan, attended workspace, isolated autonomous, and promoted execution are distinct capability levels.
5. Real-project performance is the release criterion. Coding exercises remain useful diagnostics, but product promotion requires sustained multi-file repository evidence.

## Workstreams

### A. Project intelligence

Goal: give small models enough deterministic repository understanding to make correct multi-file changes without flooding their context.

1. Git-ignore-aware repository catalog and bounded deep navigation. **Shipped.**
2. Relative module dependency graph with inbound dependents, outbound dependencies, package ownership, and related tests. **Shipped.**
3. Revision-bound TypeScript/JavaScript declarations, syntax references, and checker-resolved direct callers. **Shipped.** Python and Go adapters remain planned.
4. Evidence-triggered semantic context assembly using exact symbols, direct callers, syntax references, and module dependencies. **Shipped for explicitly named TypeScript/JavaScript symbols.**
5. Change-impact analysis that maps modified files to affected packages and candidate tests. **Shipped for deterministic Node test commands.**
6. Read-only investigation workers that return evidence rather than mutations.

### B. Reliable execution

Goal: make every attempted change bounded, recoverable, independently checked, and able to improve after a failure.

1. Transactional files, commands, sessions, undo, verification, and isolated Git promotion. **Shipped.**
2. Failure-class-specific recovery guidance and retry budgets for syntax, type, test, timeout, toolchain, infrastructure, flaky, and unknown verification failures. **Shipped, including deterministic no-progress stopping.**
3. Verification planning: focused checks during development, authoritative project gates before completion. **Shipped for deterministic Node test commands.**
4. Execution-backend interface separating host, Git-worktree, and container execution. **Shipped.**
5. Optional Docker/Podman backend with network-off default, repository-only mounts, a read-only container root, and CPU/memory/process/tmpfs limits. **Shipped.**
6. Stronger dependency-confusion, secret, workflow, and generated-file analysis before promotion. **Shipped for the documented tier-2 deterministic scan; broader analysis remains planned.**

### C. Integration surface

Goal: make Forge usable from terminals, editors, local automation, and external tool ecosystems without bypassing its safety model.

1. Versioned stream/result protocol and long-running local server mode. **Shipped over stdio NDJSON.**
2. IDE client contract for tasks, approvals, events, diffs, verification, resume, and cancellation.
3. MCP client support routed through Forge permissions, timeout/output bounds, and audit events. **Shipped for stdio tools.**
4. Small versioned extension API for skills, repository analyzers, and verification adapters. **First slice shipped: project skills, verification adapters, and `beforeCompletion`.**
5. GitHub issue and pull-request workflows built on isolated execution and explicit promotion. **First slice shipped: issue import and fresh verified draft PRs.**

### D. Release maturity

Goal: turn the alpha into a supportable daily-use developer tool.

1. Versioned configuration, session, event, and extension schemas with migrations.
2. Crash and interruption tests across every durable boundary.
3. Cross-platform isolated execution and reproducible release CI.
4. Signed packages, provenance, update policy, security reporting, and deprecation policy.
5. Current-model comparisons and a retained real-repository evaluation suite.

## Milestone sequence

### Milestone 1 — dependency-aware projects

- Add a bounded module relationship index.
- Expose a read-only `RELATED <path>` action with text/native parity.
- Report package ownership, direct dependencies, inbound dependents, and related tests.
- Use proven relationships when following context from a named file.
- Demonstrate the action end to end in a deep multi-file project.

Exit: Forge can answer “what depends on this file, what does it depend on, and which tests are closest?” without model-authored shell commands.

### Milestone 2 — symbols and references

- Add deterministic TypeScript/JavaScript declaration extraction. **Shipped.**
- Expose `SYMBOL <name>` with exact source locations, export status, and revision binding. **Shipped.**
- Expose bounded `REFERENCES <name>` syntax references with exact revision-bound locations. **Shipped.**
- Add checker-resolved direct caller lookup with alias and lexical-scope awareness. **Shipped.**
- Combine caller, reference, and dependency evidence with automatic context selection. **Shipped for explicitly named code-shaped symbols.**

Exit reached: when a task explicitly names a TypeScript/JavaScript symbol, Forge can automatically surface its declaration, direct caller, syntax-reference, and one-hop dependency files even when filenames do not contain the task vocabulary. Ordinary prose remains on the lightweight lexical path.

### Milestone 3 — change-aware verification

- Record files changed by the current run. **Shipped.**
- Map changes to package roots, inbound dependency closure, and candidate tests. **Shipped.**
- Feed the bounded impact plan into the next model turn and retain it in headless machine results. **Shipped.**
- Run deterministically narrowed Node test commands automatically while iterating, then the configured authoritative gate before accepting completion. **Shipped.**
- Persist which focused commands ran, why, and their complete verification reports. **Shipped.**

Exit reached for the supported boundary: Forge identifies affected packages/tests, narrows only recognized configured Node test commands, executes them once during iteration, persists the evidence, and still requires the authoritative completion gate. Broader language adapters remain future work.

### Milestone 4 — typed recovery

- Classify verification failures into syntax, type, test, timeout, toolchain, infrastructure, flaky, and unknown classes. **Shipped.**
- Attach one bounded class-specific recovery directive to model feedback. **Shipped.**
- Add action/no-progress classification and automatic bounded retry execution. **Shipped for verification-gate failures.**
- Stop retries on repeated unchanged verification output or exhausted per-class budgets. **Shipped.**
- Measure recovery rate and false-success rate. **Planned.**

Exit reached for verification-gate recovery: retries are mechanism-driven rather than a generic fresh prompt. Broader action-loop recovery measurement remains planned.

### Milestone 5 — isolated execution backends

- Introduce an execution-backend interface without changing Run semantics. **Shipped.**
- Keep the current host and Git-worktree implementations. **Shipped.**
- Add an optional container backend with restrictive defaults and explicit capability reporting. **Shipped for Docker and Podman.**

Exit reached as an opt-in boundary: autonomous commands can run without inheriting unrestricted host process and network access. Default-isolated unattended execution remains a 1.0 criterion.

### Milestone 6 — stable service boundary

- Version durable events and final results.
- Add a local server with task, event stream, approval, cancellation, resume, and health endpoints.
- Prove a thin external client can drive a complete run without importing CLI internals.

Exit: IDE and automation clients consume a documented stable protocol.

### Milestone 7 — extension and MCP boundary

- Add permissioned external read tools first.
- Add versioned analyzer and verification adapters.
- Add MCP client support only through the same action, approval, timeout, and journal boundaries.

Exit: extensions cannot silently bypass repository containment or audit history.

## Overnight implementation order

Each pass must inspect the latest repository state, preserve unrelated work, implement one coherent tested slice, run focused checks, run the full relevant gate, review the final diff, update current documentation, and commit. Do not push automatically.

1. Dependency relationships and `RELATED`. **Completed.**
2. TypeScript/JavaScript symbol declarations and exact locations. **Completed.**
3. Syntax reference lookup. **Completed.**
4. Semantic caller resolution. **Completed.**
5. Dependency-backed automatic context selection. **Completed.**
6. Change-impact model and focused verification execution. **Completed for deterministic Node test commands.**
7. Verification failure classification and one bounded recovery directive. **Completed.** Automatic retry execution and no-progress classification remain.
8. Execution-backend interface around existing host/worktree behavior. **Completed.**
9. Versioned server/event contract foundation. **Completed.**

## 1.0 product exit criteria

- No known repository escape or shell-injection path.
- Isolated execution is the default for unattended mutation and command work.
- Every write, command, permission, external tool call, verification, and promotion is audit-visible.
- Configuration, sessions, events, and extensions have stable versioned schemas and migrations.
- Supported operating systems pass the same reproducible mechanism suite.
- A retained real-repository benchmark demonstrates multi-file task completion, correct affected-test selection, low false-success rate, crash recovery, and safe promotion.
- Security review, update policy, support policy, and deprecation policy are published.
