# Testing Forge against real models for free

Live models are the only way to *discover* how a harness fails, and they are the
expensive, rate-limited, nondeterministic part of the loop. Almost none of the
work of *fixing* a failure needs one. This is how the two halves are split.

## The rule

**A live model discovers a failure once. The reply is kept, and the fix is
iterated against the recording, forever, at no cost.**

Every one of the six defects in `bench/DOGFOOD_LEDGER.md`, and both in this
file, were verified with a scripted provider or a recorded reply. Not one fix
needed a model to confirm it.

## Free capacity, measured 2026-08-05

| source | limit | Forge sessions |
|---|---|---|
| OpenRouter `:free` models | 20 req/min, 50 req/day | ~3-4/day |
| OpenRouter `:free`, after a one-time $10 deposit | 1000 req/day | ~75/day |
| Local Ollama | none | unlimited |

A session costs one preflight plus up to twelve turns, so budget ~13 requests.
The $10 is not consumed by `:free` models -- it raises the daily tier and stays
available for paid ones.

The local box (32 GB RAM, RTX 3060 Ti 8 GB, 11.3 GB free disk as measured) can
hold a 30B-A3B MoE only after ~10 GB is freed. An MoE of that shape activates
about 3B parameters per token, which is why it remains usable with 8 GB of VRAM
where a dense 30B would not be.

## Capturing a failure

A run writes its turns to `.forge/traces/<session>.jsonl`. **That directory is
gitignored and does not survive.** The traces from the run that produced this
file were lost to a wiped temp directory hours after the run, and had to be
reconstructed from a terminal transcript. Copy anything worth keeping:

```sh
cp .forge/traces/<session>.jsonl bench/traces/<model>-<what-went-wrong>.jsonl
```

Name it for the defect, not the date. The point of the file is the failure mode.

## Iterating for free

```sh
forge replay bench/traces/          # decoder verdict on every recorded reply
```

It reports conversion rate, repairs applied, and failure categories, with no
network and no model. The categories in `src/replay.ts` are an API: renaming one
invalidates every recorded comparison against it.

For anything above the decoder -- the gate, retries, backends, the run loop --
use a scripted provider. `tests/no-change-completion.test.ts` and
`tests/retry-cli.test.ts` drive the real CLI against a local HTTP server that
replies with whatever the test needs, including malformed and adversarial
output. That is the pattern to copy; it is deterministic and instant.

Fixtures under `bench/traces/` are enforced by
`tests/openrouter-fixes.test.ts`, so a captured failure is a permanent
regression rather than a file nobody runs.

## Findings from the OpenRouter run

**A 3000-token reply budget applied to a 256k endpoint.** With no `--context`,
`contextWindow` is 0 and `replyBudget` falls back to 3000. Pointed at
`nemotron-3-nano-30b-a3b` (256k context), the model's edit exceeded that on every
attempt, was truncated every time, and the run stopped. It read as a model
failure and was a configuration failure. Preflight already fetched `/models`,
where OpenRouter advertises `context_length`, and discarded it. It is now read
when offered and ignored when absent or nonsensical; an explicit `--context` or
a profile still wins.

**A reply that answered its own tool call.** The same model emitted
`{"status":"read","path":"package.json","contents":"..."}` -- the shape of an
observation, with contents it invented, naming a package (`bank`) that is not in
the repository. Role confusion rather than a malformed action, so no directive
rule could catch it and the turn decoded to silence. The stall breaker stopped
the run in two turns, correctly, but nothing told the model what it had done.
The decoder now recognises the shape, records `hallucinated_tool_result`,
categorises it as `tool_result_echo`, and the run says plainly that the contents
were never read. The recorded replies are in
`bench/traces/nemotron-30b-a3b-hallucinated-result.jsonl`.

Neither fix is measured against a benchmark. Both are mechanism: one removes a
configuration cliff, the other names a failure that was previously silent.

## Sweep, 2026-08-05: 8 sessions, 2 models, 4 tasks

Run once the daily tier was raised. Each session got a fresh repository, and
`npm test` was re-run independently afterwards rather than trusting Forge's
verdict -- which is what made the headline result visible.

| | qwen3-coder-30b-a3b | nemotron-3-nano-30b-a3b |
|---|---|---|
| t1 add function + named test file | committed both, green, **exit 1** (silent finish) | **exit 0, ok:true, test file never written** |
| t2 new module + tests | exit 0, correct | exit 1, nothing committed (no-change rule) |
| t3 function + named doc file | function only, doc absent, exit 1 | exit 1, oversized edit truncated |
| t4 rename + update callers | exit 0, correct | exit 1, oversized edit truncated |

**Forge's exit code was wrong in two of eight**, in opposite directions.

**t1/nemotron was a false success.** The task named `tests/clamp.test.js`. The
model added `clamp`, never wrote the file, claimed completion, and the gate
agreed because the pre-existing suite was green -- a test file that does not
exist breaks nothing. This is the gap `DOGFOOD_LEDGER.md` recorded as a known
limitation, caught in the act with an exit code of 0.

Fixed in `src/deliverables.ts`: a path the task *names* either exists at
completion or it does not, which is decidable without a second model. Re-running
the identical task and model afterwards produced both files, a green suite, and
four independently-verified `clamp` cases -- 11 turns instead of 3, the extra
turns being the model going back to write what it had skipped.

**t1/qwen was the mirror image.** Both files committed, suite green, `exit 1`.
The model finished the work, ran the tests, saw them pass, and then returned
empty replies until the stall breaker stopped the run -- it never claimed
completion, so Forge never gated it. The stall message now names that state
("you have already committed changes; say DONE or send the next action") rather
than the generic no-action text.

Note what was *not* done: "stalled with a green suite" was not made a success.
t3/qwen is the counterexample sitting in the same table -- function written, doc
file absent, suite green. Treating green-and-stalled as done would have turned
that partial delivery into a confident success.

The trace from the silent finish is kept in
`bench/traces/qwen3-coder-30b-a3b-silent-finish.jsonl`.
