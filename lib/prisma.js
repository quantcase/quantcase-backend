const { PrismaClient } = require('@prisma/client');

const prisma = global._prisma ?? new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL + (process.env.DATABASE_URL?.includes('?') ? '&' : '?') + 'connection_limit=200'
    }
  }
});
if (process.env.NODE_ENV !== 'production') global._prisma = prisma;

module.exports = prisma;
