import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDb, runMigrations, prisma } from './db.js';
import { registerAuth } from './auth.js';
import { registerWebhook } from './webhook.js';
import { registerApi } from './api.js';
import { startRetentionLoop } from './retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function main() {
  await ensureDb();
  await runMigrations();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024, // 5MB, matches Caddy
  });

  await app.register(fastifyCookie, {
    secret: process.env.SESSION_SECRET,
    parseOptions: { sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' },
  });

  // Webhook is unauthenticated (signature-verified) and gets raw body access.
  // Register BEFORE auth so the auth hook doesn't try to gate it.
  await registerWebhook(app);

  await registerAuth(app);
  await registerApi(app);

  // Serve the built React app for everything else
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback: anything that's not an API/webhook/asset returns index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/webhook/') || req.url.startsWith('/auth/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });

  // Start retention loop after the server is up
  startRetentionLoop();

  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`postal-logs listening on :${port}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async () => {
  try {
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
