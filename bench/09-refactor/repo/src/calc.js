export function add(a, b) {
  if (typeof a !== "number" || typeof b !== "number") throw new TypeError("numbers only");
  return a + b;
}
export function sub(a, b) {
  if (typeof a !== "number" || typeof b !== "number") throw new TypeError("numbers only");
  return a - b;
}
export function mul(a, b) {
  if (typeof a !== "number" || typeof b !== "number") throw new TypeError("numbers only");
  return a * b;
}
