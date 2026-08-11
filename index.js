'use strict';

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/**
 * All queries go through here. Values are always passed as parameters
 * ($1, $2 ...) so user input can never be concatenated into SQL.
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 800) console.warn(`[db] slow query (${ms}ms): ${text.slice(0, 90)}`);
  return res;
}

async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx };
