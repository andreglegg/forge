# Evaluation plan

## Objectives

Evaluation must answer four separate questions:

1. Did the patch solve the task?
2. Did it preserve existing behavior?
3. Did the harness operate safely and within budget?
4. Is a policy change genuinely better than the current baseline?

## Suite layers

### Protocol suite

Synthetic model outputs test JSON extraction, schema failures, contradictory action/final states, unknown tools, truncated objects, code fences, and recovery budgets.

### Tool-security suite

Tests repository traversal, absolute paths, symlink escapes, denied files, command-prefix bypasses, control characters, output caps, timeouts, atomic writes, ambiguous replacements, and untracked diffs.

### Micro repository suite

Small deterministic fixtures cover common changes:

- bug fix with regression test;
- new function with edge cases;
- refactor preserving API;
- multi-file import update;
- type error;
- failing linter;
- generated-file avoidance;
- new-file creation.

### Real repository suite

Versioned issue snapshots from permissively usable repositories test repository-scale behavior. Each task must have an isolated environment and an external verifier.

### Adversarial suite

Repository files and task text attempt prompt injection, secret access, evaluator tampering, test-output forgery, excessive edits, dependency-script execution, and promotion manipulation.

## Metrics

Primary:

- task pass rate;
- regression-test pass rate;
- safety-violation rate.

Secondary:

- timeout rate;
- average model calls;
- tokens or characters sent;
- wall-clock time;
- changed-file count;
- patch size;
- reviewer false-approval and false-rejection rates;
- recovery success after initial failure.

## Repeated trials

Model sampling is stochastic even at low temperature. Production comparisons should run multiple trials per task and report confidence intervals. Candidate promotion should use paired task-level comparisons where possible, not only aggregate averages.

Forge supports checkpointed repeated trials directly:

```console
forge eval evals/smoke.yaml --config forge.cognara.yaml \
  --trials 3 --name qwen35-9b-smoke
```

After each trial it atomically updates:

```text
.forge/benchmarks/evals/qwen35-9b-smoke.json
```

The report retains every raw trial and summarizes mean score, sample standard
deviation, a 95% normal confidence interval, calls, latency, prompt/output tokens,
and prompt-cache hit rate. Treat a two- or three-trial confidence interval as a
noise warning, not a strong statistical claim.

Each task trajectory is copied before its temporary fixture is removed:

```text
.forge/benchmarks/trajectories/qwen35-9b-smoke/
  <suite>/<model>/<profile>/trial-001/<task>/<run-id>/
```

That directory contains the normal Forge run evidence, external-verifier output,
and snapshots of changed files. A failed or escalated sample therefore remains
diagnosable instead of disappearing with its temporary repository.

## Data separation

Maintain:

- development suite for prompt and policy iteration;
- validation suite for candidate selection;
- held-out promotion suite that candidate generation never sees;
- periodic external suite for regression detection.

Do not repeatedly optimize against the held-out suite.

## Reproducibility

Record:

- model identifier and quantization;
- serving engine and version;
- context length and sampling settings;
- repository commit or fixture hash;
- operating-system/container image;
- harness version and configuration fingerprint;
- policy profile;
- random seeds when supported;
- complete task-level evidence.

## Promotion recommendation

A serious production gate should eventually require:

- zero new safety failures;
- statistically meaningful quality gain or equal quality with material cost/latency reduction;
- no important task-class regression;
- repeated-trial stability;
- held-out-suite confirmation;
- manual review of representative patches;
- rollback artifact and signed evidence record.
