# Qwen3.5-9B Aider Polyglot baseline

## Run identity

- Run name: `qwen35-9b-polyglot-full-v1`
- Benchmark: Aider Polyglot, all 225 official cases
- Model: `qwen3.5-9b-q4_k_m`
- Dataset commit: `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`
- Forge configuration fingerprint: `b8d44a1d7084692c`
- Report: `.forge/benchmarks/polyglot/qwen35-9b-polyglot-full-v1/report.json`
- Completion state: complete (`incomplete: false`)

## Official result

Forge passed **74 of 225 cases: 32.89%**.

| Language | Passed | Cases | Score |
| --- | ---: | ---: | ---: |
| C++ | 12 | 26 | 46.15% |
| Go | 8 | 39 | 20.51% |
| Java | 30 | 47 | 63.83% |
| JavaScript | 12 | 49 | 24.49% |
| Python | 7 | 34 | 20.59% |
| Rust | 5 | 30 | 16.67% |

Against the comparison targets used in this project, the run is 29 passes and
12.67 percentage points below Little Coder's 45.56% mean, while remaining 13.78
percentage points above the matched-model vanilla Aider baseline of 19.11%.

## Cost and runtime

- Aggregate wall time: 87,713.93 seconds, approximately 24 hours 22 minutes
- Model time: 84,498.34 seconds, approximately 23 hours 28 minutes
- Model calls: 2,675
- Prompt tokens: 17,112,932
- Cached prompt tokens: 7,149,425
- Prompt cache ratio: 41.78%
- Completion tokens: 1,083,685
- Peak prompt size: 16,540 tokens

## Failure evidence

The retained trajectories identify orchestration failures in addition to coding
failures:

- 419 rejected protocol responses: 239 truncations, 134 repetition loops, 38
  mode conflicts, and 8 duplicate malformed responses.
- Cases with zero protocol errors passed 46.2%; cases with two errors passed
  10.0%, and cases with three or more passed 9.3%.
- 101 cases consumed all 12 logical executor steps; only 17 of those passed.
- 185 repair rounds were entered. Verification or structured test evidence
  accounted for 178 of the classified failures, yet the previous implementation
  normally spent another planner call paraphrasing that evidence.
- 21 externally passing solutions were marked internally unsuccessful solely
  because model-introduced trailing whitespace failed the final patch audit.
- Verification itself polluted the working tree: 48 JavaScript cases recorded
  generated `package-lock.json` and test-spec changes, while all 30 Rust cases
  recorded generated `Cargo.lock` changes. Those artifacts entered review and
  repair decisions even though the agent did not create them.
- Several passing Java solutions were rejected because the reviewer treated
  intentionally skipped optional tests as evidence that configured verification
  had failed.

## Post-baseline upgrades

The following changes were implemented after the run completed. They do not
alter or retroactively improve the locked 32.89% result:

1. Malformed or repetitive executor output receives one compact repair attempt
   inside the same logical action step. Protocol noise no longer automatically
   consumes another implementation step.
2. The compact retry prompt removes low-priority conversation and memory while
   retaining the task, plan ledger, recent actions, verification evidence, and a
   bounded context slice.
3. Compiler diagnostics, JUnit failures, and bounded raw verifier excerpts now
   drive repair directly. Verification failures no longer trigger a redundant
   replanner call in standard or deep lanes.
4. Configured verification runs inside a Git-tree snapshot. Tracked files and
   untracked artifacts changed by the verifier are restored afterward, while the
   agent's pre-verification edits and the user's exact index state are preserved.
   If verification rewrites an agent-edited file, the run fails closed because
   the successful command no longer proves the restored source passes.
5. Model-introduced trailing whitespace is removed only from changed source
   lines before verification. Untouched lines remain byte-for-byte stable, and
   Markdown hard-break whitespace is preserved.
6. Reviewer guidance now treats a successful configured verification command as
   authoritative and does not invent failure solely from intentionally skipped
   optional tests.
7. Partial-result reporting names safety checks separately from reviewer or
   verification failures.

## Validation

- Focused formatting, lint, and related regression tests passed.
- Full `make check` passed with Ruff, strict mypy, and **497 tests passing**.
- No post-upgrade public benchmark score is claimed. A new locked run name is
  required to measure the effect without contaminating this baseline.
