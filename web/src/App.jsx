import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Events from './pages/Events.jsx';
import Suppression from './pages/Suppression.jsx';
import Admin from './pages/Admin.jsx';

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = not logged in

  useEffect(() => {
    api.me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted">
        loading…
      </div>
    );
  }
  if (me === null) return <Login />;

  return (
    <div className="min-h-screen flex flex-col">
      <Header me={me} />
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        <Routes>
          <Route path="/" element={<Dashboard me={me} />} />
          <Route path="/events" element={<Events me={me} />} />
          <Route path="/suppression" element={<Suppression me={me} />} />
          {me.isStaff && <Route path="/admin/*" element={<Admin me={me} />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="text-xs text-muted py-4 px-6 border-t border-border">
        postal-logs · {me.email}
      </footer>
    </div>
  );
}

function Header({ me }) {
  const nav = useNavigate();
  async function handleLogout() {
    await api.logout();
    nav('/');
    window.location.reload();
  }
  return (
    <header className="border-b border-border bg-panel/50 backdrop-blur sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
        <div className="font-mono text-sm tracking-tight">
          <span className="text-accent">▎</span> postal-logs
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <NavItem to="/">Dashboard</NavItem>
          <NavItem to="/events">Events</NavItem>
          <NavItem to="/suppression">Suppression</NavItem>
          {me.isStaff && <NavItem to="/admin">Admin</NavItem>}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm text-muted">
          <span>{me.email}</span>
          <button
            onClick={handleLogout}
            className="text-muted hover:text-ink underline-offset-2 hover:underline"
          >
            sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function NavItem({ to, children }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `px-3 py-1.5 rounded-md transition ${
          isActive
            ? 'bg-border text-ink'
            : 'text-muted hover:text-ink hover:bg-border/50'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
