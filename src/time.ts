/** One clock seam for every booking date, cutoff, and reminder calculation. */
let currentClock: () => Date = () => new Date();

export function now(): Date {
  return currentClock();
}

/** Test hook; production code always uses the real clock. */
export function setClockForTests(clock: (() => Date) | undefined): void {
  currentClock = clock ?? (() => new Date());
}
