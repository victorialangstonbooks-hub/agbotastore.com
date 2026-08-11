'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');

const COOKIE_NAME = 'as_session';
const CSRF_COOKIE = 'as_csrf';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Creates a persistent session: a JWT is issued to the browser, and its
 * hash is stored in PostgreSQL so sessions survive restarts and can be revoked.
 */
async function createSession(user, req) {
  const jti = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);

  const token = jwt.sign(
    { sub: String(user.id), role: user.role, jti },
    config.jwtSecret,
    { expiresIn: `${config.sessionDays}d` }
  );

  await db.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      user.id,
      sha256(jti),
      (req && req.get && req.get('user-agent')) ? String(req.get('user-agent')).slice(0, 400) : null,
      (req && req.ip) ? String(req.ip).slice(0, 80) : null,
      expiresAt,
    ]
  );

  return { token, expiresAt };
}

/**
 * Decides whether the Secure flag can be set on this specific response.
 *
 * A cookie marked `Secure` is SILENTLY DISCARDED by the browser when the
 * response did not travel over HTTPS. On Render, TLS is terminated at the edge
 * and the app is reached over plain HTTP, so we must trust X-Forwarded-Proto
 * (Express does this via `trust proxy`) rather than guessing from NODE_ENV.
 */
function isSecureRequest(req) {
  if (!req) return config.secureCookies;
  if (req.secure) return true; // set by Express when trust proxy sees https
  const xfp = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (xfp) return xfp === 'https';
  return config.secureCookies;
}

function cookieOptions(expiresAt, req) {
  return {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

function setSessionCookie(res, token, expiresAt, req) {
  const secure = isSecureRequest(req);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  // Double-submit CSRF token. Readable by JS on purpose.
  const csrf = crypto.randomBytes(24).toString('hex');
  res.cookie(CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return csrf;
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

async function revokeSession(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(payload.jti)]);
  } catch (_) { /* invalid token — nothing to revoke */ }
}

/**
 * Resolves a token into a live user by checking the DB session row.
 * Returns null when the token is invalid, revoked or expired.
 */
/**
 * Resolves a token to a user, and records WHY it failed on req (when given).
 *
 * Failure reasons are surfaced only as a short machine-readable code so that a
 * production issue can be diagnosed without guessing. In particular
 * 'invalid_signature' means the token was signed with a different JWT_SECRET
 * than the one currently loaded — i.e. the secret is missing or rotating.
 */
async function userFromToken(token, req) {
  const mark = (reason) => { if (req) req.authFailure = reason; };
  if (!token) { mark('no_token'); return null; }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') mark('expired');
    else if (err && err.message === 'invalid signature') mark('invalid_signature');
    else mark('malformed');
    return null;
  }
  if (!payload || !payload.jti) { mark('malformed'); return null; }

  const row = await db.one(
    `SELECT p.id, p.name, p.email, p.role, p.avatar_file_id, p.bio, p.created_at
       FROM sessions s
       JOIN profiles p ON p.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sha256(payload.jti)]
  );
  if (!row) { mark('session_not_found'); return null; }
  return row;
}

function readToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const auth = req.get && req.get('authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/** Attaches req.user when a valid session exists. Never blocks. */
async function attachUser(req, _res, next) {
  try {
    req.user = await userFromToken(readToken(req), req);
  } catch (err) {
    req.user = null;
    req.authFailure = 'error';
  }
  next();
}

/**
 * Per-user responses must never be cached or revalidated.
 *
 * Without this, a browser can cache the anonymous `{"user":null}` response for
 * /api/auth/me and then serve it (or get a 304) AFTER the user logs in — the
 * app then believes nobody is signed in and bounces them back to the login
 * screen. Disabling ETag/304 for these routes removes that whole failure mode.
 */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Vary', 'Cookie, Authorization');
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
}

/** Server-side owner guard. Frontend hiding is never relied upon. */
function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Forbidden. Owner access only.' });
  next();
}

/** Double-submit cookie CSRF check for state-changing requests. */
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  // Only enforced once a session cookie exists (login/register are unauthenticated).
  if (!cookieToken) return next();
  if (!headerToken || headerToken !== cookieToken) {
    return res.status(403).json({ error: 'Invalid CSRF token. Please refresh the page and try again.' });
  }
  next();
}

async function cleanupExpiredSessions() {
  try {
    await db.query('DELETE FROM sessions WHERE expires_at < now() - interval \'7 days\'');
  } catch (err) {
    console.error('[auth] session cleanup failed:', err.message);
  }
}

module.exports = {
  COOKIE_NAME,
  CSRF_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  userFromToken,
  readToken,
  attachUser,
  requireAuth,
  requireOwner,
  csrfProtect,
  cleanupExpiredSessions,
  isSecureRequest,
  noStore,
};
