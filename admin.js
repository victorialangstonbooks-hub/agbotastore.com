'use strict';

const express = require('express');
const db = require('../db');
const v = require('../lib/validate');
const { requireOwner } = require('../lib/auth');
const { uploadImage, saveFile, uploadErrorHandler } = require('../lib/uploads');
const { notify } = require('../lib/notify');
const { loadOrder, STATUS_LABEL } = require('./orders');
const { CATEGORIES, shapeProof } = require('./proof');

const router = express.Router();

// Every route in this file is server-side protected. Frontend hiding is never trusted.
router.use(requireOwner);

/** GET /api/admin/stats */
router.get('/stats', async (_req, res, next) => {
  try {
    const [customers, orders, pendingPayments, unreadMessages, reviews, proof, revenue] = await Promise.all([
      db.one("SELECT COUNT(*)::int AS c FROM profiles WHERE role = 'streamer'"),
      db.one('SELECT COUNT(*)::int AS c FROM orders'),
      db.one("SELECT COUNT(*)::int AS c FROM payment_submissions WHERE status = 'submitted'"),
      db.one("SELECT COUNT(*)::int AS c FROM messages WHERE sender_role = 'streamer' AND read_at IS NULL"),
      db.one('SELECT COUNT(*)::int AS c FROM reviews'),
      db.one('SELECT COUNT(*)::int AS c FROM proof_items'),
      db.one("SELECT COALESCE(SUM(amount_cents),0)::int AS s FROM orders WHERE payment_status = 'confirmed'"),
    ]);
    res.json({
      customers: customers.c,
      orders: orders.c,
      pendingPayments: pendingPayments.c,
      unreadMessages: unreadMessages.c,
      reviews: reviews.c,
      proofItems: proof.c,
      confirmedRevenue: revenue.s / 100,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/orders */
router.get('/orders', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : null;
    const params = [];
    let where = '1=1';
    if (status && STATUS_LABEL[status]) { params.push(status); where += ` AND o.status = $${params.length}`; }

    const rows = await db.many(
      `SELECT o.id FROM orders o WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`,
      params
    );
    const orders = [];
    for (const r of rows) orders.push(await loadOrder(r.id));
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/orders/:id — update order status / delivery note. */
router.patch('/orders/:id', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid order id.' });

    const order = await db.one('SELECT * FROM orders WHERE id = $1', [id]);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    const status = req.body.status ? v.oneOf(req.body.status, Object.keys(STATUS_LABEL)) : null;
    if (req.body.status && !status) return res.status(400).json({ error: 'Invalid order status.' });

    const deliveryNote = req.body.deliveryNote !== undefined
      ? (req.body.deliveryNote === null ? null : v.str(req.body.deliveryNote, { max: 2000 }))
      : undefined;

    await db.query(
      `UPDATE orders
          SET status = COALESCE($1, status),
              delivery_note = COALESCE($2, delivery_note),
              updated_at = now()
        WHERE id = $3`,
      [status, deliveryNote === undefined ? null : deliveryNote, id]
    );

    if (status && status !== order.status) {
      await notify(order.user_id, {
        type: 'order_status',
        title: `Order ${order.reference} — ${STATUS_LABEL[status]}`,
        body: `Your order status has been updated to "${STATUS_LABEL[status]}".`,
        link: `/dashboard#order-${id}`,
      });
    }

    res.json({ order: await loadOrder(id) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/payments */
router.get('/payments', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : null;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where += ` AND ps.status = $${params.length}`; }

    const rows = await db.many(
      `SELECT ps.*, o.reference AS order_reference, o.amount_cents AS order_amount,
              p.name AS customer_name, p.email AS customer_email
         FROM payment_submissions ps
         JOIN orders o ON o.id = ps.order_id
         JOIN profiles p ON p.id = ps.user_id
        WHERE ${where}
        ORDER BY ps.created_at DESC LIMIT 200`,
      params
    );

    res.json({
      payments: rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        orderReference: r.order_reference,
        customerName: r.customer_name,
        customerEmail: r.customer_email,
        method: r.method,
        reference: r.reference,
        amount: (r.amount_cents || r.order_amount) / 100,
        proofFileId: r.proof_file_id,
        proofUrl: r.proof_file_id ? `/api/files/${r.proof_file_id}` : null,
        status: r.status,
        adminNote: r.admin_note,
        reviewedAt: r.reviewed_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/payments/:id/confirm — CONFIRM PAYMENT */
router.post('/payments/:id/confirm', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid payment id.' });

    const sub = await db.one('SELECT * FROM payment_submissions WHERE id = $1', [id]);
    if (!sub) return res.status(404).json({ error: 'Payment submission not found.' });

    const order = await db.one('SELECT * FROM orders WHERE id = $1', [sub.order_id]);

    await db.tx(async (client) => {
      await client.query(
        `UPDATE payment_submissions
            SET status = 'confirmed', reviewed_at = now(), reviewed_by = $1, admin_note = $2
          WHERE id = $3`,
        [req.user.id, req.body.note ? String(req.body.note).slice(0, 1000) : null, id]
      );
      await client.query(
        `UPDATE orders
            SET payment_status = 'confirmed', status = 'payment_confirmed', updated_at = now()
          WHERE id = $1`,
        [sub.order_id]
      );
    });

    await notify(sub.user_id, {
      type: 'payment_confirmed',
      title: '✅ PAYMENT CONFIRMED',
      body: `Your payment for order ${order.reference} has been confirmed. Work will begin shortly.`,
      link: `/dashboard#order-${sub.order_id}`,
    });

    res.json({ ok: true, order: await loadOrder(sub.order_id) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/payments/:id/reject */
router.post('/payments/:id/reject', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid payment id.' });

    const sub = await db.one('SELECT * FROM payment_submissions WHERE id = $1', [id]);
    if (!sub) return res.status(404).json({ error: 'Payment submission not found.' });
    const order = await db.one('SELECT * FROM orders WHERE id = $1', [sub.order_id]);
    const note = req.body.note ? String(req.body.note).slice(0, 1000) : null;

    await db.tx(async (client) => {
      await client.query(
        `UPDATE payment_submissions SET status='rejected', reviewed_at=now(), reviewed_by=$1, admin_note=$2 WHERE id=$3`,
        [req.user.id, note, id]
      );
      await client.query(
        `UPDATE orders SET payment_status='rejected', status='pending_payment', updated_at=now() WHERE id=$1`,
        [sub.order_id]
      );
    });

    await notify(sub.user_id, {
      type: 'payment_rejected',
      title: 'Payment could not be verified',
      body: `Your payment for order ${order.reference} could not be verified.${note ? ' Note: ' + note : ''} Please message Agbota Segun in Chat.`,
      link: `/dashboard#order-${sub.order_id}`,
    });

    res.json({ ok: true, order: await loadOrder(sub.order_id) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/customers */
router.get('/customers', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT p.id, p.name, p.email, p.created_at,
              (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = p.id) AS order_count,
              (SELECT COALESCE(SUM(o.amount_cents),0)::int FROM orders o
                WHERE o.user_id = p.id AND o.payment_status = 'confirmed') AS spent_cents
         FROM profiles p
        WHERE p.role = 'streamer'
        ORDER BY p.created_at DESC LIMIT 300`
    );
    res.json({
      customers: rows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        createdAt: c.created_at,
        orderCount: c.order_count,
        spent: c.spent_cents / 100,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** ---------------- Proof of Work management ---------------- */

/** GET /api/admin/proof */
router.get('/proof', async (_req, res, next) => {
  try {
    const rows = await db.many('SELECT * FROM proof_items ORDER BY sort_order ASC, created_at DESC');
    res.json({
      categories: CATEGORIES,
      items: rows.map((r) => ({ ...shapeProof(r), isPublished: r.is_published })),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/proof — upload a genuine screenshot supplied by the owner. */
router.post(
  '/proof',
  uploadImage.single('image'),
  async (req, res, next) => {
    try {
      const category = v.oneOf(req.body.category, CATEGORIES.map((c) => c.key));
      const title = v.str(req.body.title, { min: 2, max: 160 });
      const caption = req.body.caption ? v.str(req.body.caption, { max: 800 }) : null;

      if (!req.file) return res.status(400).json({ error: 'Please choose an image to upload.' });
      if (!category) return res.status(400).json({ error: 'Please choose a valid proof category.' });
      if (!title) return res.status(400).json({ error: 'Please enter a title.' });

      const saved = await saveFile({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        ownerId: req.user.id,
        kind: 'proof',
        isPublic: true, // Proof of Work is displayed publicly.
      });

      const maxRow = await db.one('SELECT COALESCE(MAX(sort_order), 0)::int AS m FROM proof_items');

      const item = await db.one(
        `INSERT INTO proof_items (category, title, caption, file_id, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [category, title, caption, saved.id, maxRow.m + 10, req.user.id]
      );

      res.status(201).json({ item: { ...shapeProof(item), isPublished: item.is_published } });
    } catch (err) {
      next(err);
    }
  },
  uploadErrorHandler
);

/** PATCH /api/admin/proof/:id — edit title/caption/category/order/publish. */
router.patch('/proof/:id', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid proof id.' });

    const existing = await db.one('SELECT * FROM proof_items WHERE id = $1', [id]);
    if (!existing) return res.status(404).json({ error: 'Proof item not found.' });

    const category = req.body.category ? v.oneOf(req.body.category, CATEGORIES.map((c) => c.key)) : null;
    if (req.body.category && !category) return res.status(400).json({ error: 'Invalid category.' });
    const title = req.body.title ? v.str(req.body.title, { min: 2, max: 160 }) : null;
    const caption = req.body.caption !== undefined
      ? (req.body.caption === null ? null : v.str(req.body.caption, { max: 800 })) : undefined;
    const sortOrder = req.body.sortOrder !== undefined ? v.intIn(req.body.sortOrder, 0, 100000) : null;
    const isPublished = typeof req.body.isPublished === 'boolean' ? req.body.isPublished : null;

    const item = await db.one(
      `UPDATE proof_items SET
         category = COALESCE($1, category),
         title = COALESCE($2, title),
         caption = CASE WHEN $3::boolean THEN $4 ELSE caption END,
         sort_order = COALESCE($5, sort_order),
         is_published = COALESCE($6, is_published),
         updated_at = now()
       WHERE id = $7 RETURNING *`,
      [category, title, caption !== undefined, caption === undefined ? null : caption, sortOrder, isPublished, id]
    );

    res.json({ item: { ...shapeProof(item), isPublished: item.is_published } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/proof/reorder */
router.post('/proof/reorder', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((i) => parseInt(i, 10)).filter(Boolean) : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'Provide an ordered list of proof ids.' });
    await db.tx(async (client) => {
      for (let i = 0; i < ids.length; i++) {
        await client.query('UPDATE proof_items SET sort_order = $1, updated_at = now() WHERE id = $2', [(i + 1) * 10, ids[i]]);
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/admin/proof/:id */
router.delete('/proof/:id', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid proof id.' });
    const item = await db.one('SELECT * FROM proof_items WHERE id = $1', [id]);
    if (!item) return res.status(404).json({ error: 'Proof item not found.' });
    await db.tx(async (client) => {
      await client.query('DELETE FROM proof_items WHERE id = $1', [id]);
      await client.query('DELETE FROM files WHERE id = $1', [item.file_id]);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** ---------------- Reviews moderation ---------------- */

router.get('/reviews', async (_req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT r.*, p.name AS reviewer_name, pr.name AS product_name, o.reference
         FROM reviews r
         JOIN profiles p ON p.id = r.user_id
         JOIN orders o ON o.id = r.order_id
    LEFT JOIN products pr ON pr.id = r.product_id
        ORDER BY r.created_at DESC LIMIT 200`
    );
    res.json({
      reviews: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        reviewerName: r.reviewer_name,
        productName: r.product_name,
        orderReference: r.reference,
        isPublished: r.is_published,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/reviews/:id', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid review id.' });
    const isPublished = typeof req.body.isPublished === 'boolean' ? req.body.isPublished : null;
    if (isPublished === null) return res.status(400).json({ error: 'Nothing to update.' });
    await db.query('UPDATE reviews SET is_published = $1 WHERE id = $2', [isPublished, id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/reviews/:id', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid review id.' });
    await db.query('DELETE FROM reviews WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** ---------------- Products ---------------- */

router.get('/products', async (_req, res, next) => {
  try {
    const rows = await db.many('SELECT * FROM products ORDER BY sort_order ASC');
    res.json({
      products: rows.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        price: p.price_cents / 100,
        priceNote: p.price_note,
        tier: p.tier,
        isActive: p.is_active,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Owner can toggle availability. Prices remain owner-defined and are not auto-changed. */
router.patch('/products/:id', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid product id.' });
    const isActive = typeof req.body.isActive === 'boolean' ? req.body.isActive : null;
    if (isActive === null) return res.status(400).json({ error: 'Nothing to update.' });
    await db.query('UPDATE products SET is_active = $1, updated_at = now() WHERE id = $2', [isActive, id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** ---------------- Contact messages ---------------- */

router.get('/contact', async (_req, res, next) => {
  try {
    const rows = await db.many('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 200');
    res.json({ messages: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
