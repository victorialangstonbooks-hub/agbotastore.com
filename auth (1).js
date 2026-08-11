'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const v = require('../lib/validate');
const auth = require('../lib/auth');

const router = express.Router();

// Rate limiting on auth endpoints to blunt credential stuffing / brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  bio: u.bio || null,
  createdAt: u.created_at,
});

/** POST /api/auth/register */
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const name = v.str(req.body.name, { min: 2, max: 80 });
    const email = v.email(req.body.email);
    const password = v.password(req.body.password);

    if (!name) return res.status(400).json({ error: 'Please enter your name (at least 2 characters).' });
    if (!email) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!password) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const existing = await db.one('SELECT id FROM profiles WHERE lower(email) = lower($1)', [email]);
    if (existing) {
      return res.status(409).json({
        error: 'This email is already registered. Please log in instead.',
        code: 'EMAIL_EXISTS',
      });
    }

    const passwordHash = await auth.hashPassword(password);

    let user;
    try {
      user = await db.one(
        `INSERT INTO profiles (name, email, password_hash, role)
         VALUES ($1,$2,$3,'streamer')
         RETURNING id, name, email, role, bio, created_at`,
        [name, email, passwordHash]
      );
    } catch (err) {
      // Unique index is the real guarantee — handles the race condition too.
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'This email is already registered. Please log in instead.',
          code: 'EMAIL_EXISTS',
        });
      }
      throw err;
    }

    // Every streamer gets a conversation thread with the owner.
    await db.query(
      'INSERT INTO conversations (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [user.id]
    );

    const { token, expiresAt } = await auth.createSession(user, req);
    const csrf = auth.setSessionCookie(res, token, expiresAt, req);

    // `token` is returned so the frontend can fall back to an Authorization
    // header if the browser refuses/blocks cookies (e.g. third-party cookie
    // blocking, in-app browsers). The cookie remains the primary mechanism.
    res.status(201).json({ user: publicUser(user), csrfToken: csrf, token, expiresAt });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/login */
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const email = v.email(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter your email and password.' });
    }

    const user = await db.one(
      'SELECT id, name, email, role, password_hash, bio, created_at FROM profiles WHERE lower(email) = lower($1)',
      [email]
    );

    // Identical message for both cases so accounts cannot be enumerated.
    if (!user) {
      return res.status(401).json({ error: 'Incorrect email or password. Please try again.' });
    }

    const ok = await auth.verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Incorrect email or password. Please try again.' });
    }

    await db.query(
      'INSERT INTO conversations (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [user.id]
    );

    const { token, expiresAt } = await auth.createSession(user, req);
    const csrf = auth.setSessionCookie(res, token, expiresAt, req);

    // See note in /register — cookie is primary, token is the fallback.
    res.json({ user: publicUser(user), csrfToken: csrf, token, expiresAt });
  } catch (err) {
    next(err);
  }
});

/** GET /api/auth/me — restores the session after refresh / browser restart. */
router.get('/me', async (req, res) => {
  if (!req.user) {
    // `reason` is a diagnostic code only — never a secret. 'invalid_signature'
    // means JWT_SECRET changed since the token was issued.
    return res.json({
      user: null,
      reason: req.authFailure || 'no_token',
      tokenPresent: Boolean(auth.readToken(req)),
    });
  }
  res.json({ user: publicUser(req.user) });
});

/** POST /api/auth/logout */
router.post('/logout', async (req, res, next) => {
  try {
    const token = auth.readToken(req);
    if (token) await auth.revokeSession(token);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/auth/profile */
router.patch('/profile', auth.requireAuth, async (req, res, next) => {
  try {
    const name = v.str(req.body.name, { min: 2, max: 80 });
    const bio = req.body.bio === null || req.body.bio === undefined
      ? null
      : v.str(req.body.bio, { min: 0, max: 600 });

    if (!name) return res.status(400).json({ error: 'Please enter a valid name.' });

    const user = await db.one(
      `UPDATE profiles SET name = $1, bio = $2, updated_at = now()
       WHERE id = $3
       RETURNING id, name, email, role, bio, created_at`,
      [name, bio, req.user.id]
    );
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/change-password */
router.post('/change-password', auth.requireAuth, authLimiter, async (req, res, next) => {
  try {
    const current = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const next_ = v.password(req.body.newPassword);
    if (!next_) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

    const row = await db.one('SELECT password_hash FROM profiles WHERE id = $1', [req.user.id]);
    const ok = await auth.verifyPassword(current, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Your current password is incorrect.' });

    const hash = await auth.hashPassword(next_);
    await db.query('UPDATE profiles SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
