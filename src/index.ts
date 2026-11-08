import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { getManifest } from './routes/manifest.js';
import { handleSearch } from './routes/search.js';
import { handleStream } from './routes/stream.js';
import { handleHealth } from './routes/health.js';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Request logger for debugging BitChord queries
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl} | Range: ${req.headers.range || 'none'}`);
  next();
});

// BitChord Addon Protocol Routes
app.get('/manifest.json', getManifest);
app.get('/search', handleSearch);
app.get('/stream/:id', handleStream);
app.get('/health', handleHealth);

// Addon Status Dashboard (when opened in browser)
app.get('/', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BitChord Hi-Res Lossless Addon</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e1e7ef; padding: 40px 20px; line-height: 1.6; max-width: 680px; margin: 0 auto; }
    h1 { color: #38bdf8; margin-bottom: 8px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: bold; background: ${config.deezerArl ? '#15803d' : '#b45309'}; color: white; margin-bottom: 20px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; margin: 16px 0; border: 1px solid #334155; }
    code { background: #0b0f19; padding: 3px 8px; border-radius: 6px; font-family: monospace; color: #38bdf8; }
    ol { padding-left: 20px; }
    li { margin-bottom: 8px; }
    a { color: #38bdf8; text-decoration: none; }
  </style>
</head>
<body>
  <h1>🎵 BitChord Hi-Res Lossless Addon</h1>
  <div class="badge">${config.deezerArl ? '● Deezer ARL Connected (FLAC Ready)' : '○ ARL Missing in .env'}</div>

  <div class="card">
    <h3>📱 Cara Menghubungkan ke BitChord:</h3>
    <ol>
      <li>Buka aplikasi <strong>BitChord</strong> di Android.</li>
      <li>Buka <strong>Settings → Sources / Add-ons → Add addon</strong>.</li>
      <li>Masukkan URL addon ini (misal: <code>http://&lt;IP-LAN-KAMU&gt;:${config.port}</code> atau link tunnel HTTPS).</li>
      <li>Tekan <strong>Test</strong> lalu <strong>Save</strong>.</li>
    </ol>
  </div>

  <div class="card">
    <h3>🔗 Available Endpoints:</h3>
    <ul>
      <li><a href="/manifest.json"><code>GET /manifest.json</code></a> — Addon descriptor</li>
      <li><a href="/search?q=daft+punk"><code>GET /search?q=daft+punk</code></a> — Track search</li>
      <li><a href="/health"><code>GET /health</code></a> — Health status</li>
    </ul>
  </div>
</body>
</html>
  `);
});

app.listen(config.port, config.host, () => {
  console.log(`\n=================================================`);
  console.log(`🎵 BitChord Hi-Res Lossless Addon Server`);
  console.log(`📍 Listening on: http://${config.host}:${config.port}`);
  console.log(`📋 Manifest URL: http://${config.host}:${config.port}/manifest.json`);
  console.log(`🔑 Deezer ARL:   ${config.deezerArl ? 'CONFIGURED (FLAC ready)' : 'NOT SET (Add in .env)'}`);
  console.log(`=================================================\n`);
});
