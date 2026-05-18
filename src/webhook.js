import crypto from 'node:crypto';
import { prisma } from './db.js';

/**
 * Postal signs webhook payloads with the same RSA key it uses for DKIM.
 * Signature is in X-Postal-Signature, base64-encoded, RSA over SHA1 of the
 * raw request body (PKCS#1 v1.5 padding).
 *
 * We expose one webhook URL per mail server:
 *    POST /webhook/:token
 * The token is a long random string we generate when the mail server is
 * created, stored on MailServer.webhookToken (unique).
 */
export async function registerWebhook(app) {
  // We need the raw body bytes for signature verification. Replace Fastify's
  // default JSON parser for this route with a passthrough that stashes the
  // raw text on req.rawBody.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      req.rawBody = body;
      try {
        done(null, body ? JSON.parse(body) : {});
      } catch (err) {
        err.statusCode = 400;
        done(err);
      }
    },
  );

  app.post('/webhook/:token', async (req, reply) => {
    const token = req.params.token;
    const mailServer = await prisma.mailServer.findUnique({
      where: { webhookToken: token },
      include: { client: true },
    });
    if (!mailServer) {
      return reply.code(404).send({ error: 'unknown_webhook' });
    }

    const signatureHeader =
      req.headers['x-postal-signature'] || req.headers['x-postal-signature-256'];
    if (!signatureHeader) {
      return reply.code(401).send({ error: 'missing_signature' });
    }

    const rawBody = req.rawBody || '';
    const publicKeyPem = mailServer.publicKeyPem || mailServer.client.publicKeyPem;
    if (!publicKeyPem) {
      req.log.error(
        { mailServerId: mailServer.id, clientId: mailServer.clientId },
        'no public key set on mail server or its client',
      );
      return reply.code(503).send({ error: 'public_key_missing' });
    }
    const verifyResult = verifyPostalSignature(rawBody, signatureHeader, publicKeyPem);
    if (!verifyResult.ok) {
      req.log.warn(
        { mailServerId: mailServer.id, name: mailServer.name },
        'webhook signature mismatch',
      );
      return reply.code(401).send({ error: 'bad_signature' });
    }
    req.log.info(
      { mailServerId: mailServer.id, name: mailServer.name, alg: verifyResult.alg },
      'webhook verified',
    );

    const payload = req.body || {};

    // Test mode: caller can pass ?test=1 to verify the signature + parsing
    // without persisting. Useful for the admin "send test webhook" flow.
    if (req.query.test === '1') {
      return reply.code(200).send({ ok: true, test: true, alg: verifyResult.alg });
    }

    try {
      await ingestEvent(mailServer, payload, req.headers);
    } catch (err) {
      req.log.error({ err }, 'failed to ingest webhook event');
      return reply.code(500).send({ error: 'ingest_failed' });
    }

    return reply.code(200).send({ ok: true });
  });
}

function verifyPostalSignature(rawBody, signatureB64, publicKeyPem) {
  // Postal historically uses RSA-SHA1, like DKIM. Newer Postal versions also
  // send X-Postal-Signature-256 with RSA-SHA256. Try both and report which
  // worked so the caller can log it.
  try {
    const sig = Buffer.from(signatureB64, 'base64');

    const verifier256 = crypto.createVerify('RSA-SHA256');
    verifier256.update(rawBody);
    verifier256.end();
    if (verifier256.verify(publicKeyPem, sig)) return { ok: true, alg: 'RSA-SHA256' };

    const verifier1 = crypto.createVerify('RSA-SHA1');
    verifier1.update(rawBody);
    verifier1.end();
    if (verifier1.verify(publicKeyPem, sig)) return { ok: true, alg: 'RSA-SHA1' };

    return { ok: false };
  } catch (err) {
    return { ok: false, err };
  }
}

/**
 * Extract the interesting fields from a Postal webhook payload and insert
 * into the events table. Idempotent on Postal's per-delivery UUID when
 * present.
 *
 * Postal's payload shape varies a bit by event type. Common envelope:
 *   { event: "MessageBounced", timestamp: 1715..., uuid: "...",
 *     payload: { ...event-specific... } }
 * Some installations send the event-specific fields directly at the top
 * level (no "payload" wrapper). We handle both.
 */
async function ingestEvent(mailServer, body, headers) {
  const eventType =
    body.event ||
    headers['x-postal-event'] ||
    'Unknown';
  const postalUuid = body.uuid || headers['x-postal-uuid'] || null;
  const postalTs = body.timestamp ? new Date(body.timestamp * 1000) : null;

  const payload = body.payload || body;

  // Try to extract a "main message" object regardless of event type
  const main =
    payload.message ||
    payload.original_message ||
    payload.bounce ||
    {};

  const messageToken = main.token || null;
  const messageId = typeof main.id === 'number' ? main.id : null;
  const rcptTo = main.to || payload.to || null;
  const mailFrom = main.from || payload.from || null;
  const subject = main.subject || null;

  // Status / bounce reason are event-specific
  let status = main.status || payload.status || null;
  let details = payload.details || payload.output || main.details || null;
  let bounceType = null;

  if (eventType === 'MessageBounced') {
    bounceType = 'hard';
    status = status || 'Bounced';
  } else if (eventType === 'MessageDeliveryFailed') {
    bounceType = payload.bounce ? 'hard' : 'soft';
    status = status || 'Failed';
  } else if (eventType === 'MessageDelayed') {
    bounceType = 'soft';
    status = status || 'Delayed';
  } else if (eventType === 'MessageSent') {
    status = status || 'Sent';
  } else if (eventType === 'MessageHeld') {
    status = status || 'Held';
  }

  // Idempotency: if we already have this UUID, skip.
  if (postalUuid) {
    const existing = await prisma.event.findUnique({ where: { postalUuid } });
    if (existing) return;
  }

  await prisma.event.create({
    data: {
      mailServerId: mailServer.id,
      clientId: mailServer.clientId,
      eventType,
      postalTimestamp: postalTs,
      postalUuid,
      messageToken,
      messageId,
      rcptTo,
      mailFrom,
      subject,
      status,
      bounceType,
      details: typeof details === 'string' ? details.slice(0, 4000) : null,
      rawJson: JSON.stringify(body),
    },
  });

  // Update suppression list synchronously for hard bounces. (Soft bounces
  // are handled by the daily aggregator with a threshold.)
  if (bounceType === 'hard' && rcptTo) {
    await prisma.suppression.upsert({
      where: { clientId_rcptTo: { clientId: mailServer.clientId, rcptTo } },
      create: {
        clientId: mailServer.clientId,
        rcptTo,
        reason: details ? String(details).slice(0, 500) : eventType,
        eventCount: 1,
      },
      update: {
        lastSeenAt: new Date(),
        eventCount: { increment: 1 },
        reason: details ? String(details).slice(0, 500) : undefined,
      },
    });
  }
}
