import { useMemo } from 'react';
import * as THREE from 'three';
import type { DesignRun } from '../api';
import {
  resolveHousing,
  type ElectrodeWithHousing,
} from '../lib/housingLibrary';

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
  const electrode = run.electrodes?.[electrodeIndex] as
    | ElectrodeWithHousing
    | undefined;
  const points = run.polyline.points;

  const { position, quaternion, capRadius, capHeight, housingRadius, valid } = useMemo(() => {
    const fallback = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      capRadius: 0,
      capHeight: 0,
      housingRadius: 0,
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

    // Tier 3 #62 — resolve the housing dimensions for this electrode.
    // resolveHousing returns boreMM = 0 for "no housing", which we
    // surface as housingRadius = 0 (the render gates the housing
    // cylinder on > 0). Stock shells pull from HOUSING_LIBRARY;
    // custom housings use the doc-supplied bore.
    const housing = resolveHousing(
      electrode.housing_type,
      electrode.bore_diameter_mm,
    );
    // The housing's bore is the INNER diameter of the porcelain shell.
    // We render the shell at `bore / 2` so it visually surrounds the
    // tube cap (whose radius matches the tube's outer diameter); since
    // tube radii are typically 5–9 mm and shell bores are 9.5 / 12.7,
    // the shell reads as a chunky collar around the cap. For a shell
    // smaller than the tube radius, we'd visually clip the cap; in
    // V1 the operator picks shells matching their tube and the
    // validator (Tier 3 #62 follow-up) will eventually flag mismatches.
    const housingRad = housing.boreMM > 0 ? housing.boreMM / 2 : 0;

    return {
      position: here,
      quaternion: q,
      capRadius: radius,
      capHeight: height,
      housingRadius: housingRad,
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

  // Tier 3 #62 — porcelain housing cylinder. Layered OVER the existing
  // cap geometry (we don't replace the cap — Phase 3 #6's bright nickel
  // tip is what reads as "tube end" at zoom-out, the housing is a
  // background collar). 30 mm tall by spec, sitting flush with the cap
  // base so it looks bolted to the substrate. Lower segment count
  // (16) than the cap because the housing is a passive prop in the
  // scene; doesn't deserve the same poly budget.
  const HOUSING_HEIGHT_MM = 30;

  return (
    <group position={position} quaternion={quaternion}>
      {housingRadius > 0 && (
        <mesh position={[0, -HOUSING_HEIGHT_MM / 2, 0]}>
          <cylinderGeometry
            args={[housingRadius, housingRadius, HOUSING_HEIGHT_MM, 16]}
          />
          <meshStandardMaterial color="#666666" roughness={0.4} metalness={0.6} />
        </mesh>
      )}
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
