# Releasing Forge

Forge uses Release Please for version and changelog pull requests. Published
releases are built from their Git tags and sent to npm with GitHub Actions OIDC;
the workflow does not use a long-lived npm token.

## One-time setup

1. Create `andreglegg/forge` as a public GitHub repository and push only `main`
   and the intended release tags. Do not push the archived prototype branches.
2. Enable private vulnerability reporting and GitHub secret scanning.
3. Protect `main`: require the CI check, require pull requests, and disallow
   force pushes and branch deletion.
4. Publish `@aglegg/forge-harness@0.1.1` once from the `v0.1.1` tag checkout using an npm
   account with two-factor authentication. `v0.1.0` was released on GitHub but
   its unscoped npm name was rejected before publication, so `0.1.1` is the
   first npm release:

   ```sh
   npm ci
   npm run check
   npm pack --dry-run
   npm publish --access public
   ```

5. In npm package settings, add a GitHub Actions trusted publisher for
   repository `andreglegg/forge` and workflow `release.yml`.
6. Create the corrected initial npm-backed GitHub release from the existing tag:

   ```sh
   gh release create v0.1.1 --verify-tag --generate-notes
   ```

The initial manual publish is necessary because npm trusted publishing can only
be configured after the package exists. It is the only release that should need
an interactive npm credential.

## Normal releases

1. Merge conventional commits into `main`.
2. Review and merge the Release Please pull request.
3. The release workflow creates the GitHub release and tag, runs the complete
   check and build, and publishes that exact version to npm through OIDC.
4. Confirm the GitHub release, `npm view @aglegg/forge-harness version`, and a clean
   install with `npm install --global @aglegg/forge-harness@latest`.

Never edit a published tag or reuse a published npm version. If publishing
fails after a GitHub release is created, fix the workflow and rerun it against
the same immutable tag; if the package itself was published incorrectly,
release a new patch version.
