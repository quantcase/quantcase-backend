const { PrismaClient } = require('@prisma/client');

const base = process.env.DATABASE_URL;
const sep  = base?.includes('?') ? '&' : '?';
// connection_limit: max open connections per process (server + worker share PgBouncer's pool)
// idle_timeout: release a connection back to PgBouncer after 10s idle (prevents pool exhaustion)
const prisma = global._prisma ?? new PrismaClient({
  datasources: {
    db: {
      url: base + sep + 'connection_limit=50&pool_timeout=30&idle_timeout=10&pgbouncer=true'
    }
  }
});
if (process.env.NODE_ENV !== 'production') global._prisma = prisma;

module.exports = prisma;
