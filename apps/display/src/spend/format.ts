// How the spend screen writes its numbers. Rounding happens here, so a number
// part way through counting up still reads as a whole count.
import type { EstimateBasis } from "@transit-agents/contracts";

const CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SIGNIFICANT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
const COMPACT_DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const FIGURES = new Intl.NumberFormat("en-US", { minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
const PUBLISHED = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

// Between a number and its unit: narrow, as SI sets it, and never broken.
const THIN = "\u202f";

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

// Three figures in a unit that steps up a thousand at a time, as tokens do:
// 240 Wh, then 2.40 kWh. 999.6 rounds to 1,000, so it steps up too.
function metric(value: number, units: readonly string[]): string {
  let step = 0;
  while (step < units.length - 1 && Number(value.toPrecision(3)) >= 1000) {
    value /= 1000;
    step++;
  }
  return `${FIGURES.format(value)}${THIN}${units[step]}`;
}

// An estimate, so ≈: ≈ 0.240 Wh, ≈ 2.40 Wh, ≈ 2.40 kWh. One model call is
// 0.24 Wh, so less than 0.1 Wh shows only while counting up from 0 Wh, and
// three figures there would widen the number past its column on a phone.
export function energy(wh: number): string {
  if (wh === 0) return `0${THIN}Wh`;
  if (wh < 0.1) return `<0.1${THIN}Wh`;
  return `≈${THIN}${metric(wh, ["Wh", "kWh", "MWh", "GWh"])}`;
}

// In the unit line under energy: 0.0300 g CO₂e, 3.00 kg CO₂e.
export function co2e(grams: number): string {
  if (grams === 0) return `0${THIN}g\u00a0CO₂e`;
  if (grams < 0.01) return `<0.01${THIN}g\u00a0CO₂e`;
  return `${metric(grams, ["g", "kg", "t"])}\u00a0CO₂e`;
}

// In the unit line under energy too: 0.260 mL water, 2.60 L water.
export function water(ml: number): string {
  if (ml === 0) return `0${THIN}mL\u00a0water`;
  if (ml < 0.01) return `<0.01${THIN}mL\u00a0water`;
  return `${metric(ml, ["mL", "L", "kL", "ML"])}\u00a0water`;
}

// What a screen reader adds to the energy figure: that it's an estimate and a
// floor, and its source, in the source's own words.
export const aboutEstimate = ({ co2e, source }: EstimateBasis) =>
  `Estimate, at least: each model call counted as one median prompt. CO₂e is ${co2e}. ` +
  `From ${source.title}, ${PUBLISHED.format(new Date(source.date))}: “${source.quote}”`;

// The unit for the count on screen, which is rounded: 1 model call, 2 model calls.
export const unitFor = (count: number | null, one: string, other: string) => (count !== null && Math.round(count) === 1 ? one : other);
