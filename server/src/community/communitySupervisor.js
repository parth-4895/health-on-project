const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');
const config = require('../config/community.config');
const { startIdentityServer } = require('./identity-service');
const { startSafetyServer } = require('./safety-service');
const { createPushSender, runOnce } = require('./worker');
const { createDatabase } = require('./database');

let identityServer = null;
let safetyServer = null;
let sweeperIntervalId = null;
let isSweeping = false;

function resolveRulesFile(filePath) {
  if (filePath && fs.existsSync(filePath)) return filePath;
  const repoRules = path.resolve(__dirname, '../config/community-rules.json');
  if (fs.existsSync(repoRules)) return repoRules;
  return null;
}

/**
 * Validates whether the minimum required settings for in-process community
 * hosting are present. Missing configuration is handled gracefully without
 * crashing the primary Express API server.
 */
function isConfigured(cfg) {
  const safetyDb = cfg.safetyDatabaseUrl || cfg.workerDatabaseUrl;
  const jobsDb = cfg.jobsDatabaseUrl || cfg.workerDatabaseUrl;
  if (!cfg.identityDatabaseUrl || !safetyDb || !jobsDb || !cfg.identityServiceKey || !cfg.safetyServiceKey) {
    return false;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return false;
  }
  if (!resolveRulesFile(cfg.rulesFile)) {
    return false;
  }
  return true;
}

/**
 * Starts the internal Identity and Safety HTTP services on loopback (127.0.0.1)
 * and initializes the periodic queue sweeper worker.
 */
function start(options = {}) {
  const cfg = { ...config, ...options };

  if (!cfg.autoStartServices) {
    logger.info('Community in-process auto-start disabled by configuration', { scope: 'community' });
    return false;
  }

  if (process.env.NODE_ENV === 'test' && !options.forceStart) {
    return false;
  }

  if (!isConfigured(cfg)) {
    logger.info('Community in-process services unconfigured or missing rules; skipping community startup', {
      scope: 'community',
    });
    return false;
  }

  try {
    // 1. Start Identity Service on loopback
    identityServer = startIdentityServer({
      port: cfg.identityPort,
      host: cfg.identityHost,
      env: {
        ...process.env,
        COMMUNITY_IDENTITY_DATABASE_URL: cfg.identityDatabaseUrl,
        COMMUNITY_IDENTITY_SERVICE_KEY: cfg.identityServiceKey,
        COMMUNITY_IDENTITY_PORT: cfg.identityPort,
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      },
    });

    identityServer.on('error', (err) => {
      logger.error('Community identity service failed to listen', {
        scope: 'community-identity',
        code: err.code || 'ERR_IDENTITY_LISTEN',
      });
    });

    // 2. Start Safety Service on loopback
    const safetyDb = cfg.safetyDatabaseUrl || cfg.workerDatabaseUrl;
    const rulesFile = resolveRulesFile(cfg.rulesFile);
    safetyServer = startSafetyServer({
      port: cfg.safetyPort,
      host: cfg.safetyHost,
      env: {
        ...process.env,
        COMMUNITY_SAFETY_DATABASE_URL: safetyDb,
        COMMUNITY_WORKER_DATABASE_URL: safetyDb,
        COMMUNITY_SAFETY_SERVICE_KEY: cfg.safetyServiceKey,
        COMMUNITY_SAFETY_PORT: cfg.safetyPort,
        COMMUNITY_RULES_FILE: rulesFile,
        COMMUNITY_LLM_PROVIDER: cfg.llmProvider,
        COMMUNITY_GEMINI_MODEL: cfg.geminiModel,
        GEMINI_API_KEY: cfg.geminiApiKey,
        COMMUNITY_LLM_BYPASS: cfg.llmBypass ? 'true' : 'false',
        COMMUNITY_LLM_TIMEOUT_MS: cfg.llmTimeoutMs,
        OLLAMA_URL: cfg.ollamaUrl,
        COMMUNITY_MODEL: cfg.communityModel,
        COMMUNITY_MODEL_VERSION: cfg.communityModelVersion,
      },
    });

    safetyServer.on('error', (err) => {
      logger.error('Community safety service failed to listen', {
        scope: 'community-safety',
        code: err.code || 'ERR_SAFETY_LISTEN',
      });
    });

    // 3. Start Background Queue Sweeper
    const jobsDb = cfg.jobsDatabaseUrl || cfg.workerDatabaseUrl;
    const workerDb = createDatabase(jobsDb);
    let fcmCredentials = null;
    if (cfg.fcmCredentialsFile && fs.existsSync(cfg.fcmCredentialsFile)) {
      try {
        fcmCredentials = JSON.parse(fs.readFileSync(cfg.fcmCredentialsFile, 'utf8'));
      } catch (err) {
        logger.warn('Failed to parse community FCM credentials; push notifications disabled', {
          scope: 'community-worker',
          code: 'ERR_FCM_PARSE',
        });
      }
    }
    const pushSender = createPushSender(fcmCredentials);

    sweeperIntervalId = setInterval(async () => {
      if (isSweeping) return;
      isSweeping = true;
      try {
        await runOnce(workerDb, pushSender);
      } catch (err) {
        logger.error('Community worker sweeper iteration failed', {
          scope: 'community-worker',
          code: err.code || 'ERR_COMMUNITY_SWEEPER',
        });
      } finally {
        isSweeping = false;
      }
    }, cfg.sweeperPollMs);

    if (typeof sweeperIntervalId.unref === 'function') {
      sweeperIntervalId.unref();
    }

    logger.info('Community in-process services started', {
      scope: 'community',
      identityPort: cfg.identityPort,
      safetyPort: cfg.safetyPort,
      sweeperPollMs: cfg.sweeperPollMs,
    });

    return true;
  } catch (err) {
    logger.error('Failed to initialize community in-process services', {
      scope: 'community',
      code: err.code || 'ERR_COMMUNITY_INIT',
    });
    stop();
    return false;
  }
}

/**
 * Gracefully shuts down in-process community services and stops the sweeper.
 */
function stop() {
  if (sweeperIntervalId) {
    clearInterval(sweeperIntervalId);
    sweeperIntervalId = null;
  }

  if (identityServer && typeof identityServer.close === 'function') {
    try {
      identityServer.close();
    } catch (_) {}
    identityServer = null;
  }

  if (safetyServer && typeof safetyServer.close === 'function') {
    try {
      safetyServer.close();
    } catch (_) {}
    safetyServer = null;
  }

  isSweeping = false;
  logger.info('Community in-process services stopped', { scope: 'community' });
}

function getStatus() {
  return {
    running: Boolean(identityServer || safetyServer || sweeperIntervalId),
    identityActive: Boolean(identityServer),
    safetyActive: Boolean(safetyServer),
    sweeperActive: Boolean(sweeperIntervalId),
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  isConfigured,
};
