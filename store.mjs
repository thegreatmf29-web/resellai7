/* ============================================================================
   Resell.AI — storage layer
   ----------------------------------------------------------------------------
   Two drivers, same interface:

     file      (default)  — JSON on disk. Fine locally. NOT safe on Render's
                            free tier: the filesystem is wiped on every restart
                            and the service restarts after 15 minutes idle.
                            Paying customers would silently lose their plan.

     postgres  (DATABASE_URL set) — what you must use in production. Any free
                            Postgres works: Neon, Supabase, Render Postgres.

   The server refuses to start in production with real Stripe keys unless a
   database is configured, because losing a paying user's record is the one
   failure that costs you money and trust at the same time.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL || '';
export const DRIVER = DATABASE_URL ? 'postgres' : 'file';

/* ══════════════════════════════ file driver ══════════════════════════════ */

const FILE = process.env.DATA_FILE || path.join(__dirname, '.data.json');
let cache = null;

function readFileDb() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { cache = { users: {}, codes: {} }; }
  cache.users ||= {};
  cache.codes ||= {};
  return cache;
}

let writeTimer = null;
function writeFileDb() {
  clearTimeout(writeTimer);
  // debounce: bursts of writes collapse into one fsync
  writeTimer = setTimeout(() => {
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, FILE);        // atomic — never leaves a half-written file
    } catch (e) { console.error('store write failed:', e.message); }
  }, 120);
}

/* ════════════════════════════ postgres driver ════════════════════════════ */

let pool = null;

async function pg() {
  if (pool) return pool;
  let Pg;
  try { Pg = await import('pg'); }
  catch {
    throw new Error(
      'DATABASE_URL is set but the "pg" package is not installed. Run: npm install pg'
    );
  }
  pool = new Pg.default.Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 4
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email             TEXT PRIMARY KEY,
      created_at        BIGINT NOT NULL,
      plan              TEXT NOT NULL DEFAULT 'free',
      stripe_customer   TEXT,
      stripe_sub        TEXT,
      period_start      BIGINT NOT NULL DEFAULT 0,
      scans_used        INT NOT NULL DEFAULT 0,
      listings_used     INT NOT NULL DEFAULT 0,
      tokens            JSONB NOT NULL DEFAULT '[]'::jsonb,
      ebay              JSONB
    );
    CREATE TABLE IF NOT EXISTS codes (
      email      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires    BIGINT NOT NULL,
      attempts   INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS users_customer_idx ON users (stripe_customer);
  `);
  return pool;
}

const rowToUser = r => r && ({
  email: r.email,
  createdAt: Number(r.created_at),
  plan: r.plan,
  stripeCustomer: r.stripe_customer || null,
  stripeSub: r.stripe_sub || null,
  periodStart: Number(r.period_start),
  scansUsed: r.scans_used,
  listingsUsed: r.listings_used,
  tokens: r.tokens || [],
  ebay: r.ebay || null
});

/* ═══════════════════════════════ public API ══════════════════════════════ */

export async function getUser(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return null;
  if (DRIVER === 'file') return readFileDb().users[email] || null;
  const { rows } = await (await pg()).query('SELECT * FROM users WHERE email=$1', [email]);
  return rowToUser(rows[0]);
}

export async function putUser(u) {
  u.email = String(u.email).toLowerCase().trim();
  if (DRIVER === 'file') {
    readFileDb().users[u.email] = u;
    writeFileDb();
    return u;
  }
  await (await pg()).query(
    `INSERT INTO users (email, created_at, plan, stripe_customer, stripe_sub,
                        period_start, scans_used, listings_used, tokens, ebay)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (email) DO UPDATE SET
       plan=$3, stripe_customer=$4, stripe_sub=$5, period_start=$6,
       scans_used=$7, listings_used=$8, tokens=$9, ebay=$10`,
    [u.email, u.createdAt, u.plan, u.stripeCustomer, u.stripeSub,
     u.periodStart, u.scansUsed, u.listingsUsed,
     JSON.stringify(u.tokens || []), u.ebay ? JSON.stringify(u.ebay) : null]
  );
  return u;
}

export async function findByCustomer(customerId) {
  if (!customerId) return null;
  if (DRIVER === 'file') {
    return Object.values(readFileDb().users).find(u => u.stripeCustomer === customerId) || null;
  }
  const { rows } = await (await pg()).query('SELECT * FROM users WHERE stripe_customer=$1', [customerId]);
  return rowToUser(rows[0]);
}

/* Login codes are stored hashed. A leaked database should not hand out logins. */

export async function putCode(email, codeHash, expires) {
  email = email.toLowerCase().trim();
  if (DRIVER === 'file') {
    readFileDb().codes[email] = { codeHash, expires, attempts: 0 };
    writeFileDb();
    return;
  }
  await (await pg()).query(
    `INSERT INTO codes (email, code_hash, expires, attempts) VALUES ($1,$2,$3,0)
     ON CONFLICT (email) DO UPDATE SET code_hash=$2, expires=$3, attempts=0`,
    [email, codeHash, expires]
  );
}

export async function getCode(email) {
  email = String(email || '').toLowerCase().trim();
  if (DRIVER === 'file') return readFileDb().codes[email] || null;
  const { rows } = await (await pg()).query('SELECT * FROM codes WHERE email=$1', [email]);
  const r = rows[0];
  return r && { codeHash: r.code_hash, expires: Number(r.expires), attempts: r.attempts };
}

export async function bumpCodeAttempts(email) {
  email = email.toLowerCase().trim();
  if (DRIVER === 'file') {
    const c = readFileDb().codes[email];
    if (c) { c.attempts++; writeFileDb(); }
    return;
  }
  await (await pg()).query('UPDATE codes SET attempts=attempts+1 WHERE email=$1', [email]);
}

export async function clearCode(email) {
  email = String(email || '').toLowerCase().trim();
  if (DRIVER === 'file') { delete readFileDb().codes[email]; writeFileDb(); return; }
  await (await pg()).query('DELETE FROM codes WHERE email=$1', [email]);
}

export async function ready() {
  if (DRIVER === 'file') { readFileDb(); return true; }
  await pg();
  return true;
}
