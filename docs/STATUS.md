# Current product status

This table describes the executable TypeScript product in `src/`.

| Capability | Status | Notes |
| --- | --- | --- |
| Interactive terminal chat | Shipped | Streaming output, inline approvals, persistent transcript within the process. |
| Headless runs | Shipped | Stable exit codes, `--yes`, JSON result document. |
| OpenAI-compatible providers | Shipped | Model discovery plus a minimal completion preflight that catches inactive runtime profiles before coding begins. |
| Native OpenAI/Anthropic tools | Shipped | Optional `--native`; normalized into the same action protocol. |
| Project-scale repository navigation | Shipped | Git-ignore-aware index up to 50,000 entries, compact project maps, one-level `LIST`, deep `GLOB`/`GREP`/`SEARCH`, ranged `READ`, binary/secret filtering, and text/native parity. Proven end to end on a 225-file deep project. |
| Dependency-aware project relationships | Shipped | `RELATED <path>` reports package ownership, static relative TypeScript/JavaScript dependencies, inbound dependents, and nearby tests. Scans are bounded to 10,000 supported files and 512 KiB per file; package imports and path aliases are not yet resolved. The same resolver improves one-hop task context. |
| Revision-bound symbol declarations | Shipped | `SYMBOL <name>` parses TypeScript/JavaScript with a pinned compiler API and reports exact top-level declarations plus named class/interface/enum members with line/column ranges, export status, and source revision. Syntax-only: semantic aliases, locals, inferred types, and references remain planned. |
| Transactional filesystem operations | Shipped | Anchored edits plus `DELETE`, `MKDIR`, `MOVE`, `COPY`, and `RENAME` support files, bounded directory trees, binary content, and symlinks. Operations are previewed, separately approved, snapshot-revalidated, journalled per entry, and binary-safe undoable. Destinations must be absent; repository metadata roots are protected. |
| Command execution | Shipped | Token arrays, no shell, reduced environment, timeout and process-group termination. |
| Verification gate | Shipped | Detected/configured commands and confirmation of a passing suite. Node detection understands npm/pnpm/Yarn/Bun and prefers `check`; configured checks can safely select repository subdirectories for monorepos. |
| Sessions/show/undo | Shipped | Crash-tolerant repository-local journals and revision-guarded undo. |
| Interactive session resume | Shipped | `/resume [id]`, `forge continue [id]`, and `forge resume [id]` restore observable trace and tool evidence. |
| Evidence-preserving compaction | Shipped | Long transcripts retain stable setup, newest turns, prior failures, source locations, and explicit user constraints under a deterministic character budget. |
| Decoder replay | Shipped | Offline conversion/repair measurement from retained traces. |
| Benchmark and Polyglot adapters | Shipped | Reproducible identities, resume, comparisons, infrastructure classification. |
| npm package | Alpha | Package metadata and cross-platform release CI exist; publication is still manual. |
| Doctor/init/config commands | Shipped | Strict `forge.json` validation, idempotent initialization, resolved config output, verifier detection, and live provider/model diagnostics. |
| Named model profiles | Shipped | Project profiles carry endpoint, model, context/output budgets, temperature, native protocol, and turn budget; explicit CLI/environment values override them. |
| Read-only/plan permission modes | Shipped | Enforced by the Run actor before preview, approval, or execution; `--yes` cannot bypass them. |
| Stream-JSON event protocol | Shipped | `--stream-json` emits durable Run events as JSONL followed by one result record. |
| Disposable Git worktrees | Shipped (opt-in) | `forge run --isolate` requires a clean Git root, executes in a detached temporary worktree, retains a binary patch, and transfers session evidence. `--promote` applies only a verified, conflict-checked patch. |
| Promotion risk scan | Shipped | Added patch lines are checked for likely secrets, install lifecycle scripts, dangerous workflows, and dependency metadata. Critical findings block promotion unless explicitly overridden with `--allow-risk`. |
| Headless lifecycle hooks | Shipped (opt-in) | `sessionStart`, `beforeVerify`, `afterVerify`, and `sessionEnd` token-array commands run only with `--hooks`; failures are authoritative and reported in machine output. |
| Container/VM sandbox | Planned | No OS-level isolation today. |
| MCP and plugin API | Planned | No third-party tool/extension boundary in the TypeScript core today. |
| Remote workers / IDE protocol | Planned | Expected to consume a future stable event/tool boundary. |
| Full-screen TUI | Not planned for 0.1 | The scrollback-native terminal remains the primary interface. |

Historical documents may describe experiments or superseded Python implementations. They are evidence, not current product contracts.
