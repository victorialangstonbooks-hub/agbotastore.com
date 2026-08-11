'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

const shape = (p) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  price: p.price_cents / 100,
  priceCents: p.price_cents,
  priceNote: p.price_note,
  tier: p.tier,
  tagline: p.tagline,
  description: p.description,
  includes: p.includes || [],
  audience: p.audience,
  platforms: p.platforms || [],
  sortOrder: p.sort_order,
});

/** GET /api/products */
router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.many(
      'SELECT * FROM products WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC'
    );
    res.json({ products: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/products/:slug */
router.get('/:slug', async (req, res, next) => {
  try {
    const p = await db.one('SELECT * FROM products WHERE slug = $1 AND is_active = TRUE', [req.params.slug]);
    if (!p) return res.status(404).json({ error: 'Strategy not found.' });

    const reviews = await db.many(
      `SELECT r.id, r.rating, r.body, r.created_at, pr.name AS reviewer_name
         FROM reviews r
         JOIN profiles pr ON pr.id = r.user_id
        WHERE r.product_id = $1 AND r.is_published = TRUE
        ORDER BY r.created_at DESC
        LIMIT 20`,
      [p.id]
    );

    res.json({
      product: shape(p),
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        createdAt: r.created_at,
        reviewerName: r.reviewer_name,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
