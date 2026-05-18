import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = '/app/data';
const DB_FILE = path.join(DATA_DIR, 'postal-logs.db');

// Set DATABASE_URL before importing prisma client init.
// In Docker the path is /app/data/postal-logs.db; locally fall back to ./data.
if (!process.env.DATABASE_URL) {
  const dir = fs.existsSync(DATA_DIR) ? DATA_DIR : path.resolve('./data');
  fs.mkdirSync(dir, { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(dir, 'postal-logs.db')}`;
}

export const prisma = new PrismaClient();

export async function ensureDb() {
  // Touch the file so Prisma is happy on first run
  const url = process.env.DATABASE_URL.replace(/^file:/, '');
  fs.mkdirSync(path.dirname(url), { recursive: true });
  if (!fs.existsSync(url)) fs.writeFileSync(url, '');
}

export async function runMigrations() {
  // Run prisma migrate deploy. In dev there might not be migrations yet, so
  // fall back to db push which creates the schema directly.
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  } catch (err) {
    console.warn('prisma migrate deploy failed, falling back to db push:', err.message);
    execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });
  }

  // Bootstrap admin
  const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase().trim();
  if (bootstrapEmail) {
    const existing = await prisma.user.findUnique({ where: { email: bootstrapEmail } });
    if (!existing) {
      await prisma.user.create({
        data: { email: bootstrapEmail, isStaff: true },
      });
      console.log(`bootstrap admin created: ${bootstrapEmail}`);
    } else if (!existing.isStaff) {
      await prisma.user.update({ where: { id: existing.id }, data: { isStaff: true } });
      console.log(`bootstrap admin promoted: ${bootstrapEmail}`);
    }
  }
}
