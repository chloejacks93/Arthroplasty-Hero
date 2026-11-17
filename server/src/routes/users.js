import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { parse, forbidden, notFound, conflict, badRequest } from '../lib/errors.js';
import { can, ROLES } from '../lib/roles.js';
import { audit, diff, tempPassword } from '../lib/audit.js';

// People directory. Management and inventory can view; only administrators change.
const router = Router();
router.use((req, _res, next) => {
  if (!can.viewAll(req.user)) throw forbidden();
  next();
});
const adminOnly = (req) => { if (!can.administer(req.user)) throw forbidden('Only administrators can change user accounts.'); };

const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.role, u.phone, u.title, u.active, u.last_login_at, u.created_at,
         u.must_change_password, (u.locked_until > now()) AS locked,
         coalesce((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
                     FROM user_teams ut JOIN teams t ON t.id = ut.team_id WHERE ut.user_id = u.id), '[]') AS teams,
         (SELECT count(*)::int FROM assets a WHERE a.assigned_rep_id = u.id AND a.retired_at IS NULL) AS assigned_assets,
         (SELECT count(*)::int FROM assets a WHERE a.custodian_id = u.id AND a.retired_at IS NULL) AS custody_assets,
         (SELECT count(*)::int FROM transfers t WHERE t.recipient_id = u.id AND t.status = 'in_transit') AS incoming_transfers
    FROM users u`;

router.get('/', async (req, res) => {
  const f = parse(z.object({
    q: z.string().trim().max(100).optional(),
    role: z.enum(ROLES).optional(),
    team_id: z.uuid().optional(),
    status: z.enum(['active', 'inactive', 'all']).default('active'),
  }), req.query);
  const where = [`u.role <> 'system'`];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.status !== 'all') where.push(f.status === 'active' ? 'u.active' : 'NOT u.active');
  if (f.role) add('u.role = ?', f.role);
  if (f.team_id) add('EXISTS (SELECT 1 FROM user_teams ut WHERE ut.user_id = u.id AND ut.team_id = ?)', f.team_id);
  if (f.q) add('(u.full_name ILIKE ? OR u.email ILIKE ?)', `%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
  const { rows } = await query(`${USER_SELECT} WHERE ${where.join(' AND ')} ORDER BY u.active DESC, u.full_name`, params);
  res.json({ items: rows, canEdit: can.administer(req.user) });
});

router.get('/:id/history', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { rows } = await query(
    `SELECT a.id, a.action, a.changes, a.occurred_at, u.full_name AS actor_name FROM admin_audit a JOIN users u ON u.id = a.actor_id
      WHERE a.entity = 'user' AND a.entity_id = $1 ORDER BY a.occurred_at DESC LIMIT 100`, [id]);
  res.json({ items: rows });
});

const base = {
  full_name: z.string().trim().min(2).max(120),
  role: z.enum(ROLES),
  phone: z.string().trim().max(40).nullable().optional(),
  title: z.string().trim().max(80).nullable().optional(),
  team_ids: z.array(z.uuid()).max(50).optional(),
};
const createSchema = z.object({
  ...base,
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10, 'must be at least 10 characters').max(200).optional(),
});
const updateSchema = z.object({ ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])), active: z.boolean().optional() });

async function setTeams(c, userId, teamIds) {
  if (teamIds === undefined) return null;
  const ids = [...new Set(teamIds)];
  if (ids.length) {
    const { rows } = await c.query('SELECT id FROM teams WHERE id = ANY($1) AND active', [ids]);
    if (rows.length !== ids.length) throw badRequest('One of the selected teams does not exist or is inactive.');
  }
  const { rows: before } = await c.query('SELECT team_id FROM user_teams WHERE user_id = $1', [userId]);
  await c.query('DELETE FROM user_teams WHERE user_id = $1 AND NOT (team_id = ANY($2))', [userId, ids]);
  for (const t of ids) await c.query('INSERT INTO user_teams (user_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, t]);
  return { from: before.map((r) => r.team_id).sort(), to: ids.sort() };
}

router.post('/', async (req, res) => {
  adminOnly(req);
  const b = parse(createSchema, req.body);
  const temp = b.password ? null : tempPassword();
  const hash = await bcrypt.hash(b.password || temp, 12);
  const user = await tx(async (c) => {
    const { rows: [dupe] } = await c.query('SELECT id FROM users WHERE lower(email) = $1', [b.email]);
    if (dupe) throw conflict('A user with this email already exists.');
    const { rows: [u] } = await c.query(
      `INSERT INTO users (email, full_name, role, phone, title, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [b.email, b.full_name, b.role, b.phone || null, b.title || null, hash]);
    await setTeams(c, u.id, b.team_ids || []);
    await audit(c, req.user.id, 'user', u.id, 'created', { email: b.email, full_name: b.full_name, role: b.role, team_ids: b.team_ids || [] });
    return u;
  });
  const { rows: [full] } = await query(`${USER_SELECT} WHERE u.id = $1`, [user.id]);
  res.status(201).json({ user: full, temporaryPassword: temp });
});

router.patch('/:id', async (req, res) => {
  adminOnly(req);
  const id = parse(z.uuid(), req.params.id);
  const b = parse(updateSchema, req.body);
  await tx(async (c) => {
    const { rows: [u] } = await c.query(`SELECT * FROM users WHERE id = $1 AND role <> 'system' FOR UPDATE`, [id]);
    if (!u) throw notFound('User not found.');
    const deactivating = b.active === false && u.active;
    const demoting = b.role && b.role !== 'admin' && u.role === 'admin';
    if ((deactivating || demoting) && id === req.user.id) throw badRequest('You cannot deactivate or demote your own account.');
    if ((deactivating || demoting) && u.role === 'admin') {
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1`, [id]);
      if (!n.n) throw conflict('This is the last active administrator. Make someone else an administrator first.');
    }
    if (deactivating) {
      const { rows: [t] } = await c.query(`SELECT count(*)::int AS n FROM transfers WHERE recipient_id = $1 AND status = 'in_transit'`, [id]);
      if (t.n) throw conflict(`${u.full_name} has ${t.n} transfer${t.n > 1 ? 's' : ''} in transit to them. Cancel or let them be received first.`);
    }
    const sets = [];
    const vals = [id];
    for (const f of ['full_name', 'role', 'phone', 'title', 'active']) {
      if (b[f] === undefined) continue;
      vals.push(b[f] === '' ? null : b[f]);
      sets.push(`${f} = $${vals.length}`);
    }
    if (sets.length) await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    const teams = await setTeams(c, id, b.team_ids);
    if (deactivating || (b.role && b.role !== u.role)) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]); // sign out everywhere
    const changes = diff(u, b, ['full_name', 'role', 'phone', 'title']);
    if (teams && JSON.stringify(teams.from) !== JSON.stringify(teams.to)) changes.team_ids = teams;
    const action = b.active === false && u.active ? 'deactivated' : b.active === true && !u.active ? 'reactivated' : 'updated';
    if (Object.keys(changes).length || action !== 'updated') await audit(c, req.user.id, 'user', id, action, changes);
  });
  const { rows: [full] } = await query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  res.json({ user: full });
});

router.post('/:id/reset-password', async (req, res) => {
  adminOnly(req);
  const id = parse(z.uuid(), req.params.id);
  const temp = tempPassword();
  const hash = await bcrypt.hash(temp, 12);
  await tx(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL
        WHERE id = $1 AND role <> 'system' AND active`, [id, hash]);
    if (!rowCount) throw notFound('Active user not found.');
    await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(c, req.user.id, 'user', id, 'password_reset');
  });
  res.json({ temporaryPassword: temp });
});

export default router;
