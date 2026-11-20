/**
 * Sample-size rules shared by the tools and the UI. No data imports, so client
 * components can use it without bundling the dataset.
 */

/** Below this many listings a median is shown with a small-sample caveat. */
export const THIN_SAMPLE_COUNT = 100;

/** Below this many listings the map shows no median label (matches the pipeline's min_city_rows). */
export const MIN_LABEL_COUNT = 30;

export function isThinSample(count: number): boolean {
  return count < THIN_SAMPLE_COUNT;
}
