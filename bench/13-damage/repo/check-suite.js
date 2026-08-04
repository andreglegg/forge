import assert from "node:assert";
import { parseAge } from "./src.js";
assert.strictEqual(parseAge("42"), 42);
assert.strictEqual(parseAge("7 years"), 7);
assert.throws(() => parseAge("abc"), Error);
console.log("suite ok");
