# Paired 42-case screen: this session's changes

Run 2026-08-05. Baseline vs candidate, 42 pinned cases each, same model, same
endpoint, launched concurrently so both arms met identical machine and network
conditions.

## Result

```
27/42 → 28/42 (+1, +2.38pp)
paired: 5 gained · 4 regressed · 23 both passed · 10 both failed
exact McNemar p=1.000
false-success attempts: +0
```

**No measurable difference.** p=1.000 is as null as this test gets, and 5 gained
against 4 regressed is churn well inside the +/-5 case variance this screen is
documented to have.

## Why it could not have been otherwise

The changes almost never fire on Polyglot. Counted across all 42 candidate
cases:

| rule | cases where it fired |
|---|---|
| completion with nothing committed | 0 |
| named deliverable missing | 0 |
| per-class retry budget exhausted | 0 |
| no-progress stop | 0 |
| stall with work already committed | 1 |

That is the whole explanation for p=1.000, and it is structural rather than bad
luck:

- **Nothing-committed** cannot arise. Every Polyglot case begins with a failing
  test, so a run that changes nothing leaves the suite red and is refused by
  verification anyway. The failure this rule exists for -- a *green* suite that
  was green before the run -- is unreachable here.
- **Named deliverables** cannot arise. The prompt names files by absolute path,
  and absolute paths are excluded by construction. Measured beforehand: 0 hits
  across 42 first-attempt prompts and 0 across 300 recorded retry prompts.
- **Retry budgets** rarely bind inside a 12-turn or 8-turn attempt when the
  repairable classes get four retries each.

So this run establishes that the changes **do no harm**, and nothing more. It is
not evidence that they help, and it never could have been.

## Checking the regressions

All four regressed cases used both attempts and failed with ordinary
`type_or_compile` or `test_failure` classes. None timed out, none stopped early,
and none carry a signature of the new rules. The gains are the same shape in the
other direction.

The candidate used *fewer* turns (543 vs 590) and fewer actions (1079 vs 1162)
while taking 438s more wall time. Fewer turns and more seconds points at
provider latency between two concurrent arms, not at harness cost -- so the
runtime difference is not attributed to the changes.

## What this does and does not license

Per the standing rule that no slice may claim a score gain without paired
evidence: **this session's changes claim none.** Their justification is the
mechanism and the product-level evidence in `DOGFOOD_LEDGER.md` and
`FREE_TESTING.md`, where each rule fired on a real failure that Polyglot does
not contain.

It also means the benchmark is the wrong instrument for this class of change.
Refusing a false completion is invisible to a pass-rate screen whose every case
starts red. Measuring it needs a harness whose cases can be *satisfied by doing
nothing*, which is a suite worth building and does not exist.

## Conditions

- Model `qwen/qwen3-coder-next` via OpenRouter, temperature 0.1, 2 tries,
  12 then 8 turns, 1800s attempt cap, `--jobs 4` per arm.
- Baseline is `main` plus **only** the spawned-agent credential fix, without
  which every baseline case would have failed HTTP 401 and the comparison would
  have measured that bug instead.
- 0 infrastructure errors and 0 timeouts in both arms.
- **Not comparable to the recorded 28/42 and 27/42**, which were measured on the
  local 30B-MoE. Different model and endpoint; the coincidence of the numbers is
  a coincidence.
- Total spend under $3.
