'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const { migrate } = require('./db/migrate');
const { seed } = require('./db/seed');
const authLib = require('./lib/auth');
const { initRealtime } = require('./realtime');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const { router: orderRoutes } = require('./routes/orders');
const { router: messageRoutes } = require('./routes/messages');
const fileRoutes = require('./routes/files');
const { router: proofRoutes } = require('./routes/proof');
const reviewRoutes = require('./routes/reviews');
const notificationRoutes = require('./routes/notifications');
const contactRoutes = require('./routes/contact');
const adminRoutes = require('./routes/admin');

const app = express();

// Render terminates TLS at its proxy — required for secure cookies and rate limiting.
if (config.trustProxy) app.set('trust proxy', 1);

app.disable('x-powered-by');

// ETags on API responses cause 304 revalidations that can replay a stale
// anonymous body after login. All API responses are per-user, so no ETags.
app.set('etag', false);

// ---------- security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: wss:",
      "font-src 'self' data:",
      "form-action 'self'",
    ].join('; ')
  );
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(authLib.attachUser);

// ---------- health check (Render) ----------
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/health/full', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, database: 'connected', env: config.env, time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

/**
 * Auth diagnostics — no secrets, only a fingerprint and booleans.
 * If jwtSecretFingerprint CHANGES after a redeploy while jwtSecretFromEnv is
 * true, then JWT_SECRET is being changed in the environment and every user
 * will be logged out. If jwtSecretFromEnv is false on a deployed instance,
 * that is the bug.
 */
app.get('/api/health/auth', (req, res) => {
  res.json({
    ok: true,
    env: config.env,
    deployed: config.isDeployed,
    jwtSecretFromEnv: config.jwtSecretFromEnv,
    jwtSecretFingerprint: config.jwtSecretFingerprint,
    secureCookiesConfigured: config.secureCookies,
    requestSeenAsSecure: authLib.isSecureRequest(req),
    xForwardedProto: req.get('x-forwarded-proto') || null,
    trustProxy: config.trustProxy,
    sessionDays: config.sessionDays,
    sessionCookiePresent: Boolean(req.cookies && req.cookies[authLib.COOKIE_NAME]),
    authenticated: Boolean(req.user),
  });
});

// Public site configuration (no secrets — only what the UI must display).
app.get('/api/config', (_req, res) => {
  res.json({
    businessName: 'Agbota Segun',
    maxUploadMb: config.maxUploadMb,
    payments: {
      bitcoinConfigured: Boolean(config.payments.btcAddress),
      paypalConfigured: Boolean(config.payments.paypalInstructions),
    },
  });
});

// ---------- API ----------
// Never cache API responses — they are all per-user.
app.use('/api', authLib.noStore);
app.use('/api', authLib.csrfProtect);
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/proof', proofRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));

// ---------- static frontend ----------
const publicDir = path.join(__dirname, '..', 'public');
/**
 * Asset versioning.
 *
 * Each HTML page is rewritten in memory at boot so /assets/js/app.js becomes
 * /assets/js/app.js?v=<content-hash>. When app.js changes, the URL changes, so
 * a browser can never pair NEW html with an OLD cached app.js.
 *
 * That skew is exactly what produced "AS.onAuthenticated is not a function":
 * the html had been updated but the previously cached script had not.
 */
const assetVersion = (relPath) => {
  try {
    const buf = fs.readFileSync(path.join(publicDir, relPath));
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  } catch (_) {
    return String(Date.now());
  }
};

const ASSET_V = {
  js: assetVersion('assets/js/app.js'),
  css: assetVersion('assets/css/styles.css'),
};
console.log(`[boot] asset versions: app.js=${ASSET_V.js} styles.css=${ASSET_V.css}`);

const htmlCache = new Map();
function renderPage(name) {
  if (htmlCache.has(name)) return htmlCache.get(name);
  let html = fs.readFileSync(path.join(publicDir, name), 'utf8');
  html = html
    .replace(/\/assets\/js\/app\.js(\?v=[^"']*)?/g, `/assets/js/app.js?v=${ASSET_V.js}`)
    .replace(/\/assets\/css\/styles\.css(\?v=[^"']*)?/g, `/assets/css/styles.css?v=${ASSET_V.css}`);
  htmlCache.set(name, html);
  return html;
}

/**
 * Static assets.
 *
 * HTML is served with `no-cache` (revalidate every time) while CSS/JS keep a
 * long cache. Previously BOTH were cached for an hour independently, so after
 * a deploy a browser could hold NEW html + OLD app.js.
 */
// Serve real static files (css/js/images) only. HTML is deliberately NOT served
// here — it goes through renderPage() below so asset URLs are always versioned.
app.use((req, res, next) => {
  if (/\.html?$/i.test(req.path)) return next();
  express.static(publicDir, {
    index: false,
    setHeaders(r, filePath) {
      if (/\.(js|css)$/i.test(filePath)) {
        // Safe to cache hard: the URL carries a content hash (?v=).
        r.setHeader('Cache-Control', config.isProd ? 'public, max-age=31536000, immutable' : 'no-cache');
      } else {
        r.setHeader('Cache-Control', config.isProd ? 'public, max-age=3600' : 'no-cache');
      }
    },
  })(req, res, next);
});

// HTML pages must always revalidate so they can never be paired with a stale
// cached app.js/styles.css from a previous deploy.
const page = (name) => (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(renderPage(name));
};
app.get('/', page('index.html'));
app.get('/strategies', page('strategies.html'));
app.get('/strategy/:slug', page('strategy.html'));
app.get('/proof-of-work', page('proof.html'));
app.get('/about', page('about.html'));
app.get('/contact', page('contact.html'));
app.get('/access', page('access.html'));
app.get('/login', page('access.html'));
app.get('/register', page('access.html'));
app.get('/dashboard', page('dashboard.html'));
app.get('/chat', page('chat.html'));
app.get('/checkout/:slug', page('checkout.html'));
app.get('/admin', page('admin.html'));
app.get('*', (_req, res) => {
  res.status(404).setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(renderPage('404.html'));
});

// ---------- error handler ----------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Passwords and secrets are never logged.
  console.error('[error]', err.message);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large.' });
  }
  res.status(err.status || 500).json({
    error: config.isProd ? 'Something went wrong. Please try again.' : err.message,
  });
});

const server = http.createServer(app);
initRealtime(server);

async function start() {
  // Authentication diagnostics. The secret itself is NEVER logged — only a
  // short fingerprint. If this fingerprint changes between restarts while
  // JWT_SECRET is supposed to be set, every existing login will break.
  console.log(
    `[boot] auth: env=${config.env} deployed=${config.isDeployed} ` +
    `jwtSecretFromEnv=${config.jwtSecretFromEnv} jwtSecretFingerprint=${config.jwtSecretFingerprint} ` +
    `secureCookies=${config.secureCookies} trustProxy=${config.trustProxy} sessionDays=${config.sessionDays}`
  );
  if (!config.jwtSecretFromEnv) {
    console.warn('[boot] WARNING: JWT_SECRET is NOT from the environment — sessions will NOT survive a restart.');
  }

  try {
    await db.query('SELECT 1');
    console.log('[boot] PostgreSQL connected');
    await migrate();
    await seed();
    await authLib.cleanupExpiredSessions();
  } catch (err) {
    console.error('[boot] startup failed:', err.message);
    process.exit(1);
  }

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] Agbota Segun running on http://0.0.0.0:${config.port} (${config.env})`);
  });
}

// Graceful shutdown so Render restarts cleanly.
const shutdown = (signal) => {
  console.log(`[shutdown] ${signal} received`);
  server.close(() => {
    db.pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) start();

module.exports = { app, server, start };
