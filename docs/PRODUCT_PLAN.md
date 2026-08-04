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
3. Revision-bound TypeScript/JavaScript declaration index. **Shipped.** Semantic references/callers, then Python and Go adapters, remain planned.
4. Change-impact analysis that maps modified files to affected packages and candidate tests.
5. Budgeted semantic context assembly using dependency, symbol, failure, and recent-change evidence.
6. Read-only investigation workers that return evidence rather than mutations.

### B. Reliable execution

Goal: make every attempted change bounded, recoverable, independently checked, and able to improve after a failure.

1. Transactional files, commands, sessions, undo, verification, and isolated Git promotion. **Shipped.**
2. Failure-class-specific retry policies for syntax, type, test, timeout, toolchain, and no-progress failures.
3. Verification planning: focused checks during development, authoritative project gates before completion.
4. Execution-backend interface separating host, Git-worktree, and container execution.
5. Optional Docker/Podman backend with network-off default, restricted user, read-only host mounts, and CPU/memory/process/disk limits.
6. Stronger dependency-confusion, secret, workflow, and generated-file analysis before promotion.

### C. Integration surface

Goal: make Forge usable from terminals, editors, local automation, and external tool ecosystems without bypassing its safety model.

1. Versioned stream/result protocol and long-running local server mode.
2. IDE client contract for tasks, approvals, events, diffs, verification, resume, and cancellation.
3. MCP client support routed through Forge permissions, timeout/output bounds, and audit events.
4. Small versioned extension API for skills, repository analyzers, and verification adapters.
5. GitHub issue and pull-request workflows built on isolated execution and explicit promotion.

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
- Add semantic references/callers and combine them with dependency evidence. **Next.**

Partial exit reached: Forge can locate exact declarations even when filenames do not contain the task vocabulary. Full exit requires reference/caller lookup.

### Milestone 3 — change-aware verification

- Record files changed by the current run.
- Map changes to package roots, inbound dependency closure, and candidate tests.
- Run focused checks while iterating, then the configured authoritative gate before accepting completion.
- Persist the verification plan and why each command ran.

Exit: monorepo work no longer requires running every package after each small edit, while final completion remains authoritative.

### Milestone 4 — typed recovery

- Classify verification and action failures.
- Apply bounded retry strategies per class.
- Stop retries on infrastructure failures, repeated unchanged actions, or exhausted evidence.
- Measure recovery rate and false-success rate.

Exit: retries are mechanism-driven rather than a generic fresh prompt.

### Milestone 5 — isolated execution backends

- Introduce an execution-backend interface without changing Run semantics.
- Keep the current host and Git-worktree implementations.
- Add an optional container backend with restrictive defaults and explicit capability reporting.

Exit: autonomous commands can run without inheriting unrestricted host process and network access.

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
3. Reference lookup and dependency-backed context selection. **Next.**
4. Change-impact model and focused verification planning.
5. Failure classification and one bounded retry strategy.
6. Execution-backend interface around existing host/worktree behavior.
7. Versioned server/event contract foundation.

## 1.0 product exit criteria

- No known repository escape or shell-injection path.
- Isolated execution is the default for unattended mutation and command work.
- Every write, command, permission, external tool call, verification, and promotion is audit-visible.
- Configuration, sessions, events, and extensions have stable versioned schemas and migrations.
- Supported operating systems pass the same reproducible mechanism suite.
- A retained real-repository benchmark demonstrates multi-file task completion, correct affected-test selection, low false-success rate, crash recovery, and safe promotion.
- Security review, update policy, support policy, and deprecation policy are published.
