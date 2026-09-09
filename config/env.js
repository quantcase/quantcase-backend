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

  // Cache Redis (dedicated instance)
  cacheRedisHost:     process.env.CACHE_REDIS_HOST || process.env.REDIS_HOST || 'localhost',
  cacheRedisPort:     parseInt(process.env.CACHE_REDIS_PORT, 10) || parseInt(process.env.REDIS_PORT, 10) || 6379,
  cacheRedisPassword: process.env.CACHE_REDIS_PASSWORD || undefined,
  cacheRedisEnabled:  process.env.CACHE_REDIS_ENABLED !== 'false',

  // LLM APIs
  claudeApiKey:     process.env.CLAUDE_API_KEY,
  openaiApiKey:     process.env.OPENAI_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,

  // Google Cloud Vertex AI — OpenAI-compatible endpoint for Gemini.
  // When enabled, the L1 pipeline's Gemini calls route here (GCP credits)
  // instead of OpenRouter. Auth is GCP ADC (no static key). See config/vertexLlm.js.
  gcpProjectId:        process.env.GCP_PROJECT_ID,
  gcpVertexLocation:   process.env.GCP_VERTEX_LOCATION || 'global',
  // Master on/off switch — leave unset to keep the L1 pipeline on OpenRouter.
  vertexGeminiEnabled: process.env.VERTEX_GEMINI_ENABLED === 'true',
  // Ordered model preference for L1 Vertex calls: the first available model wins,
  // falling back to the next if a model isn't offered on Vertex.
  vertexGeminiModels:  (process.env.VERTEX_GEMINI_MODELS || 'google/gemini-3.5-flash,google/gemini-2.5-flash-lite')
                         .split(',').map((s) => s.trim()).filter(Boolean),

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
  trialPeriodHours:    parseInt(process.env.TRIAL_PERIOD_HOURS, 10) || (7 * 24),

  // Smallcase
  smallcaseEncryptionKey: process.env.SMALLCASE_ENCRYPTION_KEY,
  smallcaseGatewayName:   process.env.SMALLCASE_GATEWAY_NAME || 'quantcase',
  smallcaseSecret:        process.env.SMALLCASE_SECRET,      // shared secret — signs the x-gateway-authtoken JWT
  smallcaseApiSecret:     process.env.SMALLCASE_API_SECRET,  // API secret — x-gateway-secret header + webhook HMAC key
  smallcaseApiBaseUrl:    process.env.SMALLCASE_API_BASE_URL || 'https://gatewayapi.smallcase.com',

  // Prowess (CMIE) batch API — SendBatch/GetBatch/AbortAll/GetReport
  prowessApiKey:     process.env.PROWESS_API_KEY,
  prowessApiBaseUrl: process.env.PROWESS_API_BASE_URL || 'https://prowess.cmie.com/api',

  // Google Sign-In (verifies ID tokens from the frontend's Google OAuth flow)
  googleClientId:    process.env.GOOGLE_CLIENT_ID,
};
