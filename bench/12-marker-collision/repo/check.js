import assert from "node:assert";
import { readFileSync } from "node:fs";
const t = readFileSync("docs.md","utf8");
assert.ok(t.includes("status: Final"), "status not updated");
assert.ok(t.includes("<<<<<<< SEARCH"), "conflict example was destroyed");
assert.ok(t.includes(">>>>>>> REPLACE"), "conflict example was destroyed");
console.log("ok");
