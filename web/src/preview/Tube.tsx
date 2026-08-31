import { useMemo } from 'react';
import * as THREE from 'three';
import type { DesignRun } from '../api';
import Electrode from './Electrode';
import { EmissiveTubeMaterial } from './materials/EmissiveTubeMaterial';
import { splitRunBySegments, type RunSegment } from './segment-split';
import {
  DEFAULT_TUBE_DIAMETER_MM,
  TUBE_RADIAL_SEGMENTS,
  crossingArcPositions,
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
  crossingPoints,
}: {
  run: DesignRun;
  defaultDiameterMM?: number;
  // Bug #09 — doc-space points where this run passes over another tube.
  crossingPoints?: ReadonlyArray<readonly [number, number]>;
}) {
  const diameterMM =
    run.tube_diameter_mm ??
    defaultDiameterMM ??
    DEFAULT_TUBE_DIAMETER_MM;
  // Tier 3 #60 (NW #125) — jumper runs render at half the computed
  // tube radius and with halved emissive intensity so they read as
  // "thin glass-sleeved splice" rather than primary tubes (trade
  // convention: jumpers are 16 mm OD clear glass-sleeved twisted
  // lead-wire — Miller p.204–205 — or short flared-end splice tubes
  // — Strattman Fig.11.3 — that are usually unlit). The flag flows
  // through to TubeSegment as `isJumper` so the material picker can
  // honor it without forking the render shape.
  const isJumper = run.kind === 'jumper';
  const radius = (isJumper ? diameterMM * 0.5 : diameterMM) / 2;

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
          isJumper={isJumper}
          crossingPoints={crossingPoints}
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
  isJumper,
  crossingPoints,
}: {
  segment: RunSegment;
  radius: number;
  color: string | undefined;
  isJumper?: boolean;
  // Bug #09 — doc-space points where this run passes OVER another tube (or
  // itself). Localised per segment here rather than threaded through the
  // live/blockout split, which needs no knowledge of crossings.
  crossingPoints?: ReadonlyArray<readonly [number, number]>;
}) {
  const geometry = useMemo(() => {
    if (segment.points.length < 2) return null;
    // Tier 3 #68 — lift the polyline at jump points before feeding to
    // the curve so the tube physically arcs out of plane there.
    // Tier 3 #77 — drop-bend indices apply a separate, shallower
    // lift kernel (0.5× diameter vs 2.5× for jumps). Composed via
    // max() per-point so a jump-adjacent-to-drop reads as the
    // taller jump silhouette plus a separate subtle dip.
    // Tolerance is half a radius: generous enough to match a crossing onto the
    // segment that owns it, tight enough not to claim a crossing on a
    // different tube passing close by.
    const crossingArcs = crossingPoints?.length
      ? crossingArcPositions(segment.points, crossingPoints, radius * 0.5)
      : [];
    const lifted = liftPointsAtJumps(
      segment.points,
      segment.jumpPolylineIndices,
      radius * 2,
      segment.dropBendPolylineIndices,
      crossingArcs,
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
  }, [
    segment.points,
    segment.closed,
    segment.jumpPolylineIndices,
    segment.dropBendPolylineIndices,
    crossingPoints,
    radius,
  ]);

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
      ) : isJumper ? (
        // Tier 3 #60 — jumpers render as desaturated glass: a slightly
        // lighter base color than blockout (so they don't fade into
        // the dark scene), no emissive contribution, slight metallic
        // sheen suggesting the lead-wire underneath the glass sleeve.
        // No emission keeps them dim against bloom-lit primary tubes,
        // which matches trade convention (jumpers are usually unlit
        // splice tubes carrying current to the next primary run).
        <meshStandardMaterial
          color="#3a3a3a"
          roughness={0.4}
          metalness={0.3}
          emissive="#000000"
        />
      ) : (
        <EmissiveTubeMaterial color={color} />
      )}
    </mesh>
  );
}
