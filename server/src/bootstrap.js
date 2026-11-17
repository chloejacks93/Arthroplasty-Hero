// First-run setup for a fresh deployment.
//
//   INITIAL_ADMIN_EMAIL     (required to do anything)
//   INITIAL_ADMIN_NAME      (optional)
//   INITIAL_ADMIN_PASSWORD  (optional, min 10 chars) — a password chosen by the
//                           owner in the hosting dashboard. When absent, a random
//                           temporary password is generated and printed ONCE to
//                           the server log.
//
// Rules:
//   * No active administrator yet -> create one (must change password at first sign-in).
//   * The configured administrator exists but has NEVER signed in, and
//     INITIAL_ADMIN_PASSWORD is set -> set that password (recovers a missed log).
//   * Otherwise nothing changes. Once anyone has signed in as that administrator,
//     these settings can no longer alter the account.
// A one-line status (never containing a password) is logged on every start.
import bcrypt from 'bcryptjs';
import { tx } from './db.js';
import { tempPassword } from './lib/audit.js';

const SYSTEM = '00000000-0000-0000-0000-000000000001';

export async function ensureInitialAdmin({
  email = process.env.INITIAL_ADMIN_EMAIL,
  name = process.env.INITIAL_ADMIN_NAME,
  password = process.env.INITIAL_ADMIN_PASSWORD,
  log = console.log,
} = {}) {
  const addr = (email || '').trim().toLowerCase();
  if (!addr) {
    log('[bootstrap] INITIAL_ADMIN_EMAIL is not set; first-administrator setup skipped.');
    return null;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    log('[bootstrap] INITIAL_ADMIN_EMAIL is not a valid email address; first-administrator setup skipped.');
    return null;
  }
  // Values pasted into a dashboard often carry stray spaces or a newline.
  let chosen = password ? String(password).trim() : '';
  if (chosen && chosen.length < 10) {
    log('[bootstrap] INITIAL_ADMIN_PASSWORD is shorter than 10 characters and was ignored.');
    chosen = '';
  }

  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(74210003)'); // one instance at a time
    const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
    const { rows: [existing] } = await c.query(
      `SELECT id, role, active, last_login_at FROM users WHERE lower(email) = $1`, [addr]);

    // Case 1: nobody can administer the system yet.
    if (n.n === 0) {
      const pw = chosen || tempPassword();
      const hash = await bcrypt.hash(pw, 12);
      const fullName = (name || '').trim() || addr.split('@')[0];
      const { rows: [u] } = await c.query(
        `INSERT INTO users (email, full_name, role, password_hash, must_change_password, active)
         VALUES ($1, $2, 'admin', $3, true, true)
         ON CONFLICT ((lower(email))) DO UPDATE
           SET role = 'admin', active = true, password_hash = EXCLUDED.password_hash, must_change_password = true,
               failed_logins = 0, locked_until = NULL
         RETURNING id`, [addr, fullName, hash]);
      await c.query(
        `INSERT INTO admin_audit (actor_id, entity, entity_id, action, changes) VALUES ($1, 'user', $2, 'created', $3)`,
        [SYSTEM, u.id, JSON.stringify({ email: addr, role: 'admin', source: 'initial setup' })]);
      log('================================================================');
      log(`[bootstrap] Initial administrator: ${addr}`);
      if (chosen) log('[bootstrap] Password: the INITIAL_ADMIN_PASSWORD you set in the dashboard.');
      else log(`[bootstrap] Temporary password:    ${pw}`);
      log('[bootstrap] Sign in and set your own password.');
      log('================================================================');
      return { id: u.id, email: addr, password: chosen ? null : pw, action: 'created' };
    }

    // A recovery password takes precedence; don't overwrite it on every restart.
    if (chosen && process.env.ADMIN_RECOVERY_PASSWORD) {
      log('[bootstrap] ADMIN_RECOVERY_PASSWORD is set, so INITIAL_ADMIN_PASSWORD is ignored. Remove INITIAL_ADMIN_PASSWORD.');
      return null;
    }
    // Case 2: the configured admin exists but has never signed in; owner supplied a password.
    if (chosen && existing && existing.role === 'admin' && existing.active && !existing.last_login_at) {
      const hash = await bcrypt.hash(chosen, 12);
      await c.query(
        `UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1`,
        [existing.id, hash]);
      await c.query('DELETE FROM sessions WHERE user_id = $1', [existing.id]);
      await c.query(
        `INSERT INTO admin_audit (actor_id, entity, entity_id, action, changes) VALUES ($1, 'user', $2, 'password_reset', $3)`,
        [SYSTEM, existing.id, JSON.stringify({ source: 'INITIAL_ADMIN_PASSWORD (never signed in)' })]);
      log(`[bootstrap] Administrator ${addr} has not signed in yet: password set from INITIAL_ADMIN_PASSWORD. Sign in, then remove that setting.`);
      return { id: existing.id, email: addr, password: null, action: 'password_set' };
    }

    // Case 3: nothing to do. Explain why, without secrets.
    if (chosen) {
      log(`[bootstrap] ${n.n} administrator(s) already active and ${existing?.last_login_at ? `${addr} has signed in before` : `${addr} is not the never-signed-in administrator`}; INITIAL_ADMIN_PASSWORD ignored. You can remove it from the dashboard.`);
    } else {
      log(`[bootstrap] ${n.n} administrator(s) already exist${existing ? ` (including ${addr}${existing.last_login_at ? '' : ', not signed in yet'})` : ''}; no setup needed.`);
    }
    return null;
  });
}
