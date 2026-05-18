import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ClientFilter } from './Dashboard.jsx';

const EVENT_TYPES = [
  '',
  'MessageSent',
  'MessageBounced',
  'MessageDeliveryFailed',
  'MessageDelayed',
  'MessageHeld',
  'MessageLoaded',
  'MessageLinkClicked',
];

export default function Events({ me }) {
  const [filters, setFilters] = useState({
    clientId: '',
    eventType: '',
    rcptTo: '',
    from: '',
    to: '',
  });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState(null);

  async function load(reset = true) {
    setLoading(true);
    try {
      const params = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v),
      );
      if (!reset && cursor) params.cursor = cursor;
      params.limit = 100;
      const data = await api.events(params);
      setRows(reset ? data.items : [...rows, ...data.items]);
      setCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.clientId, filters.eventType, filters.from, filters.to]);

  function submit(e) {
    e.preventDefault();
    load(true);
  }

  function csvUrl() {
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    return '/api/events.csv?' + new URLSearchParams(params).toString();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Events</h1>
          <p className="text-sm text-muted mt-1">
            Filter and export raw webhook events. History extends back to the
            retention window configured for this app.
          </p>
        </div>
        <a
          href={csvUrl()}
          className="px-3 py-2 rounded-md bg-accent text-bg text-sm font-medium hover:bg-sky-200 transition"
        >
          Export CSV
        </a>
      </div>

      <form
        onSubmit={submit}
        className="bg-panel border border-border rounded-lg p-4 grid grid-cols-2 md:grid-cols-6 gap-3"
      >
        <ClientFilter me={me} value={filters.clientId} onChange={(v) => setFilters({ ...filters, clientId: v })} />
        <select
          value={filters.eventType}
          onChange={(e) => setFilters({ ...filters, eventType: e.target.value })}
          className="bg-bg border border-border rounded-md px-3 py-2 text-sm"
        >
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t || 'All events'}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="recipient contains…"
          value={filters.rcptTo}
          onChange={(e) => setFilters({ ...filters, rcptTo: e.target.value })}
          className="bg-bg border border-border rounded-md px-3 py-2 text-sm md:col-span-2"
        />
        <input
          type="date"
          value={filters.from}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          className="bg-bg border border-border rounded-md px-3 py-2 text-sm"
        />
        <input
          type="date"
          value={filters.to}
          onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          className="bg-bg border border-border rounded-md px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="md:col-span-6 px-3 py-2 rounded-md bg-border hover:bg-border/70 text-sm"
        >
          Apply filters
        </button>
      </form>

      <div className="bg-panel border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg/50 text-xs text-muted">
              <tr>
                <th className="text-left font-normal px-3 py-2">Received</th>
                <th className="text-left font-normal px-3 py-2">Event</th>
                <th className="text-left font-normal px-3 py-2">Recipient</th>
                <th className="text-left font-normal px-3 py-2">Subject</th>
                <th className="text-left font-normal px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  className="border-t border-border hover:bg-bg/30 cursor-pointer"
                >
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                    {new Date(r.receivedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <EventBadge type={r.eventType} bounceType={r.bounceType} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.rcptTo || '—'}</td>
                  <td className="px-3 py-2 text-muted truncate max-w-xs">
                    {r.subject || '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.status || '—'}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted">
                    No events match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-3 py-2 flex items-center justify-between text-xs text-muted">
          <span>{rows.length} shown</span>
          {hasMore && (
            <button
              onClick={() => load(false)}
              disabled={loading}
              className="px-3 py-1 rounded bg-border hover:bg-border/70"
            >
              {loading ? 'loading…' : 'load more'}
            </button>
          )}
        </div>
      </div>

      {selected && <EventDetail id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function EventBadge({ type, bounceType }) {
  let cls = 'bg-border text-ink';
  if (type === 'MessageSent') cls = 'bg-good/15 text-good';
  else if (type === 'MessageBounced' || bounceType === 'hard') cls = 'bg-bad/15 text-bad';
  else if (type === 'MessageDeliveryFailed') cls = 'bg-bad/15 text-bad';
  else if (type === 'MessageDelayed') cls = 'bg-warn/15 text-warn';
  else if (type === 'MessageHeld') cls = 'bg-accent/15 text-accent';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono ${cls}`}>
      {type}
    </span>
  );
}

function EventDetail({ id, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.event(id).then(setData);
  }, [id]);
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-20 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-panel border border-border rounded-lg p-5 max-w-2xl w-full max-h-[80vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between mb-3">
          <div className="font-mono text-sm text-accent">Event detail</div>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>
        {!data ? (
          <div className="text-muted text-sm">loading…</div>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-2 text-xs mb-4">
              <Field label="Event" v={data.eventType} />
              <Field label="Received" v={new Date(data.receivedAt).toLocaleString()} />
              <Field label="Postal time" v={data.postalTimestamp && new Date(data.postalTimestamp).toLocaleString()} />
              <Field label="Recipient" v={data.rcptTo} />
              <Field label="From" v={data.mailFrom} />
              <Field label="Status" v={data.status} />
              <Field label="Bounce type" v={data.bounceType} />
              <Field label="Message token" v={data.messageToken} mono />
              <Field label="Postal UUID" v={data.postalUuid} mono />
            </dl>
            {data.subject && (
              <div className="mb-3">
                <div className="text-xs text-muted">Subject</div>
                <div className="text-sm">{data.subject}</div>
              </div>
            )}
            {data.details && (
              <div className="mb-3">
                <div className="text-xs text-muted">Details</div>
                <pre className="text-xs bg-bg border border-border rounded p-2 whitespace-pre-wrap break-all">
                  {data.details}
                </pre>
              </div>
            )}
            <div>
              <div className="text-xs text-muted mb-1">Raw payload</div>
              <pre className="text-xs bg-bg border border-border rounded p-2 overflow-x-auto">
                {JSON.stringify(data.rawJson, null, 2)}
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, v, mono }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={mono ? 'font-mono text-[11px] break-all' : ''}>{v || '—'}</div>
    </div>
  );
}
