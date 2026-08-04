# Why some tasks are not here

**14-impossible (removed).** An impossible request whose correct outcome is a
fast explicit refusal. The check could only verify that nothing was fabricated
and nothing was damaged — both of which are true of an agent that does nothing
at all, so the task passed on its own starting state and could not fail.

Scoring termination needs a metric the runner does not have: turns spent before
stopping. Until the runner can judge *how* a task ended rather than only what
the files look like afterwards, a refusal task is unscoreable here. Shipping it
anyway would have added a guaranteed pass to every harness's score and made the
suite look broader while measuring less.
