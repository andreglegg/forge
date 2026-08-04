import { RATE } from "./config.js";

export function withTax(amount) {
  return amount + amount * RATE;
}
