// First-run setup for a fresh deployment.
// If INITIAL_ADMIN_EMAIL is set and there is no active administrator yet,
// create one with a random temporary password and print it ONCE to the
// server log (visible only to people with access to the hosting dashboard).
// The password must be changed at first sign-in. Does nothing afterwards.
import bcrypt from 'bcryptjs';
import { tx } from './db.js';
import { tempPassword } from './lib/audit.js';

export async function ensureInitialAdmin({ email = process.env.INITIAL_ADMIN_EMAIL, name = process.env.INITIAL_ADMIN_NAME, log = console.log } = {}) {
  const addr = (email || '').trim().toLowerCase();
  if (!addr) return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    log('[bootstrap] INITIAL_ADMIN_EMAIL is not a valid email; skipping.');
    return null;
  }
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(74210003)'); // one instance at a time
    const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
    if (n.n > 0) return null;
    const password = tempPassword();
    const hash = await bcrypt.hash(password, 12);
    const fullName = (name || '').trim() || addr.split('@')[0];
    const { rows: [u] } = await c.query(
      `INSERT INTO users (email, full_name, role, password_hash, must_change_password, active)
       VALUES ($1, $2, 'admin', $3, true, true)
       ON CONFLICT ((lower(email))) DO UPDATE
         SET role = 'admin', active = true, password_hash = EXCLUDED.password_hash, must_change_password = true,
             failed_logins = 0, locked_until = NULL
       RETURNING id`, [addr, fullName, hash]);
    await c.query(
      `INSERT INTO admin_audit (actor_id, entity, entity_id, action, changes)
       VALUES ('00000000-0000-0000-0000-000000000001', 'user', $1, 'created', $2)`,
      [u.id, JSON.stringify({ email: addr, role: 'admin', source: 'initial setup' })]);
    log('================================================================');
    log(`[bootstrap] Initial administrator: ${addr}`);
    log(`[bootstrap] Temporary password:    ${password}`);
    log('[bootstrap] Sign in and set your own password. This is shown once.');
    log('================================================================');
    return { id: u.id, email: addr, password };
  });
}
