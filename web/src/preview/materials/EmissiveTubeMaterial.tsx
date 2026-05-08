import { gasToEmissiveColor, isBlockoutColor } from './gasColors';

/**
 * EmissiveTubeMaterial maps a `Run.Color` (free-form gas-and-phosphor
 * string) onto a `MeshStandardMaterial` with the right emissive hex
 * and intensity.
 *
 * Why MeshStandardMaterial and not a custom GLSL shader: the standard
 * material's `emissive` + `emissiveIntensity` pair is what the
 * react-three-fiber community uses for "lit-from-within" objects, and
 * Phase 3 #4's bloom post-process picks up the emissive component
 * cleanly. Custom GLSL is a far-future optimization — V1 trades that
 * for a one-line material that the rest of the app understands.
 *
 * Why `color: '#0a0a0a'` (a near-black diffuse): emission alone draws
 * the lit core, but with a bright base color the tube reads as a
 * solid plastic rod. A near-black base lets the surface darken away
 * from the camera (dark glass housing) while the emission carries
 * the visible color — closer to the "glass tube containing a glow"
 * appearance that bloom in Phase 3 #4 will lean into.
 *
 * Blockout treatment: per Phase 3 #3 spec, this PR demotes any run
 * whose `Run.Color` is the literal string "blockout" (case-insensitive,
 * trimmed) to opaque dark grey with no emission. Per-segment blockouts
 * (a run with live + painted-over arc segments) are deferred to
 * Phase 3 #6, which will split the tube geometry and apply this
 * material to the live half + a dark-grey material to the painted
 * half. Until then, designers who want a wholly dark tube tag the
 * run's color as "blockout".
 *
 * Roughness/metalness: 0.2 / 0.0 — slightly glossy, non-metallic.
 * The gloss reads as glass; metallic 0 keeps the emissive color
 * authoritative (a metallic surface would tint the emission).
 */
export function EmissiveTubeMaterial({ color }: { color: string | undefined }) {
  if (isBlockoutColor(color)) {
    return (
      <meshStandardMaterial
        color="#222222"
        emissive="#000000"
        roughness={0.6}
        metalness={0.0}
      />
    );
  }
  const { color: emissive, intensity } = gasToEmissiveColor(color);
  return (
    <meshStandardMaterial
      color="#0a0a0a"
      emissive={emissive}
      emissiveIntensity={intensity}
      roughness={0.2}
      metalness={0.0}
    />
  );
}
