import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ClientFilter } from './Dashboard.jsx';

export default function Suppression({ me }) {
  const [clientId, setClientId] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = { limit: 500 };
    if (clientId) params.clientId = clientId;
    if (q) params.q = q;
    api.suppression(params).then((d) => {
      setRows(d);
      setLoading(false);
    });
  }, [clientId, q]);

  const csvUrl = () => {
    const params = {};
    if (clientId) params.clientId = clientId;
    return '/api/suppression.csv?' + new URLSearchParams(params).toString();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Suppression list</h1>
          <p className="text-sm text-muted mt-1">
            Recipients with hard bounces. This list is retained indefinitely —
            unlike raw events.
          </p>
        </div>
        <a
          href={csvUrl()}
          className="px-3 py-2 rounded-md bg-accent text-bg text-sm font-medium hover:bg-sky-200 transition"
        >
          Export CSV
        </a>
      </div>

      <div className="flex items-center gap-2">
        <ClientFilter me={me} value={clientId} onChange={setClientId} />
        <input
          type="search"
          placeholder="search recipient…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="bg-panel border border-border rounded-md px-3 py-2 text-sm w-72"
        />
      </div>

      <div className="bg-panel border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg/50 text-xs text-muted">
            <tr>
              <th className="text-left font-normal px-3 py-2">Recipient</th>
              <th className="text-left font-normal px-3 py-2">Reason</th>
              <th className="text-left font-normal px-3 py-2">First seen</th>
              <th className="text-left font-normal px-3 py-2">Last seen</th>
              <th className="text-right font-normal px-3 py-2">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{s.rcptTo}</td>
                <td className="px-3 py-2 text-muted font-mono text-xs truncate max-w-md">
                  {s.reason}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {new Date(s.firstSeenAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {new Date(s.lastSeenAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 text-right font-mono">{s.eventCount}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted">
                  No suppressed addresses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
