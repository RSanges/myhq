import { strings } from "./strings";

// Numbers of the settings page: dollars with a comma, and the tiny costs of
// the small model calls (a fraction of a cent) with more digits.

const twoDigits = new Intl.NumberFormat(strings.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fourDigits = new Intl.NumberFormat(strings.locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Dollars, two decimals: « 9,84 ». */
export const formatUsd = (value: number): string => twoDigits.format(value);

/** A cost that may be a fraction of a cent: « 0,0003 », « 0 » for nothing. */
export const formatSmallUsd = (value: number): string => (value === 0 ? "0" : value < 0.01 ? fourDigits.format(value) : twoDigits.format(value));
