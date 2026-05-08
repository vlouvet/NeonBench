import { useEffect, useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
// drei's exported OrbitControls type isn't generic — pull the
// underlying three-stdlib class so the imperative ref has the
// `target` / `update` methods we need.
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import type { DesignDoc } from '../api';
import Tube from './Tube';
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
 * controls and camera preset framing. Phase 3 #7 (this revision)
 * layers in scene-chrome controls — background color, ambient
 * intensity, and an optional wall plane — plus a "screenshot bridge"
 * that hands the renderer/scene/camera up to PreviewPage for the PNG
 * export.
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

/** Snapshot of the live three.js objects required for an off-canvas capture. */
export interface CaptureContext {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
}

/** Callback registration used by `<ScreenshotBridge>` to expose live three.js refs. */
export type OnCaptureReady = (ctx: CaptureContext | null) => void;

// Cubic ease-in-out: 0 at t=0, 1 at t=1, smooth at both ends. Looks
// less mechanical than linear and doesn't overshoot the way a
// spring would (overshoot is wrong here — the camera should land
// exactly on the preset position).
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * In-canvas helper that pipes the live `gl/scene/camera` triple back
 * up to PreviewPage via a callback ref. We use `useEffect` with
 * `onCaptureReady` as a dep so the parent re-registers when the
 * renderer actually changes (context loss + restore). The cleanup
 * passes `null` so a parent that unmounts during a capture click
 * fails fast rather than calling `gl.render()` on a torn-down
 * renderer.
 *
 * No JSX rendered; this is a pure side-effect component.
 */
function ScreenshotBridge({ onCaptureReady }: { onCaptureReady?: OnCaptureReady }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (!onCaptureReady) return;
    onCaptureReady({ gl, scene, camera });
    return () => onCaptureReady(null);
  }, [gl, scene, camera, onCaptureReady]);
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
}: {
  enabled: boolean;
  color: string;
  doc: DesignDoc | null;
}) {
  if (!enabled) return null;
  const bbox = bboxOfDoc(doc);
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
  backgroundColor = '#1a1a1a',
  ambientIntensity = 0.3,
  wallEnabled = false,
  wallColor = '#f0f0f0',
  onCaptureReady,
}: {
  doc: DesignDoc | null;
  defaultDiameterMM?: number;
  /** When this changes (by nonce), Scene animates the camera to the named preset. */
  presetRequest?: PresetRequest;
  /** Scene background hex (applied via `<color attach="background">`). */
  backgroundColor?: string;
  /** Ambient light intensity, 0..1. */
  ambientIntensity?: number;
  /** When true, render the `<WallBacking>` plane behind the design. */
  wallEnabled?: boolean;
  /** Wall surface color (`<meshStandardMaterial color>`). */
  wallColor?: string;
  /** Callback invoked once the live `gl/scene/camera` are available. */
  onCaptureReady?: OnCaptureReady;
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();

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
    const bbox = bboxOfDoc(doc);
    const { position, target } = cameraPositionForPreset('front', bbox);
    camera.position.copy(position);
    if (controlsRef.current) {
      controlsRef.current.target.copy(target);
      controlsRef.current.update();
    }
    didInitialFitRef.current = true;
  }, [doc, camera]);

  // When a new preset is requested, kick off an animation. We
  // capture the *current* camera position + orbit target as the
  // "from", and compute the preset framing for the current bbox as
  // the "to". Subsequent ticks of `useFrame` interpolate between
  // them with `easeInOutCubic`.
  useEffect(() => {
    if (!presetRequest) return;
    const bbox = bboxOfDoc(doc);
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
  }, [presetRequest, doc, camera]);

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
      <WallBacking enabled={wallEnabled} color={wallColor} doc={doc} />
      {doc?.runs.map((run) => (
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
        maxDistance={5000}
        enablePan
        panSpeed={1.0}
        rotateSpeed={0.7}
        zoomSpeed={1.0}
      />
      <ScreenshotBridge onCaptureReady={onCaptureReady} />
    </>
  );
}
