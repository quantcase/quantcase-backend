'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function main() {
  const baseSkill = await prisma.htmlIncrementalSkill.findUnique({
    where: { slug: 'guidance-credibility' }
  });

  if (!baseSkill) {
    console.error("Base skill 'guidance-credibility' not found!");
    process.exit(1);
  }

  const promptContent = fs.readFileSync('/home/anirudh/quantcase/vault/Quantcase/l2 prompt migration prompt.md', 'utf8');

  await prisma.htmlCompressedSkill.upsert({
    where: { slug: 'guidance-credibility-compressed' },
    update: {
      name: 'Guidance Credibility (Compressed)',
      category: 'management',
      base_l2_skill_id: baseSkill.id,
      html_template_prompt: promptContent,
      html_template_filename: 'management-lens-compressed.hbs',
      html_template_model: 'gpt-4o',
      use_template_engine: true,
      is_active: true
    },
    create: {
      slug: 'guidance-credibility-compressed',
      name: 'Guidance Credibility (Compressed)',
      category: 'management',
      base_l2_skill_id: baseSkill.id,
      html_template_prompt: promptContent,
      html_template_filename: 'management-lens-compressed.hbs',
      html_template_model: 'gpt-4o',
      use_template_engine: true,
      is_active: true
    }
  });

  console.log("Successfully seeded guidance-credibility-compressed skill.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
