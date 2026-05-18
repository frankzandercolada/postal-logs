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
  const [showPw, setShowPw] = useState(false);
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
            onClick={() => setShowPw(true)}
            className="text-muted hover:text-ink underline-offset-2 hover:underline"
          >
            change password
          </button>
          <button
            onClick={handleLogout}
            className="text-muted hover:text-ink underline-offset-2 hover:underline"
          >
            sign out
          </button>
        </div>
      </div>
      {showPw && <ChangePasswordModal onClose={() => setShowPw(false)} />}
    </header>
  );
}

function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (next.length < 12) {
      setError('New password must be at least 12 characters.');
      return;
    }
    if (next !== confirm) {
      setError('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      alert('Password updated.');
      onClose();
    } catch (err) {
      setError(err.message.includes('invalid_current_password')
        ? 'Current password is incorrect.'
        : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-sm bg-panel border border-border rounded-lg p-6 space-y-3"
      >
        <h2 className="text-lg font-semibold">Change password</h2>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm"
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password (≥ 12 chars)"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm"
          minLength={12}
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Confirm new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm"
          required
        />
        {error && (
          <div className="text-sm text-bad bg-bad/10 border border-bad/30 rounded px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded bg-border hover:bg-border/70 text-sm"
          >
            cancel
          </button>
          <button
            disabled={busy}
            className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'saving…' : 'save'}
          </button>
        </div>
      </form>
    </div>
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
