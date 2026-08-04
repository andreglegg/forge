# The replay benchmark

A deterministic, zero-cost benchmark that measures **Forge** rather than the
model it is driving. Run it with `forge replay`.

## Why it exists

Aider Polyglot measures the model. Four complete 225-case runs of the same
configuration scored 28.44%, 30.22%, 36.00% and 29.33% -- a spread of 7.56
points, standard deviation 3.41. No single-run difference under roughly seven
points is supportable, each pair costs about five hours and $12, and the score
is dominated by capability that Forge does not control.

Worse, it is blind to how the harness actually fails. Eight defects were found
and fixed in one session, and none of them would move a Polyglot score in a
legible way:

| Defect | How it appeared in the score |
| --- | --- |
| Reasoning-only endpoint treated as retryable | A near-zero run, indistinguishable from a weak model |
| Polyglot run as one attempt when it is a two-attempt benchmark | Every figure understated, silently |
| `KeyError` in chunk merging | Three cases scored zero, in every run ever recorded |
| Verifier scoring cached, unexecuted tests | The score went **up** |
| Stale git lock wedging a case | A case that looked slow, then failed |
| Unreachable provider scored as a failed case | 70 corrupted cases reported as model failures |

Each of those *is* a plausible score, which is exactly why a score cannot catch
them.

## What it measures

Every model response produced during real benchmark runs was recorded verbatim.
The replay benchmark re-runs that fixed corpus through the current protocol
layer and reports the **conversion rate**: of N real model responses, how many
did the harness turn into a usable action.

Because the corpus is frozen, the model side is constant. Any movement in the
number is Forge's doing.

- **Deterministic.** Same corpus, same result. Variance is zero, not 3.41.
- **Free.** No inference. It reads a file.
- **Fast.** Seconds, over 24,206 samples.
- **Real.** Hand-written samples drift toward whatever is easy to parse. The
  failures that actually cost cases were not ones anyone would have invented.

## Baseline

24,206 recorded responses, from fourteen runs across two models:

| Role | Converted | Total | Rate | Repaired |
| --- | ---: | ---: | ---: | ---: |
| executor | 20,599 | 21,161 | 97.34% | 796 |
| planner | 2,023 | 2,023 | 100.00% | 0 |
| replanner | 270 | 271 | 99.63% | 0 |
| reviewer | 751 | 751 | 100.00% | 0 |
| **all** | **23,643** | **24,206** | **97.67%** | **796** |

Every one of the 563 unconverted responses is `truncated`. Not one is malformed
JSON, an unknown field, or a bad value -- the deterministic parser and its
repairs handle those. The harness loses responses for exactly one reason: the
model was cut off mid-reply.

That failure is concentrated, not spread: 80 of 2,084 cases carry all of it,
led by `go/forth` (53), `cpp/zebra-puzzle` (50) and `go/counter` (28). Truncated
payloads have a median of 3,917 characters against 628 for successful ones, and
the largest is 123,188 -- a tail that is model runaway, not a tight budget.

## It already detected a real Forge improvement

Truncation losses by run, on identical measurement:

| Run | Truncated |
| --- | ---: |
| `full-v1` | 273 |
| `full-v2` | 107 |
| `tuned-v1` | 23 |
| `tuned-v2` | 19 |
| `final-v1` | 10 |
| `final-v2` | 9 |

The reply-budget autotune landed between `full` and `tuned`. Polyglot's score
never showed this; the runs it produced were 32.89% and 32.67%, statistically
indistinguishable. The replay metric shows roughly a 95% reduction in a concrete
harness failure. That is the discriminating power the benchmark was built for.

## Honest limits

- **It measures conversion, not correctness.** A response can parse into a
  perfectly valid action that does entirely the wrong thing. Code quality
  belongs to Polyglot and `forge eval`.
- **It is single-turn.** It replays each recorded response through the parser in
  isolation. It cannot measure multi-turn behaviour, because once Forge acts
  differently the conversation diverges and the recorded continuation no longer
  applies.
- **The rate can be gamed by accepting garbage.** A parser that returns an empty
  action for any input would score 100%. The number is only meaningful read
  alongside `repaired` and the test suite that pins parse *correctness*.
- **The corpus reflects two models on one benchmark.** It is Qwen3.5-9B and
  Qwen3-Coder-30B on Exercism-shaped tasks. A different model may fail in ways
  this corpus cannot show.

## Using it

```bash
forge replay                                    # score the frozen corpus
forge replay --json report.json                 # full report, including every failure
forge replay --fail-under 0.97                  # regression gate for CI
forge replay --corpus .forge/benchmarks/polyglot \
             --extract-to evals/replay/next.jsonl.gz   # freeze a new corpus
```

The corpus is committed at `evals/replay/corpus.jsonl.gz` (3.6 MB compressed,
39 MB raw). It is stored whole rather than sampled, so the reported rate is the
true rate and not something recovered from stratum weights.

Freeze a new corpus when a new model or task family is added -- and keep the old
one, because comparing across corpora compares the corpora, not the harness.

## The three measurements

| Suite | Question | Determinism | Cost |
| --- | --- | --- | --- |
| `forge replay` | Does the harness convert model output? | Total | Seconds, free |
| `forge eval evals/smoke.yaml` | Does a real model finish real tasks? | Stochastic, repeatable | Minutes |
| `forge benchmark polyglot` | How does this compare publicly? | sd 3.41 | Hours, dollars |

Run replay on every change, `forge eval` before a release, and Polyglot only
when a public comparison is actually needed.
