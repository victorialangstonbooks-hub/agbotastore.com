'use strict';

const db = require('../db');

let ioRef = null;
function setIo(io) { ioRef = io; }

/**
 * Persists a notification in PostgreSQL and pushes it live over Socket.IO.
 * Counts survive refresh/restart because the source of truth is the database.
 */
async function notify(userId, { type, title, body = null, link = null }) {
  if (!userId) return null;
  const row = await db.one(
    `INSERT INTO notifications (user_id, type, title, body, link)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, user_id, type, title, body, link, read_at, created_at`,
    [userId, type, title, body, link]
  );
  if (ioRef) {
    const unread = await unreadCount(userId);
    ioRef.to(`user:${userId}`).emit('notification', { notification: row, unread });
  }
  return row;
}

async function notifyOwners(payload) {
  const owners = await db.many("SELECT id FROM profiles WHERE role = 'owner'");
  const out = [];
  for (const o of owners) out.push(await notify(o.id, payload));
  return out;
}

async function unreadCount(userId) {
  const row = await db.one(
    'SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return row ? row.c : 0;
}

module.exports = { notify, notifyOwners, unreadCount, setIo };
