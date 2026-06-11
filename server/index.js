'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const coursesRouter = require('./routes/courses');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// API
app.use('/api', coursesRouter);

// Static frontend
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// SPA fallback: anything that isn't an API call or a real file -> index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

// JSON error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[figaro]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const certDir = path.join(__dirname);
const certPath = path.join(certDir, 'localhost.pem');
const keyPath  = path.join(certDir, 'localhost-key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
    .listen(PORT, () => {
      const def = process.env.DEFAULT_PROVIDER || 'mock';
      console.log(`\n  Figaro is running.`);
      console.log(`  →  https://localhost:${PORT}`);
      console.log(`  Default provider: ${def}\n`);
    });
} else {
  app.listen(PORT, () => {
    const def = process.env.DEFAULT_PROVIDER || 'mock';
    console.log(`\n  Figaro is running.`);
    console.log(`  →  http://localhost:${PORT}`);
    console.log(`  Default provider: ${def}\n`);
  });
}
