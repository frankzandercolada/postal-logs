import { prisma } from './db.js';
import {
  requireAuth,
  requireStaff,
  accessibleScope,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LEN,
} from './auth.js';
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
    const scope = await accessibleScope(u);
    return prisma.client.findMany({
      where: { id: { in: scope.clientIds }, archivedAt: null },
      include: {
        mailServers: {
          where: scope.isStaff ? {} : { id: { in: scope.mailServerIds } },
          select: { id: true, name: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  });

  // --- events list with filters ---
  // groupRetries=1 (default) collapses MessageDelayed events with the same
  // messageToken into a single row carrying retryCount and firstRetryAt.
  // Pass groupRetries=0 to see every individual retry.
  app.get('/api/events', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const where = await buildEventFilter(u, req.query);
    const take = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const cursor = req.query.cursor || null;
    const groupRetries = req.query.groupRetries !== '0';

    const select = {
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
      messageToken: true,
      clientId: true,
      mailServerId: true,
    };

    if (!groupRetries) {
      // Original behavior: cursor-paginated, returns every row.
      const rows = await prisma.event.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select,
      });
      const hasMore = rows.length > take;
      const items = hasMore ? rows.slice(0, take) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }

    // Grouped mode: overfetch then dedup MessageDelayed by messageToken in JS.
    // Pagination uses receivedAt as the cursor so we can keep merging old
    // delayed retries into the same group across pages.
    const since = cursor ? new Date(cursor) : null;
    const FETCH = Math.min(take * 5, 1000);
    const whereGrouped = since
      ? { ...where, receivedAt: { ...(where.receivedAt || {}), lt: since } }
      : where;
    const raw = await prisma.event.findMany({
      where: whereGrouped,
      orderBy: { receivedAt: 'desc' },
      take: FETCH,
      select,
    });

    // Group MessageDelayed events with a non-null messageToken; everything else
    // passes through as-is.
    const seen = new Map(); // messageToken -> head event index in `out`
    const out = [];
    for (const ev of raw) {
      if (ev.eventType === 'MessageDelayed' && ev.messageToken) {
        const idx = seen.get(ev.messageToken);
        if (idx === undefined) {
          seen.set(ev.messageToken, out.length);
          out.push({ ...ev, retryCount: 1, firstRetryAt: ev.receivedAt });
        } else {
          const head = out[idx];
          head.retryCount += 1;
          // raw is desc by receivedAt, so any later event has earlier time.
          head.firstRetryAt = ev.receivedAt;
        }
      } else {
        out.push(ev);
      }
    }
    const hasMore = raw.length === FETCH;
    const sliced = out.slice(0, take);
    const last = sliced[sliced.length - 1];
    return {
      items: sliced,
      // Cursor is the receivedAt of the last returned row. Next page asks for
      // events strictly older than this timestamp.
      nextCursor: hasMore && last ? new Date(last.receivedAt).toISOString() : null,
      grouped: true,
    };
  });

  // --- single event detail (with raw JSON) ---
  app.get('/api/events/:id', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const scope = await accessibleScope(u);
    const ev = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!ev || (!scope.isStaff && !scope.mailServerIds.includes(ev.mailServerId))) {
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
  // Accepts:
  //   minutes (int)    — lookback window in minutes (default 30 days)
  //   bucket  (string) — 'minute' | 'hour' | 'day' (default inferred from minutes)
  //   clientId         — restrict to a single accessible client
  app.get('/api/stats/summary', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const scope = await accessibleScope(u);
    const clientId = req.query.clientId;
    const mailServerId = req.query.mailServerId;
    const targetClientIds = clientId
      ? [clientId].filter((id) => scope.clientIds.includes(id))
      : scope.clientIds;
    if (targetClientIds.length === 0 || scope.mailServerIds.length === 0) {
      return { byType: [], byBucket: [], topBounces: [], bucket: 'day' };
    }
    // Validate explicit mailServerId is within scope.
    if (
      mailServerId &&
      !scope.isStaff &&
      !scope.mailServerIds.includes(mailServerId)
    ) {
      return { byType: [], byBucket: [], topBounces: [], bucket: 'day' };
    }
    // Mail servers within the targeted clients AND within the user's scope.
    const targetMs = await prisma.mailServer.findMany({
      where: {
        clientId: { in: targetClientIds },
        ...(mailServerId
          ? { id: mailServerId }
          : scope.isStaff
          ? {}
          : { id: { in: scope.mailServerIds } }),
      },
      select: { id: true },
    });
    const mailServerIds = targetMs.map((m) => m.id);
    if (mailServerIds.length === 0) {
      return { byType: [], byBucket: [], topBounces: [], bucket: 'day' };
    }

    // Cap the live window at the raw-event retention so we never look further
    // back than what's actually in the Event table.
    const retainMinutes =
      parseInt(process.env.RETAIN_RAW_DAYS || '120', 10) * 24 * 60;
    let minutes = parseInt(req.query.minutes || `${30 * 24 * 60}`, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) minutes = 30 * 24 * 60;
    minutes = Math.min(minutes, retainMinutes);

    const requestedBucket = req.query.bucket;
    const bucket =
      requestedBucket === 'minute' || requestedBucket === 'hour' || requestedBucket === 'day'
        ? requestedBucket
        : minutes <= 60
        ? 'minute'
        : minutes <= 24 * 60
        ? 'hour'
        : 'day';

    const since = new Date(Date.now() - minutes * 60 * 1000);
    const groupRetries = req.query.groupRetries !== '0';

    // Pull raw events once and aggregate in JS. Going through Date objects
    // sidesteps SQLite's date-format ambiguity (Prisma 5 stores DateTime as
    // numeric ms), and lets us dedup MessageDelayed by messageToken cleanly.
    // Operational noise types (DomainDNSError by default) are excluded from
    // dashboard counts unconditionally — they're not message events.
    const hidden = hiddenEventTypes();
    const rawEvents = await prisma.event.findMany({
      where: {
        mailServerId: { in: mailServerIds },
        receivedAt: { gte: since },
        ...(hidden.length > 0 ? { eventType: { notIn: hidden } } : {}),
      },
      select: { receivedAt: true, eventType: true, messageToken: true },
    });

    // When groupRetries is on, collapse MessageDelayed events with the same
    // messageToken to the FIRST occurrence in the window. That gives "how
    // many messages got delayed" rather than "how many retry attempts".
    let processed = rawEvents;
    if (groupRetries) {
      // Sort ascending so we keep the earliest event per token.
      const sorted = [...rawEvents].sort((a, b) => a.receivedAt - b.receivedAt);
      const seenTokens = new Set();
      processed = [];
      for (const ev of sorted) {
        if (ev.eventType === 'MessageDelayed' && ev.messageToken) {
          if (seenTokens.has(ev.messageToken)) continue;
          seenTokens.add(ev.messageToken);
        }
        processed.push(ev);
      }
    }

    // byType from the deduped set.
    const byTypeCounts = new Map();
    for (const ev of processed) {
      byTypeCounts.set(ev.eventType, (byTypeCounts.get(ev.eventType) || 0) + 1);
    }
    const byTypeRaw = Array.from(byTypeCounts, ([eventType, count]) => ({
      eventType,
      _count: { _all: count },
    })).sort((a, b) => b._count._all - a._count._all);
    const bucketKey = (d) => {
      const iso = d.toISOString();
      if (bucket === 'minute') return iso.slice(0, 16); // YYYY-MM-DDTHH:MM
      if (bucket === 'hour') return iso.slice(0, 13);   // YYYY-MM-DDTHH
      return iso.slice(0, 10);                          // YYYY-MM-DD
    };
    const buckets = new Map();
    for (const ev of processed) {
      const k = bucketKey(ev.receivedAt);
      let inner = buckets.get(k);
      if (!inner) {
        inner = new Map();
        buckets.set(k, inner);
      }
      inner.set(ev.eventType, (inner.get(ev.eventType) || 0) + 1);
    }
    const byBucketRows = [];
    for (const [k, inner] of buckets) {
      for (const [eventType, count] of inner) {
        byBucketRows.push({ bucket: k, eventType, count });
      }
    }
    byBucketRows.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

    // Top bounce reasons within the same window.
    const topBounces = await prisma.event.groupBy({
      by: ['details'],
      where: {
        mailServerId: { in: mailServerIds },
        bounceType: 'hard',
        receivedAt: { gte: since },
        details: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { details: 'desc' } },
      take: 10,
    });

    return {
      bucket,
      byType: byTypeRaw.map((r) => ({ eventType: r.eventType, count: r._count._all })),
      byBucket: byBucketRows,
      topBounces: topBounces.map((r) => ({
        reason: r.details,
        count: r._count._all,
      })),
    };
  });

  // --- suppression list ---
  // Suppression is per-client (dedup across mail servers); mail-server scope
  // doesn't apply here. A user with any access to a client sees its list.
  app.get('/api/suppression', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const { clientIds } = await accessibleScope(u);
    const clientId = req.query.clientId;
    const where = {
      clientId: clientId
        ? { in: [clientId].filter((id) => clientIds.includes(id)) }
        : { in: clientIds },
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
    const { clientIds } = await accessibleScope(u);
    const clientId = req.query.clientId;
    const where = {
      clientId: clientId
        ? { in: [clientId].filter((id) => clientIds.includes(id)) }
        : { in: clientIds },
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
    const { name, publicKeyPem } = req.body || {};
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'name_required' });
    }
    let normalizedKey;
    if (publicKeyPem) {
      normalizedKey = normalizePublicKey(publicKeyPem);
      if (!normalizedKey) return reply.code(400).send({ error: 'invalid_public_key' });
    }
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '-' + nanoid(6);
    return prisma.client.create({ data: { name, slug, publicKeyPem: normalizedKey } });
  });

  // Edit the client's default Postal signing key. New mail servers under this
  // client can omit publicKeyPem and inherit it.
  app.patch('/api/admin/clients/:id', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { name, publicKeyPem } = req.body || {};
    const data = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (publicKeyPem !== undefined) {
      if (publicKeyPem === null || publicKeyPem === '') {
        data.publicKeyPem = null;
      } else {
        const normalizedKey = normalizePublicKey(publicKeyPem);
        if (!normalizedKey) return reply.code(400).send({ error: 'invalid_public_key' });
        data.publicKeyPem = normalizedKey;
      }
    }
    return prisma.client.update({ where: { id: req.params.id }, data });
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
    if (!name) return reply.code(400).send({ error: 'name_required' });

    // If a key is given, normalize and use it as an override. Otherwise the
    // mail server inherits the client's publicKeyPem. Reject if neither
    // exists so the mail server isn't created in a broken state.
    let normalizedKey = null;
    if (publicKeyPem) {
      normalizedKey = normalizePublicKey(publicKeyPem);
      if (!normalizedKey) return reply.code(400).send({ error: 'invalid_public_key' });
    } else {
      const client = await prisma.client.findUnique({
        where: { id: req.params.id },
        select: { publicKeyPem: true },
      });
      if (!client?.publicKeyPem) {
        return reply.code(400).send({ error: 'client_has_no_public_key' });
      }
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
      include: {
        memberships: {
          include: {
            client: { include: { mailServers: { select: { id: true, name: true } } } },
            mailServerScopes: { select: { mailServerId: true } },
          },
        },
      },
      orderBy: { email: 'asc' },
    });
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { email, name, isStaff, password } = req.body || {};
    if (!email) return reply.code(400).send({ error: 'email_required' });
    const normalized = email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email: normalized } });

    let passwordHash;
    if (password) {
      try {
        passwordHash = await hashPassword(password);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err.message, minLength: err.minLength || MIN_PASSWORD_LEN });
      }
    } else if (!existing) {
      // New user with no password = can't ever sign in. Require one.
      return reply
        .code(400)
        .send({ error: 'password_required', minLength: MIN_PASSWORD_LEN });
    }

    return prisma.user.upsert({
      where: { email: normalized },
      create: {
        email: normalized,
        name: name || null,
        isStaff: !!isStaff,
        passwordHash,
      },
      update: {
        name: name || undefined,
        isStaff: typeof isStaff === 'boolean' ? isStaff : undefined,
        passwordHash: passwordHash || undefined,
      },
    });
  });

  // Admin resets a user's password to a value of their choice.
  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { password } = req.body || {};
    let passwordHash;
    try {
      passwordHash = await hashPassword(password);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err.message, minLength: err.minLength || MIN_PASSWORD_LEN });
    }
    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash },
    });
    // Invalidate all of that user's existing sessions so they re-login.
    await prisma.session.deleteMany({ where: { userId: req.params.id } });
    return { ok: true };
  });

  // Current user changes their own password.
  app.post('/api/me/password', async (req, reply) => {
    const u = requireAuth(req, reply);
    if (!u) return;
    const { currentPassword, newPassword } = req.body || {};
    const current = await prisma.user.findUnique({ where: { id: u.id } });
    if (!(await verifyPassword(currentPassword, current.passwordHash))) {
      return reply.code(401).send({ error: 'invalid_current_password' });
    }
    let passwordHash;
    try {
      passwordHash = await hashPassword(newPassword);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err.message, minLength: err.minLength || MIN_PASSWORD_LEN });
    }
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash } });
    // Keep current session valid; other sessions get cleared.
    const sid = req.cookies?.pe_sid;
    await prisma.session.deleteMany({
      where: { userId: u.id, ...(sid ? { NOT: { id: sid } } : {}) },
    });
    return { ok: true };
  });

  app.post('/api/admin/memberships', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const { userId, clientId, role, mailServerIds } = req.body || {};
    if (!userId || !clientId || !role)
      return reply.code(400).send({ error: 'user_client_role_required' });

    // If mailServerIds is provided (any array, including empty), it replaces
    // the existing scope. An empty array means "all" — same as no scope rows.
    // If mailServerIds is omitted entirely, existing scope rows are left
    // alone (just update the role).
    const wantsScopeUpdate = Array.isArray(mailServerIds);
    let validated = [];
    if (wantsScopeUpdate && mailServerIds.length > 0) {
      const found = await prisma.mailServer.findMany({
        where: { id: { in: mailServerIds }, clientId },
        select: { id: true },
      });
      if (found.length !== mailServerIds.length) {
        return reply.code(400).send({ error: 'mail_server_not_in_client' });
      }
      validated = found.map((m) => m.id);
    }

    return prisma.$transaction(async (tx) => {
      const membership = await tx.membership.upsert({
        where: { userId_clientId: { userId, clientId } },
        create: { userId, clientId, role },
        update: { role },
      });
      if (wantsScopeUpdate) {
        await tx.membershipMailServer.deleteMany({ where: { userId, clientId } });
        if (validated.length > 0) {
          await tx.membershipMailServer.createMany({
            data: validated.map((mailServerId) => ({ userId, clientId, mailServerId })),
          });
        }
      }
      return membership;
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

function hiddenEventTypes() {
  // Comma-separated env var; default to DomainDNSError which is operational
  // noise unrelated to message delivery.
  const raw = process.env.HIDDEN_EVENT_TYPES ?? 'DomainDNSError';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function webhookUrlFor(token) {
  const host = process.env.HOSTNAME || 'localhost:3000';
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${scheme}://${host}/webhook/${token}`;
}

async function buildEventFilter(user, q) {
  const scope = await accessibleScope(user);
  const where = { mailServerId: { in: scope.mailServerIds } };
  if (q.clientId && scope.clientIds.includes(q.clientId)) where.clientId = q.clientId;
  if (q.mailServerId && scope.mailServerIds.includes(q.mailServerId)) {
    where.mailServerId = q.mailServerId;
  }
  if (q.eventType) {
    where.eventType = q.eventType;
  } else {
    // Hide noise event types from the default view (still queryable by
    // explicitly selecting them in the event-type dropdown).
    const hidden = hiddenEventTypes();
    if (hidden.length > 0) where.eventType = { notIn: hidden };
  }
  if (q.bounceType) where.bounceType = q.bounceType;
  if (q.subject) where.subject = { contains: q.subject };
  if (q.mailFrom) where.mailFrom = { contains: q.mailFrom };
  if (q.messageToken) where.messageToken = q.messageToken;
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
