'use strict';

const express = require('express');
const db = require('../db');
const v = require('../lib/validate');
const { requireAuth } = require('../lib/auth');
const { notifyOwners } = require('../lib/notify');

const router = express.Router();

/**
 * GET /api/reviews — published reviews only.
 * These are always real: a review row can only exist if it is attached to a
 * completed order belonging to the reviewer. Nothing is seeded or fabricated.
 */
router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT r.id, r.rating, r.body, r.created_at,
              pr.name AS reviewer_name,
              p.name AS product_name
         FROM reviews r
         JOIN profiles pr ON pr.id = r.user_id
    LEFT JOIN products p ON p.id = r.product_id
        WHERE r.is_published = TRUE
        ORDER BY r.created_at DESC
        LIMIT 50`
    );
    const summary = await db.one(
      'SELECT COUNT(*)::int AS count, COALESCE(AVG(rating), 0)::numeric(3,2) AS average FROM reviews WHERE is_published = TRUE'
    );
    res.json({
      reviews: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        createdAt: r.created_at,
        reviewerName: r.reviewer_name,
        productName: r.product_name,
      })),
      summary: { count: summary.count, average: Number(summary.average) },
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/reviews — only for the reviewer's own COMPLETED order. */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const orderId = v.intIn(req.body.orderId, 1, Number.MAX_SAFE_INTEGER);
    const rating = v.intIn(req.body.rating, 1, 5);
    const body = req.body.body ? v.str(req.body.body, { max: 2000 }) : null;

    if (!orderId) return res.status(400).json({ error: 'Invalid order.' });
    if (!rating) return res.status(400).json({ error: 'Please choose a rating between 1 and 5.' });

    const order = await db.one('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, req.user.id]);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    if (order.status !== 'completed') {
      return res.status(403).json({
        error: 'You can leave a review once your order is marked completed.',
      });
    }

    const existing = await db.one('SELECT id FROM reviews WHERE order_id = $1', [orderId]);
    if (existing) return res.status(409).json({ error: 'You have already reviewed this order.' });

    const item = await db.one('SELECT product_id FROM order_items WHERE order_id = $1 ORDER BY id LIMIT 1', [orderId]);

    const review = await db.one(
      `INSERT INTO reviews (user_id, order_id, product_id, rating, body)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, rating, body, created_at`,
      [req.user.id, orderId, item ? item.product_id : null, rating, body]
    );

    await notifyOwners({
      type: 'review_created',
      title: '⭐ New review',
      body: `${req.user.name} left a ${rating}-star review on order ${order.reference}.`,
      link: '/admin#reviews',
    });

    res.status(201).json({ review });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
