# Small/local-model coding-agent strategy

## Objective

Make Forge feel like Codex CLI or Claude Code while being deliberately optimized
for 5B–40B local models: fast first action, low protocol failure, focused
context, bounded autonomy, evidence-backed completion, and graceful degradation
when a model is weak at planning, tool use, or long-horizon execution.

The core principle is **adaptive orchestration**. Forge should not run the same
planner/executor/reviewer pipeline for every prompt or every model. The harness
should select the smallest reliable execution lane from deterministic evidence,
task class, repository state, and measured model capabilities.

## Current-state audit

### Strengths already present

- Repository sandbox and command policy.
- Typed planner, executor, reviewer, and tool schemas.
- Structured-output negotiation and protocol normalization.
- Focused retrieval, reference expansion, BM25-style scoring, and prefetch.
- Bounded action loops, repetition detection, no-progress detection, and repair.
- Verification and deterministic rejection when tests fail or no files changed.
- Session undo, interrupted-turn resume, run artifacts, and capability memory.
- Full-screen interactive shell with model switching and provider fallback.
- Public benchmark adapters for Aider Polyglot and Terminal-Bench.

### Main prompt-to-action latency problems

1. **Question routing may cost two model calls.**
   `Chat.dispatch()` can call the model router, then call the model again to
   answer the question. A normal repository question should usually require one
   model call, and simple repository inventory questions require none.

2. **The repository index is rebuilt repeatedly.**
   Chat routing, question answering, and coding runs independently rebuild and
   reread repository state. The index should be session-scoped, content-hashed,
   and incrementally invalidated.

3. **Verification can run before planning even when it adds no information.**
   Reconnaissance may run baseline verification for bug/complex tasks, and the
   deterministic precheck then runs configured verification again with a short
   timeout. Recent local run artifacts show about ten seconds spent in preflight
   before reaching planning, with no executor action.

4. **Planning is an availability and latency bottleneck.**
   The current benchmark artifact for `qwen3.5-9b-q4_k_m` spent three planner
   calls and roughly 154–160 model-seconds before useful execution. The fallback
   planner now prevents total failure, but an unnecessary planner call remains
   very expensive on a slow local endpoint.

5. **One model turn per action dominates wall time.**
   Read-only batching helps reliable models, but most investigation and repair
   remains an interleaved model/tool loop. Local models pay prompt prefill and
   decode latency on every step.

6. **Capability adaptation is too narrow.**
   The current profile tracks runs, calls, protocol errors, success, and
   characters per token. It only changes read batching and a prompt hint. It
   does not select an execution lane, context budget, protocol, role model,
   planning depth, or verification policy.

## Proposed chat-to-action pipeline

```text
User prompt
   |
   v
1. Normalize + explicit mode resolution
   |  /ask /do /plan /fast /deep, @file, !command
   v
2. Deterministic intent and repository-query recipes
   |  zero-model answers for directory/status/diff/test inventory
   v
3. Incremental repository snapshot
   |  cached map, symbols, imports, chunks, git state, test map
   v
4. Lane selector
   |-- A: deterministic tool answer             (0 model calls)
   |-- B: repository question                    (1 model call)
   |-- C: direct micro-edit                       (1 edit call + verify)
   |-- D: standard evidence-first agent           (plan/action graph + verify)
   `-- E: deep repair/architecture/parallel lane  (full orchestration)
   v
5. Tool graph execution
   |  parallel independent reads/checks; approval at mutation boundaries
   v
6. Targeted verification -> broader verification
   v
7. Deterministic verdict where possible -> semantic reviewer only when needed
   v
8. Evidence-backed result + capability update
```

## Execution lanes

### Lane A — deterministic tool answer

Use no model when the user asks for observable repository facts:

- “What is in this directory?”
- “What branch am I on?”
- “Show changed files.”
- “Which test commands are configured?”
- “List Python files under src.”

The answer should be generated from bounded Forge tools, not a shell string
invented by a model. This is faster, exact, and avoids consuming a model quota.

### Lane B — repository question

For explanatory questions, skip the separate model router. Build one focused
context and make one prose call. Use deterministic classification plus explicit
`/ask` and `/do` overrides. If classification confidence is low, default to
read-only rather than starting edits.

### Lane C — direct micro-edit

Use when all of these hold:

- one explicit target file;
- one small edit verb;
- no architecture/security/migration/debug marker;
- target file is readable and under a size threshold;
- a focused verification command is known.

Skip the planner. Give the editor the task, target file, exact constraints, and
one output schema. Apply one patch transaction, run targeted verification, and
escalate to Lane D only if the patch or verification fails.

### Lane D — standard evidence-first agent

Use a short planner only when the task requires localization or multiple steps.
The planner should emit a dependency graph of reads, searches, edits, and checks.
Forge executes independent read/search nodes concurrently, then asks the model
again only at observation-dependent boundaries.

### Lane E — deep lane

Reserve the full planner/executor/reviewer/repair machinery for architecture,
security, migrations, broad refactors, unclear bugs, and cross-cutting changes.
Parallel worktree candidates and stronger reviewer models belong here, not on
ordinary prompts.

## Make commands happen sooner

### Add user-authored direct execution

Support `!command` and `/run ...` as an explicit user command path. It should
still use Forge policy, sandboxing, timeout, output bounds, and approval rules,
but it must not ask a model to rediscover the command the user already supplied.

### Replace unconditional preflight with evidence-triggered preflight

- Do not run tests before planning for explanation, inventory, or simple edit
  tasks.
- Run a baseline only for reported failures, debugging, or tasks whose contract
  depends on current failing behavior.
- Never run the same verification command in both reconnaissance and preflight.
- Prefer the narrowest known test target before the full suite.

### Record and optimize time-to-first-action

Add timestamps for:

- prompt accepted;
- repository snapshot ready;
- first model token;
- first tool proposed;
- first tool executed;
- first mutation;
- first targeted test;
- final verification.

Primary latency metrics should include:

- prompt-to-first-tool;
- prompt-to-first-mutation;
- model calls before first tool;
- prefill tokens before first tool;
- redundant tool-call rate;
- wall time to first passing targeted test.

## Tool protocol strategy

Do not assume one protocol is best for every local model.

### Typed JSON tools

Keep as the safe default for models with reliable structured output. Use JSON
schema/grammar-constrained decoding whenever the endpoint supports it.

### Bash/code-action profile

Some models are substantially better at emitting shell or code actions than a
large nested JSON schema. In an isolated worktree/container, benchmark a
restricted bash-action protocol inspired by mini-SWE-agent and CodeAct. The
harness must still parse the command, apply policy, and execute with `shell=False`
or an externally sandboxed shell adapter.

### Patch/editor profile

For small edits, benchmark a direct patch protocol with deterministic patch
validation. Architect/editor separation is useful when one model can reason but
is unreliable at exact edits.

The capability store should select the protocol from measured success, safety,
latency, and protocol-error rates—not model size or a hardcoded provider name.

## Action-graph execution

The current interleaved loop repeats the full prompt for every action. Add a
bounded action graph:

```json
{
  "nodes": [
    {"id": "r1", "tool": "read_file", "depends_on": []},
    {"id": "r2", "tool": "search_text", "depends_on": []},
    {"id": "e1", "tool": "replace_text", "depends_on": ["r1", "r2"]},
    {"id": "t1", "tool": "run_command", "depends_on": ["e1"]}
  ]
}
```

Forge should execute independent read-only nodes concurrently, stop at mutation
or uncertainty boundaries, and feed a compact observation table back to the
model. This preserves feedback while reducing sequential model calls.

## Repository understanding

### Incremental index

Persist a repository snapshot keyed by path, size, mtime, and content hash.
Only changed files should be reparsed. Share one snapshot across chat routing,
answers, and coding runs.

### Model-sized context

Aider reports that repository maps can confuse weaker models, so map size and
structure must be model-adaptive. Suggested defaults:

- 5B–7B: path list, signatures, two to four focused chunks;
- 8B–14B: signatures plus import neighbors and four to eight chunks;
- 20B–40B: broader symbol/call graph with bounded source context.

### Chunk-level retrieval

Current retrieval ranks path and symbol metadata, then includes whole files.
Add content chunks with lexical/BM25 retrieval, import/call-neighbor expansion,
and exact identifier boosts. Preserve signatures, tests, diagnostics, and local
conventions during compression.

### Stable project context

Support project instructions (`AGENTS.md`, `CLAUDE.md`, or a Forge-native file),
skills, and user-invoked workflows. Keep stable instruction prefixes byte-for-
byte identical so inference servers can reuse their KV cache.

## Inference optimization for local endpoints

1. **Prefix caching.** Keep system prompts, tool schemas, project instructions,
   and stable repository map sections at the beginning of prompts. vLLM can
   reuse shared KV prefixes, and llama.cpp supports prompt/slot caching.
2. **Grammar-constrained decoding.** Keep JSON schemas small and endpoint-
   compatible. Probe once, cache the supported structured-output mode, and
   avoid repeated downgrade attempts.
3. **Speculative decoding.** Expose server diagnostics/recommendations for
   llama.cpp draft-model or n-gram speculative decoding. Measure acceptance and
   actual time-to-first/useful action rather than assuming it always helps.
4. **Short role outputs.** Planner and router outputs should have low token
   ceilings. The executor should produce actions, not essays.
5. **Role-specific providers.** Allow a fast 1B–7B action/router model, a stronger
   editor model, and a deterministic or stronger reviewer. One provider for all
   roles wastes capability and latency.

## Expanded model capability profile

Track by model, quantization, endpoint, protocol, role, and task class:

- structured-output success and normalization categories;
- tool-selection and argument accuracy;
- read-batch success and optimal batch size;
- patch-application success;
- planner validity and plan usefulness;
- reviewer false-approval/false-rejection rates;
- context length at which quality degrades;
- prefill/decode speed and first-token latency;
- success by task class and language;
- repeated-action and no-progress rates;
- preferred lane and protocol.

Use Bayesian smoothing or minimum-sample gates before changing policy. Every
adaptive decision should be logged and benchmark-reproducible.

## Codex/Claude-class product capabilities to add

- Explicit sticky modes: ask, code, plan, and auto; separate intent from
  permission level.
- `@path` context references and direct `!command` execution.
- Project instructions and reusable skills.
- Lifecycle hooks for formatting, linting, policy, and custom verification.
- Crash-safe session resume and checkpoint/rewind UX.
- Sandboxed worktree execution for autonomous modes.
- MCP/ACP-style integration boundary after the core local loop is stable.
- Optional subagents only for clearly independent work; avoid using them as a
  substitute for a reliable single-agent loop.

## Evaluation plan

### Task classes

1. Directory/repository fact question.
2. Explain one file or symbol.
3. One-file micro-edit.
4. Bug with a named failing test.
5. Bug without a known reproduction.
6. Multi-file feature.
7. Cross-cutting refactor/security task.

### Models

Run repeated trials across representative 5B–7B, 8B–14B, and 20B–40B local
models at fixed quantization and serving settings.

### Required ablations

- deterministic routing vs model router;
- always-plan vs adaptive lanes;
- unconditional vs evidence-triggered preflight;
- one-action loop vs action graph;
- JSON tools vs bash/code-action vs patch protocol;
- fresh index vs incremental index;
- prefix caching off/on;
- speculative decoding off/on;
- one provider vs role-specific providers.

### Success criteria

Optimize a Pareto frontier rather than one score:

- external task pass rate;
- false-success rate;
- safety violations;
- prompt-to-first-tool and prompt-to-first-mutation;
- total wall time;
- model calls and tokens;
- protocol-error rate;
- user approvals and interruptions.

## Prioritized implementation roadmap

### P0 — immediate, highest return

1. Bypass the model router for confidently classified questions.
2. Add deterministic repository-fact recipes, including directory listing.
3. Add `/ask`, `/do`, `/fast`, `/deep`, `@path`, and `!command` primitives.
4. Eliminate duplicate/unconditional preflight verification.
5. Add time-to-first-action timestamps and metrics.
6. Reuse one session-scoped repository index.

### P1 — adaptive execution

1. Implement lane selection and direct micro-edit mode.
2. Expand capability profiles and policy decisions.
3. Add targeted-test discovery and staged verification.
4. Add bounded action graphs with parallel read-only execution.
5. Add role-specific providers.

### P2 — stronger small-model protocols

1. Benchmark JSON, restricted bash/code-action, and patch protocols per model.
2. Add incremental chunk/symbol/import index persistence.
3. Add stable project instructions, skills, and hooks.
4. Add server capability probing for prefix caching, structured output, and
   speculative decoding.

### P3 — deep-task competitiveness

1. Worktree-isolated parallel candidates.
2. Patch minimization and semantic/static-analysis review.
3. Crash-safe resume from persisted action graph state.
4. Benchmark-gated trajectory export and optional LoRA/SFT training for Forge's
   fixed action protocols.

## External evidence

- SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering —
  https://arxiv.org/abs/2405.15793
- Agentless: Demystifying LLM-based Software Engineering Agents —
  https://arxiv.org/abs/2407.01489
- RepoCoder: Repository-Level Code Completion Through Iterative Retrieval and
  Generation — https://arxiv.org/abs/2303.12570
- Executable Code Actions Elicit Better LLM Agents —
  https://arxiv.org/abs/2402.01030
- An LLM Compiler for Parallel Function Calling —
  https://arxiv.org/abs/2312.04511
- ReWOO: Decoupling Reasoning from Observations for Efficient Augmented
  Language Models — https://arxiv.org/abs/2305.18323
- ToolACE: Winning the Points of LLM Function Calling —
  https://arxiv.org/abs/2409.00920
- xLAM: A Family of Large Action Models to Empower AI Agent Systems —
  https://arxiv.org/abs/2409.03215
- Aider repository map and chat modes — https://aider.chat/docs/repomap.html and
  https://aider.chat/docs/usage/modes.html
- mini-SWE-agent — https://mini-swe-agent.com/latest/
- llama.cpp grammar and speculative decoding documentation —
  https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md and
  https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md
- vLLM automatic prefix caching —
  https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/
- Anthropic Claude Code best practices —
  https://www.anthropic.com/engineering/claude-code-best-practices
- OpenAI Codex CLI getting started and approval modes —
  https://help.openai.com/en/articles/11096431
