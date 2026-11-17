import crypto from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { unauthorized, forbidden } from '../lib/errors.js';

export const SESSION_COOKIE = 'ahsid';

export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  };
}

/** Create a session row and return the raw token (only ever sent to the browser as a cookie). */
export async function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [hashToken(token), userId, config.sessionDays, req.ip, (req.get('user-agent') || '').slice(0, 300)],
  );
  return token;
}

/** Attach req.user when a valid session cookie is present. Never throws for anonymous requests. */
export async function loadUser(req, _res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  const { rows } = await query(
    `UPDATE sessions s SET last_seen_at = now(),
            expires_at = GREATEST(s.expires_at, now() + make_interval(days => $2))
       FROM users u
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.active
            AND u.role <> 'system'
      RETURNING u.id, u.email, u.full_name, u.role, u.phone, u.title, u.must_change_password,
                ARRAY(SELECT team_id FROM user_teams WHERE user_id = u.id) AS team_ids`,
    [hashToken(token), config.sessionDays],
  );
  if (rows[0]) {
    req.user = rows[0];
    req.sessionTokenHash = hashToken(token);
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) throw unauthorized();
  // A temporary password must be replaced before anything else is allowed.
  if (req.user.must_change_password) {
    throw Object.assign(forbidden('Set a new password to continue.'), { details: { code: 'password_change_required' } });
  }
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) throw unauthorized();
  if (!roles.includes(req.user.role)) throw forbidden();
  next();
};

/**
 * CSRF defence for cookie auth: state-changing requests must carry a custom
 * header, which browsers will not attach to cross-site form posts.
 * Combined with SameSite=Lax cookies.
 */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'fetch') throw forbidden('Request blocked (missing client header).');
  next();
}
