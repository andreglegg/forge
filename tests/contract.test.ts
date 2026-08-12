/**
 * The event contract is a promise to code nobody in this repository controls.
 *
 * The load-bearing test here is the last one: it reads the `RunEvent` union out
 * of `runtime.ts` and fails when an event exists that the contract does not
 * name. Without it, "the registry is complete" is a comment that decays the
 * first time somebody adds an event, and a client validating against the
 * registry starts rejecting a stream that is actually fine.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli.js";
import {
  type ContractHeader,
  checkContract,
  contractHeader,
  ENVELOPE_TYPES,
  EVENT_CONTRACT_VERSION,
  EVENT_TYPES,
  REQUEST_TYPES,
} from "../src/contract.js";

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("the contract header", () => {
  test("names the version, the build, and everything a client can meet", () => {
    const header = contractHeader();
    expect(header.type).toBe("contract");
    expect(header.contract.version).toBe(EVENT_CONTRACT_VERSION);
    expect(header.contract.forge).toMatch(/^\d+\.\d+\.\d+/);
    expect(header.contract.events).toEqual([...EVENT_TYPES]);
    expect(header.contract.envelopes).toEqual([...ENVELOPE_TYPES]);
    expect(header.contract.requests).toEqual([...REQUEST_TYPES]);
  });

  test("is a version a client can parse", () => {
    expect(EVENT_CONTRACT_VERSION).toMatch(/^\d+\.\d+$/);
  });

  test("names the compaction telemetry that 1.1 added", () => {
    expect(EVENT_TYPES).toContain("context.compacted");
  });

  test("names the serve request vocabulary that 1.2 added", () => {
    // Additive minor: the header gains `requests`, so a client can negotiate
    // what input the server accepts. Envelopes and events are unchanged.
    expect(EVENT_CONTRACT_VERSION).toBe("1.2");
    expect(REQUEST_TYPES).toEqual(["run.start", "approve", "cancel", "shutdown"]);
    expect(ENVELOPE_TYPES).toEqual(["contract", "event", "result", "error"]);
  });
});

describe("contract compatibility", () => {
  test("accepts the version it was built for", () => {
    const check = checkContract(EVENT_CONTRACT_VERSION);
    expect(check.ok).toBe(true);
    expect(check.degraded).toBe(false);
  });

  test("refuses a different major in either direction", () => {
    expect(checkContract("2.0", "1.0").ok).toBe(false);
    expect(checkContract("1.0", "2.0").ok).toBe(false);
    expect(checkContract("1.0", "2.0").reason).toContain("incompatible");
  });

  test("accepts an older client but marks it degraded", () => {
    const check = checkContract("1.0", "1.4");
    expect(check.ok).toBe(true);
    expect(check.degraded).toBe(true);
    expect(check.reason).toContain("skipped");
  });

  test("a 1.0 client reads a 1.1 stream degraded, not refused", () => {
    // The additive-minor rule, exercised by the real bump rather than a
    // hypothetical pair: 1.0 clients skip context.compacted and stay correct.
    const check = checkContract("1.0", "1.1");
    expect(check.ok).toBe(true);
    expect(check.degraded).toBe(true);
  });

  test("accepts a client that knows more than the stream sends", () => {
    const check = checkContract("1.4", "1.0");
    expect(check.ok).toBe(true);
    expect(check.degraded).toBe(false);
  });

  test("refuses a version it cannot parse rather than assuming", () => {
    expect(checkContract("v1").ok).toBe(false);
    expect(checkContract("1.0", "next").ok).toBe(false);
  });
});

describe("the contract on the wire", () => {
  test("forge contract prints it without needing a run", async () => {
    const out: string[] = [];
    const code = await main(["contract"], { out: (text) => out.push(text), err: () => undefined });

    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as { version: string; events: string[] };
    expect(printed.version).toBe(EVENT_CONTRACT_VERSION);
    expect(printed.events).toEqual([...EVENT_TYPES]);
  });

  test("a streaming run announces the contract before anything that can fail", async () => {
    const out: string[] = [];
    // An unreachable provider: the run fails at preflight, which is exactly the
    // case where a client must still know what it is reading.
    const code = await main(
      [
        "run",
        "anything",
        "--repo",
        process.cwd(),
        "--url",
        "http://127.0.0.1:1/v1",
        "--model",
        "none",
        "--stream-json",
      ],
      { out: (text) => out.push(text), err: () => undefined },
    );

    expect(code).toBe(2);
    const first = JSON.parse(out[0] ?? "{}") as ContractHeader;
    expect(first.type).toBe("contract");
    expect(first.contract.version).toBe(EVENT_CONTRACT_VERSION);
  }, 30_000);
});

describe("the registry and the code agree", () => {
  test("every RunEvent type is named in the contract", () => {
    const source = readFileSync(path.join(SOURCE, "runtime.ts"), "utf8");
    const union = source.slice(
      source.indexOf("export type RunEvent"),
      source.indexOf("export type Decision"),
    );
    expect(union).not.toBe("");
    const declared = [...union.matchAll(/type:\s*"([a-z.]+)"/g)].map((match) => match[1]);

    expect(declared.length).toBeGreaterThan(0);
    expect([...new Set(declared)].sort()).toEqual([...EVENT_TYPES].sort());
  });
});
