import assert from "node:assert";
import { double, id_numbers } from "./src/numbers.js";
import { id_strings } from "./src/strings.js";
assert.strictEqual(double(4),8);
assert.strictEqual(id_numbers(1),1);
assert.strictEqual(id_strings("a"),"a");
console.log("ok");
