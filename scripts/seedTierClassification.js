const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const prisma = require('../config/prisma');

async function seed() {
  const results = [];
  const csvPath = path.join(__dirname, 'TierClassification.csv');

  console.log('Reading CSV...');
  
  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (data) => {
        // Headers are "Symbol" and "Tier "
        const company = data['Symbol'];
        const tier = data['Tier ']?.trim();
        if (company && tier) {
          results.push({ company, tier });
        }
      })
      .on('end', () => {
        resolve();
      })
      .on('error', reject);
  });

  console.log(`Found ${results.length} valid records. Seeding database...`);

  let count = 0;
  for (const { company, tier } of results) {
    try {
      await prisma.tierClassification.upsert({
        where: { company },
        update: { tier },
        create: { company, tier },
      });
      count++;
      if (count % 100 === 0) console.log(`Seeded ${count} records...`);
    } catch (err) {
      console.error(`Error seeding company ${company}:`, err.message);
    }
  }

  console.log('Seeding complete!');
  await prisma.$disconnect();
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
