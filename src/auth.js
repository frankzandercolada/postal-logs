import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from './db.js';

const SESSION_COOKIE = 'pe_sid';
const SESSION_DAYS = 30;
const BCRYPT_COST = 12;
const MIN_PASSWORD_LEN = 12;

export async function registerAuth(app) {
  app.post('/auth/login', async (req, reply) => {
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
        sameSite: 'lax',
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
    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { id: sid } }).catch(() => {});
      return;
    }
    req.currentUser = session.user;
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
