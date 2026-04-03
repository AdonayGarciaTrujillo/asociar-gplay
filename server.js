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

app.listen(PORT, () => {
  console.log(`[lab] http://localhost:${PORT}/index.html`);
  console.log(`[lab] Base: archivo local data/ o Turso si defines TURSO_DATABASE_URL`);
  console.log(`[lab] Token listados: ${lab.getLabTokenHint()}`);
});
