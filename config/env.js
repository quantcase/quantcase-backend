'use strict';

/**
 * Single source of truth for all environment variables.
 * Import this module instead of reading process.env directly throughout the codebase.
 */
module.exports = {
  port:             process.env.PORT || 8000,
  nodeEnv:          process.env.NODE_ENV || 'development',

  // Database
  databaseUrl:      process.env.DATABASE_URL,

  // Redis (BullMQ)
  redisHost:        process.env.REDIS_HOST || 'localhost',
  redisPort:        parseInt(process.env.REDIS_PORT) || 6379,
  redisPassword:    process.env.REDIS_PASSWORD || undefined,

  // LLM APIs
  claudeApiKey:     process.env.CLAUDE_API_KEY,
  openaiApiKey:     process.env.OPENAI_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,

  // App config
  fiscalYearEnd:    process.env.FISCAL_YEAR_END || '03-31',

  // Razorpay
  razorpayKeyId:       process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret:   process.env.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,

  // Smallcase
  smallcaseEncryptionKey: process.env.SMALLCASE_ENCRYPTION_KEY,
};
