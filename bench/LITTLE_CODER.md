# Little Coder paired benchmark

The fixed screen in `polyglot-paired-42.txt` is the case set emitted by
Forge's `model-screen` preset. The baseline competitor is Little Coder v0.0.2
at commit `1d62bde6`.

Apply `little-coder-v0.0.2-parity.patch` to a clean v0.0.2 checkout. The patch
does not alter Little Coder's prompts, tools, memory, model profile, agent loop,
or verification logic. It only makes dataset/output paths configurable, accepts
the fixed case manifest, and forwards temperature on its OpenAI-compatible
provider so both agents can use identical inference controls.

The paired configuration is:

- dataset commit: `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`
- model: `qwen3-coder-30b-a3b-instruct-q4_k_m`
- endpoint: `http://127.0.0.1:8790/v1`
- temperature: `0.1`
- reply cap: `3000`
- attempts: two, with turn caps of 12 and 8

The Little Coder report's built-in overall percentage still uses the full
225-case dataset denominator. For a manifest run, calculate the paired score
from the selected detail records, not its `overall.pct` field.
