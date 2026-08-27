# Contributing to Forge

Forge accepts focused issues and pull requests that preserve its bounded,
evidence-first execution model.

## Development setup

Requirements:

- Node.js 22.12 or newer;
- Git;
- Docker or Podman only when exercising the optional container backend.

```sh
npm ci
npm run check
npm run build
```

## Change workflow

1. Read `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and the relevant tests.
2. State the invariant being changed.
3. Add or update a failing test.
4. Implement the smallest coherent behavior.
5. Run focused tests, then `npm run check` and `npm run build`.
6. Inspect `git diff --check` and the complete diff.
7. Update current documentation only after behavior is proven.

Use Conventional Commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
so the reviewed release workflow can prepare accurate versions and changelogs.

AI-assisted contributions are welcome. Contributors remain responsible for the
submitted design, licensing, security, tests, and factual claims. Do not include
private prompts, credentials, generated secrets, or unreviewed bulk output.

## Safety invariants

- Model-controlled text never reaches a shell.
- Every path is contained within the selected repository root.
- Effects pass through proposal, preview, approval, revalidation, and commit.
- Verification evidence, not the model's claim, decides completion.
- New capabilities require bounded mechanism tests and honest limitations.

See `docs/SECURITY.md` for the detailed threat boundary and `SECURITY.md` for
private vulnerability reporting.
