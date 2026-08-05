# Changelog

All notable product changes are recorded here. Forge follows semantic versioning from the 0.1 public-alpha line onward.

## Unreleased

### Added

- Bounded retry budgets for a failing completion gate, with per-failure-class limits and a no-progress stop when a failure repeats unchanged. A stopped run is always a failed run.
- Optional container execution backends (`--sandbox docker|podman`, `--image`, `--sandbox-network`, or an `execution` block in `forge.json`) for model commands and verification: repository-only mount, network off by default, no host path environment.
- Versioned event contract: a `contract` first line on `--stream-json`, a `contract` field in the `--json` result, and a `forge contract` command.

### Fixed

Found by driving Forge through a real ten-session build with a 14B model; see `bench/DOGFOOD_LEDGER.md`.

- A completion claimed with nothing committed is no longer accepted. A green pre-existing suite is not evidence that work happened, and such a run previously exited 0 with `ok: true`.
- Creating or editing a path that is a directory now says so and names a way out, instead of advising an edit that cannot succeed.
- `MKDIR` refuses a path whose name is a source file, which is what put a directory at `src/money.js` in the first place.
- The repetition guard repeats why an action failed, not only that it did.
- A read refused for being unchanged is permitted once when the harness itself refused the edit that read was meant to inform, removing a deadlock between the two guards.
- A missing repository-relative module is classified as a code failure rather than a broken toolchain, and Python's `No module named` spelling is recognised.
- A failed SEARCH anchor now shows the closest real lines from the file.
- The context window advertised by the endpoint is used when neither `--context` nor a profile sets one, instead of falling back to a 3000-token reply budget that truncated every large edit against a 256k-context model.
- A reply that fabricates a tool result instead of sending a tool call is recognised, recorded as `hallucinated_tool_result`, and answered with a message saying the contents were never read.

### Changed

- The verification gate returns its report alongside its objection so retries can be budgeted against what actually failed.

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
- Project-scale repository indexing with Git ignore awareness, a compact project map, one-level `LIST`, deep `GLOB`/`GREP`/`SEARCH`, exact ranged `READ`, binary/secret filtering, and bounded non-Git fallback discovery.
- Dependency-aware `RELATED <path>` inspection for static relative TypeScript/JavaScript imports, inbound dependents, nearest package ownership, and related tests, with the same resolver used for one-hop task context.
- Post-mutation change-impact planning plus automatic focused verification for recognized configured Node test commands. Candidate tests are constrained to the command package, runs and rationale are retained in headless results, unsupported commands are not guessed, and the authoritative completion gate remains unchanged.
- Evidence-triggered automatic context selection for explicitly named TypeScript/JavaScript symbols, combining exact declarations, checker-resolved callers, syntax references, and module dependencies without loading the parser for ordinary prose tasks.
- Revision-bound `SYMBOL`, syntax `REFERENCES`, and checker-resolved `CALLERS` inspection for TypeScript/JavaScript, with text/native parity, exact ranges, source revisions, relative-import alias handling, lexical-scope filtering, and deep-project end-to-end coverage.
- A published product plan covering project intelligence, reliable execution, integration boundaries, and release maturity.
- npm, pnpm, Yarn, and Bun verification detection with root `check` preference, plus shell-free package-specific verification through validated repository working directories.
- Verification failure classification for syntax, type, assertion, timeout, missing toolchain, infrastructure, flaky, and unknown failures, with one bounded class-specific recovery directive.

### Reliability baseline

- Independent verification with confirmation of a passing suite.
- Crash-tolerant sessions, traces, replay, and revision-guarded undo.
- Shell-free repository command execution, including validated repository working-directory commands.
- Infrastructure-aware Polyglot reporting.

### Known limitations

- No OS-level process, network, or resource sandbox; Git-worktree isolation protects repository mutations only.
- Static relationships do not yet resolve package imports, path aliases, or package exports. `CALLERS` is limited to checker-visible direct calls and constructors; dynamic dispatch, reflection, inferred runtime targets, and untyped calls remain unsupported.
- No MCP, general plugin, interactive-hook, or remote-worker API.
- Session resume restores observable history but not an in-flight provider request.
- Isolation is opt-in and currently available only for headless workspace-mode runs from a fully clean Git root.
