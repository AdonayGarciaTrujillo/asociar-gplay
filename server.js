/**
 * Servidor local Express. En Vercel/Netlify usa funciones serverless + Turso (ver despliegue).
 */
const express = require('express');
const cors = require('cors');
const lab = require('./lib/lab-api');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '8kb' }));

app.post('/api/submissions', async (req, res) => {
  try {
    const ua = req.get('user-agent') || '';
    const ip = req.ip || req.socket.remoteAddress || '';
    const out = await lab.postSubmission(req.body || {}, { userAgent: ua, remoteAddress: ip });
    res.status(201).json(out);
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) console.error(err);
    res.status(code).json({ error: err.message || 'Error' });
  }
});

app.get('/api/submissions', async (req, res) => {
  try {
    const token = req.get('x-lab-token');
    const out = await lab.getSubmissions(req.query.limit, token);
    res.json(out);
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) console.error(err);
    res.status(code).json({ error: err.message || 'Error' });
  }
});

app.use(express.static(__dirname));

function dbModeLog() {
  const u = process.env.DATABASE_URL || '';
  if (/^postgres(ql)?:\/\//i.test(u)) return 'PostgreSQL (variable DATABASE_URL)';
  if (process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL) return 'Turso / libSQL remoto';
  return 'Archivo local ./data/laboratorio.db (en Render no persiste sin Postgres)';
}

app.listen(PORT, () => {
  console.log(`[lab] http://localhost:${PORT}/index.html`);
  console.log(`[lab] Base de datos: ${dbModeLog()}`);
  console.log(`[lab] Token listados (LAB_TOKEN): ${lab.getLabTokenHint()}`);
});
