'use strict';

const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const prisma      = require('../config/prisma');
const { jwtSecret, jwtRefreshSecret, jwtExpiresIn, jwtRefreshExpiresIn } = require('../config/auth');
const authService = require('../services/auth.service');

function issueTokens(user) {
  const payload = { sub: user.id, email: user.email, accountType: user.account_type };
  return {
    access_token:  jwt.sign(payload, jwtSecret,        { expiresIn: jwtExpiresIn }),
    refresh_token: jwt.sign(payload, jwtRefreshSecret, { expiresIn: jwtRefreshExpiresIn }),
  };
}

const register = async (req, res) => {
  const { email, mobile, password, display_name } = req.body;
  const user = await authService.register({ email, mobile, password, display_name });
  const tokens = issueTokens(user);
  return res.status(201).json({
    ...tokens,
    user: { id: user.id, email: user.email, accountType: user.account_type },
  });
};

const signin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  return res.json(issueTokens(user));
};

const getMe = async (req, res) => {
  const profile = await authService.getFullProfile(req.user.sub);
  return res.json(profile);
};

const updateOnboarding = async (req, res) => {
  const profile = await authService.updateOnboarding(req.user.sub, req.body);
  return res.json({ success: true, data: profile });
};

module.exports = { register, signin, getMe, updateOnboarding };
