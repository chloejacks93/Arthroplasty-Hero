import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db.js';
import { parse, unauthorized, badRequest } from '../lib/errors.js';
import { createSession, cookieOptions, requireAuth, SESSION_COOKIE } from '../middleware/auth.js';

const router = Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Pre-computed hash so unknown e-mails take the same time as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT || 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const { rows } = await query(
    `SELECT id, password_hash, active, locked_until, role FROM users WHERE lower(email) = $1`,
    [email],
  );
  const user = rows[0];
  const usable = user && user.active && user.role !== 'system' && user.password_hash;

  if (usable && user.locked_until && new Date(user.locked_until) > new Date()) {
    throw unauthorized('This account is temporarily locked after repeated failed sign-ins. Try again in 15 minutes.');
  }
  const ok = await bcrypt.compare(password, usable ? user.password_hash : DUMMY_HASH);
  if (!usable || !ok) {
    if (usable) {
      await query(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) END
          WHERE id = $1`,
        [user.id, MAX_FAILED, LOCK_MINUTES],
      );
    }
    throw unauthorized('Incorrect email or password.');
  }

  await query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
  const token = await createSession(user.id, req);
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  if (req.sessionTokenHash) await query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionTokenHash]);
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) throw unauthorized();
  res.json({ user: req.user });
});

const pwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'must be at least 10 characters').max(200),
});

router.post('/change-password', async (req, res) => {
  if (!req.user) throw unauthorized();
  const { currentPassword, newPassword } = parse(pwSchema, req.body);
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) throw badRequest('Current password is incorrect.');
  const hash = await bcrypt.hash(newPassword, 12);
  if (await bcrypt.compare(newPassword, rows[0].password_hash)) throw badRequest('Choose a password different from the current one.');
  await query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [req.user.id, hash]);
  // Sign out every other device.
  await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.sessionTokenHash]);
  res.json({ ok: true });
});

export default router;
