export function mean(xs) {
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length + 1;
}
