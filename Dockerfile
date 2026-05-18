# --- frontend build ---
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# --- backend ---
FROM node:20-alpine AS app

# Prisma on Alpine needs OpenSSL; wget is used by HEALTHCHECK; sqlite is used
# by backup.sh to take consistent online snapshots of the database.
RUN apk add --no-cache openssl wget sqlite

WORKDIR /app

# Install runtime deps. Prisma CLI is needed at runtime because
# runMigrations() shells out to `npx prisma migrate deploy`.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Generate the Prisma client. The schema's binaryTargets includes
# linux-musl-openssl-3.0.x so the engine works on Alpine.
COPY prisma ./prisma
RUN npx prisma generate

# Backend source + built frontend
COPY src ./src
COPY --from=web /web/dist ./public

# Data volume for SQLite. Make node user own everything so we can drop root.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/server.js"]
