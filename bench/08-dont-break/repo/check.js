import assert from "node:assert";
import { slugify } from "./src/slug.js";
assert.strictEqual(slugify("Hello World"), "hello-world");
assert.strictEqual(slugify("A  B"), "a-b");
console.log("ok");
