const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.earnings_calls.findMany({
    select: { id: true, company: true, fiscal_year: true, quarter: true, basic_industry: true, company_name: true, created_at: true },
  });
  let mismatched = 0, nullIndustry = 0, total = rows.length;
  const mismatchSamples = [];
  for (const r of rows) {
    const expectedId = `${r.company}_${r.fiscal_year}_${r.quarter}`;
    if (r.id !== expectedId) {
      mismatched++;
      if (mismatchSamples.length < 20) mismatchSamples.push({ id: r.id, fiscal_year: r.fiscal_year, quarter: r.quarter, expectedId, created_at: r.created_at });
    }
    if (!r.basic_industry) nullIndustry++;
  }
  console.log(`Total earnings_calls rows: ${total}`);
  console.log(`Rows where id != company_fiscalyear_quarter: ${mismatched}`);
  console.log(`Rows with null basic_industry: ${nullIndustry}`);
  console.log('Sample mismatches:', JSON.stringify(mismatchSamples, null, 2));

  const nullIndustryRows = rows.filter(r => !r.basic_industry);
  console.log('Null basic_industry rows:', JSON.stringify(nullIndustryRows.map(r => ({ id: r.id, company: r.company, created_at: r.created_at })), null, 2));
  await prisma.$disconnect();
})();
