# Qwen3.5-9B Aider Polyglot on RunPod GPUs

Four complete 225-case runs, all `incomplete: false`.

## Headline

| Run | Passed | Score |
| --- | ---: | ---: |
| `qwen35-9b-runpod-polyglot-tuned-v1` | 64 / 225 | 28.44% |
| `qwen35-9b-runpod-polyglot-tuned-v2` | 68 / 225 | 30.22% |
| `qwen35-9b-runpod-polyglot-final-v1` | 81 / 225 | 36.00% |
| `qwen35-9b-runpod-polyglot-final-v2` | 66 / 225 | 29.33% |

| Figure | Value |
| --- | ---: |
| Tuned pair mean (before the later fixes) | 132 / 450 = **29.33%** |
| **Final pair mean (shipped code)** | **147 / 450 = 32.67%** |
| Recorded local baseline | 74 / 225 = 32.89% |

**The reportable number is 32.67%**, the mean of the two runs on the shipped
code. Do not quote 36.00%: its pair partner scored 29.33% on the same 225 cases
with the same code and the same endpoint.

## Variance is the dominant effect

| Statistic | Value |
| --- | ---: |
| Spread across four runs | 7.56 points |
| Standard deviation | 3.41 points |
| Spread within the final pair alone | 6.67 points |

A case-level paired test between the tuned pair and the final pair (each case
scored 0-2 by how many runs of that pair passed it) gives 38 improved, 25
regressed, **McNemar p = 0.1299 — not significant**.

So the accumulated harness work did not produce a demonstrable score gain, and
the final pair mean is statistically indistinguishable from the 32.89%
baseline. Any future claim of a difference smaller than roughly 7 points
between single runs is unsupportable at this sample size.

## Per language, final pair

| Language | final-v1 | final-v2 | Baseline |
| --- | ---: | ---: | ---: |
| C++ | 10/26 (38.5%) | — | 46.15% |
| Go | 12/39 (30.8%) | — | 20.51% |
| Java | 32/47 (68.1%) | — | 63.83% |
| JavaScript | 12/49 (24.5%) | — | 24.49% |
| Python | 8/34 (23.5%) | — | 20.59% |
| Rust | 7/30 (23.3%) | — | 16.67% |

Given the variance above, per-language figures from a single run are indicative
only; several languages have fewer cases than the observed run-to-run spread.

## Comparison with Little Coder

Little Coder's published Qwen3.5-9B figure is 45.56%. The final pair mean is
32.67%, **12.89 points below**. That gap is larger than the measured run-to-run
spread, so unlike the baseline comparison it is unlikely to be noise.

The comparison is nevertheless not like-for-like:

- **Different GGUF build.** These runs use `jc-builds/Qwen3.5-9B-Q4_K_M-GGUF`
  (5,680,522,464 bytes). The local baseline used `Qwen3.5-9B-M-TS-Q4_K_M.gguf`
  (5,049,206,784 bytes). Same parameter count and quantisation, different
  conversion. Which build Little Coder used is not established here.
- **Scoring leniency.** Aider's verifier accepts solutions that are not
  solutions. `python/zebra-puzzle` scored a pass with stub functions replaced by
  hardcoded `'Norwegian'` and `'Japanese'` return values, and several Java cases
  passed with 12-14 tests skipped rather than run. Forge's own reviewer marked
  26 such cases as failures while the official verifier passed them. Any
  Polyglot number, this one or Little Coder's, includes some of these.

## Cost and throughput

- Hardware: RTX 4090 24 GB, RunPod secure cloud, two pods in parallel per pair
- llama.cpp `b2f221684fcd898e947a121baeda80f345da3e6b`, `CUDA_ARCHITECTURES=89`
- Model: `jc-builds/Qwen3.5-9B-Q4_K_M.gguf`, byte-identical across pods
- Decode ~130 tok/s, prompt eval ~8,800 tok/s, zero model-server errors
- Session spend: approximately $32 across all runs and experiments

## Configuration

`forge.cognara.yaml` as committed. Reply budgets are endpoint-derived
(executor 8192 on a 65536 window); `max_steps` 20; `max_prompt_chars` 40000,
deliberately unchanged after
[TUNING_EXPERIMENTS.md](TUNING_EXPERIMENTS.md) found widening it inert.

## Reproducing

```console
forge benchmark polyglot --config forge.cognara.yaml \
  --base-url http://127.0.0.1:8094/v1 \
  --model qwen3.5-9b-q4_k_m --context-window 65536 \
  --name <run-name> --batch-size 10
```

Repeat until `report.json` records `"incomplete": false`. Pod, server and
tunnel setup, including the mandatory `--jinja --reasoning off`, is in
[RUNPOD_BENCHMARKS.md](RUNPOD_BENCHMARKS.md).

## What changed between the pairs

The tuned pair ran before these landed; the final pair includes all of them:

- endpoint-derived reply budgets (truncations 78 -> 4 and 2)
- reasoning-only endpoints fail fast, and `health()` proves the endpoint
  returns content rather than stopping at a 200 from `/models`
- infrastructure errors separated from failed cases and re-attempted on resume
- evicted re-reads served instead of refused (loops -71%, score-neutral)
- **a KeyError in chunk merging that killed three cases outright** before any
  model call, in every previously recorded run including the baseline:
  `cpp/knapsack`, `cpp/parallel-letter-frequency`, `go/robot-simulator`

The last of these is worth separating: those three cases were guaranteed zeros
in the 32.89% baseline too, so that figure was measured against 222 usable
cases, not 225.

## Interruptions

Three controller network outages occurred across the session. The first two,
before the infrastructure-error fix, corrupted 70 cases which were identified,
archived and re-run. The third, during the final pair, caused the driver to
pause without consuming cases, and both final runs recorded zero
infrastructure errors.
