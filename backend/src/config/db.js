// This module is the single place the rest of the backend goes
// to talk to Postgres. Everything else (controllers, routes)
// should `require('../config/db')` and use the exported pool —
// nobody else should call `new Pool()` directly. Centralizing it
// here means connection settings only need to be correct once.

const { Pool } = require('pg');
require('dotenv').config();

// A Pool, not a single Client: Express will handle many requests
// concurrently, and each one needs its own connection for the
// duration of its query. The Pool keeps a small set of open
// connections and hands them out/reclaims them as needed, instead
// of opening a brand new TCP + auth handshake per request.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Supabase requires TLS on every connection. `rejectUnauthorized:
  // false` accepts Supabase's certificate without needing the CA
  // bundle installed locally — fine for this project; a stricter
  // production setup would pin the actual CA cert instead.
  ssl: {
    rejectUnauthorized: false,
  },

  // Caps how many simultaneous connections this backend instance
  // will hold open. Supabase's free tier has a fairly small total
  // connection limit shared across everything hitting the DB, so
  // this is intentionally conservative rather than maxed out.
  max: 10,
});

// Fails loudly and immediately if the connection string is wrong
// or the database is unreachable, rather than surfacing as a
// confusing error the first time a route tries to query.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
  process.exit(1);
});

module.exports = pool;