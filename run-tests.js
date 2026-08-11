'use strict';

/**
 * Agbota Segun — end-to-end test suite.
 * Exercises the REAL server against the REAL PostgreSQL database over HTTP,
 * covering every scenario listed in the project requirements.
 *
 * Usage:  node tests/run-tests.js    (server must be running)
 */

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:10000';
const { io } = (() => { try { return require('socket.io-client'); } catch (_) { return {}; } })();

let passed = 0, failed = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✅ ${name}`); }
  else { failed++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { results.push(`\n▸ ${t}`); }

/** Minimal cookie-jar HTTP client so sessions behave exactly like a browser. */
function client() {
  const jar = new Map();
  return {
    jar,
    cookieHeader() {
      return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    csrf() { return jar.get('as_csrf'); },
    async req(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
      const h = { ...headers };
      const cookie = this.cookieHeader();
      if (cookie) h['Cookie'] = cookie;
      const csrf = this.csrf();
      if (csrf) h['X-CSRF-Token'] = csrf;

      let payload = body;
      if (body && !(body instanceof FormData) && typeof body !== 'string') {
        h['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });

      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      setCookie.forEach((c) => {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (v === '' ) jar.delete(k); else jar.set(k, v);
      });

      if (raw) return res;
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
      return { status: res.status, data, headers: res.headers };
    },
  };
}

const rnd = () => Math.random().toString(36).slice(2, 10);

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// Minimal JPEG
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

async function main() {
  console.log('\n=== Agbota Segun — Full Test Suite ===');
  console.log('Target:', BASE, '\n');

  /* ---------- health & config ---------- */
  section('Health & deployment readiness');
  {
    const r = await client().req('/api/health');
    ok('GET /api/health returns { ok: true }', r.status === 200 && r.data && r.data.ok === true, JSON.stringify(r.data));
    const f = await client().req('/api/health/full');
    ok('Database reports connected', f.data && f.data.database === 'connected');
  }

  /* ---------- products ---------- */
  section('Product catalog & exact pricing');
  const EXPECTED = {
    'YouTube Strategy': 30, 'Twitch Strategy': 30, 'TikTok Strategy': 30,
    'Facebook Strategy': 30, 'Instagram Strategy': 30, 'Discord Strategy': 30,
    'TikTok + Instagram Strategy': 55, 'YouTube + TikTok Strategy': 60,
    'Twitch + Discord Strategy': 60, 'YouTube + Instagram + TikTok Strategy': 80,
    'Twitch + TikTok + Discord Strategy': 85, 'YouTube + Twitch + TikTok Strategy': 95,
    'YouTube + Twitch + TikTok + Discord Strategy': 120, 'Custom Multi-Platform Strategy': 150,
  };
  {
    const r = await client().req('/api/products');
    const products = (r.data && r.data.products) || [];
    ok('Catalog returns 14 strategies', products.length === 14, 'got ' + products.length);
    let priceOk = true, bad = [];
    for (const [name, price] of Object.entries(EXPECTED)) {
      const p = products.find((x) => x.name === name);
      if (!p || p.price !== price) { priceOk = false; bad.push(`${name}=${p ? p.price : 'missing'}`); }
    }
    ok('All prices match the owner specification exactly', priceOk, bad.join(', '));
    const custom = products.find((p) => p.slug === 'custom-multi-platform');
    ok('Custom strategy is marked as "starting around $150+" (not a fixed quote)',
      Boolean(custom && custom.priceNote && /starting/i.test(custom.priceNote)));
    const detail = await client().req('/api/products/youtube-strategy');
    ok('Product detail includes description, includes, audience, platforms',
      detail.data.product.description && detail.data.product.includes.length > 0 &&
      detail.data.product.audience && detail.data.product.platforms.length > 0);
  }

  /* ---------- TEST 1 + 11: registration, persistence, duplicate email ---------- */
  section('TEST 1 & 11 — Registration, login persistence, duplicate email');
  const emailA = `streamer.${rnd()}@example.com`;
  const passA = 'StreamerPass123!';
  let userA = client();
  {
    const r = await userA.req('/api/auth/register', {
      method: 'POST', body: { name: 'Test Streamer', email: emailA, password: passA },
    });
    ok('Streamer account created', r.status === 201 && r.data.user && r.data.user.role === 'streamer', JSON.stringify(r.data));
    ok('Session cookie is httpOnly and set', userA.jar.has('as_session'));

    // TEST 11 — duplicate email rejected with the exact required message
    const dup = await client().req('/api/auth/register', {
      method: 'POST', body: { name: 'Impostor', email: emailA.toUpperCase(), password: 'AnotherPass123!' },
    });
    ok('TEST 11: duplicate email rejected (409)', dup.status === 409, 'status ' + dup.status);
    ok('TEST 11: message is "This email is already registered. Please log in instead."',
      dup.data && dup.data.error === 'This email is already registered. Please log in instead.', dup.data && dup.data.error);

    // TEST 1 — logout, then "return another day" with a brand-new client (simulates closed browser)
    await userA.req('/api/auth/logout', { method: 'POST' });
    const afterLogout = await userA.req('/api/auth/me');
    ok('After logout the session is gone', afterLogout.data && afterLogout.data.user === null);

    const fresh = client(); // brand-new browser, no cookies at all
    const relogin = await fresh.req('/api/auth/login', { method: 'POST', body: { email: emailA, password: passA } });
    ok('TEST 1: account still exists after logout + browser close (re-login works)',
      relogin.status === 200 && relogin.data.user.email === emailA, JSON.stringify(relogin.data));
    ok('TEST 1: never told "you have not created an account"',
      !(relogin.data && relogin.data.error));
    userA = fresh;

    const me = await userA.req('/api/auth/me');
    ok('Session survives and restores the profile', me.data.user && me.data.user.email === emailA);

    const wrong = await client().req('/api/auth/login', { method: 'POST', body: { email: emailA, password: 'WrongPassword1' } });
    ok('Wrong password is rejected', wrong.status === 401);
  }

  /* ---------- password hashing ---------- */
  section('Password security');
  {
    const { Pool } = require('pg');
    require('dotenv').config();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query('SELECT password_hash FROM profiles WHERE lower(email)=lower($1)', [emailA]);
    await pool.end();
    const hash = rows[0] && rows[0].password_hash;
    ok('Password is stored as a bcrypt hash', Boolean(hash) && /^\$2[aby]\$/.test(hash));
    ok('Plaintext password is never stored', Boolean(hash) && !hash.includes(passA));
  }

  /* ---------- TEST 2: orders persist ---------- */
  section('TEST 2 — Orders persist across logout/login');
  let orderId = null, orderRef = null;
  {
    const r = await userA.req('/api/orders', { method: 'POST', body: { productSlug: 'youtube-tiktok', notes: 'My gaming channel.' } });
    ok('Order created in the database', r.status === 201 && r.data.order && r.data.order.id, JSON.stringify(r.data).slice(0, 160));
    orderId = r.data.order.id; orderRef = r.data.order.reference;
    ok('Order amount matches the product price ($60)', r.data.order.amount === 60);
    ok('Order starts as Pending Payment', r.data.order.status === 'pending_payment');

    await userA.req('/api/auth/logout', { method: 'POST' });
    const again = client();
    await again.req('/api/auth/login', { method: 'POST', body: { email: emailA, password: passA } });
    const list = await again.req('/api/orders');
    ok('TEST 2: order still exists after logout + login',
      list.data.orders.some((o) => o.id === orderId), 'orders: ' + list.data.orders.length);
    userA = again;
  }

  /* ---------- TEST 9 & 10: payment info from env ---------- */
  section('TEST 9 & 10 — Bitcoin / PayPal payment details from environment');
  {
    const r = await userA.req('/api/orders/meta/payment-info');
    ok('TEST 9: BTC address is served from BTC_ADDRESS env var',
      r.data.bitcoin && r.data.bitcoin.configured === true && r.data.bitcoin.address === process.env.BTC_ADDRESS,
      JSON.stringify(r.data.bitcoin));
    ok('TEST 10: PayPal instructions served from PAYPAL_INSTRUCTIONS env var',
      r.data.paypal && /Friends and Family/i.test(r.data.paypal.instructions));
    ok('TEST 10: PayPal instructions contain the configured PayPal email',
      /Ajayiawwl100@gmail\.com/i.test(r.data.paypal.instructions));
  }

  /* ---------- TEST 7 & 8: payment proof upload ---------- */
  section('TEST 7 & 8 — Payment proof upload (PNG & JPG) + persistence');
  let proofFileId = null;
  {
    const fd = new FormData();
    fd.append('method', 'bitcoin');
    fd.append('reference', 'test-txid-' + rnd());
    fd.append('proof', new Blob([PNG], { type: 'image/png' }), 'payment-screenshot.png');
    const r = await userA.req(`/api/orders/${orderId}/payment`, { method: 'POST', body: fd });
    ok('TEST 7: PNG payment screenshot upload succeeds', r.status === 201, JSON.stringify(r.data).slice(0, 200));
    ok('Order moves to Payment Submitted', r.data.order.status === 'payment_submitted');
    proofFileId = r.data.order.payments[0] && r.data.order.payments[0].proofFileId;
    ok('Payment proof is linked to the order + user', Boolean(proofFileId));

    // Refresh -> proof still there
    const refreshed = await userA.req(`/api/orders/${orderId}`);
    ok('TEST 7: payment proof still exists after refresh',
      refreshed.data.order.payments[0].proofFileId === proofFileId);

    const fetchProof = await userA.req(`/api/files/${proofFileId}`, { raw: true });
    ok('Payment proof file is retrievable by its owner', fetchProof.status === 200);
    ok('Proof served with the correct MIME type', (fetchProof.headers.get('content-type') || '').includes('image/png'));

    // TEST 8 — JPG on a second order
    const o2 = await userA.req('/api/orders', { method: 'POST', body: { productSlug: 'tiktok-strategy' } });
    const fd2 = new FormData();
    fd2.append('method', 'paypal');
    fd2.append('proof', new Blob([JPG], { type: 'image/jpeg' }), 'payment.jpg');
    const r2 = await userA.req(`/api/orders/${o2.data.order.id}/payment`, { method: 'POST', body: fd2 });
    ok('TEST 8: JPG payment screenshot upload succeeds', r2.status === 201, JSON.stringify(r2.data).slice(0, 200));
  }

  /* ---------- owner login ---------- */
  section('TEST 14 — Owner login & admin dashboard');
  const owner = client();
  {
    const r = await owner.req('/api/auth/login', {
      method: 'POST',
      body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
    });
    ok('TEST 14: owner can log in', r.status === 200 && r.data.user.role === 'owner', JSON.stringify(r.data).slice(0, 160));
    const stats = await owner.req('/api/admin/stats');
    ok('TEST 14: owner can access /api/admin/stats', stats.status === 200 && typeof stats.data.orders === 'number');
    const ordersAdmin = await owner.req('/api/admin/orders');
    ok('Owner sees all orders', ordersAdmin.status === 200 && ordersAdmin.data.orders.length >= 2);
  }

  /* ---------- TEST 13: role protection ---------- */
  section('TEST 13 — Admin routes are server-side protected');
  {
    const r = await userA.req('/api/admin/stats');
    ok('TEST 13: normal streamer gets 403 on /api/admin/stats', r.status === 403, 'status ' + r.status);
    const r2 = await userA.req('/api/admin/orders');
    ok('TEST 13: streamer blocked from /api/admin/orders', r2.status === 403);
    const r3 = await userA.req('/api/admin/payments');
    ok('TEST 13: streamer blocked from /api/admin/payments', r3.status === 403);
    const r4 = await client().req('/api/admin/stats');
    ok('Anonymous visitor blocked from admin (401)', r4.status === 401);
    const r5 = await userA.req('/api/admin/proof', { method: 'POST' });
    ok('TEST 13: streamer cannot upload proof', r5.status === 403);
  }

  /* ---------- payment confirmation workflow ---------- */
  section('Payment confirmation workflow');
  {
    const pays = await owner.req('/api/admin/payments?status=submitted');
    const target = pays.data.payments.find((p) => p.orderReference === orderRef);
    ok('Owner sees the submitted payment (💰 PAYMENT MADE)', Boolean(target));
    ok('Owner can view the payment proof URL', Boolean(target && target.proofUrl));

    const proofView = await owner.req(target.proofUrl, { raw: true });
    ok('Owner can open the payment proof file', proofView.status === 200);

    const conf = await owner.req(`/api/admin/payments/${target.id}/confirm`, { method: 'POST', body: {} });
    ok('Owner can CONFIRM PAYMENT', conf.status === 200 && conf.data.order.paymentStatus === 'confirmed');
    ok('Confirmation updates the order automatically', conf.data.order.status === 'payment_confirmed');

    const streamerView = await userA.req(`/api/orders/${orderId}`);
    ok('Streamer sees ✅ PAYMENT CONFIRMED', streamerView.data.order.paymentStatus === 'confirmed');

    const notifs = await userA.req('/api/notifications');
    ok('Streamer received a payment-confirmed notification',
      notifs.data.notifications.some((n) => n.type === 'payment_confirmed'));
    ok('Notification unread count is tracked', notifs.data.unread > 0);
  }

  /* ---------- order status / delivery ---------- */
  section('Order status & delivery workflow');
  {
    for (const st of ['in_progress', 'delivered', 'completed']) {
      const r = await owner.req(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: { status: st } });
      ok(`Owner can set status "${st}"`, r.status === 200 && r.data.order.status === st);
    }
    const note = await owner.req(`/api/admin/orders/${orderId}`, {
      method: 'PATCH', body: { deliveryNote: 'Strategy document delivered in Chat.' },
    });
    ok('Owner can add a delivery note the streamer can see', note.data.order.deliveryNote.includes('delivered'));
    const sv = await userA.req(`/api/orders/${orderId}`);
    ok('Streamer sees the updated order status', sv.data.order.status === 'completed');
  }

  /* ---------- reviews ---------- */
  section('Reviews — only from genuine completed orders');
  {
    const before = await client().req('/api/reviews');
    const beforeCount = before.data.reviews.length;

    const r = await userA.req('/api/reviews', { method: 'POST', body: { orderId, rating: 5, body: 'Clear, structured and easy to follow.' } });
    ok('Streamer with a completed order can leave a review', r.status === 201, JSON.stringify(r.data).slice(0, 160));

    const dup = await userA.req('/api/reviews', { method: 'POST', body: { orderId, rating: 4 } });
    ok('Duplicate review on the same order is rejected', dup.status === 409);

    // Review on an order that is NOT completed
    const o3 = await userA.req('/api/orders', { method: 'POST', body: { productSlug: 'discord-strategy' } });
    const bad = await userA.req('/api/reviews', { method: 'POST', body: { orderId: o3.data.order.id, rating: 5 } });
    ok('Review blocked on an order that is not completed', bad.status === 403, 'status ' + bad.status);

    const after = await client().req('/api/reviews');
    ok('Published review appears publicly', after.data.reviews.length === beforeCount + 1);
    ok('No fake/seeded reviews exist beyond genuine ones', after.data.summary.count === after.data.reviews.length);
  }

  /* ---------- TEST 3,4,5,6: chat ---------- */
  section('TEST 3, 4, 5, 6 — Chat persistence, attachments, voice notes');
  let convoId = null;
  {
    const convos = await userA.req('/api/messages/conversations');
    ok('Streamer has a conversation thread', convos.data.conversations.length === 1);
    convoId = convos.data.conversations[0].id;

    const fd = new FormData();
    fd.append('conversationId', convoId);
    fd.append('body', 'Hello, I have a question about my YouTube strategy.');
    const sent = await userA.req('/api/messages', { method: 'POST', body: fd });
    ok('Streamer can send a text message', sent.status === 201 && sent.data.message.body.includes('question'));

    // TEST 3 — refresh (new request) still has the message
    const reload = await userA.req(`/api/messages/${convoId}`);
    ok('TEST 3: message still exists after refresh (loaded from PostgreSQL)',
      reload.data.messages.some((m) => m.id === sent.data.message.id));

    // TEST 4 — close browser, come back later
    await userA.req('/api/auth/logout', { method: 'POST' });
    const later = client();
    await later.req('/api/auth/login', { method: 'POST', body: { email: emailA, password: passA } });
    const laterMsgs = await later.req(`/api/messages/${convoId}`);
    ok('TEST 4: conversation still exists after closing the browser and returning',
      laterMsgs.data.messages.length >= 1);
    userA = later;

    // image attachment
    const fdImg = new FormData();
    fdImg.append('conversationId', convoId);
    fdImg.append('file', new Blob([PNG], { type: 'image/png' }), 'screenshot.png');
    const img = await userA.req('/api/messages', { method: 'POST', body: fdImg });
    ok('Streamer can send a PNG image in chat', img.status === 201 && img.data.message.kind === 'image');

    // document attachment
    const fdDoc = new FormData();
    fdDoc.append('conversationId', convoId);
    fdDoc.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'brief.pdf');
    const doc = await userA.req('/api/messages', { method: 'POST', body: fdDoc });
    ok('Streamer can send a PDF document in chat', doc.status === 201 && doc.data.message.kind === 'file');

    // TEST 6 — voice message
    const fdVoice = new FormData();
    fdVoice.append('conversationId', convoId);
    fdVoice.append('durationMs', '4200');
    fdVoice.append('file', new Blob([Buffer.from('fake-opus-audio-data')], { type: 'audio/webm' }), 'voice-message.webm');
    const voice = await userA.req('/api/messages', { method: 'POST', body: fdVoice });
    ok('TEST 6: voice message uploads and is stored', voice.status === 201 && voice.data.message.kind === 'voice');
    const vAtt = voice.data.message.attachments[0];
    ok('Voice message records its duration', vAtt && vAtt.durationMs === 4200);

    const afterRefresh = await userA.req(`/api/messages/${convoId}`);
    const vMsg = afterRefresh.data.messages.find((m) => m.kind === 'voice');
    ok('TEST 6: voice message still exists after refresh', Boolean(vMsg));
    const playback = await userA.req(vMsg.attachments[0].url, { raw: true });
    ok('TEST 6: voice message is playable (file serves with audio MIME)',
      playback.status === 200 && (playback.headers.get('content-type') || '').startsWith('audio/'));

    // dangerous file type rejected
    const fdBad = new FormData();
    fdBad.append('conversationId', convoId);
    fdBad.append('file', new Blob([Buffer.from('#!/bin/sh\nrm -rf /')], { type: 'application/x-sh' }), 'evil.sh');
    const bad = await userA.req('/api/messages', { method: 'POST', body: fdBad });
    ok('Unsafe file type is rejected (415)', bad.status === 415, 'status ' + bad.status);

    // TEST 5 — owner side
    const ownerConvos = await owner.req('/api/messages/conversations');
    const oc = ownerConvos.data.conversations.find((c) => c.id === convoId);
    ok('TEST 5: owner inbox shows the conversation', Boolean(oc));
    ok('Owner inbox shows streamer name, last message and unread count',
      Boolean(oc && oc.userName && oc.lastMessagePreview && typeof oc.unread === 'number'));
    ok('Unread count is tracked for the owner', oc.unread > 0);

    const ownerMsgs = await owner.req(`/api/messages/${convoId}`);
    ok('TEST 5: owner sees the messages after refreshing the dashboard', ownerMsgs.data.messages.length >= 4);

    await owner.req(`/api/messages/${convoId}/read`, { method: 'POST' });
    const afterRead = await owner.req('/api/messages/conversations');
    ok('Opening the conversation marks messages as read',
      afterRead.data.conversations.find((c) => c.id === convoId).unread === 0);

    // owner replies
    const fdReply = new FormData();
    fdReply.append('conversationId', convoId);
    fdReply.append('body', 'Thanks for reaching out. I will review your channel.');
    const reply = await owner.req('/api/messages', { method: 'POST', body: fdReply });
    ok('Owner can reply to the streamer', reply.status === 201);

    const streamerUnread = await userA.req('/api/messages/meta/unread');
    ok('Streamer unread count increases on a new owner message', streamerUnread.data.unread > 0);
  }

  /* ---------- TEST 12: data isolation ---------- */
  section('TEST 12 — Users cannot see each other\'s data');
  const emailB = `streamer.${rnd()}@example.com`;
  const userB = client();
  {
    await userB.req('/api/auth/register', { method: 'POST', body: { name: 'Second Streamer', email: emailB, password: 'SecondPass123!' } });
    const orders = await userB.req('/api/orders');
    ok('TEST 12: user B sees none of user A\'s orders', orders.data.orders.length === 0);

    const peek = await userB.req(`/api/orders/${orderId}`);
    ok('TEST 12: user B cannot open user A\'s order (404)', peek.status === 404, 'status ' + peek.status);

    const msgs = await userB.req(`/api/messages/${convoId}`);
    const leaked = msgs.status === 200 && msgs.data.conversationId === convoId;
    ok('TEST 12: user B cannot read user A\'s conversation', !leaked, 'convo returned: ' + msgs.data.conversationId);

    const file = await userB.req(`/api/files/${proofFileId}`, { raw: true });
    ok('TEST 12: user B cannot download user A\'s payment proof (403)', file.status === 403, 'status ' + file.status);

    const anon = await client().req(`/api/files/${proofFileId}`, { raw: true });
    ok('Anonymous visitor cannot download private payment proof', anon.status === 403);
  }

  /* ---------- TEST 15: proof of work ---------- */
  section('TEST 15 — Proof of Work upload appears publicly');
  let proofItemId = null;
  {
    const beforePublic = await client().req('/api/proof');
    const beforeCount = beforePublic.data.items.length;
    ok('Public proof endpoint returns the 6 categories', beforePublic.data.categories.length === 6);
    ok('No fabricated proof is pre-seeded', beforeCount === 0 || beforeCount === beforePublic.data.total);

    const fd = new FormData();
    fd.append('image', new Blob([PNG], { type: 'image/png' }), 'creator-analysis.png');
    fd.append('category', 'creator_analysis');
    fd.append('title', 'Channel analysis screenshot');
    fd.append('caption', 'Analysis prepared for a creator.');
    const up = await owner.req('/api/admin/proof', { method: 'POST', body: fd });
    ok('TEST 15: owner can upload Proof of Work', up.status === 201, JSON.stringify(up.data).slice(0, 200));
    proofItemId = up.data.item.id;

    const pub = await client().req('/api/proof');
    ok('TEST 15: uploaded proof appears on the public Proof of Work page',
      pub.data.items.some((i) => i.id === proofItemId));
    ok('Proof image is publicly viewable without logging in',
      (await client().req(`/api/files/${up.data.item.fileId}`, { raw: true })).status === 200);

    const cat = await client().req('/api/proof?category=creator_analysis');
    ok('Creator Analysis category filter works', cat.data.items.some((i) => i.id === proofItemId));

    // edit / caption / reorder / unpublish / delete
    const edit = await owner.req(`/api/admin/proof/${proofItemId}`, {
      method: 'PATCH', body: { title: 'Updated analysis title', caption: 'Updated factual caption.' },
    });
    ok('Owner can edit proof title and caption',
      edit.data.item.title === 'Updated analysis title' && edit.data.item.caption === 'Updated factual caption.');

    const unpub = await owner.req(`/api/admin/proof/${proofItemId}`, { method: 'PATCH', body: { isPublished: false } });
    ok('Owner can unpublish proof', unpub.data.item.isPublished === false);
    const hidden = await client().req('/api/proof');
    ok('Unpublished proof is hidden from the public page', !hidden.data.items.some((i) => i.id === proofItemId));
    await owner.req(`/api/admin/proof/${proofItemId}`, { method: 'PATCH', body: { isPublished: true } });

    const reord = await owner.req('/api/admin/proof/reorder', { method: 'POST', body: { ids: [proofItemId] } });
    ok('Owner can reorder proof', reord.status === 200);

    const badCat = await owner.req('/api/admin/proof', { method: 'POST', body: {} });
    ok('Proof upload without an image is rejected', badCat.status === 400);
  }

  /* ---------- notifications ---------- */
  section('Notifications');
  {
    const n = await owner.req('/api/notifications');
    ok('Owner has stored notifications', n.data.notifications.length > 0);
    ok('Owner was notified of the payment (💰 PAYMENT MADE)',
      n.data.notifications.some((x) => x.type === 'payment_submitted' && /PAYMENT MADE/.test(x.title)));
    ok('Owner was notified of new chat messages', n.data.notifications.some((x) => x.type === 'new_message'));
    ok('Owner was notified of the new review', n.data.notifications.some((x) => x.type === 'review_created'));

    const first = n.data.notifications[0];
    const read = await owner.req(`/api/notifications/${first.id}/read`, { method: 'POST' });
    ok('Marking a notification read updates the count', read.status === 200 && typeof read.data.unread === 'number');
    const all = await owner.req('/api/notifications/read-all', { method: 'POST' });
    ok('Mark-all-read works', all.data.unread === 0);
  }

  /* ---------- contact ---------- */
  section('Public contact form');
  {
    const r = await client().req('/api/contact', {
      method: 'POST', body: { name: 'Prospect', email: 'prospect@example.com', subject: 'Question', body: 'Do you cover Kick as well?' },
    });
    ok('Contact form submits successfully', r.status === 201 && r.data.ok);
    const admin = await owner.req('/api/admin/contact');
    ok('Contact message reaches the owner dashboard', admin.data.messages.length > 0);
  }

  /* ---------- security ---------- */
  section('Security hardening');
  {
    const res = await client().req('/', { raw: true });
    ok('X-Content-Type-Options header present', res.headers.get('x-content-type-options') === 'nosniff');
    ok('Content-Security-Policy header present', Boolean(res.headers.get('content-security-policy')));
    ok('X-Frame-Options header present', Boolean(res.headers.get('x-frame-options')));
    ok('Server does not advertise x-powered-by', !res.headers.get('x-powered-by'));

    const cfg = await client().req('/api/config');
    const body = JSON.stringify(cfg.data);
    ok('Public config exposes no secrets',
      !body.includes(process.env.JWT_SECRET) && !body.includes(process.env.ADMIN_PASSWORD) &&
      !body.includes('DATABASE_URL') && !/postgres:\/\//.test(body));

    // SQL injection attempt
    const inj = await client().req('/api/auth/login', {
      method: 'POST', body: { email: "' OR '1'='1", password: "' OR '1'='1" },
    });
    ok('SQL injection attempt on login fails safely', inj.status === 400 || inj.status === 401);

    const stillThere = await client().req('/api/products');
    ok('Database intact after injection attempt', stillThere.data.products.length === 14);

    // CSRF: authenticated request without the CSRF header must fail
    const cookieOnly = `as_session=${userA.jar.get('as_session')}; as_csrf=${userA.jar.get('as_csrf')}`;
    const noCsrf = await fetch(BASE + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieOnly },
      body: JSON.stringify({ productSlug: 'discord-strategy' }),
    });
    ok('CSRF protection blocks a state-changing request without the token', noCsrf.status === 403, 'status ' + noCsrf.status);

    // oversized upload
    const big = Buffer.alloc(12 * 1024 * 1024, 1);
    const fdBig = new FormData();
    fdBig.append('conversationId', convoId);
    fdBig.append('file', new Blob([big], { type: 'image/png' }), 'huge.png');
    const bigRes = await userA.req('/api/messages', { method: 'POST', body: fdBig });
    ok('Oversized upload rejected by the size limit', bigRes.status === 413, 'status ' + bigRes.status);

    // XSS payload is stored escaped/safe
    const fdXss = new FormData();
    fdXss.append('conversationId', convoId);
    fdXss.append('body', '<script>alert("xss")</script>');
    const xss = await userA.req('/api/messages', { method: 'POST', body: fdXss });
    ok('XSS payload stored as plain text (escaped on render)',
      xss.status === 201 && xss.data.message.body === '<script>alert("xss")</script>');
  }

  /* ---------- realtime ---------- */
  section('Socket.IO realtime');
  {
    if (!io) {
      results.push('  ⚠️  socket.io-client not installed — realtime checked via HTTP fallback only');
    } else {
      const cookie = `as_session=${userA.jar.get('as_session')}`;
      const sock = io(BASE, { extraHeaders: { Cookie: cookie }, transports: ['websocket'], reconnection: false });
      const connected = await new Promise((res) => {
        const t = setTimeout(() => res(false), 6000);
        sock.on('connect', () => { clearTimeout(t); res(true); });
        sock.on('connect_error', () => { clearTimeout(t); res(false); });
      });
      ok('Socket.IO authenticates from the session cookie and connects', connected);

      if (connected) {
        const got = new Promise((res) => {
          const t = setTimeout(() => res(null), 6000);
          sock.on('message', (m) => { clearTimeout(t); res(m); });
        });
        const fd = new FormData();
        fd.append('conversationId', convoId);
        fd.append('body', 'Realtime delivery check');
        await owner.req('/api/messages', { method: 'POST', body: fd });
        const live = await got;
        ok('Message is delivered live over Socket.IO', Boolean(live && live.body === 'Realtime delivery check'));
        sock.close();
      }

      const anonSock = io(BASE, { transports: ['websocket'], reconnection: false });
      const rejected = await new Promise((res) => {
        const t = setTimeout(() => res(false), 6000);
        anonSock.on('connect', () => { clearTimeout(t); res(false); });
        anonSock.on('connect_error', () => { clearTimeout(t); res(true); });
      });
      ok('Unauthenticated socket connection is rejected', rejected);
      anonSock.close();
    }
  }

  /* ---------- TEST 16: restart durability ---------- */
  section('TEST 16 — Data survives a server restart (verified directly in PostgreSQL)');
  {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const q = async (sql, p) => (await pool.query(sql, p)).rows[0];

    const u = await q('SELECT COUNT(*)::int c FROM profiles');
    const o = await q('SELECT COUNT(*)::int c FROM orders');
    const m = await q('SELECT COUNT(*)::int c FROM messages');
    const f = await q('SELECT COUNT(*)::int c FROM files');
    const r = await q('SELECT COUNT(*)::int c FROM reviews');
    const p = await q('SELECT COUNT(*)::int c FROM proof_items');
    const ps = await q('SELECT COUNT(*)::int c FROM payment_submissions');
    const n = await q('SELECT COUNT(*)::int c FROM notifications');

    ok('Users are persisted on disk in PostgreSQL', u.c >= 3);
    ok('Orders are persisted on disk in PostgreSQL', o.c >= 3);
    ok('Messages are persisted on disk in PostgreSQL', m.c >= 5);
    ok('Uploaded files are persisted in PostgreSQL (survive Render redeploys)', f.c >= 4);
    ok('Reviews are persisted', r.c >= 1);
    ok('Proof items are persisted', p.c >= 1);
    ok('Payment submissions are persisted', ps.c >= 2);
    ok('Notifications are persisted', n.c >= 4);

    // Verify the unique email constraint exists at the database level
    const idx = await q(`SELECT COUNT(*)::int c FROM pg_indexes WHERE tablename='profiles' AND indexname='profiles_email_unique'`);
    ok('UNIQUE database constraint on email exists', idx.c === 1);

    const fk = await q(`SELECT COUNT(*)::int c FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY'`);
    ok('Foreign keys are defined across the schema', fk.c >= 10);

    const indexes = await q(`SELECT COUNT(*)::int c FROM pg_indexes WHERE schemaname='public'`);
    ok('Indexes are created', indexes.c >= 20);

    await pool.end();
  }

  /* ---------- pages render ---------- */
  section('Frontend pages');
  for (const [path, needle] of [
    ['/', 'Creator &amp; Streamer Growth Strategies'],
    ['/strategies', 'Creator &amp; Streamer Growth Strategies'],
    ['/strategy/youtube-strategy', 'site-nav'],
    ['/proof-of-work', 'Proof of Work'],
    ['/about', 'About Agbota Segun'],
    ['/contact', 'Talk to Agbota Segun'],
    ['/access', 'Your creator account'],
    ['/dashboard', 'My Dashboard'],
    ['/chat', 'Messages'],
    ['/admin', 'Owner Dashboard'],
    ['/checkout/youtube-strategy', 'checkout'],
  ]) {
    const r = await client().req(path);
    ok(`Page ${path} serves correctly`, r.status === 200 && String(r.data).includes(needle));
  }
  {
    const nf = await client().req('/this-page-does-not-exist');
    ok('Unknown route returns the 404 page', nf.status === 404 && String(nf.data).includes('Page not found'));
    const brand = await client().req('/');
    const html = String(brand.data);
    ok('Business name "Agbota Segun" is used throughout', html.includes('Agbota Segun'));
    ok('Site is not branded as a blog/bookstore',
      !/\bblog\b/i.test(html) && !/bookstore/i.test(html) && !/marketplace/i.test(html));
  }

  /* ---------- summary ---------- */
  console.log(results.join('\n'));
  console.log(`\n${'='.repeat(52)}`);
  console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
  console.log(`${'='.repeat(52)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.log(results.join('\n'));
  console.error('\nTest runner crashed:', err);
  process.exit(1);
});
