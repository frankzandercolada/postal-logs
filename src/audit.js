import { prisma } from './db.js';

/**
 * Append a row to AuditLog. Never throws — audit logging must not break the
 * main request path.
 *
 * @param {object} req - Fastify request (uses req.currentUser, req.ip)
 * @param {string} action - dotted action name, e.g. "user.create"
 * @param {object} [opts]
 * @param {string} [opts.targetType]
 * @param {string} [opts.targetId]
 * @param {object} [opts.meta]   - serialized to JSON
 * @param {string} [opts.actorEmail] - override (e.g. failed login: known email but no session)
 */
export async function logAudit(req, action, opts = {}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId: req.currentUser?.id ?? null,
        actorEmail: opts.actorEmail ?? req.currentUser?.email ?? null,
        action,
        targetType: opts.targetType ?? null,
        targetId: opts.targetId ?? null,
        meta: opts.meta ? JSON.stringify(opts.meta) : null,
        ip: req.ip ?? null,
      },
    });
  } catch (err) {
    req.log?.warn({ err: err.message, action }, 'audit log write failed');
  }
}
