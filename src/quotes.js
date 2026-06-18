export function mulDivFloor(a, b, d) { return d === 0n ? 0n : (a * b) / d }
export function estimateSellerPrice(usdcTotal, amountSoldBefore, pAmount, amountInitial) {
  const after = amountSoldBefore + pAmount
  return mulDivFloor(usdcTotal, after, amountInitial) - mulDivFloor(usdcTotal, amountSoldBefore, amountInitial)
}
export async function pAmountForBudget({ low = 0n, high, budget, quoteTotalPayment }) {
  let lo = low, hi = high, best = 0n
  while (lo <= hi) {
    const mid = (lo + hi) / 2n
    if (mid === 0n) return 0n
    const quoted = await quoteTotalPayment(mid)
    const total = Array.isArray(quoted) ? quoted[2] : quoted.totalPaid ?? quoted
    if (total <= budget) { best = mid; lo = mid + 1n } else { hi = mid - 1n }
  }
  return best
}
