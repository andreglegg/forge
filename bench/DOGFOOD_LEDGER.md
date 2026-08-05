# Dogfood: building a project with Forge

Forge driving a real multi-session build, on 2026-08-05. Ten headless `forge run`
sessions against `qwen2.5-coder:14b` on a LAN Ollama endpoint, building a small
double-entry ledger library (`src/money.js`, `src/account.js`, node:test suite)
from an empty skeleton. One session per task, no human turn-by-turn steering.

The model is in Forge's target class and is weak: `bench/MODEL_SCALING.md` puts
14B at 11.9-14.3% on Polyglot. That is the point -- a weak model exercises the
harness's failure paths, which is what this run was for.

## What it found

Six issues, all reproduced as tests before being fixed.

### 1. A completion that changed nothing was reported as success

The worst of them. Asked to add `parseAmount`, the model failed every edit it
attempted and wrote as its own final message: *"I am unable to proceed with the
requested changes."* The run exited **0** with `ok: true` and an empty
`committed` list.

The cause is structural, not a slip. The gate runs the project's suite and
believes a pass. A suite that was green before the run is still green after a
run that did nothing, so verification cannot separate success from inaction --
`passed: true` only ever meant "the repository is not broken".

Fixed by giving the gate the one fact verification does not carry: whether
anything changed. A completion claimed with zero committed mutations is pushed
back on once, and if the model repeats the claim the run ends as failed.
`tests/no-change-completion.test.ts` drives the real CLI and asserts the exit
code, because this bug lived precisely in the exit code.

### 2. A directory where a file was meant, with no way out

The model sent `MKDIR src/money.js`. Forge created a directory with that name.
Everything after that was unrecoverable:

| the model sent | Forge answered |
|---|---|
| `CREATE src/money.js` | "already exists; edit it instead of creating it" |
| `EDIT src/money.js` x4 | "This exact action already failed" |
| `READ src/money.js` | "is a directory; use LIST" |

Only the last message was true, and it arrived after six wasted turns. The
create/edit path checked *whether* the entry existed before checking *what it
was*, so it gave advice -- edit it -- that cannot be carried out on a directory.

Fixed in three places: the entry type is now checked first and named
("`src/money.js` is a directory, not a file. Remove it with DELETE ... or write
to a different path"); `MKDIR` refuses a path whose basename looks like a source
file, per the standing rule preferring deterministic validators over recoverable
ambiguity; and the repetition guard now repeats *why* an action failed rather
than only that it did.

### 3. Two guards that deadlock

The largest single consumer of turns, seen in three sessions. The sequence:

1. The model sends a read and an edit in one reply.
2. The edit is refused -- correctly, it was composed before the content arrived.
   The message says "Send the change now, quoting the real text."
3. The model re-reads the file to do exactly that.
4. The re-read is refused: "has not changed since you read that exact range."

Neither guard is wrong alone. Together they leave no legal move, and the model
alternates between the two refusals until the run dies. Because the harness
itself took away the model's look at the file, it now permits one repeat read of
that path. The allowance is spent, not standing, so a model that keeps asking
without acting still meets the guard.

### 4. "Cannot find module" treated as a broken toolchain

A test importing `../src/money.js` -- a file the model had not written yet --
was classified `toolchain`, which is budgeted for a single retry because a
missing *executable* is not something a code edit can fix. The run stopped while
the actual repair was one CREATE away.

The discriminator is the specifier: a relative or absolute path is this
repository's own code, and a bare specifier (`express`, `pytest`) is an
uninstalled dependency and genuinely environment work. Also fixed a gap the test
exposed -- Python's `No module named` spelling matched nothing at all.

### 5. A mis-quoted anchor was refused without a hint

The most common editing failure these models have. Told "the search text was not
found ... quote it exactly", the model re-sent the identical anchor five times
against `src/account.js`. It believes it already quoted exactly.

The refusal now carries the closest real lines from the file, numbered, chosen
by deterministic token overlap with no second model call -- the file is already
in hand. Below roughly a third shared tokens it stays silent, because printing
noise as a suggestion is worse than printing nothing.

### 6. The gate verifies the suite, not the request

Task 1 asked for a function *and* a test file. Only the function landed, the
suite passed, and the run was accepted. Not fixed: with commands configured,
nothing compares what was asked against what was done, and the read-back review
that would exists only on the no-commands path. Recorded as a known limitation;
fixing it properly means a second judge, which needs its own evidence.

## Before and after, same task and model

Task: *"Add `totalBalance(accounts)` to src/account.js ... add a test."*

| | turns | committed | result |
|---|---|---|---|
| before the fixes | 8 | 0 | exit 0, **reported success** |
| after the fixes | 6 | 3 | exit 0, suite green, work actually present |

The same task also demonstrates fix 1 directly: the "before" row is the false
success. A second task (`postEntry`) still fails after the fixes, but now fails
*honestly* in 2 turns -- "run finished with nothing committed" -- instead of
burning twelve.

**This is n=1 per row and must not be read as a measured improvement.** These
runs are single samples against a nondeterministic 14B, and this file makes no
score claim. What is established is mechanism: the false-success path is closed
by construction and covered by a CLI-level test, and the deadlock is gone
because one of the two refusals no longer fires. Whether any of it moves
Polyglot is unmeasured, and per `bench/TASK_PACKET.md` that question needs the
full 225 or a paired 42, not a story.

## Final state of the built project

Eight tests passing across `money`, `account`, and `version` modules, all
written by the model. Two of ten sessions produced nothing usable; both now end
as failures rather than as successes.

## Not Forge's fault

The first session failed because the scaffold's own `"test": "node --test tests/"`
does not work on Node 22.19 -- it resolves `tests` as a module. Forge refused to
report completion and was right to. Worth recording because it is what a broken
project looks like from inside the harness, and the classifier read it as a
toolchain failure, which is how issue 4 was found.
