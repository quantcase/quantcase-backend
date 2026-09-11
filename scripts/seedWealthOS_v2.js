'use strict';

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting WealthOS Enhanced Multi-CIO Org Seeding...');

  // 1. Create or Find Organisation
  const org = await prisma.wealthOrganisation.upsert({
    where: { slug: 'quantcase-capital' },
    update: {},
    create: {
      name: 'Quantcase Capital',
      slug: 'quantcase-capital',
      settings: {
        currency: 'INR',
        aumUnit: 'Cr',
        driftAlertThresholdPct: 5.0,
      },
    },
  });
  console.log(`✅ Organisation: ${org.name} (${org.id})`);

  const passwordHash = bcrypt.hashSync('Quantcase@123', 10);

  // Helper to upsert auth user + org member
  async function createStaffUser({ email, displayName, role }) {
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          password_hash: passwordHash,
          display_name: displayName,
          account_type: 'manager',
        },
      });
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password_hash: passwordHash,
          display_name: displayName,
          account_type: 'manager',
        },
      });
    }

    await prisma.userProfile.upsert({
      where: { user_id: user.id },
      update: {
        onboarding_completed: true,
        onboarding_step: 'done',
        full_name: displayName,
      },
      create: {
        user_id: user.id,
        full_name: displayName,
        onboarding_completed: true,
        onboarding_step: 'done',
      },
    });

    const member = await prisma.wealthOrgMember.upsert({
      where: {
        org_id_user_id: {
          org_id: org.id,
          user_id: user.id,
        },
      },
      update: { role, is_active: true },
      create: {
        org_id: org.id,
        user_id: user.id,
        role,
        is_active: true,
      },
    });

    return { user, member };
  }

  // 2. Seed Super Admin
  const superAdmin = await createStaffUser({
    email: 'admin@quantcase.ai',
    displayName: 'Super Admin',
    role: 'super_admin',
  });
  console.log(`👑 Super Admin: ${superAdmin.user.email}`);

  // 3. Seed 2 CIOs
  // CIO 1: Core Equities & Multi-Asset
  const cio1 = await createStaffUser({
    email: 'cio@quantcase.ai',
    displayName: 'Vikramaditya Singhania',
    role: 'cio',
  });
  console.log(`💼 CIO 1 (Core Strategies): ${cio1.user.email}`);

  // CIO 2: Quantitative, Global & Alternative Strategies
  const cio2 = await createStaffUser({
    email: 'devika@quantcase.ai',
    displayName: 'Devika Somani',
    role: 'cio',
  });
  console.log(`💼 CIO 2 (Global & Alts): ${cio2.user.email}`);

  // 4. Seed 4 RMs (2 under CIO 1, 2 under CIO 2)
  // RM 1: Palash Jain under CIO 1
  const rmPalash = await createStaffUser({
    email: 'palash@quantcase.ai',
    displayName: 'Palash Jain',
    role: 'rm',
  });
  const rmPalashProfile = await prisma.wealthRmProfile.upsert({
    where: { member_id: rmPalash.member.id },
    update: {
      cio_member_id: cio1.member.id,
      display_name: 'Palash Jain',
      email: rmPalash.user.email,
      team: 'Private Wealth — West Desk',
      performance_score: 94,
      target_aum_cr: 1000,
      total_aum_cr: 796,
    },
    create: {
      org_id: org.id,
      member_id: rmPalash.member.id,
      cio_member_id: cio1.member.id,
      display_name: 'Palash Jain',
      email: rmPalash.user.email,
      team: 'Private Wealth — West Desk',
      performance_score: 94,
      target_aum_cr: 1000,
      total_aum_cr: 796,
    },
  });
  console.log(`👔 RM 1 seeded: Palash Jain (under Vikramaditya Singhania)`);

  // RM 2: Ananya Sharma under CIO 1
  const rmAnanya = await createStaffUser({
    email: 'ananya@quantcase.ai',
    displayName: 'Ananya Sharma',
    role: 'rm',
  });
  const rmAnanyaProfile = await prisma.wealthRmProfile.upsert({
    where: { member_id: rmAnanya.member.id },
    update: {
      cio_member_id: cio1.member.id,
      display_name: 'Ananya Sharma',
      email: rmAnanya.user.email,
      team: 'Growth HNI — North Desk',
      performance_score: 89,
      target_aum_cr: 600,
      total_aum_cr: 420,
    },
    create: {
      org_id: org.id,
      member_id: rmAnanya.member.id,
      cio_member_id: cio1.member.id,
      display_name: 'Ananya Sharma',
      email: rmAnanya.user.email,
      team: 'Growth HNI — North Desk',
      performance_score: 89,
      target_aum_cr: 600,
      total_aum_cr: 420,
    },
  });
  console.log(`👔 RM 2 seeded: Ananya Sharma (under Vikramaditya Singhania)`);

  // RM 3: Siddharth Rao under CIO 2
  const rmSiddharth = await createStaffUser({
    email: 'siddharth@quantcase.ai',
    displayName: 'Siddharth Rao',
    role: 'rm',
  });
  const rmSiddharthProfile = await prisma.wealthRmProfile.upsert({
    where: { member_id: rmSiddharth.member.id },
    update: {
      cio_member_id: cio2.member.id,
      display_name: 'Siddharth Rao',
      email: rmSiddharth.user.email,
      team: 'Ultra HNI & Institutional Desk',
      performance_score: 96,
      target_aum_cr: 1200,
      total_aum_cr: 880,
    },
    create: {
      org_id: org.id,
      member_id: rmSiddharth.member.id,
      cio_member_id: cio2.member.id,
      display_name: 'Siddharth Rao',
      email: rmSiddharth.user.email,
      team: 'Ultra HNI & Institutional Desk',
      performance_score: 96,
      target_aum_cr: 1200,
      total_aum_cr: 880,
    },
  });
  console.log(`👔 RM 3 seeded: Siddharth Rao (under Devika Somani)`);

  // RM 4: Meera Nambiar under CIO 2
  const rmMeera = await createStaffUser({
    email: 'meera@quantcase.ai',
    displayName: 'Meera Nambiar',
    role: 'rm',
  });
  const rmMeeraProfile = await prisma.wealthRmProfile.upsert({
    where: { member_id: rmMeera.member.id },
    update: {
      cio_member_id: cio2.member.id,
      display_name: 'Meera Nambiar',
      email: rmMeera.user.email,
      team: 'Family Offices & Cross-Border Desk',
      performance_score: 91,
      target_aum_cr: 750,
      total_aum_cr: 530,
    },
    create: {
      org_id: org.id,
      member_id: rmMeera.member.id,
      cio_member_id: cio2.member.id,
      display_name: 'Meera Nambiar',
      email: rmMeera.user.email,
      team: 'Family Offices & Cross-Border Desk',
      performance_score: 91,
      target_aum_cr: 750,
      total_aum_cr: 530,
    },
  });
  console.log(`👔 RM 4 seeded: Meera Nambiar (under Devika Somani)`);

  // 5. Seed Approved Investment Models
  let coreGrowthModel = await prisma.wealthApprovedModel.findFirst({
    where: { org_id: org.id, name: 'High Conviction Multi-Asset Growth' },
  });
  if (!coreGrowthModel) {
    coreGrowthModel = await prisma.wealthApprovedModel.create({
      data: {
        org_id: org.id,
        name: 'High Conviction Multi-Asset Growth',
        description: '60% Equity, 20% Debt, 10% REITs, 10% Alts for aggressive wealth preservation.',
        model_type: 'hybrid',
        version: '2.1',
        is_published: true,
        approved_by: cio1.member.id,
        approved_at: new Date(),
        data: {
          targets: [
            { asset_class: 'equity', target_pct: 60, max_single_stock_pct: 10 },
            { asset_class: 'debt', target_pct: 20 },
            { asset_class: 'reit', target_pct: 10 },
            { asset_class: 'aif', target_pct: 10 },
          ],
        },
      },
    });
  }

  let globalAltsModel = await prisma.wealthApprovedModel.findFirst({
    where: { org_id: org.id, name: 'Global Thematic & Alternative Alpha' },
  });
  if (!globalAltsModel) {
    globalAltsModel = await prisma.wealthApprovedModel.create({
      data: {
        org_id: org.id,
        name: 'Global Thematic & Alternative Alpha',
        description: 'Global equity indexes, PE/VC AIFs, mezzanine credit, and REITs managed by Devika Somani.',
        model_type: 'hybrid',
        version: '1.4',
        is_published: true,
        approved_by: cio2.member.id,
        approved_at: new Date(),
        data: {
          targets: [
            { asset_class: 'equity', target_pct: 40 },
            { asset_class: 'aif', target_pct: 30 },
            { asset_class: 'debt', target_pct: 15 },
            { asset_class: 'reit', target_pct: 15 },
          ],
        },
      },
    });
  }

  // 6. Clean existing client tree to avoid stale duplicates
  console.log('🧹 Synchronizing client records...');
  // We will upsert or cleanly re-create clients
  const allClientEmails = [
    // Under Palash
    'rahul.mehta@example.com',
    'priya.venkat@example.com',
    'varun.kapoor@example.com',
    'anita.shah@example.com',
    // Under Ananya
    'rohan.deshmukh@example.com',
    'kavita.iyer@example.com',
    'deepak.singhal@example.com',
    // Under Siddharth
    'vikram.malhotra@example.com',
    'kabir.singhania@example.com',
    'shalini.goel@example.com',
    // Under Meera
    'suresh.nair@example.com',
    'aarav.chawla@example.com',
    'nandini.kulkarni@example.com',
  ];

  // Helper to upsert full client graph
  async function seedClientHierarchy(clientData, rmProfileId, modelId) {
    let client = await prisma.wealthClient.findFirst({
      where: { org_id: org.id, email: clientData.email },
    });

    if (client) {
      // Remove previous portfolio holdings & alerts for clean state
      const existingPort = await prisma.wealthPortfolio.findFirst({ where: { client_id: client.id } });
      if (existingPort) {
        const hList = await prisma.wealthHolding.findMany({ where: { portfolio_id: existingPort.id } });
        const hIds = hList.map(h => h.id);
        await prisma.wealthHoldingAlert.deleteMany({ where: { holding_id: { in: hIds } } });
        await prisma.wealthHolding.deleteMany({ where: { portfolio_id: existingPort.id } });
        await prisma.wealthPortfolio.delete({ where: { id: existingPort.id } });
      }
      client = await prisma.wealthClient.update({
        where: { id: client.id },
        data: {
          rm_profile_id: rmProfileId,
          name: clientData.name,
          phone: clientData.phone,
          city: clientData.city,
          segment: clientData.segment,
          risk_profile: clientData.risk_profile,
          lifecycle_status: clientData.lifecycle_status,
          aum_cr: clientData.aum_cr,
          churn_probability: clientData.churn_probability,
          engagement_score: clientData.engagement_score,
          last_contact_at: clientData.last_contact_at,
          family_members: clientData.family_members || [],
          tags: clientData.tags || ['priority', clientData.segment.toLowerCase()],
        },
      });
    } else {
      client = await prisma.wealthClient.create({
        data: {
          org_id: org.id,
          rm_profile_id: rmProfileId,
          name: clientData.name,
          email: clientData.email,
          phone: clientData.phone,
          city: clientData.city,
          segment: clientData.segment,
          risk_profile: clientData.risk_profile,
          lifecycle_status: clientData.lifecycle_status,
          aum_cr: clientData.aum_cr,
          churn_probability: clientData.churn_probability,
          engagement_score: clientData.engagement_score,
          last_contact_at: clientData.last_contact_at,
          family_members: clientData.family_members || [],
          tags: clientData.tags || ['priority', clientData.segment.toLowerCase()],
        },
      });
    }

    const portfolio = await prisma.wealthPortfolio.create({
      data: {
        client_id: client.id,
        total_value_cr: clientData.aum_cr,
        risk_score: clientData.risk_score || 7.0,
      },
    });

    for (const h of clientData.holdings) {
      const holding = await prisma.wealthHolding.create({
        data: {
          portfolio_id: portfolio.id,
          ticker: h.ticker || null,
          scheme_name: h.scheme_name,
          asset_class: h.asset_class,
          current_value_cr: h.value_cr,
          weight_pct: h.weight_pct,
          as_of_date: new Date(),
        },
      });

      if (h.alert) {
        await prisma.wealthHoldingAlert.create({
          data: {
            holding_id: holding.id,
            alert_type: h.alert.type,
            severity: h.alert.severity,
            message: h.alert.message,
            threshold: 10.0,
            actual_value: h.weight_pct,
          },
        });
      }
    }

    await prisma.wealthClientModelMapping.upsert({
      where: {
        client_id_model_id: {
          client_id: client.id,
          model_id: modelId,
        },
      },
      update: {},
      create: {
        client_id: client.id,
        model_id: modelId,
      },
    });

    return client;
  }

  // ── DESK 1: Palash Jain (Private Wealth — West Desk) ──
  console.log('🌱 Seeding clients under RM Palash Jain...');
  await seedClientHierarchy(
    {
      name: 'Rahul Mehta',
      email: 'rahul.mehta@example.com',
      phone: '+91 98201 12345',
      city: 'Mumbai',
      segment: 'HNI',
      risk_profile: 'moderate',
      lifecycle_status: 'active',
      aum_cr: 3.2,
      churn_probability: 0.25,
      engagement_score: 82,
      last_contact_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      family_members: [{ relation: 'Daughter', name: 'Aanya', age: 14 }],
      holdings: [
        { ticker: 'HDFCBANK', scheme_name: 'HDFC Bank Ltd', asset_class: 'equity', value_cr: 0.8, weight_pct: 25.0, alert: { type: 'critical_drift', severity: 'critical', message: 'Small-cap drift +6% pushing volatility above mandate' } },
        { ticker: 'TCS', scheme_name: 'Tata Consultancy Services', asset_class: 'equity', value_cr: 0.5, weight_pct: 15.6 },
        { ticker: 'RELIANCE', scheme_name: 'Reliance Industries', asset_class: 'equity', value_cr: 0.6, weight_pct: 18.7 },
        { ticker: 'INFY', scheme_name: 'Infosys Ltd', asset_class: 'equity', value_cr: 0.4, weight_pct: 12.5 },
        { ticker: 'BAJFINANCE', scheme_name: 'Bajaj Finance', asset_class: 'equity', value_cr: 0.3, weight_pct: 9.4 },
        { ticker: 'TITAN', scheme_name: 'Titan Company', asset_class: 'equity', value_cr: 0.2, weight_pct: 6.3 },
        { scheme_name: 'Nippon India Multi Cap Fund', asset_class: 'mutual_fund', value_cr: 0.25, weight_pct: 7.8 },
        { scheme_name: 'SBI Small Cap Fund', asset_class: 'mutual_fund', value_cr: 0.15, weight_pct: 4.7 },
      ],
    },
    rmPalashProfile.id,
    coreGrowthModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Priya Venkat',
      email: 'priya.venkat@example.com',
      phone: '+91 98111 23456',
      city: 'Bengaluru',
      segment: 'UHNI',
      risk_profile: 'aggressive',
      lifecycle_status: 'active',
      aum_cr: 4.6,
      churn_probability: 0.12,
      engagement_score: 92,
      last_contact_at: new Date('2026-04-11'),
      family_members: [{ relation: 'Spouse', name: 'Venkat Raman' }],
      holdings: [
        { ticker: 'INFY', scheme_name: 'Infosys Ltd', asset_class: 'equity', value_cr: 1.0, weight_pct: 21.7 },
        { scheme_name: 'Nippon India Mid Cap Fund', asset_class: 'mutual_fund', value_cr: 0.9, weight_pct: 19.5 },
        { scheme_name: 'SBI Small Cap Fund', asset_class: 'mutual_fund', value_cr: 0.7, weight_pct: 15.2 },
        { scheme_name: 'Global Technology Fund', asset_class: 'mutual_fund', value_cr: 0.5, weight_pct: 10.9 },
        { scheme_name: 'Embassy Office Parks REIT', asset_class: 'reit', value_cr: 0.4, weight_pct: 8.7 },
        { scheme_name: 'Structured Credit Series IV', asset_class: 'debt', value_cr: 0.6, weight_pct: 13.0, alert: { type: 'critical_drift', severity: 'high', message: 'NPS allocation requested on last review' } },
        { scheme_name: 'GOI G-Sec 2030', asset_class: 'debt', value_cr: 0.3, weight_pct: 6.5 },
        { scheme_name: 'HDFC Liquid Fund', asset_class: 'debt', value_cr: 0.2, weight_pct: 4.5 },
      ],
    },
    rmPalashProfile.id,
    coreGrowthModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Varun Kapoor',
      email: 'varun.kapoor@example.com',
      phone: '+91 98222 34567',
      city: 'Delhi',
      segment: 'UHNI',
      risk_profile: 'moderate',
      lifecycle_status: 'active',
      aum_cr: 7.1,
      churn_probability: 0.45,
      engagement_score: 65,
      last_contact_at: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000),
      holdings: [
        { ticker: 'HDFCBANK', scheme_name: 'HDFC Bank Ltd', asset_class: 'equity', value_cr: 1.8, weight_pct: 25.3 },
        { ticker: 'TCS', scheme_name: 'Tata Consultancy Services', asset_class: 'equity', value_cr: 1.2, weight_pct: 16.9 },
        { ticker: 'RELIANCE', scheme_name: 'Reliance Industries', asset_class: 'equity', value_cr: 1.4, weight_pct: 19.7 },
        { ticker: 'INFY', scheme_name: 'Infosys Ltd', asset_class: 'equity', value_cr: 0.8, weight_pct: 11.3 },
        { ticker: 'LT', scheme_name: 'Larsen & Toubro Ltd', asset_class: 'equity', value_cr: 0.7, weight_pct: 9.9, alert: { type: 'overweight', severity: 'medium', message: 'Mid-cap overweight +9% with 16 days inactivity' } },
        { scheme_name: 'Brookfield India Real Estate Trust', asset_class: 'reit', value_cr: 0.6, weight_pct: 8.5 },
        { scheme_name: 'G-Sec 7.38% 2027', asset_class: 'debt', value_cr: 0.6, weight_pct: 8.4 },
      ],
    },
    rmPalashProfile.id,
    coreGrowthModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Anita Shah',
      email: 'anita.shah@example.com',
      phone: '+91 98333 45678',
      city: 'Mumbai',
      segment: 'UHNI',
      risk_profile: 'aggressive',
      lifecycle_status: 'active',
      aum_cr: 5.8,
      churn_probability: 0.15,
      engagement_score: 88,
      last_contact_at: new Date('2026-04-14'),
      holdings: [
        { ticker: 'TATAPOWER', scheme_name: 'Tata Power Ltd', asset_class: 'equity', value_cr: 1.2, weight_pct: 20.7 },
        { ticker: 'MARUTI', scheme_name: 'Maruti Suzuki India Ltd', asset_class: 'equity', value_cr: 1.0, weight_pct: 17.2 },
        { ticker: 'POLYCAB', scheme_name: 'Polycab India Ltd', asset_class: 'equity', value_cr: 0.8, weight_pct: 13.8 },
        { ticker: 'ITC', scheme_name: 'ITC Ltd', asset_class: 'equity', value_cr: 0.8, weight_pct: 13.8 },
        { ticker: 'INFY', scheme_name: 'Infosys Ltd', asset_class: 'equity', value_cr: 0.7, weight_pct: 12.1 },
        { scheme_name: 'SBI Bluechip Fund', asset_class: 'mutual_fund', value_cr: 0.8, weight_pct: 13.8 },
        { scheme_name: '7.18% GS 2033', asset_class: 'debt', value_cr: 0.5, weight_pct: 8.6 },
      ],
    },
    rmPalashProfile.id,
    coreGrowthModel.id
  );

  // ── DESK 2: Ananya Sharma (Growth HNI — North Desk) ──
  console.log('🌱 Seeding clients under RM Ananya Sharma...');
  await seedClientHierarchy(
    {
      name: 'Rohan Deshmukh',
      email: 'rohan.deshmukh@example.com',
      phone: '+91 98777 11223',
      city: 'Pune',
      segment: 'HNI',
      risk_profile: 'aggressive',
      lifecycle_status: 'active',
      aum_cr: 4.1,
      churn_probability: 0.35,
      engagement_score: 79,
      last_contact_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      holdings: [
        { ticker: 'TATAELXSI', scheme_name: 'Tata Elxsi Ltd', asset_class: 'equity', value_cr: 1.1, weight_pct: 26.8, alert: { type: 'critical_drift', severity: 'critical', message: 'IT sector concentration > 45% vs 25% mandate' } },
        { ticker: 'KPITTECH', scheme_name: 'KPIT Technologies', asset_class: 'equity', value_cr: 0.9, weight_pct: 22.0 },
        { ticker: 'PERSISTENT', scheme_name: 'Persistent Systems Ltd', asset_class: 'equity', value_cr: 0.7, weight_pct: 17.1 },
        { scheme_name: 'Parag Parikh Flexi Cap Fund', asset_class: 'mutual_fund', value_cr: 0.8, weight_pct: 19.5 },
        { scheme_name: 'Axis Small Cap Fund', asset_class: 'mutual_fund', value_cr: 0.6, weight_pct: 14.6 },
      ],
    },
    rmAnanyaProfile.id,
    coreGrowthModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Kavita Iyer',
      email: 'kavita.iyer@example.com',
      phone: '+91 98888 22334',
      city: 'Bengaluru',
      segment: 'HNI',
      risk_profile: 'moderate',
      lifecycle_status: 'active',
      aum_cr: 2.9,
      churn_probability: 0.18,
      engagement_score: 85,
      last_contact_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      holdings: [
        { ticker: 'SUNPHARMA', scheme_name: 'Sun Pharma Industries', asset_class: 'equity', value_cr: 0.7, weight_pct: 24.1 },
        { ticker: 'CIPLA', scheme_name: 'Cipla Ltd', asset_class: 'equity', value_cr: 0.6, weight_pct: 20.7 },
        { ticker: 'NESTLEIND', scheme_name: 'Nestle India Ltd', asset_class: 'equity', value_cr: 0.5, weight_pct: 17.2 },
        { ticker: 'HINDUNILVR', scheme_name: 'Hindustan Unilever', asset_class: 'equity', value_cr: 0.4, weight_pct: 13.8 },
        { scheme_name: 'Mirae Asset Large Cap Fund', asset_class: 'mutual_fund', value_cr: 0.4, weight_pct: 13.8 },
        { scheme_name: 'HDFC Corporate Bond Fund', asset_class: 'debt', value_cr: 0.3, weight_pct: 10.4 },
      ],
    },
    rmAnanyaProfile.id,
    coreGrowthModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Deepak Singhal',
      email: 'deepak.singhal@example.com',
      phone: '+91 98999 33445',
      city: 'Gurugram',
      segment: 'UHNI',
      risk_profile: 'moderate',
      lifecycle_status: 'active',
      aum_cr: 6.5,
      churn_probability: 0.22,
      engagement_score: 88,
      last_contact_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      holdings: [
        { ticker: 'ICICIBANK', scheme_name: 'ICICI Bank Ltd', asset_class: 'equity', value_cr: 1.8, weight_pct: 27.7 },
        { ticker: 'KOTAKBANK', scheme_name: 'Kotak Mahindra Bank', asset_class: 'equity', value_cr: 1.2, weight_pct: 18.5 },
        { scheme_name: 'Mindspace Business Parks REIT', asset_class: 'reit', value_cr: 1.0, weight_pct: 15.4 },
        { scheme_name: 'G-Sec 7.26% 2032', asset_class: 'debt', value_cr: 1.2, weight_pct: 18.5 },
        { scheme_name: 'ICICI Prudential Balanced Advantage', asset_class: 'mutual_fund', value_cr: 0.8, weight_pct: 12.3 },
        { scheme_name: 'Nippon India Gold ETF', asset_class: 'mutual_fund', value_cr: 0.5, weight_pct: 7.6 },
      ],
    },
    rmAnanyaProfile.id,
    coreGrowthModel.id
  );

  // ── DESK 3: Siddharth Rao (Ultra HNI & Institutional Desk under Devika Somani) ──
  console.log('🌱 Seeding clients under RM Siddharth Rao...');
  await seedClientHierarchy(
    {
      name: 'Vikram Malhotra',
      email: 'vikram.malhotra@example.com',
      phone: '+91 98666 78901',
      city: 'Mumbai',
      segment: 'Institutional',
      risk_profile: 'aggressive',
      lifecycle_status: 'active',
      aum_cr: 12.5,
      churn_probability: 0.08,
      engagement_score: 95,
      last_contact_at: new Date('2026-04-18'),
      holdings: [
        { scheme_name: 'S&P 500 Index Feeder', asset_class: 'mutual_fund', value_cr: 3.5, weight_pct: 28.0 },
        { scheme_name: 'Private Equity Growth Fund IV', asset_class: 'aif', value_cr: 3.0, weight_pct: 24.0 },
        { scheme_name: 'Structured Debt Mezzanine', asset_class: 'debt', value_cr: 2.5, weight_pct: 20.0, alert: { type: 'policy_breach', severity: 'critical', message: 'Structured Debt illiquidity covenant review requested' } },
        { ticker: 'RELIANCE', scheme_name: 'Reliance Industries', asset_class: 'equity', value_cr: 1.5, weight_pct: 12.0 },
        { ticker: 'BHARTIARTL', scheme_name: 'Bharti Airtel Ltd', asset_class: 'equity', value_cr: 1.0, weight_pct: 8.0 },
        { ticker: 'HDFCBANK', scheme_name: 'HDFC Bank Ltd', asset_class: 'equity', value_cr: 1.0, weight_pct: 8.0 },
      ],
    },
    rmSiddharthProfile.id,
    globalAltsModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Kabir Singhania',
      email: 'kabir.singhania@example.com',
      phone: '+91 98555 67890',
      city: 'Kolkata',
      segment: 'Private',
      risk_profile: 'aggressive',
      lifecycle_status: 'active',
      aum_cr: 8.0,
      churn_probability: 0.10,
      engagement_score: 90,
      last_contact_at: new Date('2026-04-05'),
      holdings: [
        { ticker: 'TCS', scheme_name: 'Tata Consultancy Services', asset_class: 'equity', value_cr: 2.5, weight_pct: 31.25 },
        { ticker: 'HCLTECH', scheme_name: 'HCL Technologies Ltd', asset_class: 'equity', value_cr: 1.8, weight_pct: 22.5 },
        { scheme_name: 'Brookfield Real Estate REIT', asset_class: 'reit', value_cr: 1.5, weight_pct: 18.75 },
        { scheme_name: 'G-Sec 2034 7.18%', asset_class: 'debt', value_cr: 1.2, weight_pct: 15.0 },
        { scheme_name: 'Institutional Cash Sweep', asset_class: 'cash', value_cr: 1.0, weight_pct: 12.5 },
      ],
    },
    rmSiddharthProfile.id,
    globalAltsModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Shalini Goel',
      email: 'shalini.goel@example.com',
      phone: '+91 98444 11990',
      city: 'Delhi',
      segment: 'UHNI',
      risk_profile: 'moderate',
      lifecycle_status: 'active',
      aum_cr: 9.4,
      churn_probability: 0.14,
      engagement_score: 93,
      last_contact_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      holdings: [
        { scheme_name: 'Embassy Office Parks REIT', asset_class: 'reit', value_cr: 2.5, weight_pct: 26.6 },
        { scheme_name: 'Mindspace Business Parks REIT', asset_class: 'reit', value_cr: 2.0, weight_pct: 21.3 },
        { scheme_name: 'US Treasury 7-10Y Bond ETF', asset_class: 'debt', value_cr: 2.2, weight_pct: 23.4 },
        { ticker: 'HDFCBANK', scheme_name: 'HDFC Bank ADR', asset_class: 'equity', value_cr: 1.5, weight_pct: 16.0 },
        { scheme_name: 'Kotak Multi Asset Allocation', asset_class: 'mutual_fund', value_cr: 1.2, weight_pct: 12.7 },
      ],
    },
    rmSiddharthProfile.id,
    globalAltsModel.id
  );

  // ── DESK 4: Meera Nambiar (Family Offices & Cross-Border Desk under Devika Somani) ──
  console.log('🌱 Seeding clients under RM Meera Nambiar...');
  await seedClientHierarchy(
    {
      name: 'Suresh Nair',
      email: 'suresh.nair@example.com',
      phone: '+91 98444 56789',
      city: 'Chennai',
      segment: 'HNI',
      risk_profile: 'conservative',
      lifecycle_status: 'active',
      aum_cr: 2.4,
      churn_probability: 0.30,
      engagement_score: 74,
      last_contact_at: new Date('2026-03-20'),
      holdings: [
        { scheme_name: 'Treasury Bills 91D', asset_class: 'debt', value_cr: 1.0, weight_pct: 41.7 },
        { scheme_name: 'Liquid Savings Balance', asset_class: 'cash', value_cr: 0.62, weight_pct: 25.8, alert: { type: 'underweight', severity: 'medium', message: '₹62L idle cash sitting in savings for 4 months' } },
        { scheme_name: 'Mindspace Business Parks REIT', asset_class: 'reit', value_cr: 0.45, weight_pct: 18.8 },
        { scheme_name: 'HDFC Short Term Debt Fund', asset_class: 'debt', value_cr: 0.33, weight_pct: 13.7 },
      ],
    },
    rmMeeraProfile.id,
    globalAltsModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Aarav & Maya Chawla',
      email: 'aarav.chawla@example.com',
      phone: '+91 98123 44556',
      city: 'Mumbai',
      segment: 'Institutional',
      risk_profile: 'aggressive',
      lifecycle_status: 'active',
      aum_cr: 11.2,
      churn_probability: 0.16,
      engagement_score: 91,
      last_contact_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      family_members: [{ relation: 'Co-Trustee', name: 'Maya Chawla' }],
      holdings: [
        { ticker: 'TATAMOTORS', scheme_name: 'Tata Motors Passenger Vehicles', asset_class: 'equity', value_cr: 3.2, weight_pct: 28.6, alert: { type: 'critical_drift', severity: 'high', message: 'Auto & EV concentration drift +8%' } },
        { ticker: 'JSWENERGY', scheme_name: 'JSW Energy Green Power', asset_class: 'equity', value_cr: 2.5, weight_pct: 22.3 },
        { ticker: 'SUZLON', scheme_name: 'Suzlon Energy Renewable', asset_class: 'equity', value_cr: 1.8, weight_pct: 16.1 },
        { scheme_name: 'Mirae Asset Global Clean Energy ETF', asset_class: 'mutual_fund', value_cr: 1.5, weight_pct: 13.4 },
        { scheme_name: 'Green Bond 2030 GOI', asset_class: 'debt', value_cr: 1.2, weight_pct: 10.7 },
        { scheme_name: 'Nippon India Small Cap Fund', asset_class: 'mutual_fund', value_cr: 1.0, weight_pct: 8.9 },
      ],
    },
    rmMeeraProfile.id,
    globalAltsModel.id
  );

  await seedClientHierarchy(
    {
      name: 'Nandini Kulkarni',
      email: 'nandini.kulkarni@example.com',
      phone: '+91 98234 55667',
      city: 'Hyderabad',
      segment: 'UHNI',
      risk_profile: 'moderate',
      lifecycle_status: 'active',
      aum_cr: 5.3,
      churn_probability: 0.12,
      engagement_score: 87,
      last_contact_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      holdings: [
        { ticker: 'POWERGRID', scheme_name: 'Power Grid Corp of India', asset_class: 'equity', value_cr: 1.4, weight_pct: 26.4 },
        { ticker: 'NTPC', scheme_name: 'NTPC Ltd', asset_class: 'equity', value_cr: 1.2, weight_pct: 22.6 },
        { ticker: 'COALINDIA', scheme_name: 'Coal India Ltd', asset_class: 'equity', value_cr: 1.0, weight_pct: 18.9 },
        { ticker: 'VEDL', scheme_name: 'Vedanta Ltd', asset_class: 'equity', value_cr: 0.6, weight_pct: 11.3 },
        { scheme_name: 'HDFC Dividend Yield Fund', asset_class: 'mutual_fund', value_cr: 0.6, weight_pct: 11.3 },
        { scheme_name: 'Bharat Bond ETF 2030', asset_class: 'debt', value_cr: 0.5, weight_pct: 9.5 },
      ],
    },
    rmMeeraProfile.id,
    globalAltsModel.id
  );

  // 7. Seed Cross-Desk CRM Opportunities
  console.log('🌱 Seeding cross-desk CRM opportunities...');
  await prisma.wealthOpportunity.deleteMany({ where: { org_id: org.id } });

  const rahul = await prisma.wealthClient.findFirst({ where: { email: 'rahul.mehta@example.com' } });
  const priya = await prisma.wealthClient.findFirst({ where: { email: 'priya.venkat@example.com' } });
  const rohan = await prisma.wealthClient.findFirst({ where: { email: 'rohan.deshmukh@example.com' } });
  const vikramM = await prisma.wealthClient.findFirst({ where: { email: 'vikram.malhotra@example.com' } });
  const suresh = await prisma.wealthClient.findFirst({ where: { email: 'suresh.nair@example.com' } });
  const aarav = await prisma.wealthClient.findFirst({ where: { email: 'aarav.chawla@example.com' } });

  const oppData = [
    {
      org_id: org.id,
      client_id: rahul.id,
      rm_profile_id: rmPalashProfile.id,
      category: 'life_event',
      sub_category: 'Education funding',
      fit_score: 88,
      headline: 'Daughter turning 14 this month. No goal-linked education portfolio.',
      evidence: 'From KYC: Aanya born 2012. 4 years to undergrad. General-purpose SIPs need realignment.',
      source_type: 'life_event_trigger',
      indicative_value_cr: 0.35,
    },
    {
      org_id: org.id,
      client_id: priya.id,
      rm_profile_id: rmPalashProfile.id,
      category: 'client_asked',
      sub_category: 'Tax optimization',
      fit_score: 92,
      headline: 'Requested NPS Tier-1 tax shield proposal on recent review.',
      evidence: 'Call notes: "Husband enrolled at office; requested tax projection on ₹50k-₹2L annual deduction."',
      source_type: 'interaction_note',
      indicative_value_cr: 0.05,
    },
    {
      org_id: org.id,
      client_id: rohan.id,
      rm_profile_id: rmAnanyaProfile.id,
      category: 'rebalance',
      sub_category: 'Tech concentration de-risking',
      fit_score: 94,
      headline: 'Tech sector allocation exceeds 45% of total book.',
      evidence: 'Tata Elxsi + KPIT + Persistent combined 65.9% equity. Recommend multi-cap diversification.',
      source_type: 'portfolio_alert',
      indicative_value_cr: 1.20,
    },
    {
      org_id: org.id,
      client_id: vikramM.id,
      rm_profile_id: rmSiddharthProfile.id,
      category: 'new_product',
      sub_category: 'Structured debt rebalancing',
      fit_score: 96,
      headline: 'Mezzanine debt quarterly covenant review and liquidity gate unlock.',
      evidence: 'Series IV illiquidity window resets Q3. Opportunity to rotate ₹1.5 Cr into Global Tech feeder.',
      source_type: 'portfolio_alert',
      indicative_value_cr: 1.50,
    },
    {
      org_id: org.id,
      client_id: suresh.id,
      rm_profile_id: rmMeeraProfile.id,
      category: 'idle_cash',
      sub_category: 'Yield enhancement',
      fit_score: 82,
      headline: '₹62 Lakhs idle in savings yielding < 3.5%.',
      evidence: 'Savings balance idle > 120 days. Conservative liquid fund switch can yield +380 bps.',
      source_type: 'portfolio_alert',
      indicative_value_cr: 0.62,
    },
    {
      org_id: org.id,
      client_id: aarav.id,
      rm_profile_id: rmMeeraProfile.id,
      category: 'estate_planning',
      sub_category: 'Green transition mandate',
      fit_score: 90,
      headline: 'Family Trust green mandate expansion into ESG Sovereign Green Bonds.',
      evidence: 'Trustees approved up to ₹2.5 Cr additional allocation towards renewable energy infra.',
      source_type: 'interaction_note',
      indicative_value_cr: 2.50,
    },
  ];

  for (const o of oppData) {
    await prisma.wealthOpportunity.create({ data: o });
  }

  // 8. Seed Cross-Desk Tasks
  console.log('🌱 Seeding cross-desk operational tasks...');
  await prisma.wealthTask.deleteMany({ where: { org_id: org.id } });

  await prisma.wealthTask.createMany({
    data: [
      {
        org_id: org.id,
        client_id: rahul.id,
        rm_profile_id: rmPalashProfile.id,
        title: 'Call Rahul Mehta — Small-cap drift +6%',
        description: 'Rebalance volatile small-cap allocation before market open.',
        task_type: 'call',
        status: 'open',
        due_date: new Date(),
      },
      {
        org_id: org.id,
        client_id: priya.id,
        rm_profile_id: rmPalashProfile.id,
        title: 'Review NPS proposal with Priya Venkat',
        description: 'Prepare Tier-1 NPS tax calculation brief for 11:30 AM meeting.',
        task_type: 'portfolio_review',
        status: 'in_progress',
        due_date: new Date(),
      },
      {
        org_id: org.id,
        client_id: rohan.id,
        rm_profile_id: rmAnanyaProfile.id,
        title: 'Present Tech De-risking Memo to Rohan Deshmukh',
        description: 'Review 45% IT exposure and present Parag Parikh Flexi rebalance schedule.',
        task_type: 'meeting',
        status: 'open',
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      {
        org_id: org.id,
        client_id: vikramM.id,
        rm_profile_id: rmSiddharthProfile.id,
        title: 'Institutional IC review with Vikram Malhotra',
        description: 'Quarterly review on Structured Debt Mezzanine with CIO Devika Somani.',
        task_type: 'meeting',
        status: 'open',
        due_date: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
      {
        org_id: org.id,
        client_id: suresh.id,
        rm_profile_id: rmMeeraProfile.id,
        title: 'Send ₹62L Liquid Mutual Fund Switch slip to Suresh Nair',
        description: 'Conservative debt switch away from zero-yield savings.',
        task_type: 'email',
        status: 'open',
        due_date: new Date(),
      },
      {
        org_id: org.id,
        client_id: aarav.id,
        rm_profile_id: rmMeeraProfile.id,
        title: 'Coordinate Green Bond term sheet with Chawla Family Office',
        description: 'Follow up on ESG mandate execution.',
        task_type: 'call',
        status: 'in_progress',
        due_date: new Date(Date.now() + 12 * 60 * 60 * 1000),
      },
    ],
  });

  console.log('\n🎉 Multi-CIO Hierarchy & Rich Variation Seeded Successfully!');
  console.log('───────────────────────────────────────────────────────────────────');
  console.log('👑 Super Admin  : admin@quantcase.ai      (Quantcase@123)');
  console.log('💼 CIO 1 (Core) : cio@quantcase.ai        (Vikramaditya Singhania)');
  console.log('   ├── 👔 RM 1  : palash@quantcase.ai     (Palash Jain — 4 clients)');
  console.log('   └── 👔 RM 2  : ananya@quantcase.ai     (Ananya Sharma — 3 clients)');
  console.log('💼 CIO 2 (Alts) : devika@quantcase.ai     (Devika Somani)');
  console.log('   ├── 👔 RM 3  : siddharth@quantcase.ai  (Siddharth Rao — 3 clients)');
  console.log('   └── 👔 RM 4  : meera@quantcase.ai      (Meera Nambiar — 3 clients)');
  console.log('───────────────────────────────────────────────────────────────────');
}

main()
  .catch((e) => {
    console.error('❌ Seeder failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
