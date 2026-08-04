# What using Forge found that benchmarks did not

Forge was driven the way a user drives it -- build a project, look at the
result, send a follow-up -- against Qwen3-Coder-30B-A3B-Instruct-Q4_K_M on a
RunPod A40. Six defects surfaced in the first two runs. **None of them is
visible in a Polyglot score**, and one of them was actively hidden by it.

## The run that started it

> Build a snake game in Python using pygame. The snake moves with arrow keys,
> grows when it eats food, and the game ends if it hits a wall or itself. Show
> the score.

Forge reported `✓ Done`, `outcome: success`, reviewer approved. What it built:

| Requirement | Delivered |
| --- | --- |
| Uses pygame | 0 imports |
| Arrow keys | 0 key handling |
| Ends at walls | Wraps around (`% GRID_WIDTH`) |
| Playable | No game loop; `main()` simulates five moves and exits |
| Rendering | `print(f"Drawing snake at position {pos}")` |

The reviewer's summary: *"includes snake movement with arrow keys ... uses
pygame constants and follows the specified requirements."* It had the diff.

A follow-up naming exactly what was missing reported success again, claiming it
had replaced the print-based rendering, while `main()` stayed byte-identical.

## Why it happened

From the run's own artifacts:

1. `contract.json` acceptance was the raw prompt as **one undifferentiated
   string**
2. `evidence_required` was *"All configured verification commands pass"*
3. Verification was `pytest`
4. `pytest` ran `test_snake_game.py` — **written by the agent in that same run**
5. Five self-authored tests passed → `success`

Nothing outside the agent ever disagreed with it. Four requirements went in and
there was never a line item for the reviewer to fail.

## Fixed

| Defect | Fix |
| --- | --- |
| Self-authored tests accepted as evidence | Outcome is `unverified`, not `success`, when the run wrote the only tests and the repo had none |
| Contract collapses N requirements to one string | Deterministic split into per-sentence criteria, every one a literal substring of the request |
| `unverified` runs had their work **deleted** | Promotion gate keeps verified-but-unconfirmed work |
| A trailing newline discarded a whole run | `git diff --check` findings are no longer safety violations |
| `--json` emitted ANSI escapes | Written straight to stdout, bypassing Rich |
| Redirected runs got the human summary | `machine_output` asks `stdout.isatty()`, not Rich's `is_terminal` |

The last two share a root cause. Rich's `is_terminal` is true whenever
`FORCE_COLOR` is set, which CI commonly does, so a redirected CI run got a
progress spinner and a prose summary instead of the JSON it asked for. Whether
a human is watching is a property of the file descriptor.

## Two of these were mine

The promotion-gate deletion was caused by the `unverified` change in the same
session: marking a run not-successful made the transaction discard it. A
working `todo.py` was written, its tests passed, and the file was removed from
the repository. Caught by re-running the project after the fix rather than by
the unit tests, which had verified the predicate and not its consequence.

`test_redirected_run_output_is_only_machine_readable_json` had been failing for
the entire session and was filed as environmental. It was reporting a real bug
the whole time.

## Why the benchmark could not see any of this

Polyglot supplies its own test suite, so the self-authored-evidence path never
executes. Its stubs are shorter than one read chunk, so the partial-read
overwrite hole never executes. Its scoring reads a result file, so the `--json`
contamination never matters. And a wrong answer scores zero whether the harness
was honest about it or not — the snake game, scored as a benchmark case, is
simply a failure, indistinguishable from a weak model.

A score cannot tell you that the harness is lying to you. It reports the same
number either way. That is the argument for `forge replay` and for continuing
to use the thing on real work.

## Still open

- **The reviewer hallucinated against the diff.** Decomposed criteria give it
  line items, but nothing yet forces it to cite evidence per criterion.
- **Nothing checks that a program runs.** Every fix here makes Forge honest
  about what it does not know; none makes it know more. For a task like "build
  a playable game", the missing evidence is execution.
