'use strict';

module.exports = {
  jwtSecret:           process.env.JWT_SECRET || 'qc2026-secret',
  jwtRefreshSecret:    process.env.JWT_REFRESH_SECRET || 'qc2026-refresh-secret',
  jwtExpiresIn:        process.env.JWT_EXPIRES_IN || '24h',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
};
