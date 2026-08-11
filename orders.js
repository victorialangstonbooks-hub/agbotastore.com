'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const v = require('../lib/validate');
const { requireAuth } = require('../lib/auth');
const { uploadProof, saveFile, uploadErrorHandler } = require('../lib/uploads');
const { notify, notifyOwners } = require('../lib/notify');
const config = require('../config');

const router = express.Router();

const STATUS_LABEL = {
  pending_payment: 'Pending Payment',
  payment_submitted: 'Payment Submitted',
  payment_confirmed: 'Payment Confirmed',
  in_progress: 'In Progress',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function makeReference() {
  return 'AS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function loadOrder(orderId, userId = null) {
  const params = [orderId];
  let sql = `SELECT o.*, p.name AS customer_name, p.email AS customer_email
               FROM orders o JOIN profiles p ON p.id = o.user_id
              WHERE o.id = $1`;
  if (userId) { sql += ' AND o.user_id = $2'; params.push(userId); }
  const order = await db.one(sql, params);
  if (!order) return null;

  const items = await db.many(
    'SELECT id, product_id, product_name, unit_price_cents, quantity FROM order_items WHERE order_id = $1 ORDER BY id',
    [order.id]
  );
  const payments = await db.many(
    `SELECT id, method, reference, amount_cents, proof_file_id, status, admin_note, reviewed_at, created_at
       FROM payment_submissions WHERE order_id = $1 ORDER BY created_at DESC`,
    [order.id]
  );
  const review = await db.one('SELECT id, rating, body, created_at FROM reviews WHERE order_id = $1', [order.id]);

  return {
    id: order.id,
    reference: order.reference,
    userId: order.user_id,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    amount: order.amount_cents / 100,
    amountCents: order.amount_cents,
    currency: order.currency,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    status: order.status,
    statusLabel: STATUS_LABEL[order.status] || order.status,
    notes: order.notes,
    deliveryNote: order.delivery_note,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      name: i.product_name,
      unitPrice: i.unit_price_cents / 100,
      quantity: i.quantity,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      reference: p.reference,
      amount: p.amount_cents ? p.amount_cents / 100 : null,
      proofFileId: p.proof_file_id,
      status: p.status,
      adminNote: p.admin_note,
      reviewedAt: p.reviewed_at,
      createdAt: p.created_at,
    })),
    review: review ? { id: review.id, rating: review.rating, body: review.body, createdAt: review.created_at } : null,
    canReview: order.status === 'completed' && !review,
  };
}

/** GET /api/orders — the logged-in streamer's own orders only. */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.many('SELECT id FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const orders = [];
    for (const r of rows) orders.push(await loadOrder(r.id, req.user.id));
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/** GET /api/orders/:id — ownership enforced server-side. */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid order id.' });
    // Owner may view any order; streamers only their own.
    const order = await loadOrder(id, req.user.role === 'owner' ? null : req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

/** POST /api/orders — create a real order from a product. */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const slug = v.str(req.body.productSlug, { min: 1, max: 120 });
    const notes = req.body.notes ? v.str(req.body.notes, { max: 1200 }) : null;
    if (!slug) return res.status(400).json({ error: 'Please choose a strategy.' });

    const product = await db.one('SELECT * FROM products WHERE slug = $1 AND is_active = TRUE', [slug]);
    if (!product) return res.status(404).json({ error: 'Strategy not found.' });

    const order = await db.tx(async (client) => {
      const o = (await client.query(
        `INSERT INTO orders (reference, user_id, amount_cents, payment_status, status, notes)
         VALUES ($1,$2,$3,'pending','pending_payment',$4)
         RETURNING *`,
        [makeReference(), req.user.id, product.price_cents, notes]
      )).rows[0];

      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity)
         VALUES ($1,$2,$3,$4,1)`,
        [o.id, product.id, product.name, product.price_cents]
      );
      return o;
    });

    await notify(req.user.id, {
      type: 'order_created',
      title: 'Order created',
      body: `Your order ${order.reference} for ${product.name} has been created. Next step: submit your payment.`,
      link: `/dashboard#order-${order.id}`,
    });

    await notifyOwners({
      type: 'order_created',
      title: '🧾 New order created',
      body: `${req.user.name} created order ${order.reference} — ${product.name} ($${(product.price_cents / 100).toFixed(2)})`,
      link: `/admin#order-${order.id}`,
    });

    res.status(201).json({ order: await loadOrder(order.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/orders/:id/payment — "PAYMENT MADE".
 * Creates a payment submission, optionally with an uploaded proof file,
 * and notifies the owner.
 */
router.post(
  '/:id/payment',
  requireAuth,
  uploadProof.single('proof'),
  async (req, res, next) => {
    try {
      const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
      if (!id) return res.status(400).json({ error: 'Invalid order id.' });

      const order = await db.one('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!order) return res.status(404).json({ error: 'Order not found.' });

      const method = v.oneOf(req.body.method, ['bitcoin', 'paypal']);
      if (!method) return res.status(400).json({ error: 'Please choose Bitcoin or PayPal.' });

      const reference = req.body.reference ? v.str(req.body.reference, { max: 400 }) : null;

      let proofFileId = null;
      if (req.file) {
        const saved = await saveFile({
          buffer: req.file.buffer,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          ownerId: req.user.id,
          kind: 'payment_proof',
        });
        proofFileId = saved.id;
      }

      const submission = await db.tx(async (client) => {
        const s = (await client.query(
          `INSERT INTO payment_submissions (order_id, user_id, method, reference, amount_cents, proof_file_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,'submitted')
           RETURNING *`,
          [order.id, req.user.id, method, reference, order.amount_cents, proofFileId]
        )).rows[0];

        await client.query(
          `UPDATE orders
              SET payment_method = $1, payment_status = 'submitted', status = 'payment_submitted', updated_at = now()
            WHERE id = $2`,
          [method, order.id]
        );
        return s;
      });

      await notify(req.user.id, {
        type: 'payment_submitted',
        title: 'Payment submitted',
        body: `Your payment for order ${order.reference} is under review. You will be notified once it is confirmed.`,
        link: `/dashboard#order-${order.id}`,
      });

      await notifyOwners({
        type: 'payment_submitted',
        title: '💰 PAYMENT MADE',
        body: `${req.user.name} submitted a ${method === 'bitcoin' ? 'Bitcoin' : 'PayPal'} payment for order ${order.reference} ($${(order.amount_cents / 100).toFixed(2)}).${proofFileId ? ' Payment proof attached.' : ''}`,
        link: `/admin#payment-${submission.id}`,
      });

      res.status(201).json({ order: await loadOrder(order.id, req.user.id) });
    } catch (err) {
      next(err);
    }
  },
  uploadErrorHandler
);

/** GET /api/orders/meta/payment-info — BTC address + PayPal instructions from env. */
router.get('/meta/payment-info', requireAuth, (_req, res) => {
  res.json({
    bitcoin: {
      address: config.payments.btcAddress || null,
      configured: Boolean(config.payments.btcAddress),
      note: config.payments.btcAddress
        ? 'Send the exact order amount to this Bitcoin address, then paste your transaction ID below and upload your payment screenshot.'
        : 'The Bitcoin address has not been configured yet. Please message Agbota Segun in Chat for payment details.',
    },
    paypal: {
      instructions: config.payments.paypalInstructions,
      note: 'After paying, paste your PayPal transaction ID below and upload your payment screenshot.',
    },
  });
});

module.exports = { router, loadOrder, STATUS_LABEL };
