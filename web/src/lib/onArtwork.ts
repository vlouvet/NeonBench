// onArtwork — "may a tube travel from here to there without leaving the
// glass the operator drew?"  (Tier 2 #134)
//
// WHY THIS FILE EXISTS AT ALL. A greedy join of a fragmented script improves
// every number in the takeoff: fewer runs, less glass, fewer transformers, and
// on Chachi's job the raceway/transformer conflict disappeared outright. All
// of that came from letting the tube leave the letterforms and cut diagonally
// across blank sign face. It was caught by rendering the runs in per-run
// colours and looking at them — no metric in the takeoff moved the wrong way,
// because a shortcut across the face IS shorter. So the join op cannot be
// scored on its output; it has to be told where the tube is allowed to go, and
// that is the predicate below.
//
// THE TEST. Sample the straight hop at a fixed interval and require every
// sample to lie within a corridor of SOME existing run's glass. A hop across
// blank face fails at the first mid-gap sample; a hop that runs along a stroke
// passes. This is the cheapest sound answer available: it is a superset test
// (it accepts a hop that grazes a stroke it never really follows) but it is
// never a false ACCEPT of the failure mode that matters, which is a long
// diagonal over nothing.
//
// It is deliberately pure and doc-free so it can be unit-tested without
// building a DesignDoc, and so the op in docOps.ts has nothing to reimplement.
import type { DesignRun } from '../api';
import { flatRunPoints, runPathDistanceMM } from './arcGeom';

// Corridor half-width, in tube diameters. One diameter is half a tube either
// side of the drawn centreline plus room for the two flatteners to disagree —
// generous enough that following a stroke always passes, tight enough that
// crossing blank face never does.
export const HOP_CORRIDOR_DIAMETERS = 1.0;

// Sample spacing along the hop, in tube diameters. Half a diameter puts at
// least two samples inside any gap wide enough to matter.
export const HOP_SAMPLE_DIAMETERS = 0.5;

// Hard cap on the corridor, in tube diameters.
//
// The corridor is an operator parameter because the right value depends on how
// the geometry was made, but it is ALSO the only thing standing between this
// op and the cheating join. Left uncapped, "the run count is still too high"
// has an obvious and wrong fix: type a bigger number until the constraint
// stops constraining, at which point every metric improves and the tube is
// across the face again. Four diameters is already wider than any stroke this
// tool draws.
export const HOP_CORRIDOR_MAX_DIAMETERS = 4;

// Last-resort tube diameter, matching the rest of the editor (EditorPage's
// projDiam and docOps' BLOCKOUT_FALLBACK_DIAMETER_MM).
export const HOP_FALLBACK_DIAMETER_MM = 10;

// Ceiling on samples per hop. A pathological `near` against a millimetre
// sample interval would otherwise walk millions of points per candidate pair,
// inside an O(n^2) pairing loop. Hitting the ceiling only coarsens the
// sampling; it never turns a refusal into an acceptance, because the corridor
// test is still applied to every sample taken.
const MAX_SAMPLES = 4096;

// ArtworkPath is one run reduced to what the predicate needs: its glass as
// straight segments, and a bounding box to reject it cheaply.
//
// The flatten happens ONCE here rather than per sample. `flatRunPoints`
// returns the live array untouched for a run with no arcs, so a line-only doc
// pays nothing; an arc-heavy one pays once instead of once per distance query.
// The stand-in run carries no `segment_types`, so `runPathDistanceMM` sees
// `runHasArcs === false` and measures the already-flat points directly.
//
// FLATTEN VS INDEX: these points exist to MEASURE shape. Nothing here resolves
// an electrode, blockout, annotation or bend against them, and nothing may —
// flattening destroys the index space those live in.
export type ArtworkPath = {
  runId: string;
  flat: DesignRun;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function artworkFromRuns(runs: readonly DesignRun[]): ArtworkPath[] {
  const out: ArtworkPath[] = [];
  for (const run of runs) {
    const pts = flatRunPoints(run);
    if (pts.length === 0) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    out.push({
      runId: run.id,
      flat: { id: run.id, polyline: { points: pts, closed: !!run.polyline.closed } },
      minX,
      minY,
      maxX,
      maxY,
    });
  }
  return out;
}

// effectiveTubeDiameterMM — the run's own diameter, else the project spec's,
// else the editor-wide fallback. Same precedence the block-out op uses.
export function effectiveTubeDiameterMM(
  run: DesignRun | undefined,
  projectDiameterMM?: number,
): number {
  const own = run?.tube_diameter_mm;
  if (typeof own === 'number' && own > 0) return own;
  if (typeof projectDiameterMM === 'number' && projectDiameterMM > 0) return projectDiameterMM;
  return HOP_FALLBACK_DIAMETER_MM;
}

export type HopVerdict = {
  // Every sample lay inside the corridor.
  onArtwork: boolean;
  // Straight-line length of the hop.
  gapMM: number;
  // The worst sample's exact distance to the nearest glass. This is the number
  // that makes a refusal explainable — "45mm off the letters", not "no".
  worstOffsetMM: number;
  // Where that sample was, so an overlay can draw the refusal.
  worstPoint: [number, number];
  // Samples actually taken, including both endpoints.
  samples: number;
};

// nearestGlassMM is the EXACT distance from `p` to the closest glass in
// `artwork`, pruned by an expanded-bbox reject against the running best.
//
// The first cut of this took the obvious shortcut — stop as soon as something
// is found inside the corridor, since the boolean is all the op consumes — and
// it produced a right answer with a wrong number attached: a sample 10mm from
// one stroke and 0mm from another reported 10. That number is the whole of
// what the operator is shown about a refusal ("45mm off the letters"), so an
// upper bound dressed as a measurement is worse than the extra work. Pruning
// against `best` keeps it cheap AND exact; only a literal hit short-circuits.
function nearestGlassMM(p: [number, number], artwork: readonly ArtworkPath[]): number {
  let best = Infinity;
  for (const a of artwork) {
    // `best` starts at Infinity (nothing is rejected) and shrinks, so this
    // gets cheaper the closer we already are — which, on a hop that follows a
    // stroke, is immediately.
    if (p[0] < a.minX - best || p[0] > a.maxX + best) continue;
    if (p[1] < a.minY - best || p[1] > a.maxY + best) continue;
    const d = runPathDistanceMM(a.flat, p);
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

// hopStaysOnArtwork is the predicate. `corridorMM` and `sampleMM` are absolute
// millimetres here on purpose — deriving them from the tube diameter is the
// CALLER's job, so this function has no opinion about tube specs and a test
// can state the numbers it means.
//
// A non-finite or non-positive corridor is refused rather than waved through:
// a NaN corridor accepting every hop is exactly the failure this row exists to
// prevent, and it would be invisible.
export function hopStaysOnArtwork(
  from: readonly [number, number],
  to: readonly [number, number],
  artwork: readonly ArtworkPath[],
  corridorMM: number,
  sampleMM: number,
): HopVerdict {
  const gapMM = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const start: [number, number] = [from[0], from[1]];
  if (!Number.isFinite(corridorMM) || corridorMM <= 0) {
    return {
      onArtwork: false,
      gapMM,
      worstOffsetMM: Infinity,
      worstPoint: start,
      samples: 0,
    };
  }
  // Two endpoints, minimum: they are the ends being welded and they sit on
  // their own runs, so they are free passes — but sampling them keeps the
  // count honest and keeps a zero-length hop from special-casing.
  let steps = 1;
  if (gapMM > 0 && Number.isFinite(sampleMM) && sampleMM > 0) {
    steps = Math.min(MAX_SAMPLES - 1, Math.max(1, Math.ceil(gapMM / sampleMM)));
  }

  let worstOffsetMM = 0;
  let worstPoint: [number, number] = start;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p: [number, number] = [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
    ];
    const d = nearestGlassMM(p, artwork);
    if (d > worstOffsetMM) {
      worstOffsetMM = d;
      worstPoint = p;
    }
  }
  return {
    onArtwork: worstOffsetMM <= corridorMM,
    gapMM,
    worstOffsetMM,
    worstPoint,
    samples: steps + 1,
  };
}
