'use strict';

require('dotenv').config();
const prisma = require('../config/prisma');
const schemes = require('./mf_schemes_raw.json');

async function main() {
  console.log(`Seeding ${schemes.length} mutual fund schemes...`);

  const BATCH_SIZE = 20;
  let upserted = 0;

  for (let i = 0; i < schemes.length; i += BATCH_SIZE) {
    const batch = schemes.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(s =>
        prisma.mutualFundScheme.upsert({
          where: { amfi_code: String(s.amfi_code) },
          update: {
            name:           s.name,
            isin:           s.isin           ?? null,
            plan_type:      s.plan_type      ?? null,
            option_type:    s.option_type    ?? null,
            nav:            s.nav            ?? null,
            nav_date:       s.nav_date       ?? null,
            day_change:     s.day_change     ?? null,
            day_change_pct: s.day_change_pct ?? null,
            morningstar:    s.morningstar    ?? null,
            risk_label:     s.risk_label     ?? null,
            expense_ratio:  s.expense_ratio  ?? null,
            aum:            s.aum            ?? null,
            family_name:    s.family_name    ?? null,
            family_id:      s.family_id      ?? null,
            amc_name:       s.amc_name       ?? null,
            amc_slug:       s.amc_slug       ?? null,
            category:       s.category       ?? null,
          },
          create: {
            amfi_code:      String(s.amfi_code),
            name:           s.name,
            isin:           s.isin           ?? null,
            plan_type:      s.plan_type      ?? null,
            option_type:    s.option_type    ?? null,
            nav:            s.nav            ?? null,
            nav_date:       s.nav_date       ?? null,
            day_change:     s.day_change     ?? null,
            day_change_pct: s.day_change_pct ?? null,
            morningstar:    s.morningstar    ?? null,
            risk_label:     s.risk_label     ?? null,
            expense_ratio:  s.expense_ratio  ?? null,
            aum:            s.aum            ?? null,
            family_name:    s.family_name    ?? null,
            family_id:      s.family_id      ?? null,
            amc_name:       s.amc_name       ?? null,
            amc_slug:       s.amc_slug       ?? null,
            category:       s.category       ?? null,
          },
        })
      )
    );
    upserted += batch.length;
    console.log(`  ${upserted}/${schemes.length} done`);
  }

  console.log('Seeding complete.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
