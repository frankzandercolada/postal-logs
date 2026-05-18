import { prisma } from './db.js';

/**
 * Runs forever, sleeping until next 03:00 UTC. On each tick:
 *  1. Aggregate yesterday's raw events into stats_daily.
 *  2. Sweep raw events older than RETAIN_RAW_DAYS.
 *  3. Clear expired sessions.
 */
export function startRetentionLoop() {
  scheduleNext();
}

function scheduleNext() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  console.log(`[retention] next run at ${next.toISOString()} (in ${Math.round(delay / 60000)}m)`);
  setTimeout(async () => {
    try {
      await runRetention();
    } catch (err) {
      console.error('[retention] error:', err);
    } finally {
      scheduleNext();
    }
  }, delay);
}

export async function runRetention() {
  console.log('[retention] starting');
  await aggregateYesterday();
  await sweepOldEvents();
  await clearExpiredSessions();
  console.log('[retention] done');
}

async function aggregateYesterday() {
  // Aggregate any day we haven't aggregated yet, looking back up to 7 days
  // (to recover from missed runs).
  for (let i = 1; i <= 7; i++) {
    const day = daysAgo(i);
    const dayStr = isoDate(day);
    const dayStart = new Date(dayStr + 'T00:00:00Z');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    // If we already have entries for this date, skip (already aggregated)
    const existing = await prisma.statDaily.findFirst({ where: { date: dayStr } });
    if (existing) continue;

    // group raw events by (clientId, mailServerId, eventType)
    const grouped = await prisma.event.groupBy({
      by: ['clientId', 'mailServerId', 'eventType'],
      where: { receivedAt: { gte: dayStart, lt: dayEnd } },
      _count: { _all: true },
    });
    if (!grouped.length) {
      // Insert a marker so we don't re-scan tomorrow. Use a synthetic event
      // type that won't collide with real ones.
      // Actually simpler: just skip — looking back 7 days bounds the cost.
      continue;
    }
    for (const g of grouped) {
      await prisma.statDaily.upsert({
        where: {
          date_clientId_mailServerId_eventType: {
            date: dayStr,
            clientId: g.clientId,
            mailServerId: g.mailServerId,
            eventType: g.eventType,
          },
        },
        create: {
          date: dayStr,
          clientId: g.clientId,
          mailServerId: g.mailServerId,
          eventType: g.eventType,
          count: g._count._all,
        },
        update: { count: g._count._all },
      });
    }
    console.log(`[retention] aggregated ${dayStr}: ${grouped.length} buckets`);
  }
}

async function sweepOldEvents() {
  const retainDays = parseInt(process.env.RETAIN_RAW_DAYS || '120', 10);
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
  const result = await prisma.event.deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });
  if (result.count) console.log(`[retention] deleted ${result.count} events older than ${cutoff.toISOString()}`);

  // VACUUM SQLite to reclaim disk space (only worth doing if we deleted a lot)
  if (result.count > 10000) {
    try {
      await prisma.$executeRawUnsafe('VACUUM');
      console.log('[retention] VACUUM complete');
    } catch (err) {
      console.warn('[retention] VACUUM failed:', err.message);
    }
  }
}

async function clearExpiredSessions() {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (result.count) console.log(`[retention] cleared ${result.count} expired sessions`);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
