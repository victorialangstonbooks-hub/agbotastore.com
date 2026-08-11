/**
 * Agbota Segun — authentication / session persistence regression tests.
 *
 * Runs a REAL Chromium browser against the app served over HTTPS through a
 * TLS-terminating proxy (exactly how Render serves it), and walks the precise
 * sequences that were failing in production.
 *
 * Usage: BASE=https://127.0.0.1:8443 node tests/auth-persistence.test.js
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://127.0.0.1:8443';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'agbotasegun.outreach@gmail.com';
// Never hard-code a password. Supply it at run time:
//   OWNER_PASS='your-password' node tests/auth-persistence.test.js
const OWNER_PASS = process.env.OWNER_PASS || process.env.ADMIN_PASSWORD || '';
if (!OWNER_PASS) {
  console.error('Set OWNER_PASS (or ADMIN_PASSWORD) to run the auth persistence tests.');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
};

const loggedInAs = async (page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const d = await r.json();
    return d.user ? d.user.email : null;
  });

async function login(page, email, password) {
  await page.goto(BASE + '/access', { waitUntil: 'networkidle' });
  await page.waitForSelector('#l-email', { timeout: 15000 });
  await page.fill('#l-email', email);
  await page.fill('#l-password', password);
  await page.click('#login-btn');
  await page.waitForTimeout(2500);
}

(async () => {
  console.log('\n=== AUTH PERSISTENCE TESTS (HTTPS + proxy, production mode) ===');
  console.log('Target:', BASE, '\n');

  const browser = await chromium.launch({ ignoreHTTPSErrors: true });
  const newCtx = () => browser.newContext({ ignoreHTTPSErrors: true });

  /* ---------------- TEST 1 ---------------- */
  console.log('▸ TEST 1 — login → dashboard → refresh (owner)');
  {
    const ctx = await newCtx();
    const p = await ctx.newPage();
    await login(p, OWNER_EMAIL, OWNER_PASS);

    ok('Login accepted and redirected off /access', !p.url().includes('/access'), 'url=' + p.url());
    ok('Server confirms authenticated session', (await loggedInAs(p)) === OWNER_EMAIL);

    const cookies = await ctx.cookies();
    const sess = cookies.find((c) => c.name === 'as_session');
    ok('Session cookie stored by the browser', Boolean(sess));
    ok('Session cookie is httpOnly', Boolean(sess && sess.httpOnly));
    ok('Session cookie is Secure over HTTPS', Boolean(sess && sess.secure));
    ok('Session cookie is persistent (survives browser close)', Boolean(sess && sess.expires > 0));

    await p.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);
    ok('Navigating to dashboard keeps the session', !p.url().includes('/access'), 'url=' + p.url());

    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1800);
    ok('REFRESH — still logged in', !p.url().includes('/access'), 'url=' + p.url());
    ok('REFRESH — /api/auth/me still returns the owner', (await loggedInAs(p)) === OWNER_EMAIL);

    // hard reload, bypassing cache
    await p.evaluate(() => location.reload(true));
    await p.waitForTimeout(2000);
    ok('HARD RELOAD — still logged in', (await loggedInAs(p)) === OWNER_EMAIL);
    await ctx.close();
  }

  /* ---------------- TEST 2 ---------------- */
  console.log('\n▸ TEST 2 — logout → log back in → refresh');
  {
    const ctx = await newCtx();
    const p = await ctx.newPage();
    await login(p, OWNER_EMAIL, OWNER_PASS);
    ok('Initial login works', (await loggedInAs(p)) === OWNER_EMAIL);

    await p.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    const logoutBtn = await p.$('#logout-btn');
    if (logoutBtn) { await logoutBtn.click(); await p.waitForTimeout(2000); }
    else { await p.evaluate(() => window.AS && window.AS.logout()); await p.waitForTimeout(2000); }
    ok('Logout clears the session', (await loggedInAs(p)) === null);

    await login(p, OWNER_EMAIL, OWNER_PASS);
    ok('Re-login works', (await loggedInAs(p)) === OWNER_EMAIL);

    await p.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1800);
    ok('REFRESH after re-login — still logged in', !p.url().includes('/access'), 'url=' + p.url());
    ok('REFRESH after re-login — session valid', (await loggedInAs(p)) === OWNER_EMAIL);
    await ctx.close();
  }

  /* ---------------- TEST 3 ---------------- */
  console.log('\n▸ TEST 3 — close Chrome completely, reopen, log in again');
  {
    const ctx1 = await newCtx();
    const p1 = await ctx1.newPage();
    await login(p1, OWNER_EMAIL, OWNER_PASS);
    ok('Logged in before closing', (await loggedInAs(p1)) === OWNER_EMAIL);
    const storage = await ctx1.storageState();
    await ctx1.close(); // simulates fully quitting Chrome

    // Reopen with the SAME persisted cookie jar (what Chrome does on restart)
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, storageState: storage });
    const p2 = await ctx2.newPage();
    await p2.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
    await p2.waitForTimeout(1800);
    ok('Reopened browser is STILL logged in (no re-login needed)', (await loggedInAs(p2)) === OWNER_EMAIL);
    ok('Not bounced to the login screen', !p2.url().includes('/access'), 'url=' + p2.url());
    await ctx2.close();

    // Fully cold browser with no cookies at all -> must be able to log in normally
    const ctx3 = await newCtx();
    const p3 = await ctx3.newPage();
    await login(p3, OWNER_EMAIL, OWNER_PASS);
    ok('Cold browser can log in to the SAME existing account', (await loggedInAs(p3)) === OWNER_EMAIL);
    const notAsked = await p3.evaluate(async () => {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const d = await r.json();
      return d.user && d.user.role;
    });
    ok('Account was NOT recreated (still the owner role)', notAsked === 'owner');
    await ctx3.close();
  }

  /* ---------------- TEST 4 + 5 ---------------- */
  console.log('\n▸ TEST 4 & 5 — streamer session + existing orders/messages preserved');
  {
    // Reuse an EXISTING streamer from the database (never create/reset data).
    require('dotenv').config();
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: 'postgres://app:app@127.0.0.1:5432/agbota' });
    const { rows } = await pool.query(
      "SELECT email FROM profiles WHERE role='streamer' AND email LIKE 'streamer.%' ORDER BY id LIMIT 1"
    );
    await pool.end();

    if (!rows.length) {
      console.log('  ⚠️  no pre-existing streamer found to test with');
    } else {
      const email = rows[0].email;
      const ctx = await newCtx();
      const p = await ctx.newPage();
      await login(p, email, 'StreamerPass123!');
      ok('Streamer login works', (await loggedInAs(p)) === email, 'expected ' + email);

      await p.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
      await p.reload({ waitUntil: 'networkidle' });
      await p.waitForTimeout(1800);
      ok('Streamer REFRESH — still logged in', (await loggedInAs(p)) === email);

      const data = await p.evaluate(async () => {
        const o = await (await fetch('/api/orders', { credentials: 'same-origin' })).json();
        const c = await (await fetch('/api/messages/conversations', { credentials: 'same-origin' })).json();
        let msgs = 0;
        if (c.conversations && c.conversations.length) {
          const m = await (await fetch('/api/messages/' + c.conversations[0].id, { credentials: 'same-origin' })).json();
          msgs = (m.messages || []).length;
        }
        return { orders: (o.orders || []).length, messages: msgs };
      });
      ok('TEST 5 — existing orders still available after auth', data.orders > 0, 'orders=' + data.orders);
      ok('TEST 5 — existing messages still available after auth', data.messages > 0, 'messages=' + data.messages);

      // close + reopen Chrome
      const storage = await ctx.storageState();
      await ctx.close();
      const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, storageState: storage });
      const p2 = await ctx2.newPage();
      await p2.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
      await p2.waitForTimeout(1800);
      ok('Streamer session survives closing/reopening Chrome', (await loggedInAs(p2)) === email);

      const after = await p2.evaluate(async () => {
        const o = await (await fetch('/api/orders', { credentials: 'same-origin' })).json();
        return (o.orders || []).length;
      });
      ok('Same account loaded with the same orders', after === data.orders, `${after} vs ${data.orders}`);
      await ctx2.close();
    }
  }

  /* ---------------- cache-poisoning regression ---------------- */
  console.log('\n▸ REGRESSION — cached anonymous /api/auth/me must not survive login');
  {
    const ctx = await newCtx();
    const p = await ctx.newPage();
    // Prime the cache with an anonymous response, repeatedly.
    await p.goto(BASE + '/access', { waitUntil: 'networkidle' });
    await p.evaluate(async () => { for (let i = 0; i < 3; i++) await fetch('/api/auth/me', { credentials: 'same-origin' }); });
    await login(p, OWNER_EMAIL, OWNER_PASS);
    const who = await loggedInAs(p);
    ok('After login, /api/auth/me is NOT served from the anonymous cache', who === OWNER_EMAIL, 'got ' + who);

    const headers = await p.evaluate(async () => {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      return { cc: r.headers.get('cache-control'), etag: r.headers.get('etag'), status: r.status };
    });
    ok('/api/auth/me sends no-store', /no-store/.test(headers.cc || ''), JSON.stringify(headers));
    ok('/api/auth/me sends no ETag (no 304 replay possible)', !headers.etag, 'etag=' + headers.etag);
    await ctx.close();
  }

  console.log('\n' + '='.repeat(52));
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  console.log('='.repeat(52) + '\n');

  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
