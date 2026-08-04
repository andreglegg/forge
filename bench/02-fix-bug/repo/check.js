import assert from "node:assert";
import { mean } from "./src/stats.js";
assert.strictEqual(mean([2,4,6]),4);
console.log("ok");
