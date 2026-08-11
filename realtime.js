'use strict';

const { Server } = require('socket.io');
const db = require('./db');
const authLib = require('./lib/auth');
const messagesRoute = require('./routes/messages');
const notifyLib = require('./lib/notify');

/**
 * Socket.IO layer.
 * Realtime is an ENHANCEMENT only — every message is written to PostgreSQL
 * first by the HTTP API, so a dropped socket never loses data.
 */
function initRealtime(server) {
  const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 2e6,
  });

  // Authenticate each socket from the httpOnly session cookie.
  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie || '';
      const parsed = parseCookies(raw);
      let token = parsed[authLib.COOKIE_NAME];
      if (!token && socket.handshake.auth && socket.handshake.auth.token) {
        token = socket.handshake.auth.token;
      }
      const user = await authLib.userFromToken(token);
      if (!user) return next(new Error('unauthorized'));
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    socket.join(`user:${user.id}`);
    if (user.role === 'owner') socket.join('owners');

    // Streamers auto-join their own conversation room.
    if (user.role === 'streamer') {
      const convo = await messagesRoute.ensureConversationForUser(user.id);
      socket.join(`conversation:${convo.id}`);
      socket.emit('ready', { conversationId: convo.id, role: user.role });
    } else {
      socket.emit('ready', { role: user.role });
    }

    // Owner opens a specific conversation.
    socket.on('conversation:join', async (payload, ack) => {
      try {
        const id = parseInt(payload && payload.conversationId, 10);
        if (!id) return ack && ack({ error: 'Invalid conversation.' });

        if (user.role === 'owner') {
          const convo = await db.one('SELECT * FROM conversations WHERE id = $1', [id]);
          if (!convo) return ack && ack({ error: 'Conversation not found.' });
          socket.join(`conversation:${id}`);
          return ack && ack({ ok: true, conversationId: id });
        }
        // Streamers may only join their own.
        const own = await db.one('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [id, user.id]);
        if (!own) return ack && ack({ error: 'Forbidden.' });
        socket.join(`conversation:${id}`);
        ack && ack({ ok: true, conversationId: id });
      } catch (err) {
        ack && ack({ error: 'Could not join conversation.' });
      }
    });

    socket.on('conversation:leave', (payload) => {
      const id = parseInt(payload && payload.conversationId, 10);
      if (id) socket.leave(`conversation:${id}`);
    });

    // Text messages may be sent over the socket; they are still persisted first.
    socket.on('message:send', async (payload, ack) => {
      try {
        const message = await messagesRoute.createMessage({
          user,
          conversationId: payload && payload.conversationId,
          body: payload && payload.body,
        });
        ack && ack({ ok: true, message });
      } catch (err) {
        ack && ack({ error: err.message || 'Could not send message.' });
      }
    });

    socket.on('typing', (payload) => {
      const id = parseInt(payload && payload.conversationId, 10);
      if (!id) return;
      socket.to(`conversation:${id}`).emit('typing', {
        conversationId: id,
        role: user.role,
        name: user.name,
        typing: Boolean(payload.typing),
      });
    });

    socket.on('disconnect', () => { /* nothing to clean up — state lives in Postgres */ });
  });

  messagesRoute.setIo(io);
  notifyLib.setIo(io);
  return io;
}

function parseCookies(str) {
  const out = {};
  str.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(val); } catch (_) { out[k] = val; }
    }
  });
  return out;
}

module.exports = { initRealtime };
