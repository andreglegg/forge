import assert from "node:assert";
import { computeDiscount } from "./src/pricing.js";
assert.strictEqual(computeDiscount(100,10),90);
assert.throws(()=>computeDiscount("a",10), TypeError);
console.log("ok");
