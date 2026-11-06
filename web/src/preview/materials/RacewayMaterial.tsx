import {
  RACEWAY_COLOR,
  RACEWAY_EMISSIVE,
  RACEWAY_METALNESS,
  RACEWAY_ROUGHNESS,
} from './racewaySurface';

/**
 * RacewayMaterial — the unlit painted-aluminium surface for a raceway box
 * (Tier 3 #138). Scene chrome, not glass: no emission, so the bloom pass
 * leaves it alone. The constants and the reasoning behind them live in
 * `racewaySurface.ts`, where the node suite can read them.
 */
export function RacewayMaterial() {
  return (
    <meshStandardMaterial
      color={RACEWAY_COLOR}
      emissive={RACEWAY_EMISSIVE}
      emissiveIntensity={0}
      roughness={RACEWAY_ROUGHNESS}
      metalness={RACEWAY_METALNESS}
    />
  );
}
