import { useState } from 'react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.error === 'invalid_credentials') {
          setError('Invalid email or password.');
        } else if (body.error === 'email_and_password_required') {
          setError('Both email and password are required.');
        } else {
          setError(`Sign-in failed (${res.status}).`);
        }
        return;
      }
      window.location.assign('/');
    } catch (err) {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-panel border border-border rounded-lg p-8 space-y-4"
      >
        <div>
          <div className="font-mono text-sm text-accent mb-1">▎ postal-logs</div>
          <h1 className="text-xl font-semibold mb-1">Sign in</h1>
          <p className="text-sm text-muted">
            Enter your email and password. If you've been invited but haven't
            been given a password yet, ask an administrator.
          </p>
        </div>

        <label className="block">
          <div className="text-xs text-muted mb-1">Email</div>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <div className="text-xs text-muted mb-1">Password</div>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm"
          />
        </label>

        {error && (
          <div className="text-sm text-bad bg-bad/10 border border-bad/30 rounded px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="block w-full text-center py-2.5 rounded-md bg-ink text-bg font-medium hover:bg-white transition disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
