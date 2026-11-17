// Administrator recovery without a server shell (Render's free plan has none).
//
//   ADMIN_RECOVERY_EMAIL     the administrator to recover (defaults to INITIAL_ADMIN_EMAIL)
//   ADMIN_RECOVERY_PASSWORD  a temporary password chosen in the hosting dashboard (10+ chars)
//
// Applied ONCE per distinct value: the account gets that password, is unlocked,
// signed out everywhere, and must choose a new password at sign-in. A fingerprint
// of the applied value is stored, so restarts do not keep resetting it. Remove
// the setting after use. The password is never logged.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { tx } from './db.js';

const SYSTEM = '00000000-0000-0000-0000-000000000001';

export async function applyAdminRecovery({
  email = process.env.ADMIN_RECOVERY_EMAIL || process.env.INITIAL_ADMIN_EMAIL,
  password = process.env.ADMIN_RECOVERY_PASSWORD,
  log = console.log,
} = {}) {
  // Values pasted into a dashboard often carry stray spaces or a newline.
  password = password ? String(password).trim() : '';
  if (!password) return null;
  const addr = (email || '').trim().toLowerCase();
  if (password.length < 10) {
    log('[recovery] ADMIN_RECOVERY_PASSWORD is shorter than 10 characters; ignored.');
    return null;
  }
  if (!addr) {
    log('[recovery] Set ADMIN_RECOVERY_EMAIL (or INITIAL_ADMIN_EMAIL) to say which administrator to recover; ignored.');
    return null;
  }
  const fingerprint = crypto.createHash('sha256').update(`${addr}\n${password}`).digest('hex');
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(74210004)');
    const { rows: [done] } = await c.query(`SELECT value, updated_at FROM app_settings WHERE key = 'admin_recovery_applied'`);
    const { rows: [u] } = await c.query(`SELECT id, role, last_login_at FROM users WHERE lower(email) = $1 AND role <> 'system'`, [addr]);
    // Re-apply on every start until the owner has actually signed in with it;
    // after that, the same value never resets the account again.
    if (done?.value === fingerprint && u?.last_login_at && u.last_login_at > done.updated_at) {
      log('[recovery] This recovery password was already used to sign in. Remove ADMIN_RECOVERY_PASSWORD from the dashboard.');
      return null;
    }
    if (!u) {
      log(`[recovery] No user with email ${addr}; nothing changed.`);
      return null;
    }
    if (u.role !== 'admin') {
      log(`[recovery] ${addr} is not an administrator; nothing changed.`);
      return null;
    }
    const hash = await bcrypt.hash(String(password), 12);
    await c.query(
      `UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL, active = true
        WHERE id = $1`, [u.id, hash]);
    await c.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    await c.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('admin_recovery_applied', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [fingerprint]);
    await c.query(
      `INSERT INTO admin_audit (actor_id, entity, entity_id, action, changes) VALUES ($1, 'user', $2, 'password_reset', $3)`,
      [SYSTEM, u.id, JSON.stringify({ source: 'ADMIN_RECOVERY_PASSWORD' })]);
    log(`[recovery] Administrator ${addr} unlocked; sign in with ADMIN_RECOVERY_PASSWORD, choose a new password, then remove the setting.`);
    return { id: u.id, email: addr };
  });
}
