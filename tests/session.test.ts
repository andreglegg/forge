/**
 * Session persistence, against a real filesystem.
 *
 * Every test here is about a file that is *not* in the shape the happy path
 * produces: a torn tail, a corrupted middle, a stray temp file, a session that
 * was never finished. Those are the states a crash actually leaves behind, and
 * the store exists to survive them -- so mocking `node:fs` would test the mock
 * and none of the behaviour.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { Journal, type RunEvent } from "../src/runtime.js";
import { isSessionId, newSessionId, SessionStore } from "../src/session.js";

async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "session-"));
  try {
    // Realpath it: on macOS the OS temp dir is `/var/...` symlinked to
    // `/private/var/...`, so a raw path and a resolved one compare unequal.
    return await body(realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STARTED: RunEvent = { type: "run.started", seq: 1, task: "add a celsius helper" };
const TURN: RunEvent = { type: "turn.started", seq: 2, turn: 1 };
const COMMITTED: RunEvent = {
  type: "mutation.committed",
  seq: 3,
  id: "a1",
  path: "temperature.ts",
  added: 4,
  removed: 0,
  beforeRevision: null,
};
const FINISHED: RunEvent = { type: "run.finished", seq: 4, ok: true, summary: "added the helper" };

function journalOf(events: readonly RunEvent[]): Journal {
  const journal = new Journal();
  for (const event of events) {
    journal.append(event);
  }
  return journal;
}

function sessionFile(root: string, id: string): string {
  return path.join(root, ".forge", "sessions", `${id}.jsonl`);
}

function writeRaw(root: string, id: string, contents: string): void {
  const file = sessionFile(root, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

describe("a session id", () => {
  test("orders lexicographically in the order the runs started", () => {
    const first = newSessionId(new Date("2026-08-01T09:59:59.999Z"), "aaaaaa");
    const second = newSessionId(new Date("2026-08-01T10:00:00.000Z"), "aaaaaa");
    const third = newSessionId(new Date("2026-08-02T10:00:00.000Z"), "aaaaaa");
    expect([third, first, second].sort()).toEqual([first, second, third]);
  });

  test("is the same string for the same timestamp, so it is testable at all", () => {
    const when = new Date("2026-08-01T10:00:00.000Z");
    expect(newSessionId(when, "abc123")).toBe(newSessionId(when, "abc123"));
  });

  test("distinguishes two runs that start in the same millisecond", () => {
    const when = new Date("2026-08-01T10:00:00.000Z");
    expect(newSessionId(when, "aaaaaa")).not.toBe(newSessionId(when, "bbbbbb"));
  });

  test("contains no character that is hostile in a filename", () => {
    const id = newSessionId(new Date("2026-08-01T10:00:00.000Z"), "abc123");
    expect(id).toBe("2026-08-01T10-00-00-000Z-abc123");
    expect(isSessionId(id)).toBe(true);
  });

  test("rejects anything that could escape the sessions directory", () => {
    expect(isSessionId("..")).toBe(false);
    expect(isSessionId("../../etc/passwd")).toBe(false);
    expect(isSessionId("nested/id")).toBe(false);
    expect(isSessionId(".hidden")).toBe(false);
    expect(isSessionId("")).toBe(false);
    expect(isSessionId("a".repeat(500))).toBe(false);
  });
});

describe("a journal survives the process that wrote it", () => {
  test("round trips through save and load", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      const events = [STARTED, TURN, COMMITTED, FINISHED];
      store.save("run-1", journalOf(events));

      const loaded = store.load("run-1");
      expect(loaded).not.toBeNull();
      expect(loaded?.all()).toEqual(events);
    });
  });

  test("is not created on disk until something is written", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      expect(store.list()).toEqual([]);
      expect(store.load("run-1")).toBeNull();
      // Constructing a store must not litter a repository that never ran.
      expect(() => readFileSync(path.join(root, ".forge"))).toThrow();
    });
  });

  test("loads as null when the session was never written", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-1", journalOf([STARTED]));
      expect(store.load("run-2")).toBeNull();
    });
  });

  test("an empty journal is an empty session, not a missing one", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-1", new Journal());
      expect(store.load("run-1")?.all()).toEqual([]);
    });
  });

  test("refuses to write outside the sessions directory", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      expect(() => store.save("../escape", journalOf([STARTED]))).toThrow(/invalid session id/);
      expect(() => store.delete("../escape")).toThrow(/invalid session id/);
      expect(store.load("../escape")).toBeNull();
    });
  });
});

describe("appending as the run happens", () => {
  test("leaves a usable journal for a process that never got to save", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.appendTo("run-1", STARTED);
      store.appendTo("run-1", TURN);
      store.appendTo("run-1", COMMITTED);
      // No save(): this is the process being killed mid-run.

      expect(store.load("run-1")?.all()).toEqual([STARTED, TURN, COMMITTED]);
      const [summary] = store.list();
      expect(summary?.finished).toBe(false);
      expect(summary?.committed).toBe(1);
    });
  });

  test("drops ephemeral events, so replay of the file matches replay of the run", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.appendTo("run-1", STARTED);
      store.appendTo("run-1", { type: "model.delta", seq: 2, text: "thinking" });
      store.appendTo("run-1", FINISHED);
      expect(store.load("run-1")?.all()).toEqual([STARTED, FINISHED]);
    });
  });

  test("continues a file that save() wrote, without splicing onto its last line", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-1", journalOf([STARTED, TURN]));
      store.appendTo("run-1", COMMITTED);
      store.appendTo("run-1", FINISHED);
      expect(store.load("run-1")?.all()).toEqual([STARTED, TURN, COMMITTED, FINISHED]);
    });
  });

  test("a torn final line costs only the event that was being written", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.appendTo("run-1", STARTED);
      store.appendTo("run-1", TURN);
      store.appendTo("run-1", COMMITTED);
      // The process died between writing an event and its newline.
      appendFileSync(sessionFile(root, "run-1"), '{"type":"run.fini', "utf8");

      expect(store.load("run-1")?.all()).toEqual([STARTED, TURN, COMMITTED]);
      const [summary] = store.list();
      expect(summary?.task).toBe("add a celsius helper");
      expect(summary?.committed).toBe(1);
    });
  });

  test("a save after a torn tail replaces it with the authoritative journal", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.appendTo("run-1", STARTED);
      appendFileSync(sessionFile(root, "run-1"), '{"type":"turn.st', "utf8");

      store.save("run-1", journalOf([STARTED, TURN, COMMITTED, FINISHED]));
      expect(store.load("run-1")?.all()).toEqual([STARTED, TURN, COMMITTED, FINISHED]);
    });
  });
});

describe("a damaged session costs one session, not the whole listing", () => {
  test("a corrupt file loads as null and is skipped by list", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-good", journalOf([STARTED, FINISHED]));
      writeRaw(
        root,
        "run-corrupt",
        `${JSON.stringify(STARTED)}\n<<< not json at all >>>\n${JSON.stringify(FINISHED)}\n`,
      );

      expect(store.load("run-corrupt")).toBeNull();
      expect(store.list().map((summary) => summary.id)).toEqual(["run-good"]);
    });
  });

  test("a file of pure garbage loads as null rather than as an empty session", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      writeRaw(root, "run-1", "this was never a journal\n");
      expect(store.load("run-1")).toBeNull();
      expect(store.list()).toEqual([]);
    });
  });

  test("valid JSON that is not an event is rejected", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      writeRaw(root, "run-1", '{"hello":"world"}\n[1,2,3]\n');
      expect(store.load("run-1")).toBeNull();
    });
  });

  test("a leftover temp file from an interrupted save is not a session", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-1", journalOf([STARTED]));
      writeFileSync(`${sessionFile(root, "run-1")}.tmp`, '{"type":"run.st', "utf8");
      expect(store.list().map((summary) => summary.id)).toEqual(["run-1"]);
    });
  });
});

describe("listing sessions", () => {
  test("puts the newest run first", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      const oldest = newSessionId(new Date("2026-07-30T08:00:00.000Z"), "aaaaaa");
      const middle = newSessionId(new Date("2026-08-01T08:00:00.000Z"), "aaaaaa");
      const newest = newSessionId(new Date("2026-08-01T08:00:00.001Z"), "aaaaaa");

      // Written out of order, because insertion order must not be the answer.
      store.save(middle, journalOf([STARTED]));
      store.save(newest, journalOf([STARTED]));
      store.save(oldest, journalOf([STARTED]));

      expect(store.list().map((summary) => summary.id)).toEqual([newest, middle, oldest]);
    });
  });

  test("summarises each session by replaying it", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-done", journalOf([STARTED, TURN, COMMITTED, FINISHED]));
      store.save(
        "run-failed",
        journalOf([STARTED, { type: "run.failed", seq: 2, reason: "boom" }]),
      );
      store.save("run-open", journalOf([STARTED, TURN]));

      const byId = new Map(store.list().map((summary) => [summary.id, summary]));
      expect(byId.get("run-done")).toEqual({
        id: "run-done",
        task: "add a celsius helper",
        turns: 1,
        committed: 1,
        finished: true,
        ok: true,
      });
      expect(byId.get("run-failed")?.finished).toBe(true);
      expect(byId.get("run-failed")?.ok).toBe(false);
      expect(byId.get("run-open")?.finished).toBe(false);
      expect(byId.get("run-open")?.turns).toBe(1);
    });
  });

  test("ignores files that are not journals", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-1", journalOf([STARTED]));
      writeFileSync(path.join(root, ".forge", "sessions", "README.md"), "notes", "utf8");
      expect(store.list().map((summary) => summary.id)).toEqual(["run-1"]);
    });
  });
});

describe("deleting a session", () => {
  test("removes it from load and from the listing", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-1", journalOf([STARTED]));
      store.save("run-2", journalOf([STARTED]));

      store.delete("run-1");

      expect(store.load("run-1")).toBeNull();
      expect(store.list().map((summary) => summary.id)).toEqual(["run-2"]);
    });
  });

  test("is a no-op for a session that is already gone", async () => {
    await withRoot(async (root) => {
      const store = new SessionStore(root);
      store.save("run-1", journalOf([STARTED]));
      store.delete("run-1");
      expect(() => store.delete("run-1")).not.toThrow();
    });
  });
});
