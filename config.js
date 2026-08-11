'use strict';

require('dotenv').config();

const bool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const isProd = NODE_ENV === 'production';

// Any real deployment (Render sets RENDER / RENDER_SERVICE_ID) is treated as
// deployed even if NODE_ENV was mistyped or never set. This prevents a
// deployment from silently falling back to insecure development behaviour.
const isDeployed = isProd
  || Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL)
  || String(process.env.FORCE_SECURE_COOKIES || '').toLowerCase() === 'true';

if (!process.env.DATABASE_URL) {
  console.error('[config] FATAL: DATABASE_URL is not set. A persistent PostgreSQL database is required.');
  process.exit(1);
}

/**
 * JWT secret.
 *
 * CRITICAL: this must be STABLE across restarts. If it changes, every
 * previously issued session token fails verification and users are silently
 * logged out on the next request — which looks exactly like "login works,
 * then it bounces me back to the login screen".
 *
 * A random per-boot secret is therefore only ever allowed on a local
 * development machine, and even then it is loudly announced.
 */
const rawSecret = (process.env.JWT_SECRET || '').trim();

if (!rawSecret && isDeployed) {
  console.error(
    '[config] FATAL: JWT_SECRET is not set.\n' +
    '  A deployed instance must have a stable JWT_SECRET, otherwise every restart\n' +
    '  invalidates all logins and users get bounced back to the login screen.\n' +
    '  Fix: set JWT_SECRET in your Render environment variables, then redeploy.\n' +
    '  Generate one with:  openssl rand -hex 48'
  );
  process.exit(1);
}

if (rawSecret && rawSecret.length < 32 && isDeployed) {
  console.error('[config] FATAL: JWT_SECRET is too short (needs at least 32 characters).');
  process.exit(1);
}

let jwtSecret = rawSecret;
if (!jwtSecret) {
  jwtSecret = require('crypto').randomBytes(48).toString('hex');
  console.warn(
    '[config] WARNING: JWT_SECRET is not set. A temporary secret was generated for local\n' +
    '         development only. Every restart will log everyone out. Set JWT_SECRET in .env.'
  );
}

const config = {
  env: NODE_ENV,
  isProd,
  isDeployed,
  port: parseInt(process.env.PORT || '10000', 10),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret,
  // Fingerprint only — used for boot diagnostics. The secret itself is never logged.
  jwtSecretFingerprint: require('crypto').createHash('sha256').update(jwtSecret).digest('hex').slice(0, 12),
  jwtSecretFromEnv: Boolean(rawSecret),
  sessionDays: parseInt(process.env.SESSION_DAYS || '30', 10),
  admin: {
    email: (process.env.ADMIN_EMAIL || 'agbotasegun.outreach@gmail.com').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Agbota Segun',
  },
  payments: {
    btcAddress: (process.env.BTC_ADDRESS || '').trim(),
    paypalInstructions:
      (process.env.PAYPAL_INSTRUCTIONS || '').trim() ||
      'Pay through PayPal Friends and Family. PayPal email: Ajayiawwl100@gmail.com',
  },
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '10', 10),
  trustProxy: bool(process.env.TRUST_PROXY, true),
  // Postgres on Render requires SSL; local dev usually does not.
  pgSsl: bool(process.env.PGSSL, isDeployed),
  // Cookies are only marked Secure when actually served over HTTPS.
  // Marking them Secure on plain HTTP makes the browser silently DROP them.
  secureCookies: bool(process.env.SECURE_COOKIES, isDeployed),
};

config.maxUploadBytes = config.maxUploadMb * 1024 * 1024;

module.exports = config;
