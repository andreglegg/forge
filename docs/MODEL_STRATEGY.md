# Model-tier strategy

Forge should adapt orchestration to the model's practical capability rather than treating parameter count as a perfect predictor. Quantization, training data, context quality, and serving configuration can matter as much as nominal size.

## 5B–7B class

Recommended policy characteristics:

- very small focused context;
- explicit repository map plus two to six full files;
- low temperature;
- short plans with one verifiable action per step;
- exact replacement tools preferred over large file rewrites;
- mandatory reviewer and test loops;
- frequent protocol validation and correction;
- simple tasks decomposed into independently verifiable subtasks.

Avoid asking this tier to hold architecture, implementation, testing, and review in one generation.

## 8B–14B class

Recommended policy characteristics:

- moderate context with import-neighbor expansion;
- planner/executor/reviewer separation retained;
- slightly larger edit windows;
- test generation and implementation may be combined for small changes;
- one or two repair rounds;
- use a stronger reviewer model when available.

This tier can often solve repository tasks well when context is precise and verification is strong.

## 20B–40B class

Recommended policy characteristics:

- broader repository context and symbol graph;
- richer architectural plans;
- parallel patch candidates for difficult tasks;
- larger but still bounded edit transactions;
- deeper static-analysis feedback;
- reviewer can focus more on semantic and architectural defects.

Even at this tier, deterministic safety and external verification remain mandatory.

## Mixed-model routing

A high-value deployment can route roles independently:

- fast small model for file classification, search-query generation, and summarization;
- strongest available model for planning and difficult implementation;
- separate deterministic or stronger model for review;
- small model for reflection after evidence has been validated.

Routing decisions must be measured by task class, quality, latency, and cost. Do not assume the largest model is always the best use of resources.

## Context strategy

The retrieval stack should evolve in layers:

1. path and symbol lexical scoring;
2. import and call-neighborhood expansion;
3. BM25 over chunks;
4. optional local embeddings;
5. reranking based on task and plan;
6. context compression that preserves identifiers, signatures, invariants, and failing diagnostics.

For weaker models, removing irrelevant context is often more valuable than adding more context.

## Prompt strategy

Prompts should be modular and versioned:

- role contract;
- task and acceptance criteria;
- repository conventions;
- tool schemas;
- recent observable state;
- verification evidence;
- concise validated lessons.

Every prompt module should have a measurable purpose. Prompt growth without evaluation is technical debt.
