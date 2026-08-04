---
description: Implement one requested roadmap slice using test-first development.
argument-hint: "<specific roadmap item>"
allowed-tools: Read, Glob, Grep, Edit, Write, Bash, Agent
---

Implement this slice: $ARGUMENTS

First delegate a bounded design review to `forge-architect`. Then implement the approved slice test-first. Run targeted tests and the full check suite. Delegate independent review to `forge-reviewer` and security review to `forge-security` when the slice touches paths, commands, execution, memory, evaluation, or promotion. Address blocking findings and provide exact evidence.
