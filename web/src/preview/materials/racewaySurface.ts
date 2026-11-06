/**
 * Raceway surface for the 3D preview (Tier 3 #138).
 *
 * A raceway is the painted aluminium box the letters mount to. In the
 * preview's lighting split (see `Scene.tsx`) it is SCENE CHROME, not glass:
 * ambient- and key-lit, never emissive, and it must never reach the bloom
 * threshold. Neon on an unlit metal box is the product; a box that halos as
 * though it were lit is a different product.
 *
 * Why these numbers:
 *
 *   - `RACEWAY_COLOR = '#6e6a63'` — a warm mid grey, the colour family of
 *     the editor's raceway wash (`#9a8f7a`, EditorCanvas) but darker. The
 *     editor's own grey is too bright here: under the ambient slider at its
 *     maximum it lands above the capture guard's 0.4 luminance line
 *     (`racewayPeakLinearEstimate` below, pinned in the test), which would
 *     make a raceway-only frame look like "bright content" to
 *     `bloomMetric.ts`.
 *   - `RACEWAY_ROUGHNESS = 0.7` — the wall plane's value. Diffuse enough
 *     that the key light does not paint a hot specular stripe along the box,
 *     which is the one way a non-emissive surface can still cross the bloom
 *     threshold.
 *   - `RACEWAY_METALNESS = 0` — with no environment map in the scene a
 *     metallic surface has nothing to reflect and renders near-black except
 *     for its highlights. A dielectric reads as painted metal and keeps the
 *     highlight at the 4 % Fresnel floor.
 *   - `RACEWAY_EMISSIVE = '#000000'` — stated explicitly rather than left to
 *     the default so the "not emissive" contract is a value a test can read.
 */
export const RACEWAY_COLOR = '#6e6a63';
export const RACEWAY_ROUGHNESS = 0.7;
export const RACEWAY_METALNESS = 0;
export const RACEWAY_EMISSIVE = '#000000';

/** The scene's lights, as far as the raceway estimate needs them. */
export interface RacewayLighting {
  /** `<ambientLight intensity>`. The sidebar slider tops out at 1. */
  ambient: number;
  /** `<directionalLight intensity>` (the key light; 0.7 in Scene.tsx). */
  key: number;
}

/** The brightest the sidebar lets the scene get: ambient slider maxed, stock key light. */
export const RACEWAY_BRIGHTEST_LIGHTING: RacewayLighting = { ambient: 1, key: 0.7 };

/** Parse `#rrggbb` into 0..255 channels. */
export function hexToRGB8(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`hexToRGB8: not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** sRGB-encoded 0..255 channel → linear 0..1. */
export function srgb8ToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear 0..1 → sRGB-encoded 0..255 channel (clamped, rounded). */
export function linearToSrgb8(l: number): number {
  const v = Math.min(1, Math.max(0, l));
  const e = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(e * 255);
}

/**
 * Estimated peak LINEAR radiance (per channel) of a `meshStandardMaterial`
 * box face, at the brightest configuration the scene allows: the face
 * squarely towards both the key light and the camera.
 *
 * Model (three r155+ physically-correct lights, which r160 uses):
 *
 *   diffuse  = albedo · (ambient + key) / π        — Lambert, cos θ ≤ 1
 *   specular = 2 · F0 · D_max · V · key            — GGX at the half-vector
 *
 * with F0 = 0.04 (dielectric), α = roughness², D_max = 1 / (π α²) and the
 * Smith visibility term V = 0.25 at normal incidence. The specular term is
 * doubled as a margin for the off-normal configurations this single-angle
 * estimate does not visit.
 *
 * It is an ESTIMATE, not a proof — it does not model tone mapping or the
 * bloom halo a neighbouring tube throws onto the box. Its job is to fail
 * loudly when somebody "brightens up" the raceway colour; the authoritative
 * check is a real render through `bloomMetric.ts`, recorded in the PR.
 */
export function racewayPeakLinearEstimate(
  colorHex: string,
  roughness: number,
  lighting: RacewayLighting,
): [number, number, number] {
  const alpha = Math.max(roughness * roughness, 1e-3);
  const dMax = 1 / (Math.PI * alpha * alpha);
  const specular = 2 * 0.04 * dMax * 0.25 * lighting.key;
  const diffuseScale = (lighting.ambient + lighting.key) / Math.PI;
  const [r, g, b] = hexToRGB8(colorHex);
  return [
    srgb8ToLinear(r) * diffuseScale + specular,
    srgb8ToLinear(g) * diffuseScale + specular,
    srgb8ToLinear(b) * diffuseScale + specular,
  ];
}
