import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { sweepOverdueTransfers } from './lib/transfers.js';

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[server] Arthroplasty Asset Control listening on :${config.port} (${config.env})`);
});

// Expired-session cleanup, hourly.
const sweep = setInterval(() => {
  pool.query('DELETE FROM sessions WHERE expires_at < now()').catch((e) => console.error('[sweep]', e.message));
}, 60 * 60 * 1000);
sweep.unref();

// Overdue-transfer reminders, every 15 minutes (idempotent).
const overdue = setInterval(() => {
  sweepOverdueTransfers(pool).catch((e) => console.error('[overdue]', e.message));
}, 15 * 60 * 1000);
overdue.unref();

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
