# Public benchmark adapters

Forge supports two independent, containerized public benchmarks. Both adapters
keep the benchmark's verifier authoritative: Forge's reviewer verdict is logged,
but it cannot turn a failing external test into a pass.

## Aider Polyglot

[Aider Polyglot](https://github.com/Aider-AI/polyglot-benchmark) contains 225
Exercism tasks across C++, Go, Java, JavaScript, Python, and Rust. Forge pins the
dataset and [Aider benchmark harness](https://github.com/Aider-AI/aider/tree/main/benchmark)
commits, hides tests from the model, and runs generated code only in Aider's
official Docker image.

Start the configured local endpoint, start Docker Desktop, then run:

```console
# One deterministic case from each language
forge benchmark polyglot --config forge.cognara.yaml --smoke --name smoke

# A quick end-to-end check
forge benchmark polyglot --config forge.cognara.yaml --smoke --limit 1 --name quick

# The official 225-case run, advanced in bounded resumable batches.
# Repeat this exact command until report.json records incomplete: false.
forge benchmark polyglot --config forge.cognara.yaml \
  --name qwen35-9b-full-v1 --batch-size 10

# A selected language or exercise
forge benchmark polyglot --config forge.cognara.yaml \
  --language python --case affine-cipher --name python-affine
```

The first run builds the large official image. Later runs reuse it. Results live
under:

```text
.forge/benchmarks/polyglot/<name>/run.json
.forge/benchmarks/polyglot/<name>/report.json
.forge/benchmarks/polyglot/<name>/cases/<language>/<exercise>/result.json
.forge/benchmarks/polyglot/<name>/cases/<language>/<exercise>/evidence/
```

The report is checkpointed after every case. `--batch-size N` runs at most N
previously unfinished cases and exits normally; rerunning the same command and
`--name` continues with the next unfinished cases. Completed disposable
worktrees and build caches are removed after the external verifier runs, while
bounded run evidence and the final patch are retained. This allows the 225-case
suite to finish on machines with limited free disk.

`run.json` locks the dataset commit, model, Forge configuration fingerprint, and
case selection. A resume with different inputs is rejected instead of silently
mixing incomparable results. The batch size may change between invocations.
`score_selected` always uses all selected cases as the denominator;
`score_completed` is also recorded so a partial run is interpretable without
being mistaken for a final score. Only a report with `incomplete: false` is a
complete Polyglot result. For comparison with a published mean of two runs, use
two different run names and complete all 225 cases under each.

Use `--dry-run` to inspect the Docker command without downloading or executing
anything.

## Terminal-Bench 2.0

[Terminal-Bench 2.0](https://github.com/harbor-framework/terminal-bench-2) is
the 89-task terminal benchmark run by
[Harbor](https://www.harborframework.com/docs/getting-started). Forge supplies a
custom installed-agent adapter; Harbor retains control of task containers,
timeouts, and verification.

Install Harbor once:

```console
uv tool install harbor
```

Then:

```console
# One task, sequentially
forge benchmark terminal-bench --config forge.cognara.yaml --smoke

# A named task
forge benchmark terminal-bench --config forge.cognara.yaml --task <task-name>

# Full 89-task suite with five trials per task (445 trials), matching the
# minimum repeated-run shape used for a leaderboard-style comparison.
# Keep concurrency at one for a single model-server slot.
forge benchmark terminal-bench --config forge.cognara.yaml \
  --concurrent 1 --trials 5
```

The smoke run deterministically selects
`terminal-bench/log-summary-date-ranges`, a current data-processing task. Harbor
requires fully-qualified task IDs; Forge automatically prefixes bare `--task`
values with `terminal-bench/`. The smoke run checks the complete integration and
is not an official benchmark score.

Forge maps `127.0.0.1` and `localhost` model URLs to
`host.docker.internal`, because the agent runs inside Harbor's container. Use
`--base-url` and `--model` for another OpenAI-compatible endpoint. `--trials N`
passes Harbor's repeated-trial count (`-k N`) without changing task selection.

For a RunPod GPU model server controlled from a Docker-capable local machine,
see [RUNPOD_BENCHMARKS.md](RUNPOD_BENCHMARKS.md). That topology is required for
standard RunPod Pods because they cannot run Forge's nested benchmark Docker
controllers directly.

Inside Harbor only, Forge accepts well-formed commands that are not in its
normal allowlist. Harbor's disposable task container is the outer sandbox;
Forge still confines file paths to the task worktree and still refuses
dangerous command arguments and secret paths. This authority is off by default
everywhere else.

Some Terminal-Bench tasks may require changing absolute paths outside the
configured task worktree. Forge deliberately refuses those today. Such failures
are a known compatibility limit, not permission to weaken normal host safety.

## Local repeated baseline

Before spending hours on a public container benchmark, measure the same model on
Forge's deterministic fixture suite repeatedly:

```console
forge eval evals/smoke.yaml --config forge.cognara.yaml \
  --trials 3 --name qwen35-9b-local
```

This is not an Aider or Terminal-Bench score. It is a fast regression gate for
harness changes, with retained trajectories and prompt-cache measurements. A
public benchmark should be attempted only after the local repeated baseline is
stable enough that one stochastic sample cannot reverse the conclusion.

## Reproducibility

- Keep one model endpoint, model quantization, context window, and Forge commit
  fixed for a comparison.
- Record the generated `report.json` or Harbor job directory.
- Do not compare a smoke or filtered score with the official full-suite score.
- Use `--dry-run` to capture the complete orchestration command.
- If Docker reports an unpack or I/O error, check host disk space before
  retrying; these images and task layers are large.
