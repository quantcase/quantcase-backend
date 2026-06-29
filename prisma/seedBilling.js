'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const product = await prisma.product.upsert({
    where: { id: 'quantcase-pro' },
    update: {
      name: 'QuantCase Pro',
      description: 'Full access to earnings call intelligence, lens scores, and AI insights for Indian equities.',
      is_active: true,
    },
    create: {
      id: 'quantcase-pro',
      name: 'QuantCase Pro',
      description: 'Full access to earnings call intelligence, lens scores, and AI insights for Indian equities.',
      is_active: true,
    },
  });

  console.log(`Upserted product: ${product.id}`);

  const monthly = await prisma.price.upsert({
    where: { id: 'quantcase-pro-monthly' },
    update: {
      plan_type: 'monthly',
      amount: 249900, // paise (₹2,499)
      currency: 'INR',
      interval_months: 1,
      is_active: true,
    },
    create: {
      id: 'quantcase-pro-monthly',
      product_id: product.id,
      plan_type: 'monthly',
      amount: 249900,
      currency: 'INR',
      interval_months: 1,
      is_active: true,
    },
  });

  console.log(`Upserted price: ${monthly.id} (₹${monthly.amount / 100}/month)`);

  const annual = await prisma.price.upsert({
    where: { id: 'quantcase-pro-annual' },
    update: {
      plan_type: 'annual',
      amount: 1999900, // paise (₹19,999)
      currency: 'INR',
      interval_months: 12,
      is_active: true,
    },
    create: {
      id: 'quantcase-pro-annual',
      product_id: product.id,
      plan_type: 'annual',
      amount: 1999900,
      currency: 'INR',
      interval_months: 12,
      is_active: true,
    },
  });

  console.log(`Upserted price: ${annual.id} (₹${annual.amount / 100}/year)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
