# Changelog

All notable product changes are recorded here. Forge follows semantic versioning from the 0.1 public-alpha line onward.

## 0.1.0 — 2026-08-04

### Added

- Installable `forge` npm binary metadata.
- `forge --version` and `forge version`.
- Cross-platform Node CI for Linux, macOS, and Windows.
- Package dry-run validation in CI.
- Current TypeScript architecture, security, and feature-status documentation.
- `forge doctor`, `forge init`, `forge config`, and `forge profiles` product commands.
- Strict named model profiles for endpoint, model, context/output budgets, temperature, protocol, and turn budget.
- Deterministic evidence-preserving transcript compaction for failures, source locations, constraints, and recent turns.
- Provider/model completion preflight before coding sessions.
- Capability-enforced `workspace`, `read-only`, and `plan` modes.
- `forge continue` / `forge resume` top-level session continuation.
- `--stream-json` durable event and final-result protocol.
- `forge run --isolate` detached Git-worktree execution with retained binary patches and transferred session evidence.
- `--promote` for verified, conflict-checked patch application back to the original clean checkout.
- Promotion-time patch risk scanning with an explicit `--allow-risk` override for reviewed critical findings.
- Explicit bounded headless lifecycle hooks for session start, verification boundaries, and session end.
- Transactional `DELETE`, `MKDIR`, `MOVE`, `COPY`, and `RENAME` support in text and native protocols for files, bounded directory trees, binary content, and symlinks. Includes separate approvals, snapshot revalidation, absence-aware verification, binary-safe per-entry undo, protected metadata roots, and explicit no-overwrite semantics.

### Reliability baseline

- Independent verification with confirmation of a passing suite.
- Crash-tolerant sessions, traces, replay, and revision-guarded undo.
- Shell-free repository command execution, including validated repository working-directory commands.
- Infrastructure-aware Polyglot reporting.

### Known limitations

- No OS-level process, network, or resource sandbox; Git-worktree isolation protects repository mutations only.
- No MCP, general plugin, interactive-hook, or remote-worker API.
- Session resume restores observable history but not an in-flight provider request.
- Isolation is opt-in and currently available only for headless workspace-mode runs from a fully clean Git root.
