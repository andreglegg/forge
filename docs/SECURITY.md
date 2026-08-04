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

### Isolated Git worktrees

- `forge run --isolate` requires the selected path to be the Git root and the entire working tree to be clean, including untracked files.
- The run executes against a detached temporary worktree created from the current commit.
- Tracked edits and non-ignored new files are captured as a binary-capable Git patch under `.forge/isolated/` in the original repository.
- Without `--promote`, the original working tree is never changed.
- `--promote` is incompatible with `--no-verify`. Promotion rechecks the original HEAD, requires the original tree to remain clean, runs `git apply --check`, and only then applies the patch.
- Before promotion, added patch lines are scanned for likely credentials/private keys, package install lifecycle scripts, privileged/download-to-shell workflows, and dependency metadata changes. Critical findings retain the patch and block promotion unless the user explicitly supplies `--allow-risk` after review.
- Session, trace, and retained-object evidence is copied back before the temporary worktree is removed.

### Explicit lifecycle hooks

- Hook commands in `forge.json` never execute automatically. The user must add `--hooks` to a headless `forge run` or `forge plan` invocation.
- Hook commands are token arrays, run with `shell: false`, a scrubbed environment, bounded output, and a 60-second timeout.
- `sessionStart`, `beforeVerify`, `afterVerify`, and `sessionEnd` failures are authoritative and fail the run or final exit.
- Hooks receive only bounded Forge metadata through `FORGE_HOOK_EVENT`, `FORGE_SESSION_ID`, and optional `FORGE_VERIFIED`.
- Hooks are still arbitrary repository-controlled programs. Enabling them has the same host-code-execution implications as approving a repository test command.

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
- complete dependency-confusion analysis or a guarantee that heuristic patch scanning finds every secret;
- a third-party plugin or MCP permission boundary;
- interactive lifecycle hooks or a versioned third-party hook API.

Do not run Forge with elevated privileges or use autonomous approval on an untrusted repository. Git-worktree isolation protects the user's selected checkout from unpromoted edits, but it does not isolate processes, network, credentials available outside Forge's scrubbed command environment, or the host filesystem.

## Production-hardening direction

The next execution-backend layer is optional container isolation with network-off defaults, resource limits, and read-only host mounts. External tools, MCP servers, and plugins must pass through the same permission, timeout, output-bound, and audit-journal boundaries as built-in tools. The shipped headless hooks are repository commands, not yet a general extension API.

Security reports should include a reproducible case and affected version. Do not include real credentials or private repository content.
