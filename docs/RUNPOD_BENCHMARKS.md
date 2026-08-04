# Run Forge benchmarks with RunPod inference

This setup keeps the official benchmark sandboxes on the Forge controller and
moves only model inference to a RunPod GPU. Standard RunPod Pods are already
containers and do not support running Docker or Docker Compose inside them, so
they cannot directly host Forge's Docker-based Aider Polyglot and Harbor
Terminal-Bench controllers.

The supported topology is:

```text
Mac / Forge workspace
  ├─ Docker: official Aider Polyglot verifier
  ├─ Harbor: official Terminal-Bench task containers
  └─ SSH tunnel 127.0.0.1:8092
                    │
                    ▼
RunPod GPU Pod
  └─ llama.cpp server 127.0.0.1:8080
       └─ Qwen3.5-9B Q4_K_M
```

The SSH tunnel avoids exposing the model endpoint publicly and avoids the
100-second limit imposed by RunPod's HTTP proxy. Keep the tunnel alive for the
entire benchmark.

The claim that a standard Pod cannot host the Docker-based controllers is
verified, not assumed. Inside a running Pod:

```console
$ capsh --print | grep Current
Current: cap_chown,cap_dac_override,cap_fowner,cap_fsetid,cap_kill,cap_setgid,
cap_setuid,cap_setpcap,cap_net_bind_service,cap_net_raw,cap_sys_chroot,
cap_mknod,cap_audit_write,cap_setfcap=ep
$ mknod /tmp/testnode b 7 0
mknod: /tmp/testnode: Operation not permitted
$ ls /dev/fuse
ls: cannot access '/dev/fuse': No such file or directory
```

That is the stock Docker capability set with no `CAP_SYS_ADMIN`, `mknod`
blocked and no `/dev/fuse` for a rootless fallback, so `dockerd` cannot start
and there is no Docker-in-Docker workaround on this product tier.

## 1. Create the Pod

Use a RunPod **Pod**, not Serverless.

Recommended starting configuration:

- official RunPod PyTorch template;
- one 24 GB GPU, with RTX A5000 as the economical default or RTX 4090 for more
  throughput;
- at least 30 GB persistent volume mounted at `/workspace`;
- public IP and SSH enabled;
- no public HTTP port is required for the model server.

Use on-demand capacity for the locked benchmark run. Interruptible capacity can
invalidate a long non-resumable Terminal-Bench job.

## 2. Build llama.cpp on the Pod

Connect using the SSH command shown by RunPod, then run:

```bash
apt-get update
apt-get install -y git cmake build-essential libcurl4-openssl-dev tmux curl

cd /workspace
if [ ! -d llama.cpp/.git ]; then
  git clone https://github.com/ggml-org/llama.cpp.git
fi
cd llama.cpp
git pull --ff-only
cmake -S . -B build \
  -DGGML_CUDA=ON \
  -DLLAMA_CURL=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j"$(nproc)"
```

Record the exact llama.cpp commit before starting the benchmark:

```bash
git rev-parse HEAD
```

## 3. Start the exact Qwen model

The model alias must remain `qwen3.5-9b-q4_k_m`, because it is part of Forge's
locked benchmark identity.

**`--jinja` and `--reasoning off` are load-bearing.** Qwen3.5 is a reasoning
model. Without them every reply arrives with the text in `reasoning_content`
and `content` empty, so Forge sees nothing to parse and scores near zero across
the whole suite. That failure is indistinguishable from a weak model in the
report; it is an endpoint misconfiguration. Verify with a completion request
(step 4) before starting any run.

```bash
nohup /workspace/llama-bin/llama-server \
  --model /workspace/models/Qwen3.5-9B-Q4_K_M.gguf \
  --alias qwen3.5-9b-q4_k_m \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 65536 \
  --n-gpu-layers 99 \
  --parallel 1 \
  --kv-unified \
  --flash-attn on \
  -ctk q8_0 -ctv q8_0 \
  -b 512 -ub 512 \
  --cache-ram 256 \
  --jinja \
  --reasoning off \
  --timeout 3600 \
  > /workspace/logs/llama-server.log 2>&1 &
echo $! > /workspace/llama-server.pid
```

These flags mirror the local Cognara server that produced the recorded
baseline, so the only deliberate differences in a RunPod run are the GGUF
build, the GPU and the Forge revision.

Download the GGUF once, ahead of the build, rather than relying on `-hf` at
start time; it removes a failure mode from the critical path and lets the
download overlap the compile:

```bash
mkdir -p /workspace/models
curl -L --fail --retry 5 \
  -o /workspace/models/Qwen3.5-9B-Q4_K_M.gguf \
  https://huggingface.co/jc-builds/Qwen3.5-9B-Q4_K_M-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf
```

Watch startup and the first model download:

```bash
tail -f /workspace/llama-server.log
```

From a second Pod shell, verify the server after it reports ready:

```bash
curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8080/v1/models
nvidia-smi
```

## 4. Create the SSH tunnel from the Forge controller

Register the controller's public key with the RunPod account **before creating
the Pod**. RunPod injects `PUBLIC_KEY` at container start, so a Pod created
first will refuse key authentication and has to be recreated:

```bash
runpodctl ssh add-key --key-file ~/.ssh/id_ed25519.pub
```

A bare `ssh -N` is not sufficient for a multi-day run. When the controller
changes network (Wi-Fi to hotspot, or a DHCP lease change) the previous `ssh`
keeps the local port bound with a dead transport, and `ExitOnForwardFailure`
then kills every replacement, so the tunnel never recovers. Supervise it and
clear the stale listener first:

```bash
while true; do
  STALE=$(lsof -nP -iTCP:8092 -sTCP:LISTEN -t 2>/dev/null)
  [ -n "$STALE" ] && { kill $STALE 2>/dev/null; sleep 2; }
  ssh -N -L 8092:127.0.0.1:8080 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=6 \
    -o ExitOnForwardFailure=yes \
    -i ~/.ssh/id_ed25519 -p <SSH_PORT> root@<POD_IP>
  sleep 5
done
```

Verify from the controller, and assert the GGUF identity rather than only the
model name — a local server may answer on the same port under the same alias
while serving a different build:

```bash
curl --fail http://127.0.0.1:8092/health
curl --fail http://127.0.0.1:8092/v1/models | python3 -m json.tool | grep -E '"id"|"size"'
```

The benchmark Docker containers automatically translate this local endpoint to
`host.docker.internal:8092`.

## 5. Run smoke gates first

From the Forge repository:

```bash
# One deterministic Polyglot exercise from each language.
forge benchmark polyglot \
  --config forge.cognara.yaml \
  --base-url http://127.0.0.1:8092/v1 \
  --model qwen3.5-9b-q4_k_m \
  --context-window 65536 \
  --smoke \
  --name runpod-qwen35-9b-polyglot-smoke

# One current Terminal-Bench task, one trial.
forge benchmark terminal-bench \
  --config forge.cognara.yaml \
  --base-url http://127.0.0.1:8092/v1 \
  --model qwen3.5-9b-q4_k_m \
  --context-window 65536 \
  --concurrent 1 \
  --trials 1 \
  --smoke
```

Do not begin the paid full run unless both smoke paths reach the external
verifier and the llama.cpp log shows stable inference without out-of-memory or
connection failures.

## 6. Run the Little Coder-comparable Polyglot benchmark

Little Coder's published Qwen3.5-9B figure is the mean of two complete 225-case
runs. Forge must therefore complete two separately named locked runs.

**Gate every batch on endpoint health.** Forge deliberately scores an
unreachable provider as a failed case rather than aborting the suite, so a
transient network drop silently converts real cases into permanent zero scores
with `calls: 0` and an `LLMError` summary. Two hotspot outages during the
recorded run corrupted 70 cases this way. Wait for the endpoint instead of
consuming cases; the run is checkpointed per case, so lost time costs nothing
and a lost case corrupts the result:

```bash
until curl -sf --max-time 20 http://127.0.0.1:8092/health >/dev/null; do sleep 30; done
```

Contaminated cases are identifiable after the fact (`metrics.calls == 0` plus an
`LLMError` summary) and can be repaired by deleting the case directory and
re-running the same command: `load_completed()` rescans `cases/*/*/result.json`
and `build_report()` recomputes the report from whatever remains. Re-run every
affected case, never a chosen subset.

Run A, repeatedly executing the exact same command until `report.json` records
`"incomplete": false`:

```bash
forge benchmark polyglot \
  --config forge.cognara.yaml \
  --base-url http://127.0.0.1:8092/v1 \
  --model qwen3.5-9b-q4_k_m \
  --context-window 65536 \
  --name runpod-qwen35-9b-polyglot-a \
  --batch-size 10
```

Run B uses the same command with a different locked name:

```bash
forge benchmark polyglot \
  --config forge.cognara.yaml \
  --base-url http://127.0.0.1:8092/v1 \
  --model qwen3.5-9b-q4_k_m \
  --context-window 65536 \
  --name runpod-qwen35-9b-polyglot-b \
  --batch-size 10
```

Reports:

```text
.forge/benchmarks/polyglot/runpod-qwen35-9b-polyglot-a/report.json
.forge/benchmarks/polyglot/runpod-qwen35-9b-polyglot-b/report.json
```

Only average the two `score_selected` values after both reports have
`incomplete: false` and `completed_case_count: 225`.

## 7. Run the Little Coder-comparable Terminal-Bench 2.0 benchmark

The comparison run is 89 tasks with five independent trials per task: 445 total
trials. Keep concurrency at one for the initial locked run so model-server slot
contention does not alter the policy comparison.

```bash
forge benchmark terminal-bench \
  --config forge.cognara.yaml \
  --base-url http://127.0.0.1:8092/v1 \
  --model qwen3.5-9b-q4_k_m \
  --context-window 65536 \
  --concurrent 1 \
  --trials 5
```

Unlike Polyglot, Harbor owns the Terminal-Bench job directory and this command
is not resumed by Forge's `--batch-size` mechanism. Keep the Pod, SSH tunnel,
Docker engine, and controller awake until Harbor finishes. If the job is
interrupted, retain the Harbor directory as partial evidence but start a new
full job for a publishable comparison.

## 8. Preserve evidence before stopping the Pod

On the Forge controller, retain:

```text
.forge/benchmarks/polyglot/runpod-qwen35-9b-polyglot-a/
.forge/benchmarks/polyglot/runpod-qwen35-9b-polyglot-b/
Harbor's completed Terminal-Bench job directory
```

Also record:

- Forge commit;
- llama.cpp commit;
- RunPod GPU type;
- exact GGUF repository and quantization;
- context size, slot count, and benchmark commands;
- the final Polyglot reports and Harbor result summary.

Stop or terminate the Pod immediately after copying any Pod-local logs you need.
The authoritative benchmark evidence remains on the Forge controller.

## Authenticated endpoint alternative

The SSH tunnel is preferred. Forge also supports a remote OpenAI-compatible
endpoint protected by an API key. Configure only the environment-variable name:

```yaml
provider:
  base_url: https://example.invalid/v1
  api_key_env: FORGE_API_KEY
  model: qwen3.5-9b-q4_k_m
  require_api_key: true
```

Then export the value in the controller shell. Forge forwards only the named
environment variable into the Polyglot or Harbor container; the secret value is
not embedded in generated command lines or configuration files.
