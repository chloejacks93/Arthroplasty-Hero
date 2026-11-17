import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { sweepOverdueTransfers } from './lib/transfers.js';

import { ensureInitialAdmin } from './bootstrap.js';
import { applyAdminRecovery } from './recovery.js';

await ensureInitialAdmin().catch((e) => console.error('[bootstrap] failed:', e.message));
await applyAdminRecovery().catch((e) => console.error('[recovery] failed:', e.message));
// Which administrator accounts exist (emails only, never passwords) — visible in the
// hosting dashboard's private logs so the owner knows which address to sign in with.
await pool.query(`SELECT email, (locked_until > now()) AS locked FROM users WHERE role = 'admin' AND active ORDER BY created_at`)
  .then(({ rows }) => console.log(`[accounts] Administrator sign-in email(s): ${rows.map((r) => `${r.email}${r.locked ? ' (locked)' : ''}`).join(', ') || 'none yet'}`))
  .catch(() => {});

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
