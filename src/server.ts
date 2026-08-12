/**
 * `forge serve`: the event contract, served bidirectionally over stdio.
 *
 * Pure transport and lifecycle. This module owns the NDJSON line reader, the
 * closed request vocabulary, and the serial run state machine -- and nothing
 * else. The orchestration behind `startRun` is injected, so there is no
 * provider, no model call, and no filesystem here, and the permission model,
 * gate, and session journalling of a served run are byte-identical to
 * `forge run`: the server adds transport, not authority.
 *
 * Trust is process ancestry: whoever spawned this process could equally have
 * run `forge run --yes`, so stdin needs no further authentication. The rules a
 * client can rely on:
 *
 * - The contract header is the first output line, before any input is read.
 * - A malformed or unknown request is refused with an error envelope, never
 *   partially interpreted, and never fatal to an active run.
 * - Client disconnect with a run active denies every pending approval and
 *   cancels the run, so a vanished client can never leave an autonomous run
 *   executing with nobody to ask. Disconnect while idle is a clean exit.
 */

import { contractHeader, REQUEST_TYPES } from "./contract.js";
import type { Decision, RunCommand } from "./runtime.js";

/** The readable surface serve() consumes; process.stdin and PassThrough both satisfy it. */
export interface ServeInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export interface ServeIO {
  readonly out: (text: string) => void;
}

/**
 * The seam between the transport and one run. The run owner attaches the
 * constructed Run and forwards approval traffic through it; the server is what
 * answers `approval.requested` in place of the suppressed headless auto-deny.
 */
export interface RunChannel {
  attach(run: { send(command: RunCommand): void }): void;
  requested(id: string): void;
  resolved(id: string): void;
}

export interface ServeDependencies {
  /** Runs one task through the unmodified headless orchestration. */
  readonly startRun: (task: string, channel: RunChannel) => Promise<number>;
  /** Aborts in-flight work after the client vanished. Never used for a client's cancel. */
  readonly interrupt: () => void;
}

type ServeRequest =
  | { readonly type: "run.start"; readonly task: string }
  | { readonly type: "approve"; readonly id: string; readonly decision: Decision }
  | { readonly type: "cancel" }
  | { readonly type: "shutdown" };

type ParsedRequest =
  | { readonly request: ServeRequest }
  | { readonly error: string; readonly message: string };

/** Deterministic and closed: anything outside the vocabulary is refused, not repaired. */
function parseRequest(line: string): ParsedRequest {
  let document: unknown;
  try {
    document = JSON.parse(line);
  } catch (error) {
    return {
      error: "malformed_request",
      message: `not a JSON document: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { error: "malformed_request", message: "a request must be a JSON object" };
  }
  const record = document as Record<string, unknown>;
  const type = record["type"];
  if (type === "run.start") {
    const task = record["task"];
    if (typeof task !== "string" || task.trim() === "") {
      return { error: "invalid_request", message: "run.start needs a non-empty string task" };
    }
    return { request: { type, task } };
  }
  if (type === "approve") {
    const id = record["id"];
    const decision = record["decision"];
    if (typeof id !== "string" || id === "") {
      return { error: "invalid_request", message: "approve needs the id of a requested approval" };
    }
    if (decision !== "once" && decision !== "always" && decision !== "deny") {
      return {
        error: "invalid_request",
        message: 'approve needs a decision of "once", "always", or "deny"',
      };
    }
    return { request: { type, id, decision } };
  }
  if (type === "cancel") return { request: { type } };
  if (type === "shutdown") return { request: { type } };
  return {
    error: "unknown_request",
    message: `unknown request type ${JSON.stringify(type ?? null)}; this server accepts ${REQUEST_TYPES.join(", ")}`,
  };
}

/**
 * Serve runs over `input` until shutdown or disconnect. Resolves the process
 * exit code: 0 for a clean shutdown or an idle disconnect, nonzero when the
 * client vanished with a run active.
 */
export async function serve(
  input: ServeInput,
  io: ServeIO,
  deps: ServeDependencies,
): Promise<number> {
  // First line, before any input is consumed: a client that reads one line
  // knows the contract it is speaking and the requests it may send.
  io.out(JSON.stringify(contractHeader()));

  interface ActiveRun {
    target: { send(command: RunCommand): void } | null;
    readonly pending: Set<string>;
  }

  let active: ActiveRun | null = null;
  let stopped = false;
  let disconnected = false;

  return await new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const refuse = (error: string, message: string): void => {
      io.out(JSON.stringify({ type: "error", error, message }));
    };

    const handleLine = (line: string): void => {
      if (line.trim() === "") return;
      const parsed = parseRequest(line);
      if ("error" in parsed) {
        refuse(parsed.error, parsed.message);
        return;
      }
      const request = parsed.request;
      if (request.type === "run.start") {
        // Shutdown means finish-this-run-then-exit, so only *new* work is
        // refused. Approve and cancel below must keep flowing to the active
        // run: the client that asked to shut down is still the only party that
        // can answer that run's approvals, and dropping its input would leave
        // the run waiting on a decision nobody can ever make.
        if (stopped) {
          refuse("shutting_down", "the server is shutting down and accepts no new runs");
          return;
        }
        if (active !== null) {
          refuse("run_active", "a run is already active; wait for its result envelope");
          return;
        }
        const state: ActiveRun = { target: null, pending: new Set() };
        active = state;
        const channel: RunChannel = {
          attach: (run) => {
            state.target = run;
          },
          requested: (id) => {
            state.pending.add(id);
          },
          resolved: (id) => {
            state.pending.delete(id);
          },
        };
        void deps.startRun(request.task, channel).then(
          (code) => {
            if (active === state) active = null;
            // A disconnect can never resolve 0: the run was abandoned, and an
            // exit code that says otherwise would launder it into a success.
            if (stopped) settle(disconnected ? (code === 0 ? 1 : code) : 0);
          },
          () => {
            if (active === state) active = null;
            refuse("run_failed", "the run threw before producing a result");
            if (stopped) settle(disconnected ? 1 : 0);
          },
        );
        return;
      }
      if (request.type === "shutdown") {
        stopped = true;
        // With a run active, the settle happens when it resolves.
        if (active === null) settle(0);
        return;
      }
      if (active === null || active.target === null) {
        refuse("no_active_run", `no active run to receive ${request.type}`);
        return;
      }
      if (request.type === "approve") {
        active.target.send({ type: "approve", id: request.id, decision: request.decision });
        return;
      }
      active.target.send({ type: "cancel" });
    };

    const disconnect = (): void => {
      stopped = true;
      const state = active;
      if (state === null) {
        settle(0);
        return;
      }
      if (disconnected) return;
      disconnected = true;
      // Deny-and-cancel, then abort in-flight work: the client that would have
      // decided is gone, and there are no further runs to preserve the
      // controller for.
      for (const id of state.pending) {
        state.target?.send({ type: "approve", id, decision: "deny" });
      }
      state.pending.clear();
      state.target?.send({ type: "cancel" });
      deps.interrupt();
    };

    let buffered = "";
    input.on("data", (chunk) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let boundary = buffered.indexOf("\n");
      while (boundary !== -1) {
        const line = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 1);
        handleLine(line);
        boundary = buffered.indexOf("\n");
      }
    });
    input.on("end", () => {
      if (buffered !== "") {
        const line = buffered;
        buffered = "";
        handleLine(line);
      }
      disconnect();
    });
    input.on("error", () => disconnect());
  });
}
