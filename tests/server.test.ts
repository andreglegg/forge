/**
 * `forge serve` transport and lifecycle, tested without a provider or a run.
 *
 * Everything here drives serve() with PassThrough streams and a scripted
 * startRun, because the invariants under test are about the wire, not the
 * model: the header is the first line, client garbage is refused rather than
 * interpreted, runs are serial, and a vanished client can never leave a run
 * waiting on an approval nobody will answer.
 */

import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { contractHeader, REQUEST_TYPES } from "../src/contract.js";
import type { RunCommand } from "../src/runtime.js";
import { type RunChannel, type ServeDependencies, serve } from "../src/server.js";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface ScriptedRun {
  readonly task: string;
  readonly channel: RunChannel;
  readonly resolve: (code: number) => void;
}

function scriptedRuns(): {
  readonly calls: ScriptedRun[];
  readonly interruptions: () => number;
  readonly deps: ServeDependencies;
} {
  const calls: ScriptedRun[] = [];
  let interruptions = 0;
  return {
    calls,
    interruptions: () => interruptions,
    deps: {
      startRun: (task, channel) =>
        new Promise<number>((resolve) => calls.push({ task, channel, resolve })),
      interrupt: () => {
        interruptions += 1;
      },
    },
  };
}

function harness(deps: ServeDependencies): {
  readonly input: PassThrough;
  readonly out: string[];
  readonly done: Promise<number>;
  readonly send: (document: unknown) => Promise<void>;
} {
  const input = new PassThrough();
  const out: string[] = [];
  const done = serve(input, { out: (text) => out.push(text) }, deps);
  return {
    input,
    out,
    done,
    send: async (document) => {
      input.write(`${JSON.stringify(document)}\n`);
      await tick();
    },
  };
}

function recordingTarget(): { readonly commands: RunCommand[]; send(command: RunCommand): void } {
  const commands: RunCommand[] = [];
  return {
    commands,
    send: (command) => commands.push(command),
  };
}

function errors(out: readonly string[]): Array<{ error: string; message: string }> {
  return out
    .map((line) => JSON.parse(line) as { type: string; error?: string; message?: string })
    .filter((doc) => doc.type === "error")
    .map((doc) => ({ error: doc.error ?? "", message: doc.message ?? "" }));
}

describe("the serve transport", () => {
  test("writes the contract envelope first, before any request is consumed", async () => {
    const { calls, deps } = scriptedRuns();
    const input = new PassThrough();
    input.write(`${JSON.stringify({ type: "run.start", task: "queued" })}\n`);
    const out: string[] = [];
    const done = serve(input, { out: (text) => out.push(text) }, deps);

    // Synchronously after the call: the header is out and nothing was read.
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual(contractHeader());
    expect(
      (JSON.parse(out[0] ?? "") as { contract: { requests: string[] } }).contract.requests,
    ).toEqual([...REQUEST_TYPES]);

    await tick();
    calls[0]?.resolve(0);
    input.end();
    await done;
  });

  test("run.start invokes startRun once with the task; every line is one JSON document", async () => {
    const { calls, deps } = scriptedRuns();
    const { input, out, done, send } = harness(deps);

    await send({ type: "run.start", task: "t" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toBe("t");

    calls[0]?.resolve(0);
    await tick();
    input.end();
    expect(await done).toBe(0);
    for (const line of out) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("a second run.start while a run is active is refused; after it resolves, the next one runs", async () => {
    const { calls, deps } = scriptedRuns();
    const { input, out, done, send } = harness(deps);

    await send({ type: "run.start", task: "first" });
    await send({ type: "run.start", task: "too early" });
    expect(calls).toHaveLength(1);
    expect(errors(out)).toEqual([expect.objectContaining({ error: "run_active" })]);

    calls[0]?.resolve(0);
    await tick();
    await send({ type: "run.start", task: "second" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.task).toBe("second");

    calls[1]?.resolve(0);
    await tick();
    input.end();
    expect(await done).toBe(0);
  });

  test("a malformed line is refused and never touches the active run", async () => {
    const { calls, deps } = scriptedRuns();
    const { input, out, done, send } = harness(deps);

    await send({ type: "run.start", task: "keep going" });
    const target = recordingTarget();
    calls[0]?.channel.attach(target);

    input.write("{this is not json\n");
    await tick();
    expect(errors(out)).toEqual([expect.objectContaining({ error: "malformed_request" })]);
    expect(target.commands).toEqual([]);

    // A subsequent valid request is still honored.
    await send({ type: "approve", id: "a1", decision: "once" });
    expect(target.commands).toEqual([{ type: "approve", id: "a1", decision: "once" }]);

    calls[0]?.resolve(0);
    await tick();
    input.end();
    expect(await done).toBe(0);
  });

  test("an unknown request type is refused by name, not guessed at", async () => {
    const { deps } = scriptedRuns();
    const { input, out, done, send } = harness(deps);

    await send({ type: "resume" });
    const refused = errors(out);
    expect(refused).toEqual([expect.objectContaining({ error: "unknown_request" })]);
    expect(refused[0]?.message).toContain("resume");

    input.end();
    expect(await done).toBe(0);
  });

  test("approve or cancel with no active run is an error envelope, not a crash", async () => {
    const { deps } = scriptedRuns();
    const { input, out, done, send } = harness(deps);

    await send({ type: "approve", id: "a1", decision: "once" });
    await send({ type: "cancel" });
    expect(errors(out)).toEqual([
      expect.objectContaining({ error: "no_active_run" }),
      expect.objectContaining({ error: "no_active_run" }),
    ]);

    input.end();
    expect(await done).toBe(0);
  });

  test("after shutdown with a run active, approve and cancel still reach the run", async () => {
    const { calls, deps } = scriptedRuns();
    const { input, out: wire, done, send } = harness(deps);

    await send({ type: "run.start", task: "finish me, then exit" });
    const target = recordingTarget();
    const run = calls[0];
    if (run === undefined) throw new Error("expected a started run");
    run.channel.attach(target);
    await send({ type: "shutdown" });

    // The client asked for finish-this-run-then-exit, so it is still the one
    // that answers the run's approvals: dropping this input would leave the
    // run waiting on a decision nobody can ever make.
    run.channel.requested("a1");
    await send({ type: "approve", id: "a1", decision: "once" });
    expect(target.commands).toEqual([{ type: "approve", id: "a1", decision: "once" }]);

    // And it can still change its mind about the run it is waiting on.
    await send({ type: "cancel" });
    expect(target.commands).toEqual([
      { type: "approve", id: "a1", decision: "once" },
      { type: "cancel" },
    ]);

    // New work after shutdown is refused with an envelope, never silently
    // dropped and never started.
    await send({ type: "run.start", task: "too late" });
    expect(calls).toHaveLength(1);
    expect(errors(wire)).toEqual([expect.objectContaining({ error: "shutting_down" })]);

    run.resolve(0);
    await tick();
    input.end();
    expect(await done).toBe(0);
  });

  test("client disconnect while idle resolves 0", async () => {
    const { deps } = scriptedRuns();
    const { input, done } = harness(deps);

    input.end();
    expect(await done).toBe(0);
  });

  test("client disconnect with a run active denies pending approvals and cancels the run", async () => {
    const { calls, interruptions, deps } = scriptedRuns();
    const { input, done, send } = harness(deps);

    await send({ type: "run.start", task: "abandoned" });
    const target = recordingTarget();
    const run = calls[0];
    if (run === undefined) throw new Error("expected a started run");
    run.channel.attach(target);
    run.channel.requested("a7");

    input.end();
    await tick();
    expect(target.commands).toEqual([
      { type: "approve", id: "a7", decision: "deny" },
      { type: "cancel" },
    ]);
    expect(interruptions()).toBe(1);

    // Even a run that claims success cannot turn a disconnect into exit 0.
    run.resolve(0);
    expect(await done).not.toBe(0);
  });
});
