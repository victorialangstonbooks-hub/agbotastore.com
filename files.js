'use strict';

const express = require('express');
const db = require('../db');
const v = require('../lib/validate');
const { getFile } = require('../lib/uploads');

const router = express.Router();

/**
 * GET /api/files/:id
 * Authorization rules:
 *  - public files (Proof of Work images) are served to everyone
 *  - the owner can view anything
 *  - a streamer can only view files they uploaded, files attached to their own
 *    conversation, or proof attached to their own payment submissions
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = v.intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ error: 'Invalid file id.' });

    const file = await getFile(id);
    if (!file) return res.status(404).json({ error: 'File not found.' });

    let allowed = false;
    if (file.is_public) {
      allowed = true;
    } else if (req.user) {
      if (req.user.role === 'owner') {
        allowed = true;
      } else if (String(file.owner_id) === String(req.user.id)) {
        allowed = true;
      } else {
        // Attached to a message inside this streamer's own conversation?
        const link = await db.one(
          `SELECT 1 FROM message_attachments a
             JOIN messages m ON m.id = a.message_id
             JOIN conversations c ON c.id = m.conversation_id
            WHERE a.file_id = $1 AND c.user_id = $2
            LIMIT 1`,
          [id, req.user.id]
        );
        if (link) allowed = true;
        if (!allowed) {
          const pay = await db.one(
            'SELECT 1 FROM payment_submissions WHERE proof_file_id = $1 AND user_id = $2 LIMIT 1',
            [id, req.user.id]
          );
          if (pay) allowed = true;
        }
      }
    }

    if (!allowed) return res.status(403).json({ error: 'You do not have access to this file.' });

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', file.size_bytes);
    res.setHeader('Cache-Control', file.is_public ? 'public, max-age=86400' : 'private, max-age=0, no-store');
    // Prevents any uploaded file from being interpreted as an executable document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const inlineOk = file.mime_type.startsWith('image/') || file.mime_type.startsWith('audio/') || file.mime_type === 'application/pdf';
    const safeName = String(file.filename).replace(/["\r\n]/g, '');
    res.setHeader('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename="${safeName}"`);
    res.send(file.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
