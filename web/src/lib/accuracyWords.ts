import type { Accuracy } from '../insights';

/*
 * Plain function of what the server said, with nothing to import at run time (the type above is
 * erased), so the same code runs in the browser and in the test suite, which loads this file by
 * its path as it does the wrap-up's.
 */

/**
 * One kind of estimate in words: "Blocks run 1.6× your guess (8)". The wording is decided on
 * the figure that is printed and not on the raw ratio, so the words cannot contradict the
 * number: the ratio is rounded to a tenth first, a tenth either side of dead on (0.9 to 1.1,
 * both included) is "about right", above that is how many times the guess, and below it is the
 * share of the guess it took, in whole percent. Going by the raw ratio let 1.14 read "run 1.1×
 * your guess" and 0.895 read "finish in 90% of your guess": a figure inside "about right" printed
 * as if it were outside it. With too few to take a median it says so, and how many there are.
 */
export function accuracyWords(subject: string, a: Accuracy): string {
  const ratio = a.medianRatio;
  if (ratio == null) return `${subject}: not enough yet (${a.count})`;
  // Tenths as a whole number, so what is compared and what is printed are the one value.
  const tenths = Math.round(ratio * 10);
  if (tenths > 11) return `${subject} run ${(tenths / 10).toFixed(1)}× your guess (${a.count})`;
  if (tenths >= 9) return `${subject} are about right (${a.count})`;
  return `${subject} finish in ${Math.round(ratio * 100)}% of your guess (${a.count})`;
}
