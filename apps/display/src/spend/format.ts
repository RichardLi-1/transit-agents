// How the spend screen writes its numbers. Rounding happens here, so a number
// part way through counting up still reads as a whole count.

const CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SIGNIFICANT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
const COMPACT_DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// Three significant figures below a dollar ($0.0421), cents up to $999.99, then
// three figures again, as for tokens ($1.23K, $12.3K), so a number never grows
// past its third of the screen. Below a cent, three figures would need too many
// places. $0 for nothing.
export function dollars(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return SIGNIFICANT.format(usd);
  // $999.995 would round up to $1,000.00 in cents.
  return Math.round(usd * 100) < 100_000 ? CENTS.format(usd) : COMPACT_DOLLARS.format(usd);
}

// 999, then 1.00K, 12.3K and 1.24M. Three figures throughout, like $0.500, so
// a count keeps its width as it passes 43.0K or 50.0K.
export function tokens(count: number): string {
  const whole = Math.round(count);
  return whole < 1000 ? WHOLE.format(whole) : COMPACT.format(whole);
}

export const calls = (count: number) => WHOLE.format(Math.round(count));

// The unit for the count on screen, which is rounded: 1 model call, 2 model calls.
export const unitFor = (count: number | null, one: string, other: string) => (count !== null && Math.round(count) === 1 ? one : other);
