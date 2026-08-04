import assert from "node:assert";
import { createUser } from "./src/index.js";
const u = createUser("ana","admin");
assert.strictEqual(u.name,"ana");
assert.strictEqual(u.role,"admin");
console.log("ok");
