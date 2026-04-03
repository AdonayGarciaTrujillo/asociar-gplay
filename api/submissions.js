/**
 * Vercel Serverless: POST/GET /api/submissions
 * Variables en Vercel: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, LAB_TOKEN (obligatorio en público)
 */
const lab = require('../lib/lab-api');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Lab-Token');
}

async function readJsonBody(req) {
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string') {
    try {
      return req.body ? JSON.parse(req.body) : {};
    } catch {
      return {};
    }
  }
  const text = await new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const ua = req.headers['user-agent'] || '';
      const xf = req.headers['x-forwarded-for'];
      const ip = (typeof xf === 'string' ? xf.split(',')[0] : '') || req.socket?.remoteAddress || '';
      const out = await lab.postSubmission(body, { userAgent: ua, remoteAddress: ip });
      return res.status(201).json(out);
    }

    if (req.method === 'GET') {
      const token = req.headers['x-lab-token'];
      const limit = req.query?.limit;
      const out = await lab.getSubmissions(limit, token);
      return res.status(200).json(out);
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) console.error('[api/submissions]', err);
    return res.status(code).json({ error: err.message || 'Error interno' });
  }
};
