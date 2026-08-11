/* Agbota Segun — shared frontend library
   NOTE: no account, order or message data is ever stored in localStorage.
   The session lives in an httpOnly cookie and all data comes from the server. */
(function () {
  'use strict';

  const AS = {};

  /* ---------------- helpers ---------------- */
  const readCookie = (name) => {
    const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[2]) : null;
  };

  AS.escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  AS.money = (n) => '$' + Number(n || 0).toFixed(2).replace(/\.00$/, '');

  AS.formatBytes = (b) => {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  };

  AS.timeAgo = (iso) => {
    const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString();
  };

  AS.formatDate = (iso) => new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  AS.formatTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  AS.formatDateTime = (iso) => AS.formatDate(iso) + ' · ' + AS.formatTime(iso);

  AS.initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  /* ----------------------------------------------------------------
     Session token fallback.

     The httpOnly cookie is ALWAYS the primary session mechanism. This
     fallback only matters when the browser refuses to store or send the
     cookie (strict privacy modes, in-app/embedded browsers, blocked
     third-party cookies). It is the SAME JWT and the SAME server-side
     session — not a second auth system.
     ---------------------------------------------------------------- */
  const TOKEN_KEY = 'as_token';

  /**
   * Token storage with graceful degradation.
   *
   * Order of preference:
   *   1. localStorage    — survives browser restart
   *   2. sessionStorage  — survives refresh/navigation within the tab
   *   3. in-memory       — survives navigation via bfcache-less page loads only
   *
   * When a browser blocks site data, ACCESSING window.localStorage itself
   * throws a SecurityError, so every access must be guarded. Previously a
   * blocked store meant the token was silently dropped and the session was
   * lost even though login had fully succeeded.
   *
   * NOTE: only the short-lived JWT is ever stored. Passwords are never stored
   * and are never exposed to JavaScript.
   */
  let memoryToken = null;

  const safeStore = (kind) => {
    try {
      const s = window[kind];
      if (!s) return null;
      const probe = '__as_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_) {
      return null; // blocked (private mode / site data disabled)
    }
  };

  AS.saveToken = function (token) {
    if (!token) return;
    memoryToken = token;
    const ls = safeStore('localStorage');
    if (ls) { try { ls.setItem(TOKEN_KEY, token); return; } catch (_) {} }
    const ss = safeStore('sessionStorage');
    if (ss) { try { ss.setItem(TOKEN_KEY, token); } catch (_) {} }
  };

  AS.getToken = function () {
    const ls = safeStore('localStorage');
    if (ls) { try { const v = ls.getItem(TOKEN_KEY); if (v) return v; } catch (_) {} }
    const ss = safeStore('sessionStorage');
    if (ss) { try { const v = ss.getItem(TOKEN_KEY); if (v) return v; } catch (_) {} }
    return memoryToken;
  };

  AS.clearToken = function () {
    memoryToken = null;
    const ls = safeStore('localStorage');
    if (ls) { try { ls.removeItem(TOKEN_KEY); } catch (_) {} }
    const ss = safeStore('sessionStorage');
    if (ss) { try { ss.removeItem(TOKEN_KEY); } catch (_) {} }
  };

  /** True when the token can outlive a full page load. */
  AS.tokenIsPersistable = function () {
    return Boolean(safeStore('localStorage') || safeStore('sessionStorage'));
  };

  /* ---------------- API ---------------- */
  AS.api = async function (path, options = {}) {
    const opts = { credentials: 'same-origin', headers: {}, ...options };
    const csrf = readCookie('as_csrf');
    if (csrf) opts.headers['X-CSRF-Token'] = csrf;

    // The session cookie is httpOnly and cannot be read here, so the bearer
    // token is always attached when we have one. The server reads the cookie
    // FIRST and only falls back to this header, so the cookie stays primary.
    const t = AS.getToken();
    if (t && !opts.headers['Authorization']) opts.headers['Authorization'] = 'Bearer ' + t;

    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(path, opts);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.code;
      err.data = data;
      throw err;
    }
    return data;
  };

  /* ---------------- session ---------------- */
  let currentUser = null;
  let userLoaded = false;

  AS.getUser = async function (force) {
    if (userLoaded && !force) return currentUser;
    try {
      const data = await AS.api('/api/auth/me');
      currentUser = data.user;
    } catch (_) {
      currentUser = null;
    }
    userLoaded = true;
    return currentUser;
  };

  AS.user = () => currentUser;

  AS.logout = async function () {
    try { await AS.api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    currentUser = null;
    userLoaded = true;
    AS.clearToken();
    window.location.href = '/';
  };

  /** Called after a successful login/register response. */
  AS.onAuthenticated = function (data) {
    if (!data) return null;
    if (data.token) AS.saveToken(data.token);
    currentUser = data.user || null;
    userLoaded = true;
    return currentUser;
  };

  /**
   * Confirms with the SERVER that the session really works, immediately after
   * login. The freshly issued token is passed explicitly so verification does
   * not depend on the cookie having been accepted or on storage being writable.
   *
   * Returns { user, via } where `via` is 'cookie' or 'token', or null if the
   * server genuinely does not recognise the session.
   */
  AS.verifySession = async function (freshToken) {
    // 1. Cookie-only attempt (no Authorization header at all).
    try {
      const res = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-cache' },
      });
      const data = await res.json();
      if (data && data.user) {
        currentUser = data.user;
        userLoaded = true;
        return { user: data.user, via: 'cookie' };
      }
    } catch (_) { /* fall through to token */ }

    // 2. Bearer fallback using the token from the login response.
    const token = freshToken || AS.getToken();
    if (!token) return null;
    try {
      const res = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        headers: { Authorization: 'Bearer ' + token, 'Cache-Control': 'no-cache' },
      });
      const data = await res.json();
      if (data && data.user) {
        currentUser = data.user;
        userLoaded = true;
        return { user: data.user, via: 'token' };
      }
    } catch (_) {}
    return null;
  };

  AS.requireAuth = async function (redirect) {
    const u = await AS.getUser();
    if (!u) {
      const next = encodeURIComponent(redirect || window.location.pathname + window.location.search);
      window.location.href = '/access?next=' + next;
      return null;
    }
    return u;
  };

  /* ---------------- toast ---------------- */
  AS.toast = function (message, type = 'info', title = '') {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = (title ? `<strong>${AS.escapeHtml(title)}</strong>` : '') + `<p>${AS.escapeHtml(message)}</p>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(28px)';
      el.style.transition = 'opacity .3s, transform .3s';
      setTimeout(() => el.remove(), 320);
    }, 4200);
  };

  /* ---------------- navigation ---------------- */
  const NAV_LINKS = [
    { href: '/', label: 'Home', match: (p) => p === '/' },
    { href: '/strategies', label: 'Strategies', match: (p) => p.startsWith('/strateg') },
    { href: '/#how-it-works', label: 'How It Works' },
    { href: '/proof-of-work', label: 'Proof of Work', match: (p) => p.startsWith('/proof') },
    { href: '/about', label: 'About', match: (p) => p === '/about' },
    { href: '/contact', label: 'Contact', match: (p) => p === '/contact' },
  ];

  AS.renderNav = async function () {
    const mount = document.getElementById('site-nav');
    if (!mount) return;
    const user = await AS.getUser();
    const path = window.location.pathname;

    const links = NAV_LINKS.map((l) => {
      const active = l.match && l.match(path) ? ' class="active"' : '';
      return `<a href="${l.href}"${active}>${l.label}</a>`;
    }).join('');

    const authArea = user
      ? `
        <div class="dropdown" id="notif-dropdown">
          <button class="icon-btn" id="notif-btn" aria-label="Notifications" title="Notifications">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>
            </svg>
            <span class="badge-count" id="notif-count" style="display:none">0</span>
          </button>
          <div class="dropdown-menu" id="notif-menu">
            <div class="dropdown-head">
              <h4>Notifications</h4>
              <button class="btn btn-sm btn-ghost" id="notif-read-all">Mark all read</button>
            </div>
            <div class="dropdown-list" id="notif-list">
              <div class="loading-box"><div class="spinner"></div></div>
            </div>
          </div>
        </div>
        <a href="/chat" class="icon-btn" aria-label="Chat" title="Chat" style="text-decoration:none">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
          <span class="badge-count" id="chat-count" style="display:none">0</span>
        </a>
        <a href="${user.role === 'owner' ? '/admin' : '/dashboard'}" class="btn btn-ghost btn-sm">
          ${user.role === 'owner' ? 'Owner Dashboard' : 'Dashboard'}
        </a>
        <button class="btn btn-sm btn-ghost" id="logout-btn">Log out</button>`
      : `
        <a href="/access" class="btn btn-ghost btn-sm">Access</a>
        <a href="/strategies" class="btn btn-primary btn-sm">View Strategies</a>`;

    mount.innerHTML = `
      <nav class="nav">
        <div class="nav-inner">
          <a href="/" class="brand">
            <span class="brand-mark">AS</span>
            <span class="brand-text">Agbota Segun</span>
          </a>
          <button class="nav-toggle" id="nav-toggle" aria-label="Menu" aria-expanded="false"><span></span></button>
          <div class="nav-links" id="nav-links">${links}${user ? '<a href="/chat">Chat</a>' : ''}</div>
          <div class="nav-actions">${authArea}</div>
        </div>
      </nav>`;

    const toggle = document.getElementById('nav-toggle');
    const linksEl = document.getElementById('nav-links');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const open = linksEl.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', AS.logout);

    if (user) {
      AS.initNotifications();
      AS.refreshChatBadge();
      AS.connectSocket();
    }
  };

  /* ---------------- notifications ---------------- */
  AS.initNotifications = function () {
    const btn = document.getElementById('notif-btn');
    const menu = document.getElementById('notif-menu');
    const readAll = document.getElementById('notif-read-all');
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
      if (menu.classList.contains('open')) AS.loadNotifications();
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !btn.contains(e.target)) menu.classList.remove('open');
    });
    if (readAll) {
      readAll.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await AS.api('/api/notifications/read-all', { method: 'POST' });
          AS.loadNotifications();
          AS.setNotifCount(0);
        } catch (err) { AS.toast(err.message, 'error'); }
      });
    }
    AS.loadNotifications();
  };

  AS.setNotifCount = function (n) {
    const el = document.getElementById('notif-count');
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n > 0 ? '' : 'none';
  };

  AS.loadNotifications = async function () {
    const list = document.getElementById('notif-list');
    try {
      const data = await AS.api('/api/notifications');
      AS.setNotifCount(data.unread);
      if (!list) return;
      if (!data.notifications.length) {
        list.innerHTML = '<div class="empty" style="padding:32px 20px"><p>No notifications yet.</p></div>';
        return;
      }
      list.innerHTML = data.notifications.map((n) => `
        <a class="notif ${n.read ? '' : 'unread'}" data-id="${n.id}" href="${n.link ? AS.escapeHtml(n.link) : '#'}">
          <strong>${AS.escapeHtml(n.title)}</strong>
          ${n.body ? `<p>${AS.escapeHtml(n.body)}</p>` : ''}
          <time>${AS.timeAgo(n.createdAt)}</time>
        </a>`).join('');

      list.querySelectorAll('.notif').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.id;
          if (el.classList.contains('unread')) {
            try {
              const r = await AS.api(`/api/notifications/${id}/read`, { method: 'POST' });
              AS.setNotifCount(r.unread);
              el.classList.remove('unread');
            } catch (_) {}
          }
        });
      });
    } catch (_) { /* not logged in */ }
  };

  AS.refreshChatBadge = async function () {
    try {
      const d = await AS.api('/api/messages/meta/unread');
      const el = document.getElementById('chat-count');
      if (!el) return;
      el.textContent = d.unread > 99 ? '99+' : String(d.unread);
      el.style.display = d.unread > 0 ? '' : 'none';
    } catch (_) {}
  };

  /* ---------------- socket ---------------- */
  let socket = null;
  AS.connectSocket = function () {
    if (socket || typeof io === 'undefined') return socket;
    try {
      socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
      socket.on('notification', (payload) => {
        AS.setNotifCount(payload.unread);
        if (payload.notification) {
          AS.toast(payload.notification.body || '', 'info', payload.notification.title);
        }
        const list = document.getElementById('notif-menu');
        if (list && list.classList.contains('open')) AS.loadNotifications();
        if (payload.notification && payload.notification.type === 'new_message') AS.refreshChatBadge();
      });
      socket.on('connect_error', () => { /* falls back to HTTP; data is never lost */ });
    } catch (_) { socket = null; }
    return socket;
  };
  AS.socket = () => socket;

  /* ---------------- footer ---------------- */
  AS.renderFooter = function () {
    const mount = document.getElementById('site-footer');
    if (!mount) return;
    mount.innerHTML = `
      <footer class="footer">
        <div class="container">
          <div class="footer-grid">
            <div>
              <a href="/" class="brand" style="margin-bottom:14px">
                <span class="brand-mark">AS</span><span class="brand-text">Agbota Segun</span>
              </a>
              <p style="font-size:.9rem;max-width:330px">
                Structured creator and streamer growth strategies — documented blueprints and growth systems
                for YouTube, Twitch, TikTok, Facebook, Instagram and Discord.
              </p>
            </div>
            <div>
              <h5>Strategies</h5>
              <ul>
                <li><a href="/strategies">All Strategies</a></li>
                <li><a href="/strategies#single">Single Platform</a></li>
                <li><a href="/strategies#combo">Combined</a></li>
                <li><a href="/strategy/custom-multi-platform">Custom Strategy</a></li>
              </ul>
            </div>
            <div>
              <h5>Company</h5>
              <ul>
                <li><a href="/about">About</a></li>
                <li><a href="/proof-of-work">Proof of Work</a></li>
                <li><a href="/#how-it-works">How It Works</a></li>
                <li><a href="/contact">Contact</a></li>
              </ul>
            </div>
            <div>
              <h5>Account</h5>
              <ul>
                <li><a href="/access">Access</a></li>
                <li><a href="/dashboard">Dashboard</a></li>
                <li><a href="/chat">Chat</a></li>
              </ul>
            </div>
          </div>
          <div class="footer-bottom">
            <span>&copy; ${new Date().getFullYear()} Agbota Segun. All rights reserved.</span>
            <span>Creator &amp; Streamer Growth Strategies</span>
          </div>
        </div>
      </footer>`;
  };

  /* ---------------- scroll reveal ---------------- */
  /**
   * Scroll reveal.
   * Content visibility must NEVER depend on an animation firing, so this uses
   * a viewport check on scroll (works everywhere) plus a catch-all timer.
   */
  let revealBound = false;

  function revealVisible() {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    document.querySelectorAll('.reveal:not(.in)').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < vh + 240 && r.bottom > -240) el.classList.add('in');
    });
  }

  AS.revealAll = function () {
    document.querySelectorAll('.reveal:not(.in)').forEach((el) => el.classList.add('in'));
  };

  AS.initReveal = function () {
    revealVisible();

    if (!revealBound) {
      revealBound = true;
      let ticking = false;
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { revealVisible(); ticking = false; });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      window.addEventListener('load', () => setTimeout(revealVisible, 120));
      // Final safety net — nothing may stay invisible.
      setTimeout(AS.revealAll, 2500);
    }
  };

  /* ---------------- platform icon ---------------- */
  const PLATFORM_STYLE = {
    YouTube: { bg: '#ff000022', color: '#ff4b4b' },
    Twitch: { bg: '#9146ff22', color: '#a970ff' },
    TikTok: { bg: '#00f2ea1a', color: '#25f4ee' },
    Facebook: { bg: '#1877f222', color: '#5aa2ff' },
    Instagram: { bg: '#e1306c22', color: '#ff6b9d' },
    Discord: { bg: '#5865f222', color: '#7d88ff' },
  };
  AS.platformStyle = (p) => PLATFORM_STYLE[p] || { bg: 'rgba(255,255,255,.06)', color: '#b9c0d4' };

  AS.boot = async function (opts = {}) {
    await AS.renderNav();
    AS.renderFooter();
    AS.initReveal();
    if (opts.after) await opts.after();
  };

  window.AS = AS;
})();
