import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",

    // Explicit imports of `test`/`expect`/`vi` rather than ambient globals.
    // The port injects dependencies at the module boundary instead of
    // monkeypatching module attributes, so tests import what they use.
    globals: false,

    // Threads with per-file isolation. The suite it replaces makes ~93 real
    // git invocations and spawns real subprocesses; those must not share a
    // process, a cwd, or an environment with each other.
    pool: "threads",
    isolate: true,

    // Real subprocesses (git, the verifier, the syntax validator) are slower
    // to spawn under Node than under CPython. These bounds are for a test that
    // has hung, not for a test that is merely doing I/O.
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Every temp directory is owned by a fixture and torn down with it; a test
    // that leaks one should fail loudly rather than pollute the next file.
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
