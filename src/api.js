import { prisma } from './db.js';
import { requireAuth, requireStaff, accessibleClientIds } from './auth.js';
import { stringify } from 'csv-stringify';
import { nanoid } from 'nanoid';

export async function registerApi(app) {
  // --- health check (unauthenticated, used by Docker HEALTHCHECK) ---
  app.get('/api/health', async () => {
    // Light DB ping so the healthcheck fails if the DB is unreachable.
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, ts: new Date().toISOString() };
    } catch (err) {
      return { ok: false, error: 'db_unavailable' };
    }
  });

  // --- whoami ---
  app.get('/api/me', async (req, reply) => {
    if (!req.currentUser) return reply.code(401).send({ error: 'unauthenticated' });
    const memberships = await prisma.membership.findMany({
      where: { userId: req.currentUser.id },
      include: { client: true },
    });
    return {
      id: req.currentUser.id,
      email: req.currentUser.email,
      name: req.currentUser.name,
      isStaff: req.currentUser.isStaff,
      clients: req.currentUser.isStaff
        ? await prisma.client.findMany({
            where: { archivedAt: null },
            orderBy: { name: 'asc' },
          })
        : memberships.map((m) => ({ ...m.client, role: m.role })),
    };
  });

  // --- list clients I can see (subset, with mail servers) ---
  app.get('/api/clients', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const ids = await accessibleClientIds(u);
    return prisma.client.findMany({
      where: { id: { in: ids }, archivedAt: null },
      include: { mailServers: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
  });

  // --- events list with filters ---
  app.get('/api/events', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const where = await buildEventFilter(u, req.query);
    const take = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const cursor = req.query.cursor || null;

    const rows = await prisma.event.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        receivedAt: true,
        postalTimestamp: true,
        eventType: true,
        rcptTo: true,
        mailFrom: true,
        subject: true,
        status: true,
        bounceType: true,
        details: true,
        clientId: true,
        mailServerId: true,
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  });

  // --- single event detail (with raw JSON) ---
  app.get('/api/events/:id', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const ids = await accessibleClientIds(u);
    const ev = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!ev || !ids.includes(ev.clientId)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { ...ev, rawJson: safeJsonParse(ev.rawJson) };
  });

  // --- CSV export, streamed ---
  app.get('/api/events.csv', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const where = await buildEventFilter(u, req.query);

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="events-${new Date().toISOString().slice(0, 10)}.csv"`,
      );

    const stringifier = stringify({
      header: true,
      columns: [
        'received_at',
        'postal_timestamp',
        'event_type',
        'rcpt_to',
        'mail_from',
        'subject',
        'status',
        'bounce_type',
        'details',
        'mail_server',
        'client',
      ],
    });

    // Stream rows in batches so we never load the whole result set into memory.
    reply.send(stringifier);

    const PAGE = 1000;
    let cursor = null;
    const mailServers = await prisma.mailServer.findMany({
      select: { id: true, name: true, clientId: true },
    });
    const msMap = Object.fromEntries(mailServers.map((m) => [m.id, m.name]));
    const clients = await prisma.client.findMany({ select: { id: true, name: true } });
    const clMap = Object.fromEntries(clients.map((c) => [c.id, c.name]));

    while (true) {
      const batch = await prisma.event.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      for (const ev of batch) {
        stringifier.write([
          ev.receivedAt.toISOString(),
          ev.postalTimestamp ? ev.postalTimestamp.toISOString() : '',
          ev.eventType,
          ev.rcptTo || '',
          ev.mailFrom || '',
          ev.subject || '',
          ev.status || '',
          ev.bounceType || '',
          ev.details || '',
          msMap[ev.mailServerId] || '',
          clMap[ev.clientId] || '',
        ]);
      }
      cursor = batch[batch.length - 1].id;
      if (batch.length < PAGE) break;
    }
    stringifier.end();
  });

  // --- stats: dashboard summary ---
  app.get('/api/stats/summary', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const ids = await accessibleClientIds(u);
    const clientId = req.query.clientId;
    const targetIds = clientId ? [clientId].filter((id) => ids.includes(id)) : ids;
    if (targetIds.length === 0) return { byType: [], byDay: [], topBounces: [] };

    const days = parseInt(req.query.days || '30', 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sinceDateStr = isoDate(since);

    // Counts by event type from stats_daily (for long-range queries this stays fast)
    const byType = await prisma.statDaily.groupBy({
      by: ['eventType'],
      where: { clientId: { in: targetIds }, date: { gte: sinceDateStr } },
      _sum: { count: true },
      orderBy: { _sum: { count: 'desc' } },
    });

    const byDay = await prisma.statDaily.groupBy({
      by: ['date', 'eventType'],
      where: { clientId: { in: targetIds }, date: { gte: sinceDateStr } },
      _sum: { count: true },
      orderBy: { date: 'asc' },
    });

    // Top bounce reasons from recent raw events (within retention window)
    const recentSince = new Date(
      Math.max(since.getTime(), Date.now() - 90 * 24 * 60 * 60 * 1000),
    );
    const topBounces = await prisma.event.groupBy({
      by: ['details'],
      where: {
        clientId: { in: targetIds },
        bounceType: 'hard',
        receivedAt: { gte: recentSince },
        details: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { details: 'desc' } },
      take: 10,
    });

    return {
      byType: byType.map((r) => ({ eventType: r.eventType, count: r._sum.count || 0 })),
      byDay: byDay.map((r) => ({
        date: r.date,
        eventType: r.eventType,
        count: r._sum.count || 0,
      })),
      topBounces: topBounces.map((r) => ({
        reason: r.details,
        count: r._count._all,
      })),
    };
  });

  // --- suppression list ---
  app.get('/api/suppression', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const ids = await accessibleClientIds(u);
    const clientId = req.query.clientId;
    const where = {
      clientId: clientId ? { in: [clientId].filter((id) => ids.includes(id)) } : { in: ids },
    };
    if (req.query.q) where.rcptTo = { contains: req.query.q };
    const take = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    return prisma.suppression.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      take,
    });
  });

  app.get('/api/suppression.csv', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const ids = await accessibleClientIds(u);
    const clientId = req.query.clientId;
    const where = {
      clientId: clientId ? { in: [clientId].filter((id) => ids.includes(id)) } : { in: ids },
    };

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="suppression-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
    const stringifier = stringify({
      header: true,
      columns: ['rcpt_to', 'reason', 'first_seen_at', 'last_seen_at', 'event_count'],
    });
    reply.send(stringifier);

    const PAGE = 2000;
    let cursor = null;
    while (true) {
      const batch = await prisma.suppression.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!batch.length) break;
      for (const s of batch) {
        stringifier.write([
          s.rcptTo,
          s.reason || '',
          s.firstSeenAt.toISOString(),
          s.lastSeenAt.toISOString(),
          s.eventCount,
        ]);
      }
      cursor = batch[batch.length - 1].id;
      if (batch.length < PAGE) break;
    }
    stringifier.end();
  });

  // ====================================================================
  // Admin endpoints — staff only
  // ====================================================================

  app.get('/api/admin/clients', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    return prisma.client.findMany({
      include: { mailServers: true, _count: { select: { memberships: true } } },
      orderBy: { name: 'asc' },
    });
  });

  app.post('/api/admin/clients', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'name_required' });
    }
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '-' + nanoid(6);
    return prisma.client.create({ data: { name, slug } });
  });

  app.delete('/api/admin/clients/:id', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    await prisma.client.update({
      where: { id: req.params.id },
      data: { archivedAt: new Date() },
    });
    return { ok: true };
  });

  app.post('/api/admin/clients/:id/mail-servers', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { name, publicKeyPem, postalServerId } = req.body || {};
    if (!name || !publicKeyPem) {
      return reply.code(400).send({ error: 'name_and_public_key_required' });
    }
    const normalizedKey = normalizePublicKey(publicKeyPem);
    if (!normalizedKey) {
      return reply.code(400).send({ error: 'invalid_public_key' });
    }
    const ms = await prisma.mailServer.create({
      data: {
        clientId: req.params.id,
        name,
        publicKeyPem: normalizedKey,
        postalServerId: postalServerId ? parseInt(postalServerId, 10) : null,
        webhookToken: nanoid(32),
      },
    });
    return { ...ms, webhookUrl: webhookUrlFor(ms.webhookToken) };
  });

  app.delete('/api/admin/mail-servers/:id', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    await prisma.mailServer.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // Rotate the webhook token (in case of leak)
  app.post('/api/admin/mail-servers/:id/rotate', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ms = await prisma.mailServer.update({
      where: { id: req.params.id },
      data: { webhookToken: nanoid(32) },
    });
    return { ...ms, webhookUrl: webhookUrlFor(ms.webhookToken) };
  });

  // Connectivity / activity check for a mail server. Returns the webhook
  // URL, last event received (if any), and a recent count. Used by the
  // admin "test webhook" view: configure the URL in Postal, send a test
  // message, then reload this to verify events are arriving.
  app.get('/api/admin/mail-servers/:id/info', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ms = await prisma.mailServer.findUnique({ where: { id: req.params.id } });
    if (!ms) return reply.code(404).send({ error: 'not_found' });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [last, recentCount] = await Promise.all([
      prisma.event.findFirst({
        where: { mailServerId: ms.id },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, eventType: true, rcptTo: true },
      }),
      prisma.event.count({
        where: { mailServerId: ms.id, receivedAt: { gte: since } },
      }),
    ]);
    return {
      id: ms.id,
      name: ms.name,
      webhookUrl: webhookUrlFor(ms.webhookToken),
      lastEvent: last,
      recentCount24h: recentCount,
    };
  });

  // Users + memberships
  app.get('/api/admin/users', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    return prisma.user.findMany({
      include: { memberships: { include: { client: true } } },
      orderBy: { email: 'asc' },
    });
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { email, name, isStaff } = req.body || {};
    if (!email) return reply.code(400).send({ error: 'email_required' });
    return prisma.user.upsert({
      where: { email: email.toLowerCase().trim() },
      create: {
        email: email.toLowerCase().trim(),
        name: name || null,
        isStaff: !!isStaff,
      },
      update: {
        name: name || undefined,
        isStaff: typeof isStaff === 'boolean' ? isStaff : undefined,
      },
    });
  });

  app.post('/api/admin/memberships', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { userId, clientId, role } = req.body || {};
    if (!userId || !clientId || !role)
      return reply.code(400).send({ error: 'user_client_role_required' });
    return prisma.membership.upsert({
      where: { userId_clientId: { userId, clientId } },
      create: { userId, clientId, role },
      update: { role },
    });
  });

  app.delete('/api/admin/memberships/:userId/:clientId', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    await prisma.membership.delete({
      where: { userId_clientId: { userId: req.params.userId, clientId: req.params.clientId } },
    });
    return { ok: true };
  });
}

// --- helpers ------------------------------------------------------------

function webhookUrlFor(token) {
  const host = process.env.HOSTNAME || 'localhost:3000';
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${scheme}://${host}/webhook/${token}`;
}

async function buildEventFilter(user, q) {
  const ids = await accessibleClientIds(user);
  const where = { clientId: { in: ids } };
  if (q.clientId && ids.includes(q.clientId)) where.clientId = q.clientId;
  if (q.mailServerId) where.mailServerId = q.mailServerId;
  if (q.eventType) where.eventType = q.eventType;
  if (q.bounceType) where.bounceType = q.bounceType;
  if (q.rcptTo) where.rcptTo = { contains: q.rcptTo };
  if (q.from || q.to) {
    where.receivedAt = {};
    if (q.from) where.receivedAt.gte = new Date(q.from);
    if (q.to) where.receivedAt.lte = new Date(q.to);
  }
  // Respect SHOW_RAW_DAYS — don't show events older than this even if they're
  // still in the DB pre-retention sweep.
  const showDays = parseInt(process.env.SHOW_RAW_DAYS || '90', 10);
  const showSince = new Date(Date.now() - showDays * 24 * 60 * 60 * 1000);
  if (!where.receivedAt) where.receivedAt = {};
  if (!where.receivedAt.gte || where.receivedAt.gte < showSince) {
    where.receivedAt.gte = showSince;
  }
  return where;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function normalizePublicKey(input) {
  const s = (input || '').trim();
  if (!s) return null;
  // If they pasted a bare DKIM record value (just base64), wrap it in PEM headers.
  if (!s.includes('-----BEGIN')) {
    // Strip whitespace; 64 char lines
    const b64 = s.replace(/[^A-Za-z0-9+/=]/g, '');
    if (b64.length < 100) return null;
    const lines = b64.match(/.{1,64}/g).join('\n');
    return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
  }
  return s + (s.endsWith('\n') ? '' : '\n');
}
