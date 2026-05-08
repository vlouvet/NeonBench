import { useMemo } from 'react';
import * as THREE from 'three';
import type { DesignRun } from '../api';
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
 * The material is intentionally placeholder `<meshBasicMaterial>` —
 * Phase 3 #3 swaps this for the emissive glass shader plus per-gas
 * color, at which point this component will grow a `material` prop.
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
      <meshBasicMaterial color="#dddddd" />
    </mesh>
  );
}
