---
description: Verify that the repository is ready for a tagged release.
allowed-tools: Read, Glob, Grep, Bash
---

Check version consistency, packaging, installation in a clean virtual environment, CLI help, tests, lint, typing, documentation commands, git diff/check status, and accidental secret inclusion. Do not publish, tag, push, or modify files. Return pass/fail evidence for each release gate.
