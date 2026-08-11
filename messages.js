'use strict';

const express = require('express');
const db = require('../db');
const v = require('../lib/validate');
const { requireAuth } = require('../lib/auth');
const { uploadAny, saveFile, classify, uploadErrorHandler } = require('../lib/uploads');
const { notify, notifyOwners } = require('../lib/notify');

const router = express.Router();

let ioRef = null;
function setIo(io) { ioRef = io; }

/** Every streamer has exactly one conversation thread with Agbota Segun. */
async function ensureConversationForUser(userId) {
  let convo = await db.one('SELECT * FROM conversations WHERE user_id = $1', [userId]);
  if (!convo) {
    convo = await db.one(
      `INSERT INTO conversations (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [userId]
    );
  }
  return convo;
}

/** Resolves which conversation the requester is allowed to act on. */
async function resolveConversation(req, conversationIdRaw) {
  if (req.user.role === 'owner') {
    const id = v.intIn(conversationIdRaw, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return { error: 'Please select a conversation.', status: 400 };
    const convo = await db.one('SELECT * FROM conversations WHERE id = $1', [id]);
    if (!convo) return { error: 'Conversation not found.', status: 404 };
    return { convo };
  }
  // A streamer can only ever reach their own thread.
  const convo = await ensureConversationForUser(req.user.id);
  return { convo };
}

async function loadMessages(conversationId, { beforeId = null, limit = 50 } = {}) {
  const params = [conversationId];
  let where = 'm.conversation_id = $1';
  if (beforeId) { params.push(beforeId); where += ` AND m.id < $${params.length}`; }
  params.push(limit);

  const rows = await db.many(
    `SELECT m.id, m.conversation_id, m.sender_id, m.sender_role, m.body, m.kind, m.read_at, m.created_at,
            p.name AS sender_name
       FROM messages m
       JOIN profiles p ON p.id = m.sender_id
      WHERE ${where}
      ORDER BY m.id DESC
      LIMIT $${params.length}`,
    params
  );
  rows.reverse();

  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const atts = await db.many(
    `SELECT a.id, a.message_id, a.kind, a.duration_ms, a.file_id,
            f.filename, f.mime_type, f.size_bytes
       FROM message_attachments a
       JOIN files f ON f.id = a.file_id
      WHERE a.message_id = ANY($1::bigint[])`,
    [ids]
  );

  const byMessage = new Map();
  for (const a of atts) {
    if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
    byMessage.get(a.message_id).push({
      id: a.id,
      kind: a.kind,
      durationMs: a.duration_ms,
      fileId: a.file_id,
      filename: a.filename,
      mimeType: a.mime_type,
      sizeBytes: Number(a.size_bytes),
      url: `/api/files/${a.file_id}`,
    });
  }

  return rows.map((m) => ({
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    senderRole: m.sender_role,
    senderName: m.sender_name,
    body: m.body,
    kind: m.kind,
    read: Boolean(m.read_at),
    createdAt: m.created_at,
    attachments: byMessage.get(m.id) || [],
  }));
}

/** GET /api/messages/conversations — owner inbox, or the streamer's own thread. */
router.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === 'owner') {
      const rows = await db.many(
        `SELECT c.id, c.user_id, c.last_message_at, c.last_message_preview,
                p.name AS user_name, p.email AS user_email,
                (SELECT COUNT(*)::int FROM messages m
                  WHERE m.conversation_id = c.id AND m.sender_role = 'streamer' AND m.read_at IS NULL) AS unread
           FROM conversations c
           JOIN profiles p ON p.id = c.user_id
          WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
          ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC`
      );
      return res.json({
        conversations: rows.map((c) => ({
          id: c.id,
          userId: c.user_id,
          userName: c.user_name,
          userEmail: c.user_email,
          lastMessageAt: c.last_message_at,
          lastMessagePreview: c.last_message_preview,
          unread: c.unread,
        })),
      });
    }

    const convo = await ensureConversationForUser(req.user.id);
    const unread = await db.one(
      `SELECT COUNT(*)::int AS c FROM messages
        WHERE conversation_id = $1 AND sender_role = 'owner' AND read_at IS NULL`,
      [convo.id]
    );
    res.json({
      conversations: [{
        id: convo.id,
        userId: req.user.id,
        userName: 'Agbota Segun',
        userEmail: null,
        lastMessageAt: convo.last_message_at,
        lastMessagePreview: convo.last_message_preview,
        unread: unread.c,
      }],
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/messages/:conversationId — scrollable history, loaded from PostgreSQL. */
router.get('/:conversationId', requireAuth, async (req, res, next) => {
  try {
    const { convo, error, status } = await resolveConversation(req, req.params.conversationId);
    if (error) return res.status(status).json({ error });

    const beforeId = req.query.before ? v.intIn(req.query.before, 1, Number.MAX_SAFE_INTEGER) : null;
    const limit = v.intIn(req.query.limit, 1, 100) || 50;

    const messages = await loadMessages(convo.id, { beforeId, limit });
    res.json({ conversationId: convo.id, messages });
  } catch (err) {
    next(err);
  }
});

/** Shared send routine used by both HTTP and Socket.IO. */
async function createMessage({ user, conversationId, body, file, durationMs }) {
  const convo = user.role === 'owner'
    ? await db.one('SELECT * FROM conversations WHERE id = $1', [conversationId])
    : await ensureConversationForUser(user.id);

  if (!convo) throw Object.assign(new Error('Conversation not found.'), { status: 404 });

  const text = body ? String(body).slice(0, 5000).trim() : null;
  if (!text && !file) throw Object.assign(new Error('Message cannot be empty.'), { status: 400 });

  let savedFile = null;
  let kind = 'text';
  if (file) {
    kind = classify(file.mimetype);
    savedFile = await saveFile({
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
      ownerId: user.id,
      kind: kind === 'voice' ? 'voice' : 'attachment',
    });
  }

  const message = await db.tx(async (client) => {
    const m = (await client.query(
      `INSERT INTO messages (conversation_id, sender_id, sender_role, body, kind)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [convo.id, user.id, user.role, text, kind]
    )).rows[0];

    if (savedFile) {
      await client.query(
        `INSERT INTO message_attachments (message_id, file_id, kind, duration_ms)
         VALUES ($1,$2,$3,$4)`,
        [m.id, savedFile.id, kind === 'voice' ? 'voice' : kind === 'image' ? 'image' : 'file', durationMs || null]
      );
    }

    const preview = text
      ? text.slice(0, 120)
      : kind === 'voice' ? '🎤 Voice message'
      : kind === 'image' ? '🖼️ Image'
      : '📎 Attachment';

    await client.query(
      'UPDATE conversations SET last_message_at = now(), last_message_preview = $1 WHERE id = $2',
      [preview, convo.id]
    );
    return m;
  });

  const [full] = await loadMessages(convo.id, { limit: 1 });
  const payload = full && full.id === Number(message.id) ? full : (await loadMessages(convo.id, { limit: 1 }))[0];

  // Realtime fan-out to both sides.
  if (ioRef) {
    ioRef.to(`conversation:${convo.id}`).emit('message', payload);
    ioRef.to('owners').emit('inbox:update', {
      conversationId: convo.id,
      lastMessageAt: payload.createdAt,
      preview: payload.body || (payload.kind === 'voice' ? '🎤 Voice message' : '📎 Attachment'),
    });
  }

  // Notify the other party.
  if (user.role === 'streamer') {
    await notifyOwners({
      type: 'new_message',
      title: '💬 New message',
      body: `${user.name}: ${payload.body ? payload.body.slice(0, 90) : payload.kind === 'voice' ? 'sent a voice message' : 'sent an attachment'}`,
      link: `/admin#chat-${convo.id}`,
    });
  } else {
    await notify(convo.user_id, {
      type: 'new_message',
      title: '💬 New message from Agbota Segun',
      body: payload.body ? payload.body.slice(0, 120) : payload.kind === 'voice' ? 'Sent you a voice message' : 'Sent you an attachment',
      link: '/chat',
    });
  }

  return payload;
}

/** POST /api/messages — text and/or a single attachment (image, document, voice). */
router.post(
  '/',
  requireAuth,
  uploadAny.single('file'),
  async (req, res, next) => {
    try {
      const payload = await createMessage({
        user: req.user,
        conversationId: req.body.conversationId,
        body: req.body.body,
        file: req.file,
        durationMs: req.body.durationMs ? parseInt(req.body.durationMs, 10) : null,
      });
      res.status(201).json({ message: payload });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
  uploadErrorHandler
);

/** POST /api/messages/:conversationId/read — marks the other party's messages read. */
router.post('/:conversationId/read', requireAuth, async (req, res, next) => {
  try {
    const { convo, error, status } = await resolveConversation(req, req.params.conversationId);
    if (error) return res.status(status).json({ error });

    const otherRole = req.user.role === 'owner' ? 'streamer' : 'owner';
    await db.query(
      `UPDATE messages SET read_at = now()
        WHERE conversation_id = $1 AND sender_role = $2 AND read_at IS NULL`,
      [convo.id, otherRole]
    );

    if (ioRef) ioRef.to(`conversation:${convo.id}`).emit('read', { conversationId: convo.id, byRole: req.user.role });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** GET /api/messages/meta/unread — total unread for the badge. */
router.get('/meta/unread', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === 'owner') {
      const row = await db.one(
        `SELECT COUNT(*)::int AS c FROM messages WHERE sender_role = 'streamer' AND read_at IS NULL`
      );
      return res.json({ unread: row.c });
    }
    const convo = await ensureConversationForUser(req.user.id);
    const row = await db.one(
      `SELECT COUNT(*)::int AS c FROM messages
        WHERE conversation_id = $1 AND sender_role = 'owner' AND read_at IS NULL`,
      [convo.id]
    );
    res.json({ unread: row.c });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, setIo, ensureConversationForUser, createMessage, loadMessages };
