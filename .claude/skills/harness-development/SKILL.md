---
name: forge-harness-development
description: Engineering playbook for reliable small-model coding-agent orchestration, evaluation, and gated self-improvement.
---

# Forge Harness development skill

Use this skill when changing the agent loop, protocol, tools, retrieval, memory, evaluation, or improvement system.

## Reliability hierarchy

Prefer improvements in this order:

1. deterministic validation and safer tools;
2. better evidence and test feedback;
3. smaller, more relevant context;
4. clearer role prompts and schemas;
5. additional model calls;
6. model routing or training.

Do not add model calls to compensate for a missing deterministic check.

## Protocol changes

- Version schemas when compatibility matters.
- Reject unknown fields and unknown tools.
- Preserve a bounded recovery path for malformed JSON.
- Record raw output and parse diagnostics in the run event stream.
- Test fenced JSON, prefixed text, truncated objects, wrong types, and contradictory final/action fields.

## Tool changes

- Resolve paths after joining with the repository root.
- Check symlink escapes.
- Keep writes atomic.
- Never use `shell=True` for model-controlled input.
- Bound command time, process output, file size, and result count.
- Return structured metadata for exit code and timeout.

## Evaluation changes

- Isolate every task in a fresh copy or worktree.
- Fingerprint the suite and candidate policy.
- Preserve task-level evidence.
- Separate agent-declared success from external verification.
- Treat safety violations as hard failures.
- Do not tune on the final held-out suite.

## Self-improvement changes

- Candidate generation must be bounded and reproducible.
- Evaluation must occur before promotion.
- Promotion must be explicit and auditable.
- Keep rollback data.
- Never let a candidate alter its evaluator or promotion rules during its own run.
