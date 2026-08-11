'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('[migrate] schema ensured (tables, indexes, constraints)');
}

if (require.main === module) {
  migrate()
    .then(() => db.pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
