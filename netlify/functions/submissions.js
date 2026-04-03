/**
 * Netlify Function: proxy desde /api/submissions (ver netlify.toml)
 */
const lab = require('../../lib/lab-api');

function headers(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Lab-Token',
    'Content-Type': 'application/json',
    ...extra
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers() };
  }

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const ua = event.headers['user-agent'] || event.headers['User-Agent'] || '';
      const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || '';
      const out = await lab.postSubmission(body, { userAgent: ua, remoteAddress: String(ip).split(',')[0].trim() });
      return { statusCode: 201, headers: headers(), body: JSON.stringify(out) };
    }

    if (event.httpMethod === 'GET') {
      const token = event.headers['x-lab-token'] || event.headers['X-Lab-Token'];
      const limit = event.queryStringParameters?.limit;
      const out = await lab.getSubmissions(limit, token);
      return { statusCode: 200, headers: headers(), body: JSON.stringify(out) };
    }

    return {
      statusCode: 405,
      headers: headers(),
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) console.error('[netlify submissions]', err);
    return {
      statusCode: code,
      headers: headers(),
      body: JSON.stringify({ error: err.message || 'Error interno' })
    };
  }
};
