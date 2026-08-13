const fs = require('fs');
const prisma = require('../config/prisma');
const path = require('path');

async function main() {
  const dir = path.join(__dirname, '../prompts/multiStagePrompts/guidance_credibility');
  
  const dataExtraction = fs.readFileSync(path.join(dir, 'stage1_data_extraction.md'), 'utf8');
  const htmlRender = fs.readFileSync(path.join(dir, 'stage3_html_render.md'), 'utf8');

  // Update the Guidance Credibility incremental skill
  await prisma.htmlIncrementalSkill.update({
    where: { slug: 'guidance-credibility' },
    data: {
      data_extraction_prompt: dataExtraction,
      html_template_prompt: htmlRender,
      enable_data_validation: true,
      data_validation_loops: 1,
      enable_html_validation: false,
    }
  });
  
  console.log('Successfully updated guidance-credibility incremental skill with multi-stage prompts!');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
