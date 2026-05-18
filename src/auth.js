import fastifyOauth2 from '@fastify/oauth2';
import crypto from 'node:crypto';
import { prisma } from './db.js';

const SESSION_COOKIE = 'pe_sid';
const SESSION_DAYS = 30;

export async function registerAuth(app) {
  const hostname = process.env.HOSTNAME || 'localhost:3000';
  const callbackUri =
    hostname.startsWith('localhost') || hostname.startsWith('127.0.0.1')
      ? `http://${hostname}/auth/google/callback`
      : `https://${hostname}/auth/google/callback`;

  await app.register(fastifyOauth2, {
    name: 'googleOAuth2',
    scope: ['openid', 'email', 'profile'],
    credentials: {
      client: {
        id: process.env.GOOGLE_CLIENT_ID,
        secret: process.env.GOOGLE_CLIENT_SECRET,
      },
      auth: fastifyOauth2.GOOGLE_CONFIGURATION,
    },
    startRedirectPath: '/auth/google',
    callbackUri,
  });

  app.get('/auth/google/callback', async (req, reply) => {
    try {
      const tokenResult =
        await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req);
      const access = tokenResult.token?.access_token || tokenResult.access_token;

      // Get user info from Google
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${access}` },
      });
      if (!res.ok) throw new Error(`userinfo ${res.status}`);
      const info = await res.json();
      const email = (info.email || '').toLowerCase().trim();
      if (!email || info.email_verified === false) {
        return reply.code(403).send('Email not verified by Google.');
      }

      const allowed = (process.env.ALLOWED_DOMAIN || '').toLowerCase().trim();
      const emailDomain = email.split('@')[1];

      // Look up or create user. Pre-existing users (created by admin invite)
      // can log in regardless of domain restriction.
      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        if (allowed && emailDomain !== allowed) {
          return reply
            .code(403)
            .send(
              `Sign-in restricted to @${allowed}. Ask an admin to invite you.`,
            );
        }
        user = await prisma.user.create({
          data: {
            email,
            name: info.name || null,
            googleSub: info.sub,
            isStaff: false,
          },
        });
      } else {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            googleSub: user.googleSub || info.sub,
            name: user.name || info.name || null,
            lastLoginAt: new Date(),
          },
        });
      }

      const session = await createSession(user.id);
      reply
        .setCookie(SESSION_COOKIE, session.id, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge: SESSION_DAYS * 24 * 60 * 60,
        })
        .redirect('/');
    } catch (err) {
      req.log.error({ err }, 'oauth callback failed');
      return reply.code(500).send('Login failed. Check server logs.');
    }
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
