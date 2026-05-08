import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProjectList from './pages/ProjectList';
import ProjectDetail from './pages/ProjectDetail';
import EditorPage from './pages/EditorPage';
import './App.css';

// Tier 3 #57 — code-split the 3D preview route. The preview pulls in
// three.js + @react-three/fiber + @react-three/drei + postprocessing
// (~310 KB gzipped) which users who never visit /preview would otherwise
// pay for on first load. `React.lazy()` keeps the chunk out of the main
// bundle until navigation. Default-import is required for `lazy()`, so
// this bypasses the `./preview` barrel (which only re-exports).
const PreviewPage = lazy(() => import('./preview/PreviewPage'));

function PreviewLoadingFallback() {
  return (
    <div
      style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--text-muted, #888)',
        fontSize: '0.9rem',
      }}
    >
      Loading 3D preview…
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<ProjectList />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="projects/:id/edit/:vid" element={<EditorPage />} />
          {/* Phase 3 #1 — read-only 3D preview route. Currently renders a
            * spinning green wireframe cube placeholder; subsequent Phase 3
            * specs replace the placeholder with extruded tube geometry,
            * emissive shaders, and orbit-camera controls. */}
          <Route
            path="projects/:id/versions/:vid/preview"
            element={
              <Suspense fallback={<PreviewLoadingFallback />}>
                <PreviewPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
