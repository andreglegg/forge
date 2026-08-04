import assert from "node:assert";
import { withTax } from "./src/price.js";
assert.strictEqual(withTax(100), 110);
console.log("ok");
