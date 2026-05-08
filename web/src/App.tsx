import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProjectList from './pages/ProjectList';
import ProjectDetail from './pages/ProjectDetail';
import EditorPage from './pages/EditorPage';
import { PreviewPage } from './preview';
import './App.css';

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
          <Route path="projects/:id/versions/:vid/preview" element={<PreviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
