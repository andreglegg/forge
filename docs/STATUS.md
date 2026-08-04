# Current product status

This table describes the executable TypeScript product in `src/`.

| Capability | Status | Notes |
| --- | --- | --- |
| Interactive terminal chat | Shipped | Streaming output, inline approvals, persistent transcript within the process. |
| Headless runs | Shipped | Stable exit codes, `--yes`, JSON result document. |
| OpenAI-compatible providers | Shipped | Model discovery through `/v1/models`. |
| Native OpenAI/Anthropic tools | Shipped | Optional `--native`; normalized into the same action protocol. |
| Repository reads/search/grep | Shipped | Canonical-root containment and bounded output. |
| Anchored edits | Shipped | Preview, approval, revision revalidation, commit. |
| Command execution | Shipped | Token arrays, no shell, reduced environment, timeout and process-group termination. |
| Verification gate | Shipped | Detected/configured commands and confirmation of a passing suite. |
| Sessions/show/undo | Shipped | Crash-tolerant repository-local journals and revision-guarded undo. |
| Interactive session resume | Shipped | `/resume [id]` restores observable trace and tool evidence. |
| Decoder replay | Shipped | Offline conversion/repair measurement from retained traces. |
| Benchmark and Polyglot adapters | Shipped | Reproducible identities, resume, comparisons, infrastructure classification. |
| npm package | Alpha | Package metadata and cross-platform release CI exist; publication is still manual. |
| Doctor/init/config commands | In progress | Planned for the 0.1 productization cycle. |
| Read-only/plan permission modes | In progress | Must be enforced by capability, not prompt alone. |
| Stream-JSON event protocol | Planned | Existing final `--json` is not an event stream. |
| Disposable Git worktrees | Planned | Current runs edit the selected working tree directly. |
| Container/VM sandbox | Planned | No OS-level isolation today. |
| MCP, hooks, plugins | Planned | No extension API in the TypeScript core today. |
| Remote workers / IDE protocol | Planned | Expected to consume a future stable event/tool boundary. |
| Full-screen TUI | Not planned for 0.1 | The scrollback-native terminal remains the primary interface. |

Historical documents may describe experiments or superseded Python implementations. They are evidence, not current product contracts.
