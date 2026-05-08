import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';
import type { DesignDoc } from '../api';

/**
 * Scene is the `<Canvas>`-internal payload for the Phase 3 preview. V1
 * is intentionally a placeholder: ambient + directional lighting and a
 * spinning green wireframe cube. Phase 3 #2 will replace the cube with
 * tube extrusions derived from `doc.runs[i].polyline`; until then the
 * `doc` prop is accepted but unused — passing it through now means
 * downstream specs don't have to touch `PreviewPage.tsx` to wire data.
 *
 * Cube size: 100 mm wide. The Canvas camera in PreviewPage sits at
 * z=1500 with a 50° FOV, which puts a 1000 × 500 mm typical design
 * comfortably in frame; a 100 mm cube reads as a clear "hello, three.js
 * is alive" without dominating that scale.
 *
 * The cube rotates at ~0.5 rad/s on Y and ~0.25 rad/s on X. `useFrame`
 * delivers a `delta` in seconds so the rotation rate is frame-rate
 * independent (a 60 fps and a 30 fps client see the same angular speed).
 */
export default function Scene({ doc }: { doc: DesignDoc | null }) {
  // The `doc` prop is wired through from PreviewPage so Phase 3 #2 can
  // derive tube geometry from `doc.runs[i].polyline` without changing
  // the component's public shape. V1 doesn't actually read the doc —
  // the placeholder cube is hard-coded — so we explicitly discard it
  // here; eslint's no-unused-vars rule doesn't honor an underscore
  // prefix in this repo's config.
  void doc;
  // Mesh ref drives the per-frame rotation. Typed as `Mesh | null` so
  // useFrame's type-narrowing path (the early return below) keeps the
  // body strict-mode clean.
  const meshRef = useRef<Mesh | null>(null);

  useFrame((_state, delta) => {
    const m = meshRef.current;
    if (!m) return;
    m.rotation.y += 0.5 * delta;
    m.rotation.x += 0.25 * delta;
  });

  return (
    <>
      {/* Soft fill so the cube's shadowed faces aren't pure black. */}
      <ambientLight intensity={0.3} />
      {/* Key light from front-upper-right; matches the spec's defaults. */}
      <directionalLight position={[100, 200, 100]} intensity={0.7} />
      <mesh ref={meshRef}>
        <boxGeometry args={[100, 100, 100]} />
        <meshBasicMaterial color="green" wireframe />
      </mesh>
    </>
  );
}
