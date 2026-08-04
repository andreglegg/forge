/**
 * The reliability metric, tested on its own terms.
 *
 * `score` must be a pure function of recorded text: no clock, no network, no
 * repository. That is the whole property that makes it usable as a pre-commit
 * check and as a bisect signal, so it is what these tests assert hardest.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { categorize, formatReport, loadTraces, score, type TraceRecord } from "../src/replay.js";

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "replay-"));
  try {
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const EDIT = ["EDIT a.ts", "<<<<<<< SEARCH", "old", "=======", "new", ">>>>>>> REPLACE"].join("\n");

function records(...raws: string[]): TraceRecord[] {
  return raws.map((raw) => ({ raw }));
}

describe("scoring", () => {
  test("an actionable reply converts", () => {
    const report = score(records(EDIT, "READ a.ts", "DONE finished"));

    expect(report.total).toBe(3);
    expect(report.converted).toBe(3);
    expect(report.conversionRate).toBe(1);
  });

  test("`DONE` counts as converted", () => {
    // "I am done" is a usable answer. Scoring it as a failure would make the
    // harness report its own successful runs as losses.
    const report = score(records("DONE nothing to change"));

    expect(report.converted).toBe(1);
  });

  test("prose alone does not convert, and is categorised", () => {
    const report = score(records("I think I should look at the code first."));

    expect(report.converted).toBe(0);
    expect(report.byCategory["no_action"]).toBe(1);
    expect(report.failures[0]?.excerpt).toContain("I think I should");
  });

  test("a truncated edit block is counted as truncation, not as a mystery", () => {
    // The distinction is the point of the taxonomy: a truncated reply means the
    // budget cut the model off, which is a different fix from a malformed one.
    const report = score(records(["EDIT a.ts", "<<<<<<< SEARCH", "old"].join("\n")));

    expect(report.converted).toBe(0);
    expect(report.byCategory["truncated"]).toBe(1);
  });

  test("repairs are counted per reply and per kind", () => {
    const wrongDirection = [
      "EDIT a.ts",
      ">>>>>>> SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
    ].join("\n");

    const report = score(records(wrongDirection, EDIT));

    expect(report.repaired).toBe(1);
    expect(report.byRepair["marker_direction"]).toBe(1);
  });

  test("an empty corpus does not divide by zero", () => {
    const report = score([]);

    expect(report.total).toBe(0);
    expect(report.conversionRate).toBe(0);
  });

  test("the same corpus always scores the same", () => {
    // The property the whole instrument rests on. A metric with variance
    // cannot be bisected on, which is why a coding benchmark is not this.
    const corpus = records(EDIT, "prose only", "DONE ok");

    expect(score(corpus)).toEqual(score(corpus));
  });
});

describe("the failure taxonomy", () => {
  test("categories are decided by repair, then by content", () => {
    expect(categorize(["truncated_edit_block"], "anything")).toBe("truncated");
    expect(categorize(["orphan_search_block"], "anything")).toBe("orphan_block");
    expect(categorize(["bad_directive:read"], "anything")).toBe("bad_directive");
    expect(categorize([], "")).toBe("empty");
    expect(categorize([], "just talking")).toBe("no_action");
  });
});

describe("loading a corpus", () => {
  test("reads every jsonl file in a directory, in name order", async () => {
    await withDir(async (dir) => {
      const traces = path.join(dir, "traces");
      mkdirSync(traces, { recursive: true });
      writeFileSync(path.join(traces, "a.jsonl"), `${JSON.stringify({ raw: "first" })}\n`);
      writeFileSync(path.join(traces, "b.jsonl"), `${JSON.stringify({ raw: "second" })}\n`);
      writeFileSync(path.join(traces, "notes.txt"), "ignored");

      const loaded: TraceRecord[] = [];
      for await (const record of loadTraces(traces)) loaded.push(record);

      expect(loaded.map((r) => r.raw)).toEqual(["first", "second"]);
    });
  });

  test("a torn final line loses that turn and nothing else", async () => {
    // A trace is written by a process that may be killed mid-line. Losing the
    // whole corpus because one run was interrupted would defeat keeping it.
    await withDir(async (dir) => {
      const file = path.join(dir, "t.jsonl");
      writeFileSync(file, `${JSON.stringify({ raw: "kept" })}\n{"raw": "tor`);

      const loaded: TraceRecord[] = [];
      for await (const record of loadTraces(file)) loaded.push(record);

      expect(loaded.map((r) => r.raw)).toEqual(["kept"]);
    });
  });

  test("a missing source is empty, not an error", async () => {
    const loaded: TraceRecord[] = [];
    for await (const record of loadTraces("/nonexistent/traces")) loaded.push(record);

    expect(loaded).toEqual([]);
  });
});

describe("the report", () => {
  test("says so plainly when there is nothing recorded", () => {
    expect(formatReport(score([]))).toMatch(/No recorded turns/);
  });

  test("leads with the number and names the repairs", () => {
    const text = formatReport(
      score(records(EDIT, ["EDIT a.ts", "<<<<<<< SEARCH", "old"].join("\n"))),
    );

    expect(text).toContain("1 of 2 replies converted (50.00%)");
    expect(text).toContain("truncated");
  });
});
