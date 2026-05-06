import { Link, Outlet } from 'react-router-dom';

export default function Layout() {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">NeonBench</Link>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
