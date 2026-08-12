# Changelog

All notable product changes are recorded here. Forge follows semantic versioning from the 0.1 public-alpha line onward.

## Unreleased

### Added

- Bounded retry budgets for a failing completion gate, with per-failure-class limits and a no-progress stop when a failure repeats unchanged. A stopped run is always a failed run.
- Optional container execution backends (`--sandbox docker|podman`, `--image`, `--sandbox-network`, or an `execution` block in `forge.json`) for model commands and verification: repository-only mount, network off by default, no host path environment.
- Container resource bounds and a read-only root: sandboxed commands default to 4096 MiB memory (swap pinned equal), 2 CPUs, and 512 processes, with a read-only root filesystem beside a writable `/workspace` and a bounded `/tmp` tmpfs that also carries `HOME`, fixing dependency-cache writes under Docker's user mapping. Overridable per project (`execution.memoryMiB`/`cpus`/`pids`/`tmpfsMiB`/`readOnlyRoot`/`limits`) and per run (`--sandbox-memory`, `--sandbox-cpus`, `--sandbox-pids`, `--sandbox-writable-root`, `--sandbox-no-limits`); flags win so an operator can contain a run without editing a file the model can edit. An image name that would parse as a runtime option, and a tmpfs larger than the memory bound, are rejected by name.
- Versioned event contract: a `contract` first line on `--stream-json`, a `contract` field in the `--json` result, and a `forge contract` command.
- Project skills and verification adapters: `.forge/skills/*.md` documents are keyword-selected deterministically into context (at most one, never always-on, charged to the existing budget and recorded in the context receipt), and `verifyAdapters` in forge.json lets a project fail an exit-0 verify command by pattern (`failWhen`) or reshape its failure evidence — the gate can only get stricter; no field exists that converts a failure into a pass. Adapter-matched lines are clipped before they reach the model, and an adapter naming a command absent from `verify` is a hard config error.
- MCP client through Forge permissions: stdio MCP servers declared in `forge.json` and enabled only by `--mcp` expose their tools to the model as `MCP <server> <tool> [json]` through the same action protocol, schema validation, approval flow (scoped `mcp:<server>:<tool>` classes), timeout, and 16k output clip as built-in tools, with ordinary journal audit events. The hand-rolled JSON-RPC client bounds everything — 1 MiB lines, 32 tools, one outstanding call — spawns servers as credential-scrubbed token arrays, freezes the tool set at startup, and fails the run loudly before provider contact if a declared server is broken. Server output is untrusted inert text.
- Extension API 1.0 (contract 1.3): a strict `extensions` manifest in forge.json plus explicit `--extensions` on headless runs. Extensions are subprocesses behind the same boundary as every command — token arrays, no shell, scrubbed environment, group-kill timeout, bounded output — with request/result files in a tempdir outside the repository. The one lifecycle point, `beforeCompletion`, lets an extension reject a completion into a bounded reopen (two per run) or fail it; every protocol failure fails closed, an extension can tighten but never approve or loosen, a declared api Forge does not implement is refused before preflight, and the startup manifest snapshot is immune to mid-run forge.json edits. Every crossing is journalled as paired `extension.invoked`/`extension.resolved` audit events.
- `forge serve` (contract 1.2): the versioned event stream becomes bidirectional over stdio NDJSON. The contract header is the first line even when preflight fails; client input is the closed request set `run.start`/`approve`/`cancel`/`shutdown`, advertised in the header — malformed or unknown requests get an error envelope and never touch the active run. Approvals in a served run resolve only by explicit client decision, `--yes`, or disconnect (deny-and-cancel, nonzero exit); permission model, gate, retry budgets, and journalling are identical to `forge run`. This is the service boundary IDE clients, MCP, and the extension API build on.
- Promotion risk scan tier 2: lookalike dependency substitutions (edit distance 1 against a removed manifest name), dependencies resolved from git/local/tarball sources (plain-http critical), unpinned `*`/`latest` specifiers, prepare-family lifecycle scripts, Slack/Stripe/Google/JWT credential prefixes, and quoted high-entropy tokens with lockfile/hash/minified suppression. Deterministic and offline; criticals still block promotion without `--allow-risk`. Review-driven precision fixes are pinned by test: benign script renames and quoted paths/commit SHAs stay unflagged.
- Capability-aware profile recommendations: `forge doctor` cross-checks configured named profiles against what the endpoint's preflight probe advertises (model ids, and the selected model's context window — a per-model claim, never applied endpoint-wide) and names the best-fitting profile with the reason. Advisory only: nothing is written, exit codes are unchanged, adoption stays an explicit `--profile` or forge.json edit, and the recommendation never enters model context.
- Compaction telemetry (contract 1.1): every turn whose transcript the context guard actually altered emits one durable `context.compacted` event carrying deterministic counters — kept/omitted messages and characters, evidence priorities, dedup and clip flags — never evicted content. The bytes sent to the provider are unchanged; a byte-identity test enforces that this telemetry claims no score effect.

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
- A completion is refused when a path the task named does not exist. Verification runs the project's existing commands and cannot notice a file that was never written; observed live, a model skipped a named test file, claimed completion, and was believed because the pre-existing suite was green.
- A stalled reply in a run that has already committed changes now says so, instead of the generic no-action message, so a model that finished the work but never claimed completion can be gated rather than failed.
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
