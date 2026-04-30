'use strict';
require('dotenv').config();
const prisma = require('../config/prisma');

const KEY = ['ASSET_PPE','ASSET_CWIP','DEP_AMORT','PBT','FIN_COST','TOTAL_ASSETS','CURR_LIAB','CFO','CFI'];

prisma.prowessValueNew.findMany({
  where: { company: 'Motherson Sumi Wiring India Ltd.', kpi_abbr: { in: KEY } },
  select: { kpi_abbr: true, value: true, multiplier: true, fiscal_year: true },
  orderBy: { fiscal_year: 'asc' },
}).then(rows => {
  rows.forEach(r => {
    const mult = r.multiplier || 1;
    const display = r.value !== null ? (r.value / mult).toFixed(2) : 'null';
    console.log(r.kpi_abbr.padEnd(16), 'FY:', r.fiscal_year, '| Cr:', display);
  });
  prisma.$disconnect();
});
