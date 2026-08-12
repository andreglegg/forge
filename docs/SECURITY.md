# Security model

## Threat model

Repository files, user instructions, generated model output, tool output, dependency scripts, and provider responses are all untrusted. Forge is designed to reduce accidental or model-driven damage inside one repository; it is not currently an operating-system sandbox.

## Enforced controls

### Paths

- Every file operation is rooted at one canonical repository directory.
- Absolute paths, traversal, and symlink resolutions that escape the root are rejected.
- `.git`, `.forge`, `.codex-bridge`, dependency/build/cache directories, common secret files, `.docs`, and `.meta` are excluded from ordinary repository discovery. Exercise specifications under `.docs` are admitted only by explicit task-packet mode. The repository root plus `.git`, `.forge`, and `.codex-bridge` cannot be targeted by first-class mutations.
- Git-aware discovery uses the fixed token array `git ls-files -co --exclude-standard -z` with `shell: false`; repository content cannot change that command. Non-Git discovery does not follow directory symlinks.
- Repository inspection is bounded to 50,000 indexed entries, 2 MiB per searched file, 200 regex GREP matches, 100 literal SEARCH matches, and 16,000 characters per read. Binary files are skipped by text search and rejected by text reads.
- Static TypeScript/JavaScript relationship and symbol inspection considers at most 10,000 supported source files and 512 KiB per file. Relationship results resolve only repository-indexed relative modules and return at most 50 entries per section. Symbol results use a pinned TypeScript compiler syntax parser, return at most 100 exact declarations, and bind every location to the parsed source revision. Neither path executes repository code or consults installed dependencies.
- Whole-file replacement of an existing file requires a successful complete read of the current revision within the read bound. Ranged, clipped, failed, stale, binary, and hidden-path reads do not authorize replacement.
- Proposed mutations are bound to exact file or tree snapshots. A changed source, destination, or planned parent makes the approved proposal stale and it is refused.

### Mutations

- The model can propose anchored text edits plus explicit `DELETE`, `MKDIR`, `MOVE`, `COPY`, and `RENAME` directives. Forge previews the resulting text diff or bounded entry manifest before approval.
- Recursive traversal uses `lstat`: symlinks are copied, moved, deleted, and restored as entries rather than followed. Special files outside the regular-file/directory/symlink set are refused.
- Tree operations are capped at 10,000 entries and 128 MiB of retained content. Larger or specialized operations require an explicitly approved command and lose structured per-entry preview/undo guarantees.
- Move, copy, and rename destinations must be absent. Forge never performs an implicit overwrite; replacement requires a separately approved deletion.
- Approval is scoped by action class. Text edits, each filesystem verb, and command execution do not approve one another.
- Immediately before commit, Forge rechecks exact source, destination, and planned-parent snapshots. A concurrent change makes the approved mutation stale and it is refused.
- Binary-safe undo content is retained before a destructive commit begins. Mutation events record every affected entry, its type, basic permission mode, and before/after revisions. Undo operates in reverse order and refuses to overwrite or recursively remove later user work.
- Structured undo preserves file bytes, symlink targets, directory structure, and basic mode bits. It does not promise to preserve ownership, ACLs, extended attributes, timestamps, sparse-file layout, or hard-link identity.
- A final claim in a turn whose mutations failed is rejected.

### Commands

- Commands are token arrays and use `spawn` with `shell: false`.
- A narrowly supported `cd <repository-directory> && <one command>` form changes only the validated working directory for model commands and configured verification; additional shell chains, redirects, pipes, and escapes are rejected.
- Commands run with a reduced environment that excludes provider credentials.
- Duration, output, and process lifetime are bounded; timeouts terminate the process group.
- In attended mode, command execution requires a separate approval. Headless execution requires the explicit `--yes` option.
- Commands run on an execution backend. The default is the host, unchanged. `--sandbox docker|podman` (or `execution` in `forge.json`) runs model commands and the verification gate inside a container with only the repository mounted at `/workspace`, no network unless `--sandbox-network` is given, no host environment variables beyond locale and output-shape settings, and the invoking uid under Docker. A container runtime named without an image is a hard error before the provider is contacted, never a silent fallback to the host.

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
- Before promotion, the patch is scanned offline and deterministically for likely credentials/private keys (including Slack/Stripe/Google/JWT prefixes and quoted or assigned high-entropy tokens, with lockfile/hash/minified-file suppression), npm install- and prepare-family lifecycle scripts, privileged/download-to-shell workflows, dependency metadata changes, lookalike dependency substitutions (an added `package.json` or `requirements*.txt` name within edit distance 1 of a removed one), and dependencies resolved from git/local/tarball/plain-http sources or unpinned `*`/`latest` specifiers. Critical findings retain the patch and block promotion unless the user explicitly supplies `--allow-risk` after review.
- Session, trace, and retained-object evidence is copied back before the temporary worktree is removed.

### Explicit lifecycle hooks

- Hook commands in `forge.json` never execute automatically. The user must add `--hooks` to a headless `forge run` or `forge plan` invocation.
- Hook commands are token arrays, run with `shell: false`, a scrubbed environment, bounded output, and a 60-second timeout.
- `sessionStart`, `beforeVerify`, `afterVerify`, and `sessionEnd` failures are authoritative and fail the run or final exit.
- Hooks receive only bounded Forge metadata through `FORGE_HOOK_EVENT`, `FORGE_SESSION_ID`, and optional `FORGE_VERIFIED`.
- Hooks are still arbitrary repository-controlled programs. Enabling them has the same host-code-execution implications as approving a repository test command.

### Versioned extensions (extension API 1.0)

- Extension entries in `forge.json` never execute automatically. The user must add `--extensions` to a headless `forge run` invocation, and the manifest is snapshotted at session start, so a mid-run edit to `forge.json` (a file the model can write) cannot change the active extension set.
- Extensions are subprocesses, never code loaded into the Forge process: token arrays, `shell: false`, the same scrubbed environment as every other command (no provider credentials), bounded output, and a group-killed timeout.
- Each declared `api` is checked against the implemented extension API (1.0) before the provider is contacted; a mismatch is a hard error, never a silent skip.
- The `beforeCompletion` request and result files live in a fresh OS temp directory outside the repository. An extension can accept, or reject with a bounded reason that reopens the run (at most 2 rejects per run, then the run fails with exit 1). Any protocol failure — timeout, nonzero exit, missing or malformed result — fails the run closed. An extension can tighten an outcome; it can never approve or loosen one.
- Every crossing is journalled as `extension.invoked`/`extension.resolved` pairs under event contract 1.3.
- Extensions are still arbitrary host programs with the same host-code-execution implications as hooks, and they run on the host even when a container backend is configured for commands.

### Verification

- The model's success claim is not authoritative.
- Configured or detected project checks run independently after completion.
- A passing verification is repeated once to detect an unstable pass.
- Provider and toolchain infrastructure failures are separated from coding failures in benchmark reports.

## Deliberate limitations

An approved build or test command can execute arbitrary repository-controlled code. `npm test`, `pytest`, `cargo test`, Gradle, and similar tools may run scripts written by the repository or by the model. Environment scrubbing and repository containment reduce the blast radius but do not provide process isolation.

The current TypeScript product does not yet provide:

- VM, seccomp, AppArmor, or restricted-user isolation, or container isolation for anything other than model commands and the verification gate (benchmarks, hooks, and Git operations still run on the host);
- disk quotas (memory, CPU, and process-count bounds ship with the container backend; `--storage-opt` is storage-driver-specific and not portable across runtimes);
- semantic aliases, inferred types, overload identity, references/callers, package exports, or TypeScript path-alias resolution;
- complete dependency-confusion analysis or a guarantee that heuristic patch scanning finds every secret;
- an MCP permission boundary;
- container-backend execution of hook or extension subprocesses (both run on the host);
- extension lifecycle points beyond `beforeCompletion` (the other lifecycle hooks remain exit-code-only).

Do not run Forge with elevated privileges or use autonomous approval on an untrusted repository. Git-worktree isolation protects the user's selected checkout from unpromoted edits, but it does not isolate processes; on the default host backend it does not isolate the network, credentials available outside Forge's scrubbed command environment, or the host filesystem. A container backend addresses those for the commands it runs, and is opt-in.

## Production-hardening direction

Optional container isolation has shipped with network off, a read-only root filesystem, and default memory (4096 MiB, swap pinned equal), CPU (2), and process-count (512) bounds; `/workspace` and a bounded `/tmp` tmpfs (which also carries `HOME`) stay writable. Two enforcement caveats: on cgroups-v1 rootless systems the runtime warns and ignores resource limits rather than failing, and on cgroups-v2 rootless systems without CPU delegation the runtime hard-errors — `execution.limits: false` / `--sandbox-no-limits` is the explicit escape hatch, which drops only the cgroup bounds, never the filesystem semantics, and is announced by the backend description. The next execution-backend work is covering the remaining host-executed paths and surfacing the backend state in machine-readable output. External tools, MCP servers, and plugins must pass through the same permission, timeout, output-bound, and audit-journal boundaries as built-in tools. The shipped extension API (1.0, `beforeCompletion`) is that boundary's first versioned third-party crossing; headless hooks remain exit-code-only repository commands.

Security reports should include a reproducible case and affected version. Do not include real credentials or private repository content.
