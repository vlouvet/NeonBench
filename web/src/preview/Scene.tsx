// react-refresh/only-export-components flags non-component named
// exports because Fast Refresh can't preserve their identity across
// HMR boundaries. We export `filterVisibleRuns` (a pure helper) and
// the bloom tuning constants alongside the `Scene` component because
// they're tightly coupled to it. Splitting them into a separate
// module would balloon the file scope for V1; if HMR state-keeping
// for the scene ever becomes a real friction we can hoist them then.
// Same disable strategy as `SceneControls.tsx`.
/* eslint-disable react-refresh/only-export-components */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
// drei's exported OrbitControls type isn't generic — pull the
// underlying three-stdlib class so the imperative ref has the
// `target` / `update` methods we need.
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  Bloom,
  EffectComposer,
  EffectComposerContext,
} from '@react-three/postprocessing';
import * as THREE from 'three';
import type { DesignDoc, DesignRun, Group } from '../api';
import { isGroupVisible } from '../api';
import Tube from './Tube';
// `isGroupVisible` is consumed inside `filterVisibleRuns` below.
import {
  bboxOfDoc,
  cameraPositionForPreset,
  type CameraPreset,
} from './cameraPresets';

/**
 * Scene is the `<Canvas>`-internal payload for the Phase 3 preview.
 *
 * Phase 3 #1 stood this up as a placeholder spinning cube; Phase 3 #2
 * replaced the cube with real tube geometry. Phase 3 #5 adds orbit
 * controls and camera preset framing. Phase 3 #7 layers in
 * scene-chrome controls — background color, ambient intensity, and
 * an optional wall plane — plus a "screenshot bridge" that hands the
 * renderer/scene/camera up to PreviewPage for the PNG export. Phase
 * 3 #4 (this revision — yes the numbering is out of order; #4 was
 * deferred to last) layers a `<Bloom>` post-processing pass on top so
 * emissive tubes get the soft halo glow that sells the neon look.
 * Bloom can be disabled at runtime with `?nobloom` (e.g. for
 * frame-rate debugging or A/B screenshot comparisons).
 *
 * Phase 3 #5 layered orbit controls + preset framing. Phase 3 #7
 * (this revision) adds:
 *
 *   1. `backgroundColor` — applied via `<color attach="background">`
 *      so the scene clear color is reactive, not stuck on the
 *      `<Canvas style={background}>` value.
 *   2. `ambientIntensity` — drives `<ambientLight intensity>`. Slider
 *      in the sidebar runs 0..1.
 *   3. `wallEnabled` + `wallColor` — optional `<mesh>` plane behind
 *      the design (see `WallBacking` below). 50 mm Z offset to dodge
 *      z-fighting with the tubes.
 *   4. `onCaptureReady` — a one-shot bridge for screenshot capture.
 *      The capture callback (closing over `gl/scene/camera`) lives
 *      inside the canvas; the Save PNG button lives outside it. We
 *      use a tiny child component `<ScreenshotBridge>` that calls
 *      `useThree()` and registers the capture function with the
 *      parent via a callback ref. This keeps the bridge reactive
 *      (re-registers if the renderer changes — e.g. context loss /
 *      restore) without a stale closure.
 *
 * The preset animation is a manual `useFrame` lerp rather than a
 * dependency on framer-motion or drei's `<CameraControls>`. Reasons:
 *   - drei's `<CameraControls>` is a different control scheme
 *     (chained input states) and would break the OrbitControls UX
 *     this spec calls for.
 *   - framer-motion would be a new top-level dep for one 30-line
 *     animation; the constraint says "no animation library".
 *   - `useFrame` is already in fiber, free, and gives us the exact
 *     ease curve we want.
 */

// Preset transition duration in milliseconds. 600 ms matches the
// "snappy but not jarring" feel of typical 3D-app preset buttons
// (Blender's numpad views, SketchUp's standard views). Shorter and
// it feels jumpy; longer and the user starts wondering if it's
// broken.
export const PRESET_ANIMATION_MS = 600;

// How far behind the design (in -Z, mm) the wall plane sits. 50 mm
// is far enough to dodge z-fighting with the tube surfaces (which
// extrude along Z) and to read as a "backing" rather than co-planar,
// but close enough that the bloom from the emissive tubes still
// catches the wall surface. If a future spec adds tube-back geometry
// that pokes into negative Z, revisit.
export const WALL_Z_OFFSET_MM = 50;

// Wall plane size multiplier on the bbox. 1.5× makes the wall extend
// past the design on every side so the design looks "mounted" on a
// panel, not pasted to the panel's exact silhouette. Smaller (1.1×)
// looks like a die-cut backplate; bigger (2×) starts wasting frame
// real-estate.
export const WALL_SIZE_FACTOR = 1.5;

// Minimum wall size in mm so an empty / tiny doc still renders a
// visible plane (the bbox fallback is a 200 mm cube; without a floor
// here, exotic edge cases could hand the plane geometry a near-zero
// size and the user would see nothing).
export const WALL_MIN_SIZE_MM = 100;

// Bloom tuning constants (Phase 3 #4). Exported so test corpora /
// the scenePrefs persistence helper / future per-project tuning have a
// single source of truth for the baked-in defaults. Tier 3 #55 turned
// `intensity` / `threshold` / `radius` into props (with these as
// fallbacks) so a slider in SceneControls can override them per
// session — the constants stay exported with the same names so
// downstream readers (scenePrefs, screenshots, manual smoke) don't
// have to hunt for the new shape.
//
// Rationale for the defaults (unchanged from #4):
//
//   - `BLOOM_INTENSITY = 1.2` — strong enough to read as glow without
//     washing out fine line work. Bloom's contribution is additive;
//     anything north of ~2 on emissive surfaces of strength 1.4
//     (Phase 3 #3 default) starts to clip.
//   - `BLOOM_LUMINANCE_THRESHOLD = 0.4` — only emissive surfaces
//     bloom. The wall plane (Phase 3 #7) and ambient-lit scene chrome
//     come in well below 0.4 luminance so they stay matte. The
//     directional key light (intensity 0.7) is also below the
//     threshold on a non-emissive surface.
//   - `BLOOM_LUMINANCE_SMOOTHING = 0.2` — soft falloff around the
//     threshold so dim/desaturated tubes (e.g. powder blue ~0.5) get
//     a softer halo than bright tubes (ruby red ~1.0). 0 produces a
//     hard cutoff that looks artificial; >0.4 starts pulling the
//     wall into the bloom. Not surfaced as a slider (Tier 3 #55) —
//     the three exposed knobs (intensity / threshold / radius) cover
//     the practical tuning range; smoothing is a "shape of the
//     transition" detail that doesn't need per-project override.
//   - `BLOOM_RADIUS = 0.7` — mid-large halo. With `mipmapBlur` on,
//     this is a multi-step downsample radius, not a kernel size; 0.7
//     is roughly "neon shop window seen from across the street",
//     which is the look we want.
//   - `BLOOM_MIPMAP_BLUR = true` — large soft halos via mipmap chain
//     downsampling (cheap on every GPU we care about) instead of a
//     wide convolution kernel. This is the difference between bloom
//     costing ~0.3 ms/frame and ~3 ms/frame on integrated GPUs.
export const BLOOM_INTENSITY = 1.2;
export const BLOOM_LUMINANCE_THRESHOLD = 0.4;
export const BLOOM_LUMINANCE_SMOOTHING = 0.2;
export const BLOOM_RADIUS = 0.7;
export const BLOOM_MIPMAP_BLUR = true;

/**
 * Pure helper — pick the runs that should render given a focused
 * group id and the doc's group-visibility flags. Two filters compose:
 *
 *   1. Group visibility (Tier 3 #33c, deferred 3D-side bit picked up
 *      in Tier 3 #63): a run whose owning group has `visible === false`
 *      is hidden globally. `undefined` is treated as visible — the
 *      pre-33c persisted-doc back-compat rule.
 *   2. Group focus (Tier 3 #63): when `selectedGroupId` is set, only
 *      runs whose `group_id` matches render; everything else is
 *      hidden.
 *
 * A run with no `group_id` ("ungrouped") always passes the visibility
 * filter (no group → no hide-state) and only passes the focus filter
 * when no focus is active. The two filters are independent — a focused
 * group with `visible === false` correctly returns no runs at all.
 *
 * Exported so the unit tests can exercise the composition without
 * spinning up the React tree.
 */
export function filterVisibleRuns(
  runs: DesignRun[],
  groups: Group[] | undefined,
  selectedGroupId: string | null | undefined,
): DesignRun[] {
  const visibilityById = new Map<string, boolean>();
  for (const g of groups ?? []) visibilityById.set(g.id, isGroupVisible(g));
  const focus =
    typeof selectedGroupId === 'string' && selectedGroupId.length > 0
      ? selectedGroupId
      : null;
  return runs.filter((run) => {
    const gid = run.group_id;
    if (gid && visibilityById.get(gid) === false) return false;
    if (focus && gid !== focus) return false;
    return true;
  });
}

/**
 * Read `?nobloom` from the current URL search string. Returns true
 * when the param is present (with or without a value). We check the
 * raw search string rather than going through `URLSearchParams` so
 * the helper stays SSR-safe behind a `typeof window` guard — on
 * vitest's jsdom there's a window, but on a hypothetical SSR build
 * there wouldn't be, and we don't want a render-time crash.
 *
 * Used by Scene to conditionally skip the `<EffectComposer>` wrap.
 * Useful for:
 *   - frame-rate debugging on weak machines
 *   - the windows-smoke CI runner (anyone wiring a smoke test that
 *     doesn't want to depend on WebGL post-processing being healthy)
 *   - A/B comparison screenshots ("what does this look like without
 *     bloom?")
 */
function readNoBloomFromURL(): boolean {
  if (typeof window === 'undefined') return false;
  const search = window.location?.search ?? '';
  if (!search) return false;
  // Match `?nobloom`, `?nobloom=1`, `?foo=bar&nobloom`, etc. The bare
  // form (no `=`) is allowed so users don't have to know an arbitrary
  // value to type.
  return /(^\?|&)nobloom(=|&|$)/.test(search);
}

/**
 * Preset request envelope. Each click of a preset button creates a
 * new object (even if it's the same preset name as last time) so a
 * referential-equality `useEffect` dep correctly fires the animation
 * even when the user clicks "Front" twice in a row to re-frame.
 */
export interface PresetRequest {
  preset: CameraPreset;
  /** Monotonic id; bumped per click so identical-preset re-clicks still re-animate. */
  nonce: number;
}

/** Minimal post-process composer surface the screenshot helper needs. */
export interface ComposerLike {
  render(): void;
}

/** Snapshot of the live three.js objects required for an off-canvas capture. */
export interface CaptureContext {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /**
   * The live `EffectComposer` instance from `@react-three/postprocessing`,
   * when bloom is active. When `?nobloom` short-circuits the composer wrap,
   * this is `null` (or absent) and the screenshot helper falls back to
   * `gl.render(scene, camera)`.
   */
  composer?: ComposerLike | null;
}

/** Callback registration used by `<ScreenshotBridge>` to expose live three.js refs. */
export type OnCaptureReady = (ctx: CaptureContext | null) => void;

/** Internal callback used by `<ComposerBridge>` to surface the composer instance. */
type OnComposerReady = (composer: ComposerLike | null) => void;

// Cubic ease-in-out: 0 at t=0, 1 at t=1, smooth at both ends. Looks
// less mechanical than linear and doesn't overshoot the way a
// spring would (overshoot is wrong here — the camera should land
// exactly on the preset position).
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * In-canvas helper that pipes the live `gl/scene/camera` triple (and
 * an optional post-process `composer`) back up to PreviewPage via a
 * callback ref. We use `useEffect` with `onCaptureReady` as a dep so
 * the parent re-registers when the renderer actually changes (context
 * loss + restore). The cleanup passes `null` so a parent that
 * unmounts during a capture click fails fast rather than calling
 * `gl.render()` on a torn-down renderer.
 *
 * The `composer` arg comes from `<ComposerBridge>` (rendered inside
 * `<EffectComposer>`); when `?nobloom` is active the composer wrap is
 * skipped entirely and `composer` stays `null` so the screenshot
 * helper falls back to the bare `gl.render(scene, camera)` path.
 *
 * No JSX rendered; this is a pure side-effect component.
 */
function ScreenshotBridge({
  composer,
  onCaptureReady,
}: {
  composer: ComposerLike | null;
  onCaptureReady?: OnCaptureReady;
}) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (!onCaptureReady) return;
    onCaptureReady({ gl, scene, camera, composer });
    return () => onCaptureReady(null);
  }, [gl, scene, camera, composer, onCaptureReady]);
  return null;
}

/**
 * Reads the live `EffectComposer` instance via `EffectComposerContext`
 * (exported by `@react-three/postprocessing`) and surfaces it through
 * `onComposerReady`. Must be rendered as a child of `<EffectComposer>`
 * — `useContext` returns `undefined` otherwise, in which case we
 * report `null` so the screenshot path falls back to the bare
 * renderer.
 *
 * Same churn handling as `ScreenshotBridge`: re-runs the registration
 * when the context value (or its `composer` field) changes — e.g. on
 * a context-loss / restore cycle the package rebuilds the composer.
 */
function ComposerBridge({
  onComposerReady,
}: {
  onComposerReady: OnComposerReady;
}) {
  const ctx = useContext(EffectComposerContext);
  const composer = ctx?.composer ?? null;
  useEffect(() => {
    onComposerReady(composer);
    return () => onComposerReady(null);
  }, [composer, onComposerReady]);
  return null;
}

/**
 * Wall-backing plane. Rendered when `enabled` is true. Positioned 50
 * mm behind the bbox center; sized 1.5× the bbox extent (with a
 * safety floor) so it looks like a panel the design is mounted on.
 *
 * `meshStandardMaterial` is the natural fit here — it picks up the
 * scene's ambient light + (eventually) the bloom from the emissive
 * tubes. `roughness=0.7` keeps the surface diffuse so it doesn't
 * mirror-bounce the tube colors and turn into a stage light.
 *
 * `THREE.DoubleSide` so an iso/back orbit doesn't reveal a hole — V1
 * doesn't try to model "rear of the wall" geometry.
 */
function WallBacking({
  enabled,
  color,
  doc,
  selectedGroupId,
}: {
  enabled: boolean;
  color: string;
  doc: DesignDoc | null;
  /** Tier 3 #63 — when set, the wall sizes to the group's bbox, not the doc's. */
  selectedGroupId?: string | null;
}) {
  if (!enabled) return null;
  const bbox = bboxOfDoc(doc, selectedGroupId);
  const width = Math.max(bbox.size.x * WALL_SIZE_FACTOR, WALL_MIN_SIZE_MM);
  const height = Math.max(bbox.size.y * WALL_SIZE_FACTOR, WALL_MIN_SIZE_MM);
  return (
    <mesh
      position={[bbox.center.x, bbox.center.y, -WALL_Z_OFFSET_MM]}
      // `receiveShadow` is harmless without a shadow-casting light
      // configured (Phase 3 #4 doesn't enable shadow maps); leaving
      // it on so a future shadow pass picks up the wall for free.
      receiveShadow
    >
      <planeGeometry args={[width, height]} />
      <meshStandardMaterial
        color={color}
        roughness={0.7}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export default function Scene({
  doc,
  defaultDiameterMM,
  presetRequest,
  selectedGroupId = null,
  backgroundColor = '#1a1a1a',
  ambientIntensity = 0.3,
  wallEnabled = false,
  wallColor = '#f0f0f0',
  bloomIntensity = BLOOM_INTENSITY,
  bloomThreshold = BLOOM_LUMINANCE_THRESHOLD,
  bloomRadius = BLOOM_RADIUS,
  onCaptureReady,
}: {
  doc: DesignDoc | null;
  defaultDiameterMM?: number;
  /** When this changes (by nonce), Scene animates the camera to the named preset. */
  presetRequest?: PresetRequest;
  /**
   * Tier 3 #63 — when non-null/non-empty, restrict rendered runs to
   * those whose `group_id` matches. Camera-fit, wall-plane sizing,
   * and bbox-fed framing all key off the filtered subset so the
   * preview reframes to just the focal group.
   *
   * Composes with the group's `visible` flag (Tier 3 #33c, deferred
   * 3D-side bit picked up here): a run renders iff its group is
   * visible AND (no `selectedGroupId` OR `run.group_id` matches it).
   *
   * Unknown / stale group ids (no matching `Group` in `doc.groups`)
   * fall back to the unfiltered behavior with a `console.warn` so a
   * shared / bookmarked URL with a stale id doesn't show a black
   * scene.
   */
  selectedGroupId?: string | null;
  /** Scene background hex (applied via `<color attach="background">`). */
  backgroundColor?: string;
  /** Ambient light intensity, 0..1. */
  ambientIntensity?: number;
  /** When true, render the `<WallBacking>` plane behind the design. */
  wallEnabled?: boolean;
  /** Wall surface color (`<meshStandardMaterial color>`). */
  wallColor?: string;
  /**
   * Bloom strength (0..3). Defaults to `BLOOM_INTENSITY`. Tier 3 #55
   * surfaces this as a slider; everything above ~2 starts to clip on
   * the brightest emissives so the slider clamps there.
   */
  bloomIntensity?: number;
  /**
   * Bloom luminance threshold (0..1). Defaults to
   * `BLOOM_LUMINANCE_THRESHOLD`. Below the threshold, surfaces don't
   * bloom — lower values pull more of the scene chrome into the
   * glow, higher values restrict it to only the brightest emissives.
   */
  bloomThreshold?: number;
  /**
   * Bloom mipmap-blur radius (0..2). Defaults to `BLOOM_RADIUS`.
   * Larger = softer / wider halo; smaller = tighter/crisper.
   */
  bloomRadius?: number;
  /** Callback invoked once the live `gl/scene/camera` are available. */
  onCaptureReady?: OnCaptureReady;
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();

  // Resolve `selectedGroupId` to an "effective" filter id. An empty
  // string is normalized to null (treat `?groupId=` the same as
  // missing). An unknown id (no matching entry in `doc.groups`) is
  // also normalized to null with a `console.warn` so a stale /
  // bookmarked URL doesn't render a black scene with no runs. Once
  // normalized, this single value flows into the run filter, the
  // initial-fit bbox, the per-preset framing bbox, and the wall
  // plane sizing, so they all agree on what "visible" means. Tier
  // 3 #63.
  const effectiveGroupId = useMemo<string | null>(() => {
    if (!selectedGroupId) return null;
    if (!doc) return selectedGroupId; // doc still loading — keep the id, fallback path below covers it
    const groups = doc.groups ?? [];
    const present = groups.some((g) => g.id === selectedGroupId);
    if (!present) {
      // Unknown group id (e.g. shared link to a deleted group, or a
      // typo). Warn once and behave as if no filter were set.
      console.warn(
        `[Preview] Unknown selectedGroupId "${selectedGroupId}"; rendering all groups.`,
      );
      return null;
    }
    return selectedGroupId;
  }, [selectedGroupId, doc]);

  // The runs that actually render — composes the visibility filter
  // (Tier 3 #33c carried over) with the focus filter (Tier 3 #63).
  // The pure helper above is the single source of truth for the
  // composition rules; the unit test exercises it directly.
  const visibleRuns = useMemo(() => {
    if (!doc) return [];
    return filterVisibleRuns(doc.runs, doc.groups, effectiveGroupId);
  }, [doc, effectiveGroupId]);

  // Live `EffectComposer` handle. `<ComposerBridge>` (rendered inside
  // `<EffectComposer>` when bloom is active) writes into this ref;
  // `<ScreenshotBridge>` reads it and forwards to PreviewPage as part
  // of the `CaptureContext`. We also keep a `useState` mirror so the
  // bridge re-fires `onCaptureReady` when the composer instance
  // changes (context-loss + restore swaps the underlying object).
  const [composer, setComposer] = useState<ComposerLike | null>(null);
  const handleComposerReady = useCallback<OnComposerReady>((c) => {
    setComposer(c);
  }, []);

  // `?nobloom` is read once at mount. We don't subscribe to URL
  // changes — the preview route doesn't navigate without unmount,
  // and listening to popstate just for this would be over-engineered.
  // `useMemo` keeps the value stable so toggling other props doesn't
  // remount EffectComposer (which would briefly drop a frame of
  // bloom).
  const noBloom = useMemo(() => readNoBloomFromURL(), []);

  // Animation bookkeeping. Held in a ref (not state) because the
  // animation runs in `useFrame` and re-rendering on every tick
  // would defeat the purpose of using fiber's render loop.
  const animationRef = useRef<{
    startMs: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);

  // Initial fit-to-content: when `doc` first loads, snap the camera
  // and target to the front preset framed on the design's bbox.
  // Snap (not animate) because the user hasn't done anything yet —
  // an animation here would be a "look at this!" gesture from the
  // page, which is the wrong note to open on. We use a ref guard
  // so a doc that re-renders (e.g. parent state churn) doesn't
  // re-snap the camera and yank it out from under the user.
  const didInitialFitRef = useRef(false);
  useEffect(() => {
    if (didInitialFitRef.current) return;
    if (!doc) return;
    const bbox = bboxOfDoc(doc, effectiveGroupId);
    const { position, target } = cameraPositionForPreset('front', bbox);
    camera.position.copy(position);
    if (controlsRef.current) {
      controlsRef.current.target.copy(target);
      controlsRef.current.update();
    }
    didInitialFitRef.current = true;
  }, [doc, camera, effectiveGroupId]);

  // Tier 3 #63 — when the user changes the focused group (URL → prop)
  // the camera should reframe to the new bbox. We re-use the front-
  // preset framing for consistency with the initial-fit behavior;
  // animating into the new bbox via the existing preset machinery
  // keeps the transition feel identical to clicking a preset button.
  // Skip the very first run (the initial-fit effect above already
  // handled it) so we don't double-animate on mount.
  const previousGroupRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (previousGroupRef.current === undefined) {
      previousGroupRef.current = effectiveGroupId;
      return;
    }
    if (previousGroupRef.current === effectiveGroupId) return;
    previousGroupRef.current = effectiveGroupId;
    if (!doc) return;
    const bbox = bboxOfDoc(doc, effectiveGroupId);
    const { position, target } = cameraPositionForPreset('front', bbox);
    animationRef.current = {
      startMs: performance.now(),
      fromPos: camera.position.clone(),
      toPos: position,
      fromTarget: controlsRef.current
        ? controlsRef.current.target.clone()
        : new THREE.Vector3(),
      toTarget: target,
    };
  }, [effectiveGroupId, doc, camera]);

  // When a new preset is requested, kick off an animation. We
  // capture the *current* camera position + orbit target as the
  // "from", and compute the preset framing for the current bbox as
  // the "to". Subsequent ticks of `useFrame` interpolate between
  // them with `easeInOutCubic`.
  //
  // `effectiveGroupId` is in the dep list because the bbox the
  // preset frames depends on it (Tier 3 #63 — preset framing should
  // match the focused group's bbox). Re-running on a group change
  // here is harmless: the dedicated group-change effect below
  // already kicks an animation, and without an active
  // `presetRequest` the body short-circuits.
  useEffect(() => {
    if (!presetRequest) return;
    const bbox = bboxOfDoc(doc, effectiveGroupId);
    const { position, target } = cameraPositionForPreset(
      presetRequest.preset,
      bbox,
    );
    animationRef.current = {
      startMs: performance.now(),
      fromPos: camera.position.clone(),
      toPos: position,
      fromTarget: controlsRef.current
        ? controlsRef.current.target.clone()
        : new THREE.Vector3(),
      toTarget: target,
    };
    // The animation runs in useFrame below; nothing else to do
    // here.
  }, [presetRequest, doc, camera, effectiveGroupId]);

  useFrame(() => {
    const anim = animationRef.current;
    if (!anim) return;
    const t = Math.min(
      1,
      (performance.now() - anim.startMs) / PRESET_ANIMATION_MS,
    );
    const k = easeInOutCubic(t);
    camera.position.lerpVectors(anim.fromPos, anim.toPos, k);
    if (controlsRef.current) {
      controlsRef.current.target.lerpVectors(
        anim.fromTarget,
        anim.toTarget,
        k,
      );
      controlsRef.current.update();
    }
    if (t >= 1) {
      animationRef.current = null;
    }
  });

  return (
    <>
      {/* Reactive scene background. `<color attach="background">` sets
          `scene.background`, which is what the screenshot path reads;
          relying on the `<Canvas style>` background would leave the
          PNG transparent / black on the off-canvas read. */}
      <color attach="background" args={[backgroundColor]} />
      {/* Soft fill so future shaded materials don't render as solid
          black. Slider-driven (Phase 3 #7). */}
      <ambientLight intensity={ambientIntensity} />
      {/* Key light from front-upper-right; effectively no-op on
          basic-material tubes, but kept so Phase 3 #3+ has a stable
          rig to inherit. */}
      <directionalLight position={[100, 200, 100]} intensity={0.7} />
      <WallBacking
        enabled={wallEnabled}
        color={wallColor}
        doc={doc}
        selectedGroupId={effectiveGroupId}
      />
      {visibleRuns.map((run) => (
        <Tube
          key={run.id}
          run={run}
          defaultDiameterMM={defaultDiameterMM}
        />
      ))}
      {/*
        OrbitControls config (per spec):
          - enableDamping + dampingFactor: slight ease on user input.
          - min/maxDistance: clamp absurd zooms (can't end up inside
            a 12 mm tube; can't end up 100 km out).
          - rotateSpeed 0.7: slightly slower than default (1.0); 3D
            apps usually feel better with a calmer rotate.
          - panSpeed / zoomSpeed: defaults; spec calls them out so
            future tuning has a single place to land.
      */}
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.1}
        minDistance={50}
        // 5000 mm clamps preset framing for any sign whose
        // bbox-diagonal × 1.5 exceeds 5 m — the orbit controls
        // silently snap the camera back inside the cap, fighting
        // with the preset animation. 50 m is "every realistic neon
        // sign plus headroom" without letting the user wander into
        // the void.
        maxDistance={50_000}
        enablePan
        panSpeed={1.0}
        rotateSpeed={0.7}
        zoomSpeed={1.0}
      />
      <ScreenshotBridge composer={composer} onCaptureReady={onCaptureReady} />
      {/*
        Bloom post-processing (Phase 3 #4). EffectComposer takes over
        the render loop: it draws the scene into an offscreen target,
        then runs the effect chain. We wrap only the effects (not the
        scene meshes) — meshes stay rendered by fiber's default path,
        which EffectComposer captures into its render target.

        `multisampling={0}` disables MSAA on the composer's render
        target. The trade-off: edges of non-emissive geometry may
        show slight aliasing. We accept that because:
          1. The dominant geometry is emissive tubes, where bloom
             itself softens the edges below the visibility threshold.
          2. MSAA on the composer pipeline is expensive on integrated
             GPUs (the windows-smoke CI runner being the canary), and
             we'd rather hold 60 fps than chase 4xMSAA edges.

        `?nobloom` — when present in the URL, skip the composer wrap
        entirely. Useful for performance debugging, A/B screenshot
        comparisons, and any future smoke harness that wants to
        confirm the preview route renders without depending on the
        post-processing pipeline.
      */}
      {!noBloom && (
        <EffectComposer multisampling={0}>
          <Bloom
            intensity={bloomIntensity}
            luminanceThreshold={bloomThreshold}
            luminanceSmoothing={BLOOM_LUMINANCE_SMOOTHING}
            mipmapBlur={BLOOM_MIPMAP_BLUR}
            radius={bloomRadius}
          />
          {/*
            Capture the live composer instance so the screenshot path
            can drive `composer.render()` through the bloom pipeline
            instead of `gl.render(scene, camera)` (which would skip
            post-processing and produce a flat-emissive PNG — Tier 1
            #68). When `?nobloom` short-circuits this whole branch,
            no bridge mounts and the screenshot helper falls back to
            the bare renderer.
          */}
          <ComposerBridge onComposerReady={handleComposerReady} />
        </EffectComposer>
      )}
    </>
  );
}
