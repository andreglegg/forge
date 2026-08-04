# What other agents do, and what of it Forge should take

A survey of Claude Code, Codex CLI, aider, Cursor and little-coder, with every
proposal checked against Forge's source and against 900 recorded case-instances
from the four complete Polyglot runs. Five candidate mechanisms; **three
survived adversarial verification, two were refuted.**

Recorded here mainly so the refuted ones are not re-proposed. Each was
plausible, well-argued and wrong for a reason that only shows up in the data.

## The finding that governs everything else

The model is the binding constraint. ~62% of the 621 failures are wrong
algorithms or multi-error implementations; the residual is dominated by
assertion failures (192). **Every surviving proposal has an honest expected
effect at or below the 3.41 run-to-run standard deviation.** None can be
validated by a single 225-case A/B.

The corrected baseline across the four runs is **31.0%**, not the 32.67%
previously carried in the notes.

That does not make the surviving items worthless. It makes them *correctness*
work: places where Forge asserts something false to the model. They ship as
bugs, gated on deterministic mechanism metrics, with "unknown" as the honest
answer on score.

## Shipped

| Fix | What was wrong | Commit |
| --- | --- | --- |
| Verification freshness | Round-1 results rendered as current on every round-2 step, and preferred over the model's own fresher `run_command` output | `1f7760c` |
| `replace_text` diagnostics | Failure classifier quoted the file zero times; every branch said "read the file again" | `76e8e64` |
| Partial-read overwrite | A ranged read satisfied the guard that exists to prove the model saw the file | `8a5f109` |

The last was found by mining recorded evidence rather than by any benchmark:
Polyglot stubs are shorter than one chunk, so every read there is a full read
and the path is never exercised.

## Refuted — do not rebuild

**Verification gate before `final` (Claude Code's Stop hook shape).** The
proposal was that Forge accepts `final` without evidence because
`_completion_obligation` returns "" for tasks that do not request test
authoring. The source reading is correct. The conclusion is not.

613 of 621 failures (98.7%) already receive verifier output as the next round's
observation. Decisively: of the 169 failures whose final diagnostic is
compile-class, **163 (96%) had already been shown that exact compiler output in
an earlier repair round** and shipped broken code anyway. Genuine headroom is 6
cases of 900. Its own worked example — `tuned-v1 go/react` — shows the model
quoting the diagnostic verbatim and then dying on `failed_action_refused |
replace_text`. The binding constraint is edit application, not observation.

The headline statistic ("287 blind voluntary stops = 46.2% of failures") does
not reproduce under any reading: 60 strict, 402 generous, and the per-language
split matches neither.

**Compile check after every mutation (Cursor).** Blocked by policy on its two
largest targets: `policy.py` does exact token-prefix matching, and the Polyglot
allowlist authorizes `cargo test` / `go test`, not `cargo check` / `go build`.
cpp and javascript run opaque `cpp-test.sh` / `npm-test.sh`, so a mapping keyed
on the configured command never fires. The Python "natural experiment" offered
as evidence is definitional — pytest has no compile stage. Honest ceiling
1.1–1.6 points against sd 3.41, at roughly double the benchmark wall clock.

## Duplicative of machinery Forge already has

- **Skills / knowledge injection (little-coder).** `instructions.py` globs
  `.forge/skills/*.md`; `prompts.py` has TOOL_GUIDE/TOOL_RULES; `_match_failure`
  returns cause-differentiated repair text; `MemoryStore.relevant` does scored
  selection.
- **Architect/editor split (aider).** Forge already has planner/executor/
  reviewer.
- **Fast-apply model (Cursor).** Exists because Cursor's model emits lazy
  `// ... existing code ...` diffs. Forge's exact-match `replace_text` is the
  stronger design under rule 9, and the failure evidence does not implicate
  apply fidelity.
- **Vectorstore semantic search.** `repo.py` covers the real case; Polyglot
  exercises are single-file. Textbook rule-1 speculative framework.

## Already falsified — do not re-propose in disguise

Widening the prompt budget (p=0.146/0.289/0.688) and serving evicted re-reads
(p=1.000). See `TUNING_EXPERIMENTS.md`.

## The largest unexplored lever

Forge pays the cost of code-in-JSON on 100% of edits. Aider's published
measurements put that at **-3.2 to -9.5 points** across every model arm tested,
at 100% well-formedness — the loss is not malformed output, it is that models
write worse code when escaping it into JSON. Forge's recorded traffic carries
497,483 backslashes, 4.28% of executor output on edit turns, and `protocol.py`
holds four repair passes that exist only because of hand-escaped code.

A plain-text SEARCH/REPLACE surface would touch `protocol.py`, `protocols.py`,
`prompts.py`, `agent.py` and `schemas.py` at once, which is not a smallest-
coherent-behaviour slice. Sequence it as its own investigation.

## Not yet run

Raising `max_review_rounds` is a **zero-code experiment** and should precede any
further loop work. `detect.py` pins it to 1 for the benchmark profile, and no
recorded run has ever executed more than one repair round. Several remaining
proposals reduce, in net effect, to "give the loop more observe-repair cycles" —
if flat rounds do not move the number, those have no mechanism left to claim.
