# Phase 3 #1 — Foundation: three.js + react-three-fiber + preview route

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/p3-1-foundation`

## Goal

Phase 3's promise is "extrude vector paths to 3D glass tubes, emissive shader with bloom, per-gas color, blockout opacity, electrode caps, orbit-camera preview UI" (per README). Before any of that lands, we need a foundation: dependency choices, file-layout convention, route topology, and a working scene scaffold that renders a hard-coded test object so subsequent specs can replace the placeholder with real geometry.

This spec ships:

1. The three.js + react-three-fiber dependency additions (with user pre-approval per CLAUDE.md's "new third-party dependencies require explicit approval").
2. A new `/projects/:id/versions/:vid/preview` route (read-only, no edit affordances).
3. A `web/src/preview/` directory with the core scene scaffold.
4. A single hard-coded green wireframe cube rendered in the scene as proof-of-life.

"Done" means: navigating to the preview URL renders a 60 fps spinning cube against a dark background with basic ambient + directional lighting, the route is wired into the existing React Router setup, and subsequent Phase 3 specs can replace the cube with real geometry without touching anything else.

## Branch + setup

```sh
git fetch origin
git checkout -b task/p3-1-foundation origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/package.json` + `web/package-lock.json` — add `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` (the last two are needed by downstream Phase 3 specs; bundling them now avoids a second dep PR). Pin to the latest stable major (`three@^0.160`, fiber `^8`, drei `^9`, post `^2`). **Get user approval before adding.**
- `web/src/main.tsx` (or wherever the router is set up) — register the new preview route.
- `web/src/pages/ProjectDetail.tsx` — add a small "3D preview" link button next to the existing editor link, per design-version row.

**New:**

- `web/src/preview/PreviewPage.tsx` — route component. Loads the design version via the existing `api.getDesignVersion(p, v)` helper and mounts the scene. Wraps `<Canvas>` from `@react-three/fiber`.
- `web/src/preview/Scene.tsx` — the `<Canvas>`-internal contents: ambient + directional light, a hard-coded green wireframe cube placeholder (this gets replaced by Phase 3 #2's tube geometry), and a default `<PerspectiveCamera>`.
- `web/src/preview/index.ts` — barrel export.
- `web/src/preview/PreviewPage.test.tsx` — minimal smoke test (no RTL setup; this can be a vitest-mocked module test that imports the component without rendering, just verifies it exports a default function).
- `web/src/preview/preview.css` (optional) — full-viewport canvas styling. Inline styles in `Canvas` work too; pick one and document.

**Don't touch:**

- `EditorCanvas.tsx`, `EditorPage.tsx` — completely unrelated; Phase 3 lives in its own directory.
- Any backend file — no API changes.
- `App.css`, `index.css` — preview gets its own stylesheet.
- Any other `web/src/pages/*.tsx`.

## Deliverables

### Dependencies

1. **`three`** — the renderer. ~150 KB gzipped. The most boring choice.
2. **`@react-three/fiber`** — React renderer for three. Lets us write the scene as JSX components, which is consistent with the rest of the app's React 19 + TypeScript style. Without it, we'd be juggling imperative three.js code inside `useEffect`s — ugly and bug-prone.
3. **`@react-three/drei`** — helper components (`<OrbitControls>`, `<Environment>`, `<Stats>`). Used by Phase 3 #4 (camera) but bundling now avoids a second dep approval.
4. **`@react-three/postprocessing`** — bloom + post-effect pipeline. Used by Phase 3 #3 (emissive material) but same logic.

These four together are the canonical react + three stack. No alternatives meet the "boring" bar (Babylon.js has no React renderer; raw three.js would require a manual React integration that's effectively reinventing fiber).

**Bundle-size impact**: ~600 KB gzipped total (three + fiber + drei + postprocessing). Acceptable cost for the entire Phase 3 surface; document in the PR body.

### Route + page scaffold

Route: `/projects/:projectId/versions/:versionId/preview`. Renders `<PreviewPage>`. The page:

1. On mount, fetches the design version via `api.getDesignVersion(projectId, versionId)`.
2. While loading, renders a small "Loading 3D preview…" placeholder.
3. On error, renders an error message + "Back to project" link.
4. On success, mounts `<Scene doc={doc} />` inside a full-viewport `<Canvas>`.

`<Canvas>` configuration:
- `dpr={[1, 2]}` — adaptive pixel ratio.
- `camera={{ position: [0, 0, 1500], fov: 50 }}` — far enough to see a typical 1000×500 mm design from outside; `fov: 50` is a reasonable photographic default.
- Background color: `#0a0a0a` (dark grey, lets emissive tubes pop later).

`<Scene>` for V1:
- `<ambientLight intensity={0.3} />`
- `<directionalLight position={[100, 200, 100]} intensity={0.7} />`
- Hard-coded green wireframe cube at origin, 100 mm wide, slowly rotating via `useFrame`.

### ProjectDetail integration

Next to each design-version row's "Open editor" link, add a "3D preview" link that navigates to the preview route. Plain text link or small button — match the existing pattern.

## Constraints

- **User approval required** for the four new npm packages. Document the bundle-size impact in the PR body; user has already signed off in conversation but the formal record stays in the PR.
- **No new Go dependencies** — Phase 3 is frontend-only.
- **No backend changes** — the route is React-router-side; the existing design-version fetch endpoint is sufficient.
- **No edit affordances** — the preview is read-only. No "save" button, no toolbar tools. This stays true through every Phase 3 spec.
- **No bundle-size optimization in V1** — code-splitting via `React.lazy(() => import('./preview/PreviewPage'))` is a follow-up. V1 just imports normally; the ~600 KB hits the main bundle. Document the follow-up.
- **No SSR concerns** — this is a SPA; three.js is client-only. No issues with React Server Components since the app doesn't use them.
- **`web/dist` changes** — `npm run build` will produce a much larger bundle. CI must still pass. Confirm `windows-smoke`'s timeout is unaffected.

## Geometry / algorithms

None for V1. The placeholder cube is `<mesh><boxGeometry args={[100, 100, 100]} /><meshBasicMaterial color="green" wireframe /></mesh>`.

## Tests

- **`PreviewPage.test.tsx`** — vitest module test that imports `PreviewPage` and confirms it exports a function (no runtime rendering; RTL isn't set up). Pinning the export shape catches accidental refactors.
- **Build test** — `npm run build` must succeed with the new deps. Confirm in CI.
- **No three.js scene test** — the visual output is the spec; testing the cube renders exactly is hostile.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Bundle-size: log the pre-PR and post-PR `dist/assets/index-*.js` sizes in the PR body so the cost is visible.

Manual smoke:

```sh
( cd web && npm run dev )
```

1. Open any project with at least one design version.
2. Click "3D preview" on a version row.
3. URL navigates; a dark scene loads with a slowly-rotating green wireframe cube.
4. Browser DevTools confirms 60 fps; no console errors.
5. Hit "Back to project" → returns to ProjectDetail without errors.

## Workflow

1. Get user approval for the four new deps (already given verbally; PR body re-states for the record).
2. Add the deps; run `npm install`; commit `package.json` + `package-lock.json`.
3. Build `Scene.tsx` with the placeholder cube. Confirm it renders standalone via a temporary scratch page if helpful.
4. Build `PreviewPage.tsx`; wire `api.getDesignVersion`.
5. Register the route in `main.tsx` (or wherever the existing routes live).
6. Add the "3D preview" link to `ProjectDetail.tsx`.
7. Run all four pre-merge checks. Manual smoke per above.
8. Open PR titled "Phase 3 foundation: three.js + react-three-fiber + preview route (Phase 3 #1)".
9. **Move spec** from `specs/active/phase3-1-three-foundation.md` to `specs/done/phase3-1-three-foundation.md` as part of the final commit.

## Report back

Under 300 words. Include:

- PR URL
- Bundle-size delta (pre vs post in KB gzipped)
- File-size deltas on touched files
- CI final state
- Frame rate observed in DevTools on a typical macOS dev environment
- Judgment calls — any decisions about route shape, Canvas tuning, lighting defaults
- Phase 3 follow-ups worth tracking (code-splitting via React.lazy, fps counter via `<Stats>` from drei in dev mode, dark/light scene background toggle)
