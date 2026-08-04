import assert from "node:assert";
import { add, subtract } from "./src/math.js";
assert.strictEqual(add(2,3),5);
assert.strictEqual(subtract(5,3),2);
console.log("ok");
