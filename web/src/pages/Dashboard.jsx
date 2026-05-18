import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

const RANGES = [
  { label: 'last hour', minutes: 60, bucket: 'minute' },
  { label: 'last 6 hours', minutes: 6 * 60, bucket: 'hour' },
  { label: 'last 24 hours', minutes: 24 * 60, bucket: 'hour' },
  { label: 'last 7 days', minutes: 7 * 24 * 60, bucket: 'day' },
  { label: 'last 30 days', minutes: 30 * 24 * 60, bucket: 'day' },
];

const COLOR_FOR = (type) => {
  if (type === 'MessageSent') return '#4ade80';
  if (type === 'MessageBounced') return '#f87171';
  if (type === 'MessageDeliveryFailed') return '#fb923c';
  if (type === 'MessageDelayed') return '#fbbf24';
  if (type === 'MessageHeld') return '#a78bfa';
  if (type === 'MessageLoaded') return '#7dd3fc';
  if (type === 'MessageClicked') return '#22d3ee';
  return '#94a3b8';
};

export default function Dashboard({ me }) {
  const [clientId, setClientId] = useState('');
  const [rangeIdx, setRangeIdx] = useState(3); // default: last 7 days
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [asPercent, setAsPercent] = useState(false);

  const range = RANGES[rangeIdx];

  useEffect(() => {
    setData(null);
    setErr(null);
    api
      .summary({ clientId, minutes: range.minutes, bucket: range.bucket })
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [clientId, rangeIdx]);

  function toggleHidden(type) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

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
            value={rangeIdx}
            onChange={(e) => setRangeIdx(parseInt(e.target.value, 10))}
            className="bg-panel border border-border rounded-md px-3 py-2 text-sm"
          >
            {RANGES.map((r, i) => (
              <option key={i} value={i}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {err && <div className="text-bad text-sm">{err}</div>}
      {!data && !err && <div className="text-muted text-sm">loading…</div>}
      {data && (
        <Summary
          data={data}
          hidden={hidden}
          onToggle={toggleHidden}
          asPercent={asPercent}
          setAsPercent={setAsPercent}
        />
      )}
    </div>
  );
}

function Summary({ data, hidden, onToggle, asPercent, setAsPercent }) {
  const allTypes = useMemo(() => data.byType.map((t) => t.eventType), [data.byType]);
  const visibleTypes = useMemo(
    () => allTypes.filter((t) => !hidden.has(t)),
    [allTypes, hidden],
  );

  // Build the chart series: one row per bucket, one column per visible type.
  const series = useMemo(() => {
    const buckets = Array.from(new Set(data.byBucket.map((r) => r.bucket))).sort();
    const rows = buckets.map((bucket) => {
      const row = { bucket };
      for (const t of visibleTypes) row[t] = 0;
      return row;
    });
    const idx = Object.fromEntries(rows.map((r, i) => [r.bucket, i]));
    for (const r of data.byBucket) {
      if (idx[r.bucket] === undefined) continue;
      if (!visibleTypes.includes(r.eventType)) continue;
      rows[idx[r.bucket]][r.eventType] = r.count;
    }
    if (asPercent) {
      for (const row of rows) {
        const total = visibleTypes.reduce((a, t) => a + (row[t] || 0), 0);
        if (total > 0) {
          for (const t of visibleTypes) {
            row[t] = +((row[t] / total) * 100).toFixed(1);
          }
        }
      }
    }
    return rows;
  }, [data.byBucket, visibleTypes, asPercent]);

  // Card counts already aggregate across the whole window — no per-bucket math.
  const visibleByType = data.byType.filter((t) => visibleTypes.includes(t.eventType));

  return (
    <>
      {/* event-type chips: click to hide/show */}
      <div className="flex flex-wrap items-center gap-2">
        {allTypes.length === 0 && (
          <div className="text-muted text-sm">no events in this window</div>
        )}
        {allTypes.map((t) => {
          const isHidden = hidden.has(t);
          const count = data.byType.find((x) => x.eventType === t)?.count ?? 0;
          return (
            <button
              key={t}
              onClick={() => onToggle(t)}
              title={isHidden ? 'click to show' : 'click to hide'}
              className={`text-xs px-2 py-1 rounded border transition ${
                isHidden
                  ? 'bg-bg border-border text-muted line-through'
                  : 'bg-panel border-border text-ink'
              }`}
              style={isHidden ? undefined : { borderColor: COLOR_FOR(t) }}
            >
              <span
                className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                style={{ background: isHidden ? '#444' : COLOR_FOR(t) }}
              />
              {t} · {count.toLocaleString()}
            </button>
          );
        })}
        {allTypes.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <label className="text-xs text-muted">show as</label>
            <div className="flex border border-border rounded overflow-hidden text-xs">
              <button
                onClick={() => setAsPercent(false)}
                className={`px-2 py-1 ${!asPercent ? 'bg-accent text-bg' : 'bg-panel'}`}
              >
                count
              </button>
              <button
                onClick={() => setAsPercent(true)}
                className={`px-2 py-1 ${asPercent ? 'bg-accent text-bg' : 'bg-panel'}`}
              >
                %
              </button>
            </div>
          </div>
        )}
      </div>

      {/* counter cards (respect chip visibility) */}
      {visibleByType.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {visibleByType.slice(0, 8).map((t) => (
            <div key={t.eventType} className="bg-panel border border-border rounded-lg p-4">
              <div className="text-xs text-muted">{t.eventType}</div>
              <div
                className="text-2xl font-mono mt-1"
                style={{ color: COLOR_FOR(t.eventType) }}
              >
                {t.count.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* line chart */}
      <div className="bg-panel border border-border rounded-lg p-4">
        <div className="text-sm text-muted mb-2">
          Events per {data.bucket} {asPercent && '(% of bucket total)'}
        </div>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <LineChart data={series}>
              <CartesianGrid stroke="#262b38" strokeDasharray="3 3" />
              <XAxis
                dataKey="bucket"
                stroke="#8c93a6"
                fontSize={11}
                tickFormatter={(v) => formatBucketTick(v, data.bucket)}
                minTickGap={20}
              />
              <YAxis
                stroke="#8c93a6"
                fontSize={11}
                domain={asPercent ? [0, 100] : ['auto', 'auto']}
                tickFormatter={asPercent ? (v) => `${v}%` : undefined}
              />
              <Tooltip
                contentStyle={{ background: '#161922', border: '1px solid #262b38' }}
                labelStyle={{ color: '#e6e8ee' }}
                labelFormatter={(v) => formatBucketTooltip(v, data.bucket)}
                formatter={(value, name) => [asPercent ? `${value}%` : value, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {visibleTypes.map((t) => (
                <Line
                  key={t}
                  type="monotone"
                  dataKey={t}
                  stroke={COLOR_FOR(t)}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* top bounces */}
      <div className="bg-panel border border-border rounded-lg p-4">
        <div className="text-sm text-muted mb-3">
          Top hard-bounce reasons (this window)
        </div>
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

// Bucket strings are UTC ISO prefixes; format for the user's locale.
function formatBucketTick(value, bucket) {
  if (!value) return '';
  if (bucket === 'day') {
    const d = new Date(value + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (bucket === 'hour') {
    const d = new Date(value + ':00:00Z');
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  // minute, e.g. "2026-05-18T10:00"
  const d = new Date(value + ':00Z');
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatBucketTooltip(value, bucket) {
  if (!value) return '';
  if (bucket === 'day') {
    const d = new Date(value + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  if (bucket === 'hour') {
    const d = new Date(value + ':00:00Z');
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const d = new Date(value + ':00Z');
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
