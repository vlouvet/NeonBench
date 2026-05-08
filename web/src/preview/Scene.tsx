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
 * replaced the cube with real tube geometry. Phase 3 #5 (this
 * revision) adds:
 *
 *   1. `<OrbitControls>` from `@react-three/drei` — operators can
 *      orbit (left-drag), pan (right-drag), and zoom (wheel /
 *      pinch).
 *   2. A `presetRequest` prop that, when changed, animates the
 *      camera + orbit target to one of four preset framings (front,
 *      iso, top, side) over `PRESET_ANIMATION_MS` milliseconds.
 *   3. An on-mount fit-to-content step: the camera + target snap
 *      (no animation) to the front preset framed on the design's
 *      bbox so the first frame shows the whole sign rather than a
 *      tiny dot at `[0, 0, 1500]`.
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
 *
 * Lighting is unchanged from #2 — `meshBasicMaterial` (placeholder
 * tube material) is unlit, so the directional light is essentially
 * a no-op until Phase 3 #3 swaps in physical materials.
 */

// Preset transition duration in milliseconds. 600 ms matches the
// "snappy but not jarring" feel of typical 3D-app preset buttons
// (Blender's numpad views, SketchUp's standard views). Shorter and
// it feels jumpy; longer and the user starts wondering if it's
// broken.
export const PRESET_ANIMATION_MS = 600;

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

// Cubic ease-in-out: 0 at t=0, 1 at t=1, smooth at both ends. Looks
// less mechanical than linear and doesn't overshoot the way a
// spring would (overshoot is wrong here — the camera should land
// exactly on the preset position).
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export default function Scene({
  doc,
  defaultDiameterMM,
  presetRequest,
}: {
  doc: DesignDoc | null;
  defaultDiameterMM?: number;
  /** When this changes (by nonce), Scene animates the camera to the named preset. */
  presetRequest?: PresetRequest;
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
    </>
  );
}
