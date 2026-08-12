// The invoking shell may export FORGE_URL/FORGE_MODEL/FORGE_API_KEY (or any
// future FORGE_*); the suite's default-resolution assertions must not inherit
// them. Runs before each test file; spawned subprocesses inherit the scrubbed
// environment. Tests that exercise overrides set variables explicitly.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("FORGE_")) delete process.env[key];
}
