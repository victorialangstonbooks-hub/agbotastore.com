'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

const CATEGORIES = [
  { key: 'client_conversations', label: 'Client Conversations' },
  { key: 'strategy_delivery', label: 'Strategy Delivery' },
  { key: 'channel_progress', label: 'Channel Progress' },
  { key: 'creator_analysis', label: 'Creator Analysis' },
  { key: 'positive_feedback', label: 'Positive Feedback' },
  { key: 'payout_revenue', label: 'Payout / Revenue' },
];

const shape = (r) => ({
  id: r.id,
  category: r.category,
  categoryLabel: (CATEGORIES.find((c) => c.key === r.category) || {}).label || r.category,
  title: r.title,
  caption: r.caption,
  fileId: r.file_id,
  url: `/api/files/${r.file_id}`,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
});

/**
 * GET /api/proof — public Proof of Work.
 * Returns ONLY what the owner has genuinely uploaded. Nothing is generated,
 * seeded or fabricated; an empty list is returned until the owner uploads.
 */
router.get('/', async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' && req.query.category !== 'all'
      ? req.query.category : null;

    const params = [];
    let where = 'p.is_published = TRUE';
    if (category && CATEGORIES.some((c) => c.key === category)) {
      params.push(category);
      where += ` AND p.category = $${params.length}`;
    }

    const rows = await db.many(
      `SELECT p.* FROM proof_items p
        WHERE ${where}
        ORDER BY p.sort_order ASC, p.created_at DESC`,
      params
    );

    const counts = await db.many(
      `SELECT category, COUNT(*)::int AS c FROM proof_items WHERE is_published = TRUE GROUP BY category`
    );
    const countMap = Object.fromEntries(counts.map((c) => [c.category, c.c]));

    res.json({
      categories: CATEGORIES.map((c) => ({ ...c, count: countMap[c.key] || 0 })),
      total: Object.values(countMap).reduce((a, b) => a + b, 0),
      items: rows.map(shape),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, CATEGORIES, shapeProof: shape };
