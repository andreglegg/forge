# Polyglot full-benchmark result — 2026-08-03

Forge on the complete 225-case Aider Polyglot benchmark, against Little Coder
v0.0.2 as the baseline competitor.

## Result

**135/225 = 60.00%** (`forge-preflight-full225-v1`, complete, 0 infrastructure
errors, 0 false successes).

| metric | value |
|--------|-------|
| Forge, full benchmark | **135/225 = 60.00%** |
| Little Coder, published full benchmark | 45.56% |
| Effect size | **+14.44 pp** (1.32x) |
| One-sided exact binomial, `P(X>=135 \| n=225, p=0.4556)` | **9.5e-06** |
| Clopper-Pearson 95% one-sided lower bound | **54.33%** |
| First-attempt rate (`passRate1`) | 54.22% |
| Retry recovery | 122 -> 135, i.e. 13 of 103 first-attempt failures |

The conservative lower bound is the load-bearing number: at the pessimistic end
of sampling error Forge still exceeds Little Coder's published rate.

### Per language

| language | passed | rate |
|----------|--------|------|
| cpp | 23/26 | 88.4% |
| go | 22/39 | 56.4% |
| java | 26/47 | 55.3% |
| javascript | 30/49 | 61.2% |
| python | 19/34 | 55.8% |
| rust | 15/30 | 50.0% |

### Failure classes

`test_failure` 76, `timeout` 5, `type_or_compile` 4, `syntax` 3, `unknown` 2.

`test_failure` dominating means code that builds and runs but computes the wrong
answer — a comprehension problem, not a toolchain one. See "Specifications are
never read" below.

## What this claim is and is not

- The **paired 42-case comparison is the controlled evidence.** Both agents ran
  on this machine, same model, endpoint, temperature and attempt structure, on
  an identical pinned case list (`polyglot-paired-42.txt`, verified byte-equal
  to the run selection). Forge 28/42 and 27/42 vs Little Coder 19/42; exact
  paired McNemar `p=0.01172` and `p=0.007813`.
- The **225-case comparison is weaker.** 45.56% is Little Coder's *published*
  figure from their environment, not re-measured here. The binomial test above
  treats it as a fixed constant, which understates true uncertainty. The two
  lines of evidence agree, but they are not equally strong.
- **42-case runs vary by about +/-5.** Observed on an unchanged system: 28, 27,
  23. The 225-case result below is unaffected (its confidence bound already
  accounts for sampling), but no 42-case comparison smaller than that gap
  should be treated as a real difference.
- **One full replication, not two.** A second full run (`...-v2`) was planned
  and deliberately skipped in favour of measuring the task-packet finding
  below. The original acceptance gate wanted both.

## Provenance

```text
identityFingerprint    f5c7b2669da5a282
datasetCommit          7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f
executableFingerprint  a5f8ad3be456c618
model                  qwen3-coder-30b-a3b-instruct-q4_k_m
modelDigest            90169a9caa025170
endpoint               http://127.0.0.1:8790/v1
temperature            0.1
tries 2 · firstTurns 12 · retryTurns 8 · jobs 2 · taskPacket false
```

Reproduce (resumable — completed cases are not repeated):

```sh
bin/forge polyglot .forge/datasets/polyglot-benchmark \
  --name forge-preflight-full225-v1 \
  --model-digest 90169a9caa025170 --jobs 2
```

Reports live under `.forge/benchmarks/polyglot/<name>/report.json`, which
`.gitignore` excludes; this file is the durable record.

## Finding 1 — specifications are never read

Every one of the 225 exercises ships `.docs/instructions.md`, the student-facing
problem statement. The upstream harness keeps `.docs/` deliberately (it excludes
only `.meta/`, the reference solution), so it is legitimate input.

**Zero of 59 attempts across the candidate runs ever opened it.**

The signature is the same exercise failing across unrelated toolchains:

| exercise | outcome |
|----------|---------|
| transpose | failed in **all four** languages that ship it (go, java, javascript, python) |
| pig-latin | failed in java, python, go |
| poker | failed in javascript, rust, go |
| robot-name, rest-api, counter, react, decimal, xorcism | failed in both candidate replications |

`transpose` is the clean example. The spec states "Pad to the left with spaces.
Don't pad to the right." The model wrote `while (end > 0 && charAt(end-1) == ' ')
end--`, stripping *all* trailing spaces, and failed 4/12 tests on exactly that.
It burned all 12 turns and failed the retry too. The rule is not recoverable
from test names; one read of the spec resolves it.

`python/transpose` was predicted to fail in advance of python running, as a
falsifiable test of this diagnosis. It failed.

### The capability already exists and has never been switched on

`src/cli.ts:491` `taskPacketItems()` already reads `.docs/introduction.md`,
`.docs/instructions.md` and `.docs/instructions.append.md`. It is gated behind
`--task-packet`, which defaults to **off**, and the benchmark never passed it —
so every result above was measured with specifications disabled.

Added in 98f4d4b ("feat(agent): add measured project instructions and task
packets"): built to be measured before being enabled, then never measured.

This is a configuration question, not missing code — exactly the
benchmark-gated policy optimisation CLAUDE.md rule 5 describes.

**It was measured and rejected. See `TASK_PACKET.md`.** The packet scored 22/42
against controls of 28/42 and 27/42. The diagnosis above was right — the model
genuinely cannot infer rules stated only in prose — but the intervention loses
by turn exhaustion, and merely reaches parity when given more turns. Do not
enable it by default.

A first attempt at "fixing" this by adding spec discovery to
`src/instructions.ts` was written, tested and **reverted**: it duplicated
`taskPacketItems` and broke `tests/cli-context.test.ts:49`, which deliberately
asserts the default packet excludes the spec.

## Finding 2 — the retry attempt is weak

The second attempt recovered 13 of 103 first-attempt failures (~13%); mid-run in
java it had recovered nothing at all. Repeat failures reproduce identically
across replications.

Plausibly the same root cause: a diagnostic packet cannot supply a specification
the model never read. Worth re-measuring after the task-packet question settles,
rather than changing two things at once.

## Operational note

`bin/forge` exits 2 when any `src/**/*.ts` is newer than `dist/**/*.js`, and the
benchmark spawns a fresh `bin/forge run` per case. **Editing `src/` during a run
fails every remaining case.** Documentation is always safe to write mid-run.
