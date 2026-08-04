# Model scaling: 7B / 14B / 30B — 2026-08-03

How far down the model-size curve Forge's orchestration still works. Relevant to
any claim that Forge is usable with small local models.

## Result (pinned 42 cases, packet off, 12 turns, two replications each)

| model | params | v1 | v2 | rate |
|-------|--------|----|----|------|
| qwen2.5-7b (general) | 7B dense | 2/42 | 2/42 | **4.8%** |
| qwen2.5-coder-14b | 14B dense | 5/42 | 6/42 | **11.9-14.3%** |
| qwen3-coder-30b-a3b | 30B MoE, ~3B active | 28/42 | 27/42 | **64.3-66.7%** |

Little Coder on the same 42 cases with the 30B: 19/42 (45.2%).

Replication is tight at the small end (7B identical twice, 14B within one case),
so these are stable measurements, not noise.

## Reading

There is a **cliff**, not a gradient, between 14B and 30B — roughly a 4.5x jump
in pass rate. Orchestration does not rescue a model that cannot produce
compiling code: inspected 7B failures run the full 12 turns, take 15+ actions,
edit files, and fail with `type_or_compile`. The agent loop is working; the
model is not.

So Forge's measured benefit has a **model-capability floor**. "Works with small
local models" is only supportable for models of roughly 30B-MoE capability and
up, on this benchmark. Below that the harness runs correctly and still loses.

## Confounds — do not read this as a pure size curve

The three models differ in more than parameter count:

- **Generation.** The 30B is Qwen3; the 7B and 14B are Qwen2.5. Some of the gap
  is a year of model progress, not size.
- **Coder tuning.** The 7B is a general instruct model, not a coder model. Its
  4.8% understates what a 7B *coder* model would do.
- **Architecture.** The 30B is MoE (~3B active parameters), the others dense.

A cleaner curve would need one family and generation at several sizes — e.g.
qwen3-coder at 7B/14B/30B if/when available. Until then the honest claim is
"these three models scored this," not "capability scales thus with size."

What is *not* confounded: every run used the same harness, the same pinned 42
cases, the same llama.cpp build on the same A40 GPU model, temperature 0.1, two
attempts at 12/8 turns. Serving stack was deliberately held constant — the 7B
and 14B GGUFs were served on the same infrastructure as the 30B rather than via
the local Ollama box, specifically to avoid a stack confound on top of the
others.

## Provenance

```text
qwen2.5-7b            Qwen2.5-7B-Instruct-Q4_K_M.gguf        digest qwen25-7b-q4km
qwen2.5-coder-14b     Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf digest qwen25coder14b-q4km
qwen3-coder-30b-a3b   digest 90169a9caa025170
dataset commit        7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f
llama-server          -c 32768 -b 512 -ub 512 -ngl 999 -fa on -ctk q8_0 -ctv q8_0
```

Reproduce:

```sh
bin/forge polyglot .forge/datasets/polyglot-benchmark --name <name> \
  --per-language 7 --url <endpoint> --model <id> --jobs 2
```

## Operational note

The 14B and 7B suites were initially run concurrently on one A40 with the 30B
suite. The GPU saturated at 100% while the host sat at 5/11 cores — these runs
are **GPU-bound, not CPU-bound**, so stacking suites on one GPU buys nothing and
inflates timeouts (see `TASK_PACKET.md`). Run one suite per GPU.
