'use strict';

require('dotenv').config();
const prisma = require('../config/prisma');

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS bse_discovered_urls (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      scrip_cd           INT         NOT NULL,
      company_name       TEXT        NOT NULL,
      scrape_date        DATE        NOT NULL,
      transcript_urls    TEXT[]      NOT NULL DEFAULT '{}',
      ppt_urls           TEXT[]      NOT NULL DEFAULT '{}',
      annual_report_urls TEXT[]      NOT NULL DEFAULT '{}',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bse_discovered_urls_scrip_date_unique UNIQUE (scrip_cd, scrape_date)
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS bse_du_scrip_idx ON bse_discovered_urls(scrip_cd)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS bse_du_date_idx ON bse_discovered_urls(scrape_date)
  `);

  console.log('bse_discovered_urls table ready.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
