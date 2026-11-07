/**
 * Community Subsystem Configuration.
 *
 * Centralizes tunables and credentials for:
 * - Community Public API router
 * - Community Identity service
 * - Community Safety/moderation service
 * - Community background Sweeper worker
 */

const env = process.env;

module.exports = {
  // Whether to auto-start internal Identity, Safety, and Sweeper services in-process
  autoStartServices: env.COMMUNITY_AUTO_START_SERVICES !== 'false',

  // Internal loopback ports and hosts
  identityPort: Number(env.COMMUNITY_IDENTITY_PORT || 4101),
  safetyPort: Number(env.COMMUNITY_SAFETY_PORT || 4102),
  identityHost: env.COMMUNITY_IDENTITY_HOST || '127.0.0.1',
  safetyHost: env.COMMUNITY_SAFETY_HOST || '127.0.0.1',

  // Background jobs sweeper polling cadence (ms)
  sweeperPollMs: Number(env.COMMUNITY_WORKER_POLL_MS || 30000),

  // URLs and secrets
  identityUrl: env.COMMUNITY_IDENTITY_URL || 'http://127.0.0.1:4101',
  safetyUrl: env.COMMUNITY_SAFETY_URL || 'http://127.0.0.1:4102',
  identityServiceKey: env.COMMUNITY_IDENTITY_SERVICE_KEY || '',
  safetyServiceKey: env.COMMUNITY_SAFETY_SERVICE_KEY || '',

  // Database URLs with dedicated capability roles
  communityDatabaseUrl: env.COMMUNITY_DATABASE_URL || '',
  identityDatabaseUrl: env.COMMUNITY_IDENTITY_DATABASE_URL || '',
  safetyDatabaseUrl: env.COMMUNITY_SAFETY_DATABASE_URL || env.COMMUNITY_WORKER_DATABASE_URL || '',
  jobsDatabaseUrl: env.COMMUNITY_JOBS_DATABASE_URL || env.COMMUNITY_WORKER_DATABASE_URL || '',
  workerDatabaseUrl: env.COMMUNITY_WORKER_DATABASE_URL || '',

  // Secret file paths
  rulesFile: env.COMMUNITY_RULES_FILE || '',
  fcmCredentialsFile: env.COMMUNITY_FCM_CREDENTIALS_FILE || '',

  // LLM screening controls
  llmProvider: env.COMMUNITY_LLM_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : 'ollama'),
  geminiApiKey: env.GEMINI_API_KEY || env.LLM_API_KEY || '',
  geminiModel: env.COMMUNITY_GEMINI_MODEL || 'gemini-3.5-flash-lite',
  llmBypass: env.COMMUNITY_LLM_BYPASS === 'true',
  llmTimeoutMs: Number(env.COMMUNITY_LLM_TIMEOUT_MS || 30000),
  ollamaUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434',
  communityModel: env.COMMUNITY_MODEL || '',
  communityModelVersion: env.COMMUNITY_MODEL_VERSION || '',
};
