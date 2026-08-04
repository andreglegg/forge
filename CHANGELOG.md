# Changelog

All notable product changes are recorded here. Forge follows semantic versioning from the 0.1 public-alpha line onward.

## 0.1.0 — 2026-08-04

### Added

- Installable `forge` npm binary metadata.
- `forge --version` and `forge version`.
- Cross-platform Node CI for Linux, macOS, and Windows.
- Package dry-run validation in CI.
- Current TypeScript architecture, security, and feature-status documentation.

### Reliability baseline

- Independent verification with confirmation of a passing suite.
- Crash-tolerant sessions, traces, replay, and revision-guarded undo.
- Shell-free repository command execution, including validated repository working-directory commands.
- Infrastructure-aware Polyglot reporting.

### Known limitations

- No OS-level sandbox or automatic disposable-worktree promotion.
- No MCP, plugin, hook, or remote-worker API.
- Session resume restores observable history but not an in-flight provider request.
