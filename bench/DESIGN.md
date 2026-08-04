# A benchmark for harnesses, not models

> If you cannot name plausible results that would make you conclude the
> competitor's general tools are better, this is advocacy, not evaluation.

## The claim this can actually support

The weights and the endpoint are fixed. The model is **not** held constant, and
saying so was my first mistake: each harness changes the prompt the model sees,
the observations it gets back, the actions available to it, and how many
attempts it gets. Those are the treatment. So the defensible claim is scoped:

> Under these models, budgets, approval policy and task distribution, harness A
> produces more useful outcomes than harness B.

There is no context-free measure of "harness quality" here, and nothing should
be compressed into one league-table number.

## Nothing is reported without a spread

forge scored 9/10 and 10/10 on two runs of the same suite with the same model.
The task that differed takes the *same code path* in both configurations, so the
entire observed gap was run-to-run variance — and I had already written down
that a 10-task suite resolves to 10 points before reading a 1-task difference as
a result.

So: every configuration is run *n* times, the spread is reported alongside the
mean, and **no difference smaller than the spread is a difference.** `forge bench
--trials n` exists for this and leads its output with the range, not the mean,
because the mean is the number someone will quote and the range is the number
that says whether they may.

## What actually varies when the model is fixed

Six things, and every task family below targets one of them.

| Capability | The failure it prevents |
| --- | --- |
| **Context selection** | the model edits a file it never saw, from memory of what such a file usually contains |
| **Protocol robustness** | a reply that says the right thing is parsed as nothing |
| **Feedback quality** | the model is told "failed" and not what would have worked |
| **Loop safety** | ten turns spent restating one wrong idea |
| **Verification** | "done" is believed |
| **Reversibility** | a wrong edit costs the user their afternoon |

A task that every harness passes, or none does, measures none of this. A task is
**discriminating** only if a plausible harness design fails it while another
plausible one does not.

## Task families

Each family names the capability it isolates.

1. **Protocol stress.** A 400-line file to edit; a file whose *contents* contain
   `=======` and `<<<<<<<`; a file with astral characters. Discriminates
   truncation handling and edit-format collision. A SEARCH/REPLACE harness can
   fail catastrophically here in a way a whole-file-rewrite harness does not —
   and vice versa on the long file.
2. **Retrieval.** The relevant file is one of forty; the task names a *symbol*,
   not a path. Discriminates context selection. Trivial with three files, which
   is why the first suite could not measure it.
3. **Feedback quality.** The obvious first edit is guaranteed to fail — an
   ambiguous anchor, a stale line number. Measures whether the harness's error
   text is actionable. Scored by *recovery*, below, not by pass alone.
4. **Verification.** The change looks right and breaks a test. Plus the same
   task with no test command available at all — the case that produced forge's
   only loss in the first run.
5. **Damage.** A task with an obvious destructive shortcut: make the failing
   test pass, where deleting the assertion also does. Scored by the guard
   suite, below.
6. **Termination.** A contradictory or impossible request. The correct outcome
   is a fast, explicit refusal, not a burned step budget. A harness that cannot
   stop is not measured by pass rate at all.
7. **Multi-file coherence.** Three coordinated edits where any one alone leaves
   the project broken.

## Metrics

Pass rate over twenty tasks has a resolution of five points. It is the headline
and it is nearly the least informative number here.

- **pass** — the bench's own checks, run in a fresh copy after the agent exits.
  Never the agent's report, never a command the agent also ran.
- **false_success** — claimed done ∧ ¬pass. The number a harness cannot report
  about itself. Gameable only by never claiming success, which `pass` then
  punishes; the pair is what makes each honest.
- **damage** — a *guard suite* of checks that passed on the **starting** state
  and fail afterwards. This is the one that catches "made the test pass by
  deleting the assertion", and no pass/fail metric can see it.
- **turns_to_success**, **chars_to_success** — cost. Characters, not tokens: the
  endpoint's tokenizer is not available offline and a token count produced
  without one is fabricated.
- **recovery** — of tasks whose first tool action failed, the fraction that
  still passed. Isolates feedback quality from first-shot luck.
- **termination** — on family 6, turns spent before stopping. Lower is better;
  reaching the cap is a failure however it is dressed.

## Approvals are the sharpest fairness trap

If I inspect forge's proposed edits and reject bad ones while the competitor runs
autonomously, I have inserted a skilled human into one system and measured
myself. The autonomous track needs a **deterministic approval mediator**:
approve reversible in-repository reads and edits, deny network and destructive
commands, and give *no semantic feedback* about whether an edit is good. Count
approval requests; exclude approval waiting from active runtime.

## Anti-overfitting

I am going to read these results and change forge. That is Goodhart's law with
extra steps, and the honest defences are structural rather than intentional.

- **60/40 dev/held-out split.** Fixes are driven by the dev half. The held-out
  half is run when claiming an improvement and its individual failures are not
  inspected — only the aggregate. A fix that moves dev and not held-out was
  overfitted, and that is a *reportable outcome*, not a setback to hide.
- **Fix the class, not the case.** Before changing anything, write down the
  general failure it belongs to. "Task 08 failed" is not a reason; "a claim was
  accepted with no evidence available" is.
- **The fixture that exposed a bug is a regression test, not evidence.** I fixed
  forge's no-test-command loss, ran it against one differently-shaped project,
  and called it generalised. That is one near-transfer data point, and it is not
  the same claim. Transfer has to be classified: *exact* (the original fixture),
  *near* (same failure mechanism, different ecosystem and file topology), *far*
  (unrelated repositories benefiting from the general capability), and
  *negative controls* (tasks the fix should not affect and must not harm). A fix
  that moves only the exact fixture is memorisation.
- **Rotation.** Symbol and file names are regenerated per run from a seed, so
  memorised specifics cannot help and neither can a fix keyed to them.

## Fairness traps, named in advance

Where this could be rigged in forge's favour without anyone intending it:

- **Task phrasing.** Written by me, these will drift toward my own protocol's
  idiom. Phrasings should come from someone who did not write the protocol.
- **Tool asymmetry.** `pi` has `bash`; forge's `run` is approval-gated. Both
  must run unattended (`--yes`), and where pi wins by shelling out to something
  forge structurally cannot do, that is a **capability** difference and must be
  labelled as one rather than counted as harness quality.
- **Verification discovery.** forge finds `npm test` and runs it; pi does not
  unless told. That is a genuine harness capability and should count — but it
  must be *reported as the reason*, not hidden inside a pass rate.
- **Timeouts and retries.** Identical per task, for both.
- **Concurrency.** One endpoint serves one request at a time. Runs must be
  strictly sequential or every duration is contention noise. I have already
  corrupted one run this way; it is the easiest mistake here to make twice.

## 9B and 30B

The prediction worth testing: **harness effects should be larger at 9B.**
Protocol robustness, feedback quality and loop safety all matter more as the
model gets worse, so a harness that helps should show a *wider* margin at 9B
than at 30B.

One correction to that prediction, and it matters: **verification is not
automatically more valuable at 9B.** A gate helps only if the model can read the
failure and produce a better revision. If it cannot, the gate buys a longer loop
and a worse cost profile, not a better outcome.

Read an inversion carefully rather than triumphantly:

- **forge ahead at 9B, behind at 30B** — effective scaffolding for weak models,
  a protocol tax on strong ones.
- **forge behind at 9B, ahead at 30B** — the edit protocol is too demanding for
  exactly the models it claims to serve. That would gut the positioning.
- **inversion only on verification-heavy tasks** — a difference in recovery
  competence, not general harness quality.

## What would make this worthless

- Tasks so easy that both harnesses pass everything. The first suite was close
  to this: 10/10 and 9/10 discriminated on exactly one task.
- Judging with a command the agent also ran. Then the harness marks its own
  homework and the number measures its confidence.
- Reporting pass rate alone. Damage and false-success are where the differences
  between these two designs actually live.
- Tuning to the visible half and reporting the visible half.
