import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

export default function Dashboard({ me }) {
  const [clientId, setClientId] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    api.summary({ clientId, days }).then(setData).catch((e) => setErr(String(e)));
  }, [clientId, days]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-muted text-sm mt-1">
            Webhook events from your Postal mail servers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ClientFilter me={me} value={clientId} onChange={setClientId} />
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="bg-panel border border-border rounded-md px-3 py-2 text-sm"
          >
            <option value={7}>last 7 days</option>
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
            <option value={365}>last year</option>
          </select>
        </div>
      </div>

      {err && <div className="text-bad text-sm">{err}</div>}
      {!data && !err && <div className="text-muted text-sm">loading…</div>}
      {data && <Summary data={data} />}
    </div>
  );
}

function Summary({ data }) {
  const eventTypes = Array.from(new Set(data.byDay.map((r) => r.eventType)));
  const days = Array.from(new Set(data.byDay.map((r) => r.date))).sort();
  const series = days.map((date) => {
    const row = { date };
    for (const t of eventTypes) {
      row[t] = 0;
    }
    return row;
  });
  const idx = Object.fromEntries(series.map((r, i) => [r.date, i]));
  for (const r of data.byDay) {
    if (idx[r.date] !== undefined) series[idx[r.date]][r.eventType] = r.count;
  }

  const colorFor = (type) => {
    if (type === 'MessageSent') return '#4ade80';
    if (type === 'MessageBounced') return '#f87171';
    if (type === 'MessageDeliveryFailed') return '#fb923c';
    if (type === 'MessageDelayed') return '#fbbf24';
    if (type === 'MessageHeld') return '#a78bfa';
    return '#7dd3fc';
  };

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {data.byType.slice(0, 8).map((t) => (
          <div key={t.eventType} className="bg-panel border border-border rounded-lg p-4">
            <div className="text-xs text-muted">{t.eventType}</div>
            <div className="text-2xl font-mono mt-1" style={{ color: colorFor(t.eventType) }}>
              {t.count.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-panel border border-border rounded-lg p-4">
        <div className="text-sm text-muted mb-2">Events per day</div>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <LineChart data={series}>
              <CartesianGrid stroke="#262b38" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="#8c93a6" fontSize={11} />
              <YAxis stroke="#8c93a6" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#161922', border: '1px solid #262b38' }}
                labelStyle={{ color: '#e6e8ee' }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {eventTypes.map((t) => (
                <Line
                  key={t}
                  type="monotone"
                  dataKey={t}
                  stroke={colorFor(t)}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-panel border border-border rounded-lg p-4">
        <div className="text-sm text-muted mb-3">Top hard-bounce reasons (last 90 days)</div>
        {data.topBounces.length === 0 ? (
          <div className="text-sm text-muted">no bounces recorded</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="text-left font-normal pb-2">Reason</th>
                <th className="text-right font-normal pb-2 w-24">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.topBounces.map((b, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-2 font-mono text-xs">{b.reason}</td>
                  <td className="py-2 text-right font-mono">{b.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function ClientFilter({ me, value, onChange }) {
  const clients = me.clients || [];
  if (clients.length <= 1) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-panel border border-border rounded-md px-3 py-2 text-sm"
    >
      <option value="">All clients</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
