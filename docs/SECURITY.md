# Security model

## Threat model

Repository files, user instructions, generated model output, tool output, dependency scripts, and provider responses are all untrusted. Forge is designed to reduce accidental or model-driven damage inside one repository; it is not currently an operating-system sandbox.

## Enforced controls

### Paths

- Every file operation is rooted at one canonical repository directory.
- Absolute paths, traversal, and symlink resolutions that escape the root are rejected.
- `.git`, `.forge`, common secret files, generated directories, and configured deny patterns are excluded from discovery and reading.
- Proposed edits are bound to the revision that was previewed. A changed file makes the approved proposal stale and it is refused.

### Mutations

- The model proposes an anchored replacement; Forge previews the exact result before approval.
- Approval is scoped by action class. Approving an edit does not approve command execution.
- Mutation events record before/after revisions and retained content for guarded undo.
- A final claim in a turn whose mutations failed is rejected.

### Commands

- Commands are token arrays and use `spawn` with `shell: false`.
- A narrowly supported `cd <repository-directory> && <one command>` form changes only the validated working directory; additional shell chains, redirects, pipes, and escapes are rejected.
- Commands run with a reduced environment that excludes provider credentials.
- Duration, output, and process lifetime are bounded; timeouts terminate the process group.
- In attended mode, command execution requires a separate approval. Headless execution requires the explicit `--yes` option.

### Model output and persistence

- Tool arguments are schema-validated and action counts are bounded per turn.
- Partial edit directives are never executed.
- Hidden reasoning blocks are not required or exposed; traces store observable model text, decoded actions, repairs, and results.
- Sessions and traces are repository-local under ignored `.forge` state.

### Verification

- The model's success claim is not authoritative.
- Configured or detected project checks run independently after completion.
- A passing verification is repeated once to detect an unstable pass.
- Provider and toolchain infrastructure failures are separated from coding failures in benchmark reports.

## Deliberate limitations

An approved build or test command can execute arbitrary repository-controlled code. `npm test`, `pytest`, `cargo test`, Gradle, and similar tools may run scripts written by the repository or by the model. Environment scrubbing and repository containment reduce the blast radius but do not provide process isolation.

The current TypeScript product does not yet provide:

- container, VM, seccomp, AppArmor, or restricted-user isolation;
- network denial for repository commands;
- CPU, memory, process-count, or disk quotas beyond command timeout/output bounds;
- automatic disposable Git-worktree execution and verified promotion;
- dependency-confusion or secret scanning;
- a third-party plugin or MCP permission boundary.

Do not run Forge with elevated privileges or use autonomous approval on an untrusted repository. Use a clean branch or disposable clone and review the final diff.

## Production-hardening direction

The planned execution-backend interface will add disposable Git worktrees first, followed by optional container backends with network-off defaults and resource limits. External tools, MCP servers, hooks, and plugins must pass through the same permission, timeout, output-bound, and audit-journal boundaries as built-in tools.

Security reports should include a reproducible case and affected version. Do not include real credentials or private repository content.
