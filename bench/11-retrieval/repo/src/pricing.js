export function computeDiscount(price, pct) {
  return price * (1 - pct / 100);
}
