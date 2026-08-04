# Self-improvement

## Definition

In Forge, self-improvement means improving the harness policy using measured outcomes. It does **not** mean unreviewed recursive source rewriting or claiming the model has changed its own weights.

The optimization target may include:

- prompt modules and ordering;
- context selection budgets;
- maximum action and review loops;
- role temperatures and token budgets;
- retrieval weights;
- task-lane routing between configured models and promoted policy profiles.

## Evidence lifecycle

1. Define separate development and held-out evaluation suites.
2. Record the baseline over repeated trials on both suites.
3. Generate a bounded set of deterministic policy candidates.
4. Run every candidate for the same number of trials against the same suite fingerprints.
5. Persist task results, verification evidence, safety violations, latency, timeouts, and token use after every trial.
6. Compute confidence intervals and the quality/latency/token Pareto frontier.
7. Mark candidates eligible only when every configured gate passes on development and held-out evidence.
8. Require explicit `forge promote <report> <candidate-id>` activation.
9. Keep the prior policy and complete evidence for audit and rollback.

A standard run is:

```bash
forge improve evals/development.yaml \
  --held-out evals/held-out.yaml \
  --trials 3 \
  --config forge.yaml \
  --repo . \
  --name policy-v1

forge promote .forge/improvements/policy-v1.json <eligible-candidate-id> --repo .
```

## Promotion gates

A candidate is ineligible when any of the following is true:

- either suite has fewer than `minimum_trials` or `minimum_tasks` observations;
- evidence is incomplete or a suite fingerprint differs from its baseline;
- any safety violation occurs;
- mean score gain is below `minimum_score_gain`;
- the candidate lower confidence bound does not clear the baseline upper bound by `minimum_confidence_gain`;
- timeout rate exceeds `maximum_timeout_regression`;
- mean wall time exceeds `maximum_wall_time_regression`;
- mean token use exceeds `maximum_token_regression`;
- `require_pareto_frontier` is enabled and the candidate is dominated on quality, latency, tokens, timeouts, or safety.

Setting `require_held_out_suite: false` permits exploratory reports without a held-out suite. Statistical promotion still requires held-out baseline and candidate evidence.

## Trajectory export

Forge exports only observable benchmark inputs, verified result summaries, and metrics. It does not copy hidden reasoning or chain-of-thought files into datasets.

```bash
forge export-trajectories \
  .forge/trajectories/improvements/policy-v1 \
  --output .forge/datasets/policy-v1
```

The output contains:

- `sft.jsonl` for successful observable task/result pairs;
- `dpo.jsonl` for chosen/rejected pairs from comparable attempts;
- `router.jsonl` for lane, model, profile, success, latency, and token observations;
- `manifest.json` with source and row counts.

Model-weight training remains an external, versioned pipeline. Any trained adapter or replacement model must return through the same repeated development and held-out evaluation gates before use.

## Router learning

Router training is deterministic and creates an inactive candidate. It groups valid observations by task lane, model, and profile, then selects the highest-success route with latency and token use as tie-breakers.

```bash
forge train-router .forge/datasets/policy-v1/router.jsonl --repo .
forge promote-router .forge/router/candidates/router-<digest>.json --repo .
```

Only `forge promote-router` writes `.forge/active-router.json`. At runtime, a promoted router takes precedence over the global policy for lanes it covers. A `baseline` route removes the global policy for that task; a non-baseline route must match the explicitly promoted active policy. Missing models, missing profiles, malformed metrics, or invalid active records fail closed rather than silently falling back.

## Memory discipline

Run memory is repository-scoped and evidence-backed. A lesson is stored only when:

- the run succeeded;
- external verification passed;
- the reviewer approved the result;
- the lesson is specific enough to reuse;
- its confidence reflects the outcome;
- failed-run hypotheses are labeled as hypotheses.
