'use strict';

const prisma = require('../config/prisma');

/**
 * POST /api/models
 * Create a new portfolio model.
 */
async function createModel(req, res, next) {
  try {
    const { name, riskProfile, capital, assetClasses, client, positions, whyThisPortfolio } = req.body;

    if (!name || !riskProfile || capital == null || !assetClasses) {
      return res.status(400).json({ error: 'name, riskProfile, capital, and assetClasses are required' });
    }

    const model = await prisma.portfolioModel.create({
      data: {
        name,
        riskProfile,
        capital,
        assetClasses,
        client:           client           ?? null,
        positions:        positions         ?? null,
        whyThisPortfolio: whyThisPortfolio  ?? null,
      },
    });

    return res.status(201).json(model);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/models
 * Return all portfolio models, newest first.
 */
async function getModels(req, res, next) {
  try {
    const models = await prisma.portfolioModel.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return res.json(models);
  } catch (err) {
    next(err);
  }
}

module.exports = { createModel, getModels };
