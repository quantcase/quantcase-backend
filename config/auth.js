'use strict';

module.exports = {
  jwtSecret:            process.env.JWT_SECRET || 'qc2026-secret',
  jwtRefreshSecret:     process.env.JWT_REFRESH_SECRET || 'qc2026-refresh-secret',
  jwtExpiresIn:         process.env.JWT_EXPIRES_IN || '24h',
  jwtRefreshExpiresIn:  process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // Temporary whitelist — replace with DB-backed users when auth is fully built out
  whitelistedUsers: [
    {
      id: '1',
      email: 'hello@quantcase.ai',
      accountType: 'manager',
      // bcrypt hash of 'helloqc'
      passwordHash: '$2b$10$4QOc6eVHV.Y2vfun3zKtu.k0FcHS83M/ZeJmIh.DueWPnjld9zoDu',
    },
    {
      id: '2',
      email: 'raj@quantcase.ai',
      accountType: 'investor',
      // bcrypt hash of 'helloqc'
      passwordHash: '$2b$10$frzEL3OPYmGGiWyXleNW2OZaL79dFRD5Q6fQGuuwZ.d7f5TNkClim',
    },
  ],
};
