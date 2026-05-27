#!/usr/bin/env node
'use strict';

require('dotenv').config();
const prisma = require('../config/prisma');

const USERS = [
  {
    email:         'hello@quantcase.ai',
    display_name:  'QuantCase Admin',
    password_hash: '$2b$10$4QOc6eVHV.Y2vfun3zKtu.k0FcHS83M/ZeJmIh.DueWPnjld9zoDu',
    account_type:  'manager',
  },
  {
    email:         'raj@quantcase.ai',
    display_name:  'Raj',
    password_hash: '$2b$10$frzEL3OPYmGGiWyXleNW2OZaL79dFRD5Q6fQGuuwZ.d7f5TNkClim',
    account_type:  'investor',
  },
];

async function main() {
  console.log('Seeding users and default team...');

  const users = [];
  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where:  { email: u.email },
      update: { password_hash: u.password_hash, account_type: u.account_type, display_name: u.display_name },
      create: u,
    });
    users.push(user);
    console.log(`  Upserted user: ${user.email} (${user.id})`);
  }

  let team = await prisma.team.findFirst({ where: { name: 'Default' } });
  if (!team) {
    team = await prisma.team.create({ data: { name: 'Default' } });
    console.log(`  Created team: Default (${team.id})`);
  } else {
    console.log(`  Team already exists: Default (${team.id})`);
  }

  for (const user of users) {
    await prisma.teamMember.upsert({
      where:  { team_id_user_id: { team_id: team.id, user_id: user.id } },
      update: {},
      create: { team_id: team.id, user_id: user.id },
    });
    console.log(`  Assigned ${user.email} to Default team`);
  }

  console.log('Seed complete.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
