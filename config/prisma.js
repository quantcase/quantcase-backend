const { PrismaClient } = require('@prisma/client');

// Pool sizing belongs in DATABASE_URL. Appending connection_limit here instead
// would silently override the URL's value (last duplicate key wins) — and the
// server and worker each open their own pool against a shared pooler.
const prisma = global._prisma ?? new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL }
  }
});
if (process.env.NODE_ENV !== 'production') global._prisma = prisma;

module.exports = prisma;
