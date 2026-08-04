# Forge Harness engineering instructions

## Mission

Build a production-grade, provider-neutral coding-agent harness that improves the reliability of 5B–40B models through structured orchestration, retrieval, verification, and measured policy optimization.

## Non-negotiable rules

1. Work in vertical slices with tests. Do not create large speculative frameworks without executable behavior.
2. Preserve the repository sandbox. Every filesystem path must be resolved and checked against the configured repository root.
3. Never execute model-provided text through a shell. Commands must be token arrays, run with `shell=False`, checked by policy, timed out, and output-bounded.
4. Never expose hidden chain-of-thought. Store concise decision summaries and observable evidence only.
5. Self-improvement is benchmark-gated policy optimization. It must not silently modify source, prompts, or active configuration.
6. Candidate promotion requires persisted evidence and an explicit user action.
7. Tests, lint, and type checking are part of the definition of done.
8. Keep provider adapters thin. Core orchestration must not depend on one vendor's tool-call format.
9. Prefer deterministic parsers and validators over asking the model to recover from preventable ambiguity.
10. Do not claim a capability is complete unless an automated test or reproducible command demonstrates it.

## Architecture boundaries

Forge is the TypeScript agent at the repository root. `src/` is its source;
`bin/forge` runs the built `dist/`. The Python harness and the earlier TS
attempt are archived under `legacy/` and are not maintained.

- `provider.ts`: provider transport only.
- `protocol.ts` / `codecs.ts`: the text action protocol and its decoders.
- `native.ts`: provider-native tool calling, kept behind the same protocol.
- `workspace.ts`: sandboxed path resolution, reads, anchored edits, diffs.
- `context.ts`: retrieval and budgeted prompt assembly; no model calls.
- `instructions.ts`: deterministic project-instruction discovery.
- `exec.ts`: bounded command execution, `shell: false`, token arrays only.
- `verify.ts`: the completion gate; the project's own commands are authoritative.
- `session.ts` / `replay.ts`: recorded runs and offline decoder scoring.
- `bench.ts` / `polyglot.ts` / `compare.ts`: isolated benchmark execution.
- `cli.ts`: user interaction, orchestration and dependency assembly.

## Required workflow for each change

1. Read the relevant architecture document and existing tests.
2. State the invariant being changed.
3. Add or update a failing test.
4. Implement the smallest coherent behavior.
5. Run targeted tests, then the full check suite.
6. Inspect `git diff --check` and the complete diff.
7. Update documentation only after behavior is proven.

## Initial priorities

Read `CLAUDE_HANDOFF.md` for current state and open work, and `bench/` for what
has been measured. Do not jump to distributed execution, fine-tuning, a GUI, or
arbitrary MCP access before the safety, evaluation, and resumability foundations
are solid.

Measurement discipline: the 42-case screen has about +/-5 cases of run-to-run
variance, so prefer the mechanism over the score gap, or use the full 225. Two
plausible-sounding interventions have already been measured and rejected; see
`bench/TASK_PACKET.md`.
