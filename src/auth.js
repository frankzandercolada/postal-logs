import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import fastifyRateLimit from '@fastify/rate-limit';
import { prisma } from './db.js';

const SESSION_COOKIE = 'pe_sid';
const SESSION_DAYS = 14;
const SESSION_IDLE_DAYS = parseInt(process.env.SESSION_IDLE_DAYS || '7', 10);
const BCRYPT_COST = 12;
const MIN_PASSWORD_LEN = 12;

export async function registerAuth(app) {
  // Per-route rate limiting; not registered as global because the rest of the
  // API has its own auth gating and rate-limiting JSON GETs adds noise.
  await app.register(fastifyRateLimit, { global: false });

  app.post('/auth/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        // Key on IP only — adding the email gives attackers a clean way to
        // know they've been throttled, and we don't want to leak which emails
        // exist via differential response. IP throttling is the right knob.
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body || {};
    const e = (email || '').toLowerCase().trim();
    const p = typeof password === 'string' ? password : '';
    if (!e || !p) {
      return reply.code(400).send({ error: 'email_and_password_required' });
    }

    const user = await prisma.user.findUnique({ where: { email: e } });
    // Always run bcrypt to avoid leaking which emails exist via timing.
    const hash = user?.passwordHash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid';
    const ok = await bcrypt.compare(p, hash);
    if (!user || !user.passwordHash || !ok) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    const session = await createSession(user.id);
    return reply
      .setCookie(SESSION_COOKIE, session.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: SESSION_DAYS * 24 * 60 * 60,
      })
      .send({ ok: true });
  });

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) {
      await prisma.session.deleteMany({ where: { id: sid } }).catch(() => {});
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  // Decorate request with .currentUser, populated for any request that has
  // a valid session cookie. API routes that require auth check for it.
  app.decorateRequest('currentUser', null);
  app.addHook('onRequest', async (req) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) return;
    const session = await prisma.session.findUnique({
      where: { id: sid },
      include: { user: true },
    });
    if (!session) return;
    const now = new Date();
    if (session.expiresAt < now) {
      await prisma.session.delete({ where: { id: sid } }).catch(() => {});
      return;
    }
    const idleMs = SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
    if (now - session.lastActiveAt > idleMs) {
      await prisma.session.delete({ where: { id: sid } }).catch(() => {});
      return;
    }
    req.currentUser = session.user;
    // Throttle lastActiveAt writes to once per minute per session.
    if (now - session.lastActiveAt > 60 * 1000) {
      prisma.session
        .update({ where: { id: sid }, data: { lastActiveAt: now } })
        .catch(() => {});
    }
  });
}

async function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return prisma.session.create({ data: { id, userId, expiresAt } });
}

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LEN) {
    const err = new Error('password_too_short');
    err.statusCode = 400;
    err.minLength = MIN_PASSWORD_LEN;
    throw err;
  }
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain || '', hash);
}

export { MIN_PASSWORD_LEN };

/** Helper for API routes — throws 401 if not signed in. */
export function requireAuth(req, reply) {
  if (!req.currentUser) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return req.currentUser;
}

export function requireStaff(req, reply) {
  const u = requireAuth(req, reply);
  if (!u) return null;
  if (!u.isStaff) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return u;
}

/**
 * Returns the set of client IDs the user can see. Staff can see everything.
 * Non-staff users only see clients they have a membership for.
 */
export async function accessibleClientIds(user) {
  if (user.isStaff) {
    const clients = await prisma.client.findMany({
      where: { archivedAt: null },
      select: { id: true },
    });
    return clients.map((c) => c.id);
  }
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    select: { clientId: true },
  });
  return memberships.map((m) => m.clientId);
}
