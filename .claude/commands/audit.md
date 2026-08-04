---
description: Run correctness and security audits without changing files.
allowed-tools: Read, Glob, Grep, Bash, Agent
---

Run the full check suite and inspect the complete working-tree diff. Delegate independent reviews to `forge-reviewer` and `forge-security`. Reconcile their findings, remove duplicates, and return only actionable issues ranked by severity, followed by verified strengths and missing test coverage. Do not modify files.
