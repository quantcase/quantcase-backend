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
  // Base URL used to build absolute links to locally-uploaded files (see
  // routes/admin.documentUpload.routes.js) so worker.js can fetch() them.
  publicBaseUrl:    process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8000}`,

  // Razorpay
  razorpayKeyId:       process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret:   process.env.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  // Debug logging for the Razorpay flow is on by default; set RAZORPAY_DEBUG=false to silence it.
  razorpayDebug:       process.env.RAZORPAY_DEBUG !== 'false',

  // Smallcase
  smallcaseEncryptionKey: process.env.SMALLCASE_ENCRYPTION_KEY,
  smallcaseGatewayName:   process.env.SMALLCASE_GATEWAY_NAME || 'quantcase',
  smallcaseSecret:        process.env.SMALLCASE_SECRET,      // shared secret — signs the x-gateway-authtoken JWT
  smallcaseApiSecret:     process.env.SMALLCASE_API_SECRET,  // API secret — x-gateway-secret header + webhook HMAC key
  smallcaseApiBaseUrl:    process.env.SMALLCASE_API_BASE_URL || 'https://gatewayapi.smallcase.com',

  // Prowess (CMIE) batch API — SendBatch/GetBatch/AbortAll/GetReport
  prowessApiKey:     process.env.PROWESS_API_KEY,
  prowessApiBaseUrl: process.env.PROWESS_API_BASE_URL || 'https://prowess.cmie.com/api',
};
