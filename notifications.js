'use strict';

const express = require('express');
const db = require('../db');
const v = require('../lib/validate');
const { requireAuth } = require('../lib/auth');
const { unreadCount } = require('../lib/notify');

const router = express.Router();

/** GET /api/notifications */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT id, type, title, body, link, read_at, created_at
         FROM notifications WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 80`,
      [req.user.id]
    );
    res.json({
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        read: Boolean(n.read_at),
        createdAt: n.created_at,
      })),
      unread: await unreadCount(req.user.id),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/notifications/:id/read */
router.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid notification.' });
    await db.query(
      'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
      [id, req.user.id]
    );
    res.json({ ok: true, unread: await unreadCount(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/notifications/read-all */
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
    res.json({ ok: true, unread: 0 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
