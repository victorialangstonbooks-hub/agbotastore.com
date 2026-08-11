'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const v = require('../lib/validate');
const { notifyOwners } = require('../lib/notify');

const router = express.Router();

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages sent. Please try again later.' },
});

/** POST /api/contact — public contact form. */
router.post('/', contactLimiter, async (req, res, next) => {
  try {
    const name = v.str(req.body.name, { min: 2, max: 80 });
    const email = v.email(req.body.email);
    const subject = req.body.subject ? v.str(req.body.subject, { max: 160 }) : null;
    const body = v.str(req.body.body, { min: 5, max: 3000 });

    if (!name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!email) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!body) return res.status(400).json({ error: 'Please enter your message.' });

    await db.query(
      'INSERT INTO contact_messages (name, email, subject, body) VALUES ($1,$2,$3,$4)',
      [name, email, subject, body]
    );

    await notifyOwners({
      type: 'contact_message',
      title: '📨 New contact message',
      body: `${name} (${email}): ${body.slice(0, 120)}`,
      link: '/admin#contact',
    });

    res.status(201).json({ ok: true, message: 'Thank you. Your message has been sent to Agbota Segun.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
