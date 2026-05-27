'use strict';

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma  = require('../config/prisma');
const { jwtSecret, jwtRefreshSecret, jwtExpiresIn, jwtRefreshExpiresIn } = require('../config/auth');

const signin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!user.password_hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const payload = { sub: user.id, email: user.email, accountType: user.account_type };

  const accessToken  = jwt.sign(payload, jwtSecret,        { expiresIn: jwtExpiresIn });
  const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: jwtRefreshExpiresIn });

  return res.json({ access_token: accessToken, refresh_token: refreshToken });
};

const getMe = (req, res) => {
  const { sub: id, email, accountType } = req.user;
  return res.json({ id, email, accountType });
};

module.exports = { signin, getMe };
