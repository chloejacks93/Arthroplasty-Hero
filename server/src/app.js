import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError } from './lib/errors.js';
import { loadUser, requireAuth, csrfGuard } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import assetRoutes from './routes/assets.js';
import dashboardRoutes from './routes/dashboard.js';
import metaRoutes from './routes/meta.js';
import importRoutes from './routes/imports.js';
import conflictRoutes from './routes/conflicts.js';
import exportRoutes from './routes/exports.js';
import qrRoutes from './routes/qr.js';
import transferRoutes from './routes/transfers.js';
import investigationRoutes from './routes/investigations.js';
import notificationRoutes from './routes/notifications.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS at its proxy
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'", 'blob:'],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Camera is needed for QR scanning (Phase 3); everything else is denied.
  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Health check for Render (no auth, no data).
  app.get('/healthz', async (_req, res) => {
    await query('SELECT 1');
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(loadUser);
  api.use(csrfGuard);
  api.use('/auth', authRoutes);
  api.use(requireAuth);
  api.use('/dashboard', dashboardRoutes);
  api.use('/assets', assetRoutes);
  api.use('/meta', metaRoutes);
  api.use('/imports', importRoutes);
  api.use('/conflicts', conflictRoutes);
  api.use('/exports', exportRoutes);
  api.use('/qr', qrRoutes);
  api.use('/transfers', transferRoutes);
  api.use('/investigations', investigationRoutes);
  api.use('/notifications', notificationRoutes);
  api.use((_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint.')));
  app.use('/api', api);

  // Serve the built client (single-page app) when present.
  const dist = config.clientDist || path.resolve(here, '../../client/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, redirect: false, maxAge: '1h', setHeaders: noCacheForShell }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // Central error handler — never leaks stack traces or SQL to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
    if (err?.code === '23505') return res.status(409).json({ error: 'That record already exists (duplicate value).' });
    if (err?.code === '23503') return res.status(409).json({ error: 'That change references a record that does not exist or is still in use.' });
    if (err?.code === '23514' || err?.code === '22P02') return res.status(400).json({ error: 'One or more values are not valid.' });
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}

function noCacheForShell(res, filePath) {
  if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(filePath)) res.set('Cache-Control', 'no-cache');
  else if (/[\\/]_app[\\/]/.test(filePath)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
}
