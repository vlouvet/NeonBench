import { useMemo } from 'react';
import * as THREE from 'three';
import type { DesignRun } from '../api';
import Electrode from './Electrode';
import { EmissiveTubeMaterial } from './materials/EmissiveTubeMaterial';
import { splitRunBySegments, type RunSegment } from './segment-split';
import {
  DEFAULT_TUBE_DIAMETER_MM,
  TUBE_RADIAL_SEGMENTS,
  liftPointsAtJumps,
  polylineToCurve,
  tubeSegmentCount,
} from './tube-geom';

/**
 * Tube renders one `DesignRun` as a 3D tube. Phase 3 #2 + #3 shipped
 * a single emissive tube per run; Phase 3 #6 (this revision) splits
 * the run into per-segment sub-tubes so blockouts can render with a
 * different material from the live arc, and adds electrode caps at
 * every `Run.Electrode` polyline position.
 *
 * Segment split:
 *   `splitRunBySegments` walks the run's blockouts (in live-arc
 *   index space, per the rest of the codebase) and returns a list
 *   of `{points, isBlockout, closed}` sub-segments. Each sub-segment
 *   is fed to its own `<tubeGeometry>` with the matching material
 *   (emissive for live, opaque dark grey for blockout). Adjacent
 *   sub-segments share a polyline point so the rendered tube reads
 *   as continuous — no visible gap at the seam.
 *
 *   Diameter is unchanged across segments; only the material flips.
 *   That keeps the tube's silhouette consistent. A future spec could
 *   add a tiny radial step at blockout edges to simulate the paint
 *   thickness, but V1 stays smooth.
 *
 * Electrodes:
 *   For each entry in `run.electrodes`, an `<Electrode>` child is
 *   rendered. The component computes the electrode's world position
 *   (Y-flipped from doc space) and orients a metallic cylinder + cap
 *   along the tube's local tangent. Per the spec, the cap protrudes
 *   beyond the polyline tip — replacing the open tube end visually.
 *
 * Diameter resolution: per-run override first
 * (`run.tube_diameter_mm`), then the project-level default supplied
 * by Scene, then a defensive 12 mm fallback. Same precedence as
 * Phase 3 #2.
 *
 * Geometry rebuild: each sub-segment's geometry is keyed by the
 * segment index + `points.length` + radius via `useMemo`. A re-render
 * that doesn't change the underlying segment array is a free no-op.
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

  const segments = useMemo(() => splitRunBySegments(run), [run]);

  if (segments.length === 0) return null;

  return (
    <>
      {segments.map((segment, idx) => (
        <TubeSegment
          key={idx}
          segment={segment}
          radius={radius}
          color={run.color}
        />
      ))}
      {run.electrodes?.map((_, electrodeIdx) => (
        <Electrode
          key={`electrode-${electrodeIdx}`}
          run={run}
          electrodeIndex={electrodeIdx}
          defaultDiameterMM={defaultDiameterMM}
        />
      ))}
    </>
  );
}

/**
 * A single sub-segment of a run's tube. Owns its own geometry memo
 * so a change to one segment's points doesn't churn the others.
 *
 * Blockout sleeves use a fixed dark-grey `<meshStandardMaterial>`
 * (per spec): rough, non-metallic, no emission. The opaque colour
 * sits on top of the live tube where they share seam points;
 * three.js depth-buffers them naturally because they're parts of
 * one continuous surface, not stacked parallel surfaces — so no
 * `polygonOffset` needed.
 */
function TubeSegment({
  segment,
  radius,
  color,
}: {
  segment: RunSegment;
  radius: number;
  color: string | undefined;
}) {
  const geometry = useMemo(() => {
    if (segment.points.length < 2) return null;
    // Tier 3 #68 — lift the polyline at jump points before feeding to
    // the curve so the tube physically arcs out of plane there.
    const lifted = liftPointsAtJumps(
      segment.points,
      segment.jumpPolylineIndices,
      radius * 2,
    );
    const curve = polylineToCurve(lifted, segment.closed);
    const segCount = tubeSegmentCount(segment.points);
    return new THREE.TubeGeometry(
      curve,
      segCount,
      radius,
      TUBE_RADIAL_SEGMENTS,
      segment.closed,
    );
  }, [segment.points, segment.closed, segment.jumpPolylineIndices, radius]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry}>
      {segment.isBlockout ? (
        <meshStandardMaterial
          color="#1a1a1a"
          roughness={0.7}
          metalness={0.0}
          emissive="#000000"
        />
      ) : (
        <EmissiveTubeMaterial color={color} />
      )}
    </mesh>
  );
}
