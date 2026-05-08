import { useMemo } from 'react';
import * as THREE from 'three';
import type { DesignRun } from '../api';

/**
 * Electrode renders one tube-end cap: a short metallic cylinder with
 * a hemisphere on top, oriented along the tube's local tangent so the
 * cap reads as continuous with the tube surface rather than as a
 * floating widget.
 *
 * Position: walk to `electrode.point_index` in the run's polyline,
 * apply the same Y-flip Phase 3 #2 uses (doc-Y down → three-Y up).
 *
 * Tangent: estimated from the polyline neighbor (the previous point
 * for non-zero indices, the next point for index 0). For closed
 * runs an out-of-bounds index falls back to the shape's Y axis,
 * which is harmless visually because the cap is small. The tangent
 * is normalized; when the neighbor is coincident (zero-length
 * tangent), we default to `+Y` so the cylinder still has a defined
 * orientation.
 *
 * Geometry choices (from spec):
 *   - cylinder radius is `tube_radius * 1.05` so the cap visibly
 *     overlaps the tube end; perfectly flush would z-fight or leave
 *     a hairline gap depending on subpixel rounding.
 *   - cylinder height 6 mm — matches a typical PK-electrode shell.
 *   - hemisphere on top closes the cap end so the user doesn't see
 *     into a hollow cylinder when the camera orbits past the tip.
 *   - color #888 / metalness 0.85 / roughness 0.3 — bright nickel
 *     finish that catches the directional light without competing
 *     with the emissive tube color.
 *
 * The cap protrudes beyond the polyline endpoint by half its height,
 * matching how a real GTO cap solders onto the tube tip rather than
 * stopping flush with the glass.
 */
export default function Electrode({
  run,
  electrodeIndex,
  defaultDiameterMM,
}: {
  run: DesignRun;
  electrodeIndex: number;
  defaultDiameterMM?: number;
}) {
  const electrode = run.electrodes?.[electrodeIndex];
  const points = run.polyline.points;

  const { position, quaternion, capRadius, capHeight, valid } = useMemo(() => {
    const fallback = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      capRadius: 0,
      capHeight: 0,
      valid: false as boolean,
    };
    if (!electrode) return fallback;
    const idx = electrode.point_index;
    if (idx < 0 || idx >= points.length) return fallback;

    const [x, y] = points[idx];
    const here = new THREE.Vector3(x, -y, 0);

    // Pick the neighboring polyline point. Prefer the previous point
    // (so the cap points AWAY from the tube interior at a tail
    // electrode); fall back to the next point for index 0.
    let neighborIdx = idx - 1;
    if (neighborIdx < 0) {
      if (run.polyline.closed && points.length > 1) {
        neighborIdx = points.length - 1;
      } else {
        neighborIdx = idx + 1;
      }
    }
    const neighbor = points[neighborIdx];
    const tangent =
      neighbor === undefined
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(x - neighbor[0], -(y - neighbor[1]), 0);
    if (tangent.lengthSq() < 1e-9) tangent.set(0, 1, 0);
    tangent.normalize();

    const diameterMM = run.tube_diameter_mm ?? defaultDiameterMM ?? 12;
    const tubeRadius = diameterMM / 2;
    const radius = tubeRadius * 1.05;
    const height = 6;

    // `<cylinderGeometry>` defaults to its long axis along +Y. The
    // electrode group is anchored at the polyline point and rotated so
    // the cylinder's +Y aligns with the tangent (pointing outward
    // away from the tube body). The hemisphere child sits at the top
    // of the cylinder (+height/2 along local +Y).
    const yAxis = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(yAxis, tangent);

    return {
      position: here,
      quaternion: q,
      capRadius: radius,
      capHeight: height,
      valid: true,
    };
  }, [
    electrode,
    points,
    run.polyline.closed,
    run.tube_diameter_mm,
    defaultDiameterMM,
  ]);

  if (!valid) return null;

  return (
    <group position={position} quaternion={quaternion}>
      <mesh position={[0, capHeight / 2, 0]}>
        <cylinderGeometry args={[capRadius, capRadius, capHeight, 12]} />
        <meshStandardMaterial color="#888888" roughness={0.3} metalness={0.85} />
      </mesh>
      <mesh position={[0, capHeight, 0]}>
        <sphereGeometry
          args={[capRadius, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2]}
        />
        <meshStandardMaterial color="#888888" roughness={0.3} metalness={0.85} />
      </mesh>
    </group>
  );
}
