'use strict';

const bcrypt = require('bcryptjs');
const db = require('./index');
const config = require('../config');
const { products } = require('./products.data');

/**
 * Idempotent product seeding — keyed on slug.
 * Running this repeatedly NEVER creates duplicates.
 */
async function seedProducts() {
  for (const p of products) {
    await db.query(
      `INSERT INTO products
         (slug, name, price_cents, price_note, tier, tagline, description, includes, audience, platforms, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,TRUE)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         price_cents = EXCLUDED.price_cents,
         price_note = EXCLUDED.price_note,
         tier = EXCLUDED.tier,
         tagline = EXCLUDED.tagline,
         description = EXCLUDED.description,
         includes = EXCLUDED.includes,
         audience = EXCLUDED.audience,
         platforms = EXCLUDED.platforms,
         sort_order = EXCLUDED.sort_order,
         updated_at = now()`,
      [
        p.slug,
        p.name,
        p.price_cents,
        p.price_note || null,
        p.tier,
        p.tagline || null,
        p.description,
        JSON.stringify(p.includes || []),
        p.audience || null,
        JSON.stringify(p.platforms || []),
        p.sort_order || 0,
      ]
    );
  }
  console.log(`[seed] ${products.length} products ensured (idempotent, no duplicates)`);
}

/**
 * Ensures the owner/admin account exists.
 * - Creates it if missing (when ADMIN_PASSWORD is provided).
 * - Always guarantees the ADMIN_EMAIL account has role='owner'.
 * - Never downgrades or wipes an existing account.
 */
async function seedOwner() {
  const email = config.admin.email;
  const existing = await db.one('SELECT id, role FROM profiles WHERE lower(email) = lower($1)', [email]);

  if (existing) {
    if (existing.role !== 'owner') {
      await db.query('UPDATE profiles SET role = $1, updated_at = now() WHERE id = $2', ['owner', existing.id]);
      console.log('[seed] existing account promoted to owner:', email);
    } else {
      console.log('[seed] owner account present:', email);
    }
    // Optional password reset via env flag (useful if the owner is locked out).
    if (config.admin.password && process.env.ADMIN_RESET_PASSWORD === 'true') {
      const hash = await bcrypt.hash(config.admin.password, 12);
      await db.query('UPDATE profiles SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, existing.id]);
      console.log('[seed] owner password reset from ADMIN_PASSWORD');
    }
    return;
  }

  if (!config.admin.password) {
    console.warn(
      `[seed] owner account ${email} does not exist yet and ADMIN_PASSWORD is not set. ` +
      'Set ADMIN_PASSWORD and restart to create it.'
    );
    return;
  }

  const hash = await bcrypt.hash(config.admin.password, 12);
  await db.query(
    `INSERT INTO profiles (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (lower(email)) DO NOTHING`,
    [config.admin.name, email, hash]
  );
  console.log('[seed] owner account created:', email);
}

async function seed() {
  await seedProducts();
  await seedOwner();
}

if (require.main === module) {
  seed()
    .then(() => db.pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}

module.exports = { seed, seedProducts, seedOwner };
