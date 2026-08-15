'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Starting seeding of compressed skills based on incremental skills...");

  const incrementalSkills = await prisma.htmlIncrementalSkill.findMany();
  const incrementalConfigs = await prisma.htmlIncrementalSkillConfig.findMany();

  for (const incSkill of incrementalSkills) {
    const compressedSlug = `${incSkill.slug}-compressed`;
    
    // Don't overwrite guidance-credibility-compressed as it has a specific template already, 
    // but check if it exists so we can still migrate its configs.
    const existing = await prisma.htmlCompressedSkill.findUnique({
      where: { slug: compressedSlug }
    });

    let compressedSkillId;

    if (existing && compressedSlug === 'guidance-credibility-compressed') {
      console.log(`Skipping creation of ${compressedSlug} (already seeded manually).`);
      compressedSkillId = existing.id;
    } else {
      const newSkill = await prisma.htmlCompressedSkill.upsert({
        where: { slug: compressedSlug },
        update: {
          name: `${incSkill.name} (Compressed)`,
          category: incSkill.category,
          base_l2_skill_id: incSkill.id,
          html_template_prompt: incSkill.html_template_prompt || "Please wait for template.",
          html_template_filename: incSkill.html_template_filename,
          html_template_model: incSkill.html_template_model,
          max_tokens: incSkill.max_tokens,
          use_template_engine: incSkill.use_template_engine,
          is_active: incSkill.is_active,
        },
        create: {
          slug: compressedSlug,
          name: `${incSkill.name} (Compressed)`,
          category: incSkill.category,
          base_l2_skill_id: incSkill.id,
          html_template_prompt: incSkill.html_template_prompt || "Please wait for template.",
          html_template_filename: incSkill.html_template_filename,
          html_template_model: incSkill.html_template_model,
          max_tokens: incSkill.max_tokens,
          use_template_engine: incSkill.use_template_engine,
          is_active: incSkill.is_active,
        }
      });
      console.log(`Created/Updated compressed skill: ${compressedSlug}`);
      compressedSkillId = newSkill.id;
    }

    // Now copy configs for this skill
    const configsForSkill = incrementalConfigs.filter(c => c.skill_id === incSkill.id);
    for (const incConfig of configsForSkill) {
      await prisma.htmlCompressedSkillConfig.upsert({
        where: {
          skill_id_key: {
            skill_id: compressedSkillId,
            key: incConfig.key,
          }
        },
        update: {
          name: `${incConfig.name} (Compressed)`,
          html_template_prompt: incConfig.html_template_prompt || "Please wait for template.",
          html_template_filename: incConfig.html_template_filename,
          html_template_model: incConfig.html_template_model,
          is_active: incConfig.is_active,
        },
        create: {
          skill_id: compressedSkillId,
          key: incConfig.key,
          name: `${incConfig.name} (Compressed)`,
          html_template_prompt: incConfig.html_template_prompt || "Please wait for template.",
          html_template_filename: incConfig.html_template_filename,
          html_template_model: incConfig.html_template_model,
          is_active: incConfig.is_active,
        }
      });
      console.log(`  - Created/Updated config: ${incConfig.key} for ${compressedSlug}`);
    }
  }

  console.log("Seeding complete!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
