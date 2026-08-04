import assert from "node:assert";
import { clamp, abs } from "./src/index.js";
assert.strictEqual(abs(-2),2);
assert.strictEqual(clamp(5,1,3),3);
assert.strictEqual(clamp(0,1,3),1);
console.log("ok");
