import { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { api } from '../api.js';

export default function Admin() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <nav className="flex gap-2 text-sm border-b border-border">
        <SubTab to="/admin">Clients & mail servers</SubTab>
        <SubTab to="/admin/users">Users</SubTab>
      </nav>
      <Routes>
        <Route index element={<Clients />} />
        <Route path="users" element={<Users />} />
      </Routes>
    </div>
  );
}

function SubTab({ to, children }) {
  return (
    <NavLink
      end
      to={to}
      className={({ isActive }) =>
        `px-3 py-2 border-b -mb-px ${
          isActive ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function Clients() {
  const [clients, setClients] = useState([]);
  const [newName, setNewName] = useState('');
  const [revealed, setRevealed] = useState(null); // { id, url } of just-created mail server

  async function refresh() {
    setClients(await api.adminClients());
  }
  useEffect(() => {
    refresh();
  }, []);

  async function createClient(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    await api.adminCreateClient({ name: newName.trim() });
    setNewName('');
    refresh();
  }

  return (
    <div className="space-y-5">
      <form onSubmit={createClient} className="flex gap-2 max-w-md">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New client name"
          className="flex-1 bg-panel border border-border rounded-md px-3 py-2 text-sm"
        />
        <button className="px-4 py-2 rounded-md bg-accent text-bg text-sm font-medium">
          Add client
        </button>
      </form>

      {clients.length === 0 && <div className="text-muted text-sm">No clients yet.</div>}

      {clients.map((c) => (
        <ClientCard key={c.id} client={c} onChange={refresh} revealed={revealed} setRevealed={setRevealed} />
      ))}
    </div>
  );
}

function ClientCard({ client, onChange, revealed, setRevealed }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', publicKeyPem: '', postalServerId: '' });

  async function addServer(e) {
    e.preventDefault();
    const ms = await api.adminCreateMailServer(client.id, form);
    setRevealed({ id: ms.id, url: ms.webhookUrl });
    setForm({ name: '', publicKeyPem: '', postalServerId: '' });
    setAdding(false);
    onChange();
  }

  async function deleteServer(id) {
    if (!confirm('Delete this mail server and all its events?')) return;
    await api.adminDeleteMailServer(id);
    onChange();
  }

  async function rotate(id) {
    if (!confirm('Rotate the webhook token? You will need to update Postal.')) return;
    const ms = await api.adminRotateMailServer(id);
    setRevealed({ id: ms.id, url: ms.webhookUrl });
    onChange();
  }

  return (
    <div className="bg-panel border border-border rounded-lg p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="font-medium">{client.name}</div>
          <div className="text-xs text-muted font-mono">{client.slug}</div>
        </div>
        <button
          onClick={() => setAdding(!adding)}
          className="text-sm px-3 py-1 rounded bg-border hover:bg-border/70"
        >
          {adding ? 'cancel' : '+ mail server'}
        </button>
      </div>

      {adding && (
        <form onSubmit={addServer} className="bg-bg border border-border rounded p-3 mb-3 space-y-2">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Mail server name (e.g. transactional-prod)"
            className="w-full bg-panel border border-border rounded px-3 py-2 text-sm"
            required
          />
          <input
            value={form.postalServerId}
            onChange={(e) => setForm({ ...form, postalServerId: e.target.value })}
            placeholder="Postal numeric server id (optional, for reference)"
            className="w-full bg-panel border border-border rounded px-3 py-2 text-sm"
          />
          <textarea
            value={form.publicKeyPem}
            onChange={(e) => setForm({ ...form, publicKeyPem: e.target.value })}
            placeholder={`Paste public key. You can use either:\n• full PEM (-----BEGIN PUBLIC KEY----- ...)\n• or just the base64 string after p= from \`postal default-dkim-record\``}
            rows={5}
            className="w-full bg-panel border border-border rounded px-3 py-2 text-xs font-mono"
            required
          />
          <button className="px-4 py-2 rounded bg-accent text-bg text-sm font-medium">
            Create mail server
          </button>
        </form>
      )}

      {client.mailServers.length === 0 ? (
        <div className="text-sm text-muted">No mail servers yet.</div>
      ) : (
        <div className="space-y-2">
          {client.mailServers.map((m) => (
            <MailServerRow
              key={m.id}
              server={m}
              revealed={revealed}
              onRotate={rotate}
              onDelete={deleteServer}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MailServerRow({ server: m, revealed, onRotate, onDelete }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);

  async function toggleInfo() {
    if (!open) {
      setInfo(await api.adminMailServerInfo(m.id));
    }
    setOpen(!open);
  }
  async function refreshInfo() {
    setInfo(await api.adminMailServerInfo(m.id));
  }

  return (
    <div className="bg-bg/50 border border-border rounded p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">{m.name}</div>
          <div className="text-xs text-muted font-mono">
            postal id: {m.postalServerId ?? '—'} · token: {m.webhookToken.slice(0, 8)}…
          </div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={toggleInfo}
            className="text-xs px-2 py-1 rounded bg-border hover:bg-border/70"
          >
            {open ? 'hide info' : 'show webhook url & test'}
          </button>
          <button
            onClick={() => onRotate(m.id)}
            className="text-xs px-2 py-1 rounded bg-border hover:bg-border/70"
          >
            rotate token
          </button>
          <button
            onClick={() => onDelete(m.id)}
            className="text-xs px-2 py-1 rounded bg-border hover:bg-bad/30 hover:text-bad"
          >
            delete
          </button>
        </div>
      </div>

      {revealed && revealed.id === m.id && (
        <div className="mt-2 bg-accent/10 border border-accent/30 rounded p-2 text-xs">
          <div className="text-accent mb-1">
            Webhook URL for this mail server — paste into Postal:
          </div>
          <code className="break-all font-mono">{revealed.url}</code>
        </div>
      )}

      {open && info && (
        <div className="mt-3 space-y-2 text-xs">
          <div className="bg-bg border border-border rounded p-2">
            <div className="text-muted mb-1">Webhook URL</div>
            <div className="flex items-center gap-2">
              <code className="break-all font-mono flex-1">{info.webhookUrl}</code>
              <button
                onClick={() => navigator.clipboard.writeText(info.webhookUrl)}
                className="px-2 py-1 rounded bg-border hover:bg-border/70"
              >
                copy
              </button>
            </div>
            <div className="text-muted mt-2">
              In Postal: this mail server → Webhooks → New webhook → paste this URL,
              tick the events you want, save. Then send a test message and reload below.
            </div>
          </div>

          <div className="bg-bg border border-border rounded p-2 grid grid-cols-2 gap-2">
            <div>
              <div className="text-muted">Last event received</div>
              <div className="font-mono">
                {info.lastEvent
                  ? `${new Date(info.lastEvent.receivedAt).toLocaleString()} · ${info.lastEvent.eventType}`
                  : '— never —'}
              </div>
            </div>
            <div>
              <div className="text-muted">Events in last 24h</div>
              <div className="font-mono">{info.recentCount24h}</div>
            </div>
            <button
              onClick={refreshInfo}
              className="col-span-2 px-2 py-1 rounded bg-border hover:bg-border/70 mt-1"
            >
              refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Users() {
  const [users, setUsers] = useState([]);
  const [clients, setClients] = useState([]);
  const [newUser, setNewUser] = useState({
    email: '',
    name: '',
    isStaff: false,
    password: '',
  });
  const [inviteError, setInviteError] = useState(null);
  const [resettingId, setResettingId] = useState(null);

  async function refresh() {
    setUsers(await api.adminUsers());
    setClients(await api.adminClients());
  }
  useEffect(() => {
    refresh();
  }, []);

  async function invite(e) {
    e.preventDefault();
    setInviteError(null);
    if (!newUser.email) return;
    if (!newUser.password || newUser.password.length < 12) {
      setInviteError('Initial password must be at least 12 characters.');
      return;
    }
    try {
      await api.adminUpsertUser(newUser);
      setNewUser({ email: '', name: '', isStaff: false, password: '' });
      refresh();
    } catch (err) {
      setInviteError(err.message);
    }
  }

  async function resetPassword(userId, password) {
    try {
      await api.adminResetPassword(userId, password);
      setResettingId(null);
      refresh();
    } catch (err) {
      alert('Reset failed: ' + err.message);
    }
  }

  async function addMembership(userId, clientId, role) {
    await api.adminUpsertMembership({ userId, clientId, role });
    refresh();
  }

  async function removeMembership(userId, clientId) {
    await api.adminDeleteMembership(userId, clientId);
    refresh();
  }

  async function toggleStaff(user) {
    await api.adminUpsertUser({ email: user.email, isStaff: !user.isStaff });
    refresh();
  }

  return (
    <div className="space-y-5">
      <form onSubmit={invite} className="bg-panel border border-border rounded-lg p-4 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input
            type="email"
            placeholder="email@example.com"
            value={newUser.email}
            onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
            className="bg-bg border border-border rounded-md px-3 py-2 text-sm"
            required
          />
          <input
            type="text"
            placeholder="Initial password (≥ 12 chars; share out of band)"
            value={newUser.password}
            onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            className="bg-bg border border-border rounded-md px-3 py-2 text-sm font-mono"
            required
            minLength={12}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={newUser.isStaff}
              onChange={(e) => setNewUser({ ...newUser, isStaff: e.target.checked })}
            />
            internal staff
          </label>
          <button className="px-4 py-2 rounded bg-accent text-bg text-sm font-medium">
            Invite
          </button>
        </div>
        {inviteError && (
          <div className="text-xs text-bad">{inviteError}</div>
        )}
      </form>

      {users.map((u) => (
        <div key={u.id} className="bg-panel border border-border rounded-lg p-4">
          <div className="flex items-start justify-between mb-2">
            <div>
              <div className="font-medium">
                {u.email}
                {u.isStaff && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded bg-accent/15 text-accent">
                    staff
                  </span>
                )}
              </div>
              {u.lastLoginAt && (
                <div className="text-xs text-muted">
                  last login: {new Date(u.lastLoginAt).toLocaleString()}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setResettingId(resettingId === u.id ? null : u.id)}
                className="text-xs px-2 py-1 rounded bg-border hover:bg-border/70"
              >
                {resettingId === u.id ? 'cancel reset' : 'reset password'}
              </button>
              <button
                onClick={() => toggleStaff(u)}
                className="text-xs px-2 py-1 rounded bg-border hover:bg-border/70"
              >
                {u.isStaff ? 'demote to regular user' : 'promote to staff'}
              </button>
            </div>
          </div>
          {resettingId === u.id && (
            <ResetPasswordForm
              onCancel={() => setResettingId(null)}
              onSubmit={(pw) => resetPassword(u.id, pw)}
            />
          )}
          {!u.isStaff && (
            <div className="mt-3 space-y-1.5">
              <div className="text-xs text-muted">Client access</div>
              {u.memberships.length === 0 && (
                <div className="text-xs text-muted">No client access.</div>
              )}
              {u.memberships.map((m) => (
                <div key={m.clientId} className="flex items-center gap-2 text-sm">
                  <span className="flex-1">{m.client.name}</span>
                  <select
                    value={m.role}
                    onChange={(e) => addMembership(u.id, m.clientId, e.target.value)}
                    className="bg-bg border border-border rounded px-2 py-1 text-xs"
                  >
                    <option value="viewer">viewer</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <button
                    onClick={() => removeMembership(u.id, m.clientId)}
                    className="text-xs text-muted hover:text-bad"
                  >
                    remove
                  </button>
                </div>
              ))}
              <AddMembership user={u} clients={clients} onAdd={addMembership} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AddMembership({ user, clients, onAdd }) {
  const existing = new Set(user.memberships.map((m) => m.clientId));
  const available = clients.filter((c) => !existing.has(c.id));
  const [clientId, setClientId] = useState('');
  const [role, setRole] = useState('viewer');
  if (available.length === 0) return null;
  return (
    <div className="flex items-center gap-2 pt-1">
      <select
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        className="bg-bg border border-border rounded px-2 py-1 text-xs"
      >
        <option value="">— add client access —</option>
        {available.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="bg-bg border border-border rounded px-2 py-1 text-xs"
      >
        <option value="viewer">viewer</option>
        <option value="admin">admin</option>
        <option value="owner">owner</option>
      </select>
      <button
        onClick={() => clientId && onAdd(user.id, clientId, role)}
        disabled={!clientId}
        className="text-xs px-2 py-1 rounded bg-border hover:bg-border/70 disabled:opacity-50"
      >
        add
      </button>
    </div>
  );
}

function ResetPasswordForm({ onSubmit, onCancel }) {
  const [pw, setPw] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (pw.length < 12) {
          alert('Password must be at least 12 characters.');
          return;
        }
        onSubmit(pw);
        setPw('');
      }}
      className="mt-2 flex items-center gap-2"
    >
      <input
        type="text"
        autoFocus
        placeholder="New password (≥ 12 chars)"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        className="flex-1 bg-bg border border-border rounded px-2 py-1 text-xs font-mono"
        minLength={12}
        required
      />
      <button className="text-xs px-2 py-1 rounded bg-accent text-bg">
        set password
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs px-2 py-1 rounded bg-border hover:bg-border/70"
      >
        cancel
      </button>
    </form>
  );
}
