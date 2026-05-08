import type { DesignDoc } from '../api';
import Tube from './Tube';

/**
 * Scene is the `<Canvas>`-internal payload for the Phase 3 preview.
 * Phase 3 #1 stood this up as a placeholder spinning cube; Phase 3 #2
 * (this revision) replaces the cube with real tube geometry — every
 * `Run.Polyline` becomes a 3D tube laid flat on the XY plane via the
 * `<Tube>` component.
 *
 * The `defaultDiameterMM` prop carries the project-level fallback the
 * Tube component uses when a run has no per-run diameter override. The
 * preview route doesn't currently load the project's tube spec
 * (PreviewPage is in the strict no-touch list for this spec), so the
 * default is left at 12 mm (matching `DEFAULT_TUBE_DIAMETER_MM` in
 * `tube-geom.ts`). Phase 3 #4 / #5 can wire the real spec through if
 * a follow-up wants project-aware diameters here.
 *
 * Lighting is kept light: `meshBasicMaterial` is unlit, so the
 * directional light has no effect on the tubes themselves. We keep a
 * dim ambient so when Phase 3 #3 swaps in physical materials, the
 * scene already has a baseline fill instead of going black on day
 * one.
 *
 * Material color: `#dddddd` (placeholder, set inside Tube). Phase 3
 * #3 swaps to emissive glass with per-gas color.
 */
export default function Scene({
  doc,
  defaultDiameterMM,
}: {
  doc: DesignDoc | null;
  defaultDiameterMM?: number;
}) {
  return (
    <>
      {/* Soft fill so future shaded materials don't render as solid black. */}
      <ambientLight intensity={0.3} />
      {/* Key light from front-upper-right; effectively no-op on
          basic-material tubes, but kept so Phase 3 #3 has a stable
          rig to inherit. */}
      <directionalLight position={[100, 200, 100]} intensity={0.7} />
      {doc?.runs.map((run) => (
        <Tube
          key={run.id}
          run={run}
          defaultDiameterMM={defaultDiameterMM}
        />
      ))}
    </>
  );
}
