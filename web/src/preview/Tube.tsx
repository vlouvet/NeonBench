import { useMemo } from 'react';
import * as THREE from 'three';
import type { DesignRun } from '../api';
import { EmissiveTubeMaterial } from './materials/EmissiveTubeMaterial';
import {
  DEFAULT_TUBE_DIAMETER_MM,
  TUBE_RADIAL_SEGMENTS,
  polylineToCurve,
  tubeSegmentCount,
} from './tube-geom';

/**
 * Tube renders one `DesignRun` as a 3D tube extrusion: the run's
 * polyline is converted to a `CatmullRomCurve3` via `polylineToCurve`
 * (which Y-flips on the way out — see `tube-geom.ts`), then fed to
 * `<tubeGeometry>` with a path-segment count derived from arc length.
 *
 * Diameter resolution: per-run override first (`run.tube_diameter_mm`),
 * falling back to the project-level default supplied by the parent
 * Scene. Radius is half the diameter. The 12 mm DEFAULT_TUBE_DIAMETER_MM
 * fallback is a defensive last resort — a valid design always supplies
 * one of the two.
 *
 * The material is `<EmissiveTubeMaterial>` — Phase 3 #3's gas-keyed
 * emissive glass material. It reads `run.color` (a free-form
 * gas-and-phosphor string) and resolves it to an emissive hex via
 * the `materials/gasColors.ts` lookup table. Bloom for a more
 * dramatic glow comes in Phase 3 #4. Per-segment blockouts (a tube
 * partially painted over) come in Phase 3 #6 — V1 only honors a
 * whole-run "blockout" color string, demoting the entire tube to
 * dark grey.
 *
 * Open vs closed runs: a closed polyline ring (e.g. an "O") draws a
 * closed tube with no end caps; an open polyline (e.g. a stroke)
 * leaves visibly open ends. Phase 3 #5 will draw electrode caps on
 * top of those open ends.
 *
 * Geometry rebuild: `useMemo` keys on the run's identity, polyline
 * shape, and effective diameter so a re-render that doesn't actually
 * change the geometry is a free no-op. The geometry instance is the
 * thing three.js cares about; the JSX wrapper around it is cheap.
 */
export default function Tube({
  run,
  defaultDiameterMM,
}: {
  run: DesignRun;
  defaultDiameterMM?: number;
}) {
  const diameterMM =
    run.tube_diameter_mm ??
    defaultDiameterMM ??
    DEFAULT_TUBE_DIAMETER_MM;
  const radius = diameterMM / 2;
  const points = run.polyline.points;
  const closed = run.polyline.closed;

  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const curve = polylineToCurve(points, closed);
    const segments = tubeSegmentCount(points);
    return new THREE.TubeGeometry(
      curve,
      segments,
      radius,
      TUBE_RADIAL_SEGMENTS,
      closed,
    );
    // Effective inputs: the points array's reference (replaced
    // wholesale on edits), the closed flag, and the resolved radius.
    // The run is keyed by id at the call site (`<Tube key={run.id}>`)
    // so React already separates the memo slots between runs — no
    // need to repeat run.id here.
  }, [points, closed, radius]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry}>
      <EmissiveTubeMaterial color={run.color} />
    </mesh>
  );
}
