# Command working directories and provider failures — 2026-08-04

## Decision

Ship both mechanisms:

1. Interpret the common model output `RUN cd <directory> && <one command>` as a
   validated working-directory invocation while continuing to execute with
   `shell: false`.
2. Classify HTTP provider failures and Cognara profile conflicts as benchmark
   infrastructure failures, stop retrying them, and exclude them from scored
   results.

No Polyglot score improvement is claimed. The intended 30B reproduction was
blocked by a runtime-profile conflict, and a 9B attempt was interrupted by an
engine outage before a clean comparison completed.

## Why the command adapter exists

The retained retry trace for `cpp/binary-search-tree` in the full 225-case run
emitted:

```text
RUN cd build && make
```

Forge safely used an argv array with `shell: false`, but attempted to spawn an
executable literally named `cd`. The model then searched for alternative
spellings instead of receiving compiler feedback:

- one turn decoded 490 proposals and dropped 488;
- the next decoded 87 and dropped 84;
- the final turn decoded 94 and dropped 92.

The action guard prevented mass execution, but the retry budget was consumed.
A search of retained full-run traces found this exact `RUN cd` form in this one
failure, so this is a focused compatibility mechanism rather than a general
shell parser.

## Implemented command semantics

Forge now accepts exactly:

```text
cd <repository-relative-directory> && <one command>
```

It resolves the directory through the existing workspace containment logic,
requires an existing directory, removes the leading `cd ... &&`, and spawns the
remaining argv with that directory as `cwd` and `shell: false`.

It rejects:

- a directory outside the repository;
- a missing or non-directory path;
- additional command chains;
- pipes, redirects, and semicolon control tokens;
- a `cd` form with no following command.

The result returned to the model names the effective repository working
directory.

## Provider infrastructure classification

The first targeted 30B attempt reached Cognara while a different runtime profile
was active. The endpoint returned HTTP 409 with `profile_conflict`. Before this
change, the Polyglot adapter verified the untouched exercise, recorded an
ordinary test failure, and spent the second model attempt.

The infrastructure classifier now recognizes provider responses in the form
`HTTP 4xx/5xx from http(s)://...` and the explicit `profile_conflict` marker.
Infrastructure cases remain persisted for diagnosis but are not added to scored
results, and a retry is not spent on the same unavailable endpoint.

A subsequent 9B attempt made five turns and five actions before Cognara returned
HTTP 502 `engine_unreachable`. The new classifier correctly persisted the case
as infrastructure, excluded it from the score, and stopped before retrying.

## Verification

Focused regression suites:

```text
npx vitest run tests/exec.test.ts tests/polyglot.test.ts
23 passed
```

The command tests prove both normalization and actual execution in the selected
subdirectory. They also prove rejection of command chains and repository escape.
The Polyglot tests prove a profile conflict causes one agent call, one persisted
attempt, infrastructure classification, and exclusion from scored results.

Full repository gate:

```text
npm run check
212 passed, 1 skipped; lint and strict type checking passed

npm run build
passed

git diff --check
passed
```

Biome still reports the repository's pre-existing deprecated configuration
field as informational output.

## Measurement boundary

This work establishes two deterministic mechanism fixes. It does not establish a
new pass-rate estimate:

- the original 30B endpoint was unavailable;
- the local Cognara 30B profile could not be activated concurrently;
- the local 9B engine became unreachable during one attempt;
- a later resumed 9B foreground run exceeded the bridge's ten-minute command
  limit without producing a new persisted result.

A clean controlled Polyglot replication remains necessary before attributing any
score change to the command adapter.
