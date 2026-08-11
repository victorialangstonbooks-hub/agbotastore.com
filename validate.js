'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v, { min = 0, max = 5000, trim = true } = {}) {
  if (typeof v !== 'string') return null;
  const s = trim ? v.trim() : v;
  if (s.length < min || s.length > max) return null;
  return s;
}

function email(v) {
  const s = str(v, { min: 3, max: 254 });
  if (!s) return null;
  const lower = s.toLowerCase();
  return EMAIL_RE.test(lower) ? lower : null;
}

function password(v) {
  if (typeof v !== 'string') return null;
  if (v.length < 8 || v.length > 200) return null;
  return v;
}

function intIn(v, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < min || n > max) return null;
  return n;
}

function oneOf(v, allowed) {
  return allowed.includes(v) ? v : null;
}

/** Escapes HTML so nothing user-supplied can execute in the browser. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { str, email, password, intIn, oneOf, escapeHtml, EMAIL_RE };
