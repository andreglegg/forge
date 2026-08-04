# Overnight session log

Written as I go, so what you read in the morning is what happened rather than
what I remember happening.

## The correction that shaped everything

I told you little-coder won, 10/10 to forge's 9/10. **That was wrong.** Running
forge three times on the same suite with the same model gave:

```
9.3/10 mean over 3 runs · range 9-10 · spread 1 task
  ~ 07-cross-file   2/3 — flaky
  ~ 08-dont-break   2/3 — flaky
```

little-coder's 10/10 sits *inside* forge's own range. On that suite the two are
statistically indistinguishable, and the difference I reported was exactly the
size of the noise. I had written in `DESIGN.md` that a 10-task suite resolves to
10 points, then read a 1-task difference as a result within the hour.

Everything below follows from that: the instrument had to become trustworthy
before any improvement to forge could be believed.

## What changed tonight

**The suite can now discriminate.** Four families it was missing:

| task | what it isolates |
| --- | --- |
| `11-retrieval` | the relevant file is 1 of 40 and the task names a *symbol*, not a path |
| `12-marker-collision` | a file containing `<<<<<<< SEARCH` verbatim, which the edit protocol must survive |
| `13-damage` | the failing assertion can simply be deleted to make the suite green |
| `15-three-files` | three coordinated edits, any one alone leaves the project broken |

**One task deleted rather than fixed.** `14-impossible` passed on its own
starting state — its check could only verify nothing was fabricated, which is
true of an agent that does nothing. Scoring a refusal needs turns-before-stopping,
which the runner cannot see. Shipping it would have handed every harness a free
pass. Reasons in `TASKS.md`.

**Timeouts raised to 900s.** `08-dont-break` took 282s against a 300s cap, so
its pass/fail was partly measuring endpoint load. A task that can fail by being
unlucky with latency is measuring the wrong thing.

**Damage is measured.** Guards run on the untouched copy first, to learn which
hold, then again afterwards. Anything that worked before and does not now is
damage — the metric no pass/fail can see, and the only thing that catches an
agent making a test pass by deleting the assertion. Ten tasks carry guards, all
verified green on their starting states.

**Failures keep their evidence.** `.forge/bench-failures/<task>/` now holds the
whole working copy — traces, journal, files as the agent left them — plus a
`BENCH.txt` with the prompt and verdict. Before this, a failure produced the
word FAIL, which is the one part of a failure needing no explanation. Two tasks
are flaky and I could not see why; now I will be able to.

## The result: forge loses

14 tasks, 3 trials each, same model, same starting states, independent judge,
strictly sequential:

```
forge         12.7/14 mean · range 12-14 · 1 false success · 1586s
little-coder  13.7/14 mean · range 13-14 · 0 false successes ·  584s
```

little-coder is ahead on the mean, has no false successes, and is 2.7× faster.
Eleven tasks are 3/3 for both. The three that differ are all losses for forge,
and all three are families I added *because* the old suite could not
discriminate:

| task | forge | little-coder |
| --- | --- | --- |
| `07-cross-file` | 1/3 | 2/3 |
| `12-marker-collision` | 2/3 | 3/3 |
| `15-three-files` | 2/3 | 3/3 |

Statistical honesty: forge's own spread is 2 tasks, so a 1.0 mean difference is
not separable at n=3. What makes it worth acting on is not the number — it is
that the losses are concentrated on three families and I know the mechanism for
two of them.

## Two mechanisms found, both fixed

**`12-marker-collision` — the edit format cannot express the edit.** Asked to
change one word in a file that *documents* merge conflicts, the model quoted ten
lines of context containing `=======` and `>>>>>>> REPLACE`. The inner divider
ended the SEARCH section and the inner terminator ended the block, so the search
text was silently truncated to something not in the file. Nothing threw; the
edit never applied. There is no local fix in the decoder — both the divider and
the terminator become ambiguous and resolving them needs the file, which the
decoder does not have. What fixes it is what the model should have done anyway:
`status: Draft` alone was a unique anchor. The prompt now demands the smallest
uniquely-matching anchor and says why over-quoting is not free.

**`15-three-files` — a completion that changed nothing was accepted.** One run
claimed success in *three seconds* having touched none of the three files. My
own review pass returned early when no files changed, with a confident comment
explaining that such a case was out of scope. The comment was the tell: it
argued a case was none of the function's business rather than what to do about
it. Now asked explicitly, and failing closed on an ambiguous verdict.

`07-cross-file` remains unexplained — the bug is in a file the task does not
name, and forge is not tracing to it. That is a context-selection failure and
the next thing to work on.

## Re-benching

forge with both fixes, three trials, same suite. Whether the number moves is the
test of whether the fixes were general or merely local.

## Standing rules I am holding myself to

- No difference smaller than the measured spread is a difference.
- A fix names the general failure class before it is written. "Task N failed" is
  not a reason.
- The fixture that exposed a bug becomes a regression test, not evidence that
  the fix generalises.
- Every task must start red, and every guard must start green.
