'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function main() {
  const content = fs.readFileSync('compression-prompt.md', 'utf8');
  
  // Remove the [INSERT YOUR SOURCE JSON HERE] part since the backend injects it natively now
  const cleanPrompt = content.replace(/```json\n\[INSERT YOUR SOURCE JSON HERE\]\n\n```/g, '').trim();

  await prisma.htmlCompressedSkill.update({
    where: { slug: 'guidance-credibility-compressed' },
    data: {
      html_template_prompt: cleanPrompt
    }
  });

  console.log("Updated guidance-credibility-compressed with proper compression prompt.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
