/**
 * selectionMetrics — the numbers the editor shows about what is selected
 * (Tier 1 #129).
 *
 * Pulled out of the components on purpose. The sidebar readout and the
 * on-canvas label have to agree to the millimetre — an operator who reads a
 * width off the canvas, then off the panel, and gets two answers stops
 * trusting both — and the only way to guarantee that is one function.
 *
 * FLATTEN FOR MEASURING. Every extent here comes from `selectionBBoxMM` /
 * `runLengthMM`, which flatten arc segments first. Measuring the raw vertex
 * array instead is the bug this row exists to fix: at ARC_BULGE 0.5 an arc
 * bows a quarter of its chord off that chord, so a two-vertex arc run's raw
 * "bounding box" is a zero-height line while the glass it describes is 10 mm
 * tall on a 40 mm chord. Nothing here may index into points; it only measures.
 *
 * Lives in its own module rather than in `arrange.ts` because it needs
 * `runLengthMM` from `docOps`, and `docOps` already imports `arrange` — the
 * other direction would close a cycle.
 */
import type { DesignDoc } from '../api';
import { selectionBBoxMM, type BBoxMM } from './arrange';
import { runLengthMM } from './docOps';

export type SelectionMetrics = {
  /** How many of the requested ids actually resolved to runs. */
  runCount: number;
  /** Flatten-aware extent of the whole selection. */
  bbox: BBoxMM;
  widthMM: number;
  heightMM: number;
  /**
   * Total glass in the selection: the sum of each run's full path length.
   *
   * FOR A CLOSED RUN THIS IS THE WHOLE PERIMETER, including the closing
   * chord — not the live arc between its electrodes. That is a deliberate
   * choice between two defensible answers. The perimeter is the glass that
   * gets cut and bent, it is what `runLengthMM` measures, and it is what the
   * validator's `total_length_mm` sums, so the panel agrees with the
   * "total tube" badge above it. A closed loop's unlit arc is still glass.
   * The UI labels this "tube" rather than "lit" so the choice is visible.
   */
  lengthMM: number;
  /** How many of the selected runs are closed loops. Drives the label. */
  closedCount: number;
};

/**
 * Measure a selection. Returns null when nothing resolves — an empty
 * selection has no size, and inventing a zero-by-zero box would render a
 * readout that looks like a measurement of something.
 */
export function selectionMetrics(
  doc: DesignDoc,
  runIds: readonly string[],
): SelectionMetrics | null {
  const bbox = selectionBBoxMM(doc, runIds);
  if (!bbox) return null;
  const ids = new Set(runIds);
  let runCount = 0;
  let lengthMM = 0;
  let closedCount = 0;
  for (const run of doc.runs) {
    if (!ids.has(run.id)) continue;
    runCount++;
    lengthMM += runLengthMM(run);
    if (run.polyline.closed) closedCount++;
  }
  return {
    runCount,
    bbox,
    widthMM: bbox.maxX - bbox.minX,
    heightMM: bbox.maxY - bbox.minY,
    lengthMM,
    closedCount,
  };
}
