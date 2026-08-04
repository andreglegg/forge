# Current product status

This table describes the executable TypeScript product in `src/`.

| Capability | Status | Notes |
| --- | --- | --- |
| Interactive terminal chat | Shipped | Streaming output, inline approvals, persistent transcript within the process. |
| Headless runs | Shipped | Stable exit codes, `--yes`, JSON result document. |
| OpenAI-compatible providers | Shipped | Model discovery plus a minimal completion preflight that catches inactive runtime profiles before coding begins. |
| Native OpenAI/Anthropic tools | Shipped | Optional `--native`; normalized into the same action protocol. |
| Repository reads/search/grep | Shipped | Canonical-root containment and bounded output. |
| Anchored edits and file deletion | Shipped | Edits and `DELETE <path>` are previewed before approval, revalidated against the approved revision, journalled, and undoable. Deletion is limited to individual regular files; directories and symlinks are refused. |
| Command execution | Shipped | Token arrays, no shell, reduced environment, timeout and process-group termination. |
| Verification gate | Shipped | Detected/configured commands and confirmation of a passing suite. |
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
