/**
 * Judge for greenfield work, where the agent authors the tests as well as the
 * code. Two failure modes exist here that no other task in this suite can see.
 *
 * 1. The agent's tests can be weak or absent, so behaviour is asserted here
 *    independently rather than by trusting `npm test` to mean anything.
 * 2. The agent's tests can be nondeterministic. Observed for real: an
 *    agent-authored project put two test files on one shared JSON file, and
 *    `node --test` runs files in parallel, so the suite passed once by winning
 *    a race and failed 1 run in 6 afterwards. A judge that runs the suite once
 *    scores that as a pass.
 *
 * So the suite is run repeatedly and every run must pass.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";

const RUNS = 3;

function freshState() {
  rmSync("tasks.json", { force: true });
}

// --- the agent must have written tests at all -------------------------------
assert.ok(existsSync("test"), "no test/ directory was created");
const testFiles = readdirSync("test").filter((name) => name.endsWith(".js"));
assert.ok(testFiles.length > 0, "test/ contains no .js test files");

// --- behaviour, asserted without reference to the agent's tests -------------
freshState();
const store = await import("./src/store.js");

await store.addTask("one");
await store.addTask("two");

let all = await store.listTasks();
assert.strictEqual(all.length, 2, "listTasks should return both added tasks");

const ids = all.map((task) => task.id);
assert.strictEqual(new Set(ids).size, 2, "task ids must be distinct");
assert.ok(
  ids.every((id) => typeof id === "number"),
  "task ids must be numbers",
);
assert.ok(
  all.every((task) => task.done === false),
  "a newly added task must not be done",
);

await store.completeTask(ids[0]);
all = await store.listTasks();
assert.strictEqual(all.find((task) => task.id === ids[0]).done, true, "completeTask should set done");
assert.strictEqual(
  all.find((task) => task.id === ids[1]).done,
  false,
  "completeTask must not affect other tasks",
);

// --- the agent's own suite must pass, and pass every time --------------------
for (let run = 1; run <= RUNS; run += 1) {
  freshState();
  const result = spawnSync("npm", ["test"], { encoding: "utf8" });
  assert.strictEqual(
    result.status,
    0,
    `the agent's own test suite failed on run ${run} of ${RUNS}. ` +
      "A suite that does not give the same answer twice is not evidence.\n" +
      `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500),
  );
}

console.log("ok");
