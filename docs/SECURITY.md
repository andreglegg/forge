# Security model

## Threat model

Repository content, user tasks, generated model text, tool output, and dependency scripts can all be adversarial. Forge therefore treats model output as untrusted input.

## Enforced controls

Paths:

- File access is rooted at one canonical repository directory.
- Traversal through `..`, symlinks, and absolute paths is rejected when it escapes the root.
- Denied glob patterns protect secrets and repository internals.
- Glob matching folds case when the underlying volume does. This is probed
  from the filesystem, not inferred from the operating system: `fnmatch` uses
  `os.path.normcase`, which is the identity function on macOS even though
  APFS is case-insensitive, so `.GIT/config` and `.git/config` compared as
  different strings while naming the same inode.
- `.git` and `.forge` are refused structurally, independent of configuration.
  These are the harness' trust anchors — git executes hooks and configured
  commands during the `git status` the harness itself runs, and `.forge` holds
  the promoted `active-policy.json` — so neither may depend on a user-supplied
  deny list being spelled correctly.
- The deny list applies to discovery as well as reading: `list_files`,
  `search_text`, and the retrieval index all filter through it. A policy that
  blocks `read_file .env` while `search_text` prints its contents is not a
  policy.
- Policy fails closed: a configuration with no `policy:` section still denies
  a default set of secret paths.

Commands:

- Commands are arrays, not shell strings, and run with `shell=False`.
- Command prefixes must match an allowlist, and the authorization decision is
  made over exactly the token array that will execute.
- Individual arguments that escape the sandbox regardless of prefix are denied
  (`--no-index`, `--exec`, `--output`, `--upload-pack`, `--receive-pack`).
- Commands run in their own process group; a timeout kills the whole tree.
  Killing only the direct child left a forked grandchild holding the output
  pipe, which made the timeout unenforceable.
- The environment is reduced to a fixed allowlist. Provider credentials are
  never passed to repository commands or to evaluation verifiers.
- Time and output are bounded.
- File writes can be globally disabled.
- Changed-file count is checked before completion.

Model output:

- Treated as untrusted input throughout; every schema rejects unknown fields.
- Reasoning blocks (`<think>…</think>`) are stripped at the transport boundary
  and never persisted, per the no-hidden-chain-of-thought rule.

## Deliberate limitations

An allowlisted build tool can still execute repository-defined scripts. For example, `npm test`, `cargo test`, or `pytest` may run arbitrary code from the repository — a model that writes `conftest.py` and then runs an allowlisted `pytest` has achieved code execution by design, not by bypass. The argument denylist and environment scrub reduce the blast radius; they do not close this. Use containers, virtual machines, restricted users, or disposable worktrees for untrusted repositories.

The MVP does not provide an OS-level sandbox. Do not run it with elevated privileges.

Edits are not transactional. A run that fails verification leaves its partial
changes in the working tree; worktree isolation and rollback remain roadmap
items, so run against a clean, committed tree you are willing to lose.

## Recommended production hardening

- execute each run in an ephemeral container or microVM;
- mount the repository read-write and everything else read-only;
- disable network by default;
- use seccomp/AppArmor on Linux;
- cap CPU, memory, processes, and disk;
- maintain language-specific command profiles;
- scan patches for secrets and dependency confusion;
- sign evaluation and promotion records;
- separate the evaluation controller from the candidate agent environment.
