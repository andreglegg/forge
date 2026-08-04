# Forge product roadmap

This roadmap applies to the current TypeScript product. See `STATUS.md` for the shipped feature matrix.

## 0.1 public alpha

- Publishable npm package and cross-platform Node CI.
- `version`, `doctor`, `init`, and resolved `config` commands.
- Provider/model compatibility preflight with actionable diagnostics.
- Top-level `continue` and `resume` commands built on retained sessions.
- Read-only and plan permission modes enforced at the tool/effect boundary.
- JSONL event output for automation.
- Current architecture, security, and operations documentation.

## 0.2 trusted daily use

- Disposable Git-worktree execution with verified, reviewed promotion.
- Execution-backend interface with optional Docker/Podman isolation.
- Network-off defaults and resource limits for sandbox backends.
- Evidence-preserving semantic context compaction.
- Failure-class-specific retries.
- Model profiles selected from detected provider/model capabilities.
- Dependency-change and likely-secret warnings.

## 0.3 integration surface

- Versioned lifecycle-hook API.
- MCP client support through Forge permissions, timeouts, output bounds, and audit events.
- Small skill and verification-adapter API.
- Stable stream protocol and server mode for IDEs and local automation.
- GitHub issue and pull-request workflows.
- Read-only research subagents for independent repository investigation.

## 1.0 exit criteria

- No known repository escape or shell-injection path.
- Default isolated execution for autonomous mode.
- Reproducible evaluation across supported operating systems.
- Crash-safe session continuation and schema migrations.
- Audit trail for every write, command, permission, external tool, and promotion.
- Stable configuration, event, and extension schemas.
- Security review and documented support/deprecation policy.
- Current-model head-to-head evaluation against relevant local coding agents.
- Evidence from sustained use on real multi-file repositories, not only coding exercises.

## Product principle

New capabilities are promoted only after deterministic mechanism tests and focused evaluation. Prompt growth, larger turn budgets, and broad autonomy are not assumed to help small models; Forge's retained evidence has repeatedly shown that mechanisms outperform additional guidance.
