# Tuning experiments against Qwen3.5-9B

Controlled experiments run on the Aider Polyglot suite while investigating why
Forge scored 29.33% on the [RunPod runs](QWEN35_9B_RUNPOD_POLYGLOT.md).

Two of the three hypotheses below were falsified. They are recorded in full
because the correlations that motivated them were strong and will look
compelling again to the next person who reads the trajectories.

## Method

All experiments use one fixed 42-case subset: seven cases per language, taken
at even intervals from the alphabetised case list, so selection cannot depend
on outcome. Every arm runs the identical cases against the identical model
endpoint, changing exactly one variable. Paired outcomes are tested with an
exact McNemar test on the discordant pairs.

Subset selection and the analysis scripts are not committed; the case list is
reproducible from the rule above.

## 1. Reply budget derived from the endpoint window — CONFIRMED, shipped

**Hypothesis.** `roles.executor.max_tokens: 1200` was tuned for a 4 tok/s local
endpoint and truncates the executor on a 65536-window GPU endpoint, and each
truncation consumes a logical step.

**Evidence before the change**, over 65 cases: `executor_raw` payloads
hard-clipped at 4587 chars (1200 tokens ≈ 4560 chars); 47 truncation retries of
which 31 truncated again under the same ceiling; 51.6% of cases reached the
12-step ceiling; median calls per case exactly 12.

**Result.** On the same ten cases, changing only the reply budget: truncations
4 → 0 with identical per-case pass/fail. Across full 225-case runs: truncations
78 → 4 and 2; ceiling hits 51.6% → 8.0% and 5.3%; median calls 12 → 11.

Shipped as `config.autotune_reply_budgets`. This is a defect fix; no score
improvement is claimed from it in isolation.

## 2. Prompt budget widening — FALSIFIED, not shipped

**Hypothesis.** `max_prompt_chars: 40000` (~10.5k tokens against a 65536
window) evicts previously-read file content, so the model re-reads files it
already had, trips loop detection and loses steps.

**Motivating correlation.** Loop-detected cases had a median peak prompt of
10,559 tokens against 8,729 for clean cases — apparently sitting on the ceiling.

**Design.** Three arms at 40000 / 80000 / 160000 chars (`max_context_chars`
scaled with them), 42 identical cases each.

| Metric | 40k | 80k | 160k |
| --- | ---: | ---: | ---: |
| Passed | 8 | 14 | 10 |
| Loop-detected cases | 24 | 23 | 25 |
| `read_file` loop events | 41 | 40 | 43 |
| Median peak prompt | 11,196 | 10,217 | 10,846 |

| Comparison | Discordant | p |
| --- | --- | ---: |
| 40k → 80k | 9 gained, 3 lost | 0.146 |
| 80k → 160k | 2 gained, 6 lost | 0.289 |
| 40k → 160k | 4 gained, 2 lost | 0.688 |

**Result.** No comparison is significant, and the loop rate is flat across an
8x range of budgets. The decisive observation is the median peak prompt: it
stays near 10-11k tokens whether the ceiling is 40000 or 160000 chars, so
nothing was pressing against the ceiling and raising it was inert.

**Not shipped.** Had only the 40k → 80k arm been run, its 8 → 14 result would
have looked like a large win at p = 0.146 with no mechanism.

## 3. Serving an evicted re-read instead of refusing it — CONFIRMED mechanically, score-neutral, shipped

**Hypothesis.** `MAX_IDENTICAL_ACTIONS = 2` refuses a third identical
`read_file` and instructs the model to do something different. When the content
has left the transcript this strands the model, and that is what makes
loop-detected cases fail.

**Motivating correlation.** Over 450 cases, loop-detected cases passed at 15.8%
against 42.5% for clean cases, and 409 of 458 loop events were repeated
`read_file` actions.

**Result**, 42 identical cases, identical configuration, only `agent.py`
changed:

| Metric | Control | With fix |
| --- | ---: | ---: |
| Loop-detected cases | 24 | 7 |
| `read_file` loop events | 41 | 9 |
| `evicted_reread` events | 0 | 29 |
| Median calls per case | 12 | 11 |
| Passed | 8 | 8 |

Paired: 4 gained, 4 lost, McNemar p = 1.000.

**The causal claim is falsified.** The mechanism works — 71% fewer loops — and
the score does not move at all. Loop detection was a symptom of an already
failing trajectory, not its cause.

Shipped regardless, on correctness grounds: refusing to return a file the model
can no longer see, while telling it to move on without it, is wrong
independently of its effect on the score. Recorded here as score-neutral so no
future summary can cite it as an improvement.

## What this implies

Two orchestration-level hypotheses with strong supporting correlations both
failed to move the score. The remaining failures are dominated by verifier
diagnostics that describe incorrect code rather than mis-orchestration:
assertion or test failure 192, type mismatch 41, undefined symbol 24, missing
method or trait 19, syntax error 18.

The reasonable reading is that on this model, Forge's orchestration is no
longer the binding constraint. Further harness tuning should be expected to
produce small effects, and any claimed gain needs a paired test on a fixed
subset before it is believed.
