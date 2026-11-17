import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { parse, forbidden, notFound, conflict } from '../lib/errors.js';
import { can } from '../lib/roles.js';
import { audit, diff } from '../lib/audit.js';

const router = Router();

router.get('/', async (req, res) => {
  const status = parse(z.enum(['active', 'inactive', 'all']).default('active'), req.query.status);
  const params = [];
  const where = [];
  if (status !== 'all') where.push(status === 'active' ? 't.active' : 'NOT t.active');
  if (!can.viewAll(req.user)) { params.push(req.user.id); where.push(`t.id IN (SELECT team_id FROM user_teams WHERE user_id = $${params.length})`); }
  const { rows } = await query(
    `SELECT t.id, t.name, t.code, t.description, t.active, t.created_at,
            (SELECT count(*)::int FROM user_teams ut JOIN users u ON u.id = ut.user_id WHERE ut.team_id = t.id AND u.active) AS members,
            count(a.id)::int AS assets,
            count(a.id) FILTER (WHERE a.asset_type = 'tray')::int AS trays,
            count(a.id) FILTER (WHERE a.asset_type = 'tote')::int AS totes,
            count(a.id) FILTER (WHERE a.status = 'in_transit')::int AS in_transit,
            count(a.id) FILTER (WHERE a.status IN ('missing','overdue','under_investigation'))::int AS exceptions
       FROM teams t LEFT JOIN assets a ON a.team_id = t.id AND a.retired_at IS NULL
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY t.id ORDER BY t.active DESC, t.name`, params);
  res.json({ items: rows, canEdit: can.administer(req.user) });
});

const schema = z.object({
  name: z.string().trim().min(2).max(100),
  code: z.string().trim().max(20).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  active: z.boolean().optional(),
});

async function nameTaken(c, name, exceptId) {
  const { rowCount } = await c.query('SELECT 1 FROM teams WHERE lower(btrim(name)) = lower(btrim($1)) AND id <> coalesce($2, gen_random_uuid())', [name, exceptId || null]);
  if (rowCount) throw conflict(`A team named “${name}” already exists.`);
}

router.post('/', async (req, res) => {
  if (!can.administer(req.user)) throw forbidden();
  const b = parse(schema, req.body);
  const t = await tx(async (c) => {
    await nameTaken(c, b.name);
    const { rows: [row] } = await c.query('INSERT INTO teams (name, code, description) VALUES ($1,$2,$3) RETURNING *', [b.name, b.code || null, b.description || null]);
    await audit(c, req.user.id, 'team', row.id, 'created', { name: b.name });
    return row;
  });
  res.status(201).json({ team: t });
});

router.patch('/:id', async (req, res) => {
  if (!can.administer(req.user)) throw forbidden();
  const id = parse(z.uuid(), req.params.id);
  const b = parse(schema.partial(), req.body);
  const t = await tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw notFound('Team not found.');
    if (b.name) await nameTaken(c, b.name, id);
    const sets = [];
    const vals = [id];
    for (const f of ['name', 'code', 'description', 'active']) {
      if (b[f] === undefined) continue;
      vals.push(b[f] === '' ? null : b[f]);
      sets.push(`${f} = $${vals.length}`);
    }
    if (!sets.length) return cur;
    const { rows: [row] } = await c.query(`UPDATE teams SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    const action = b.active === false && cur.active ? 'deactivated' : b.active === true && !cur.active ? 'reactivated' : 'updated';
    await audit(c, req.user.id, 'team', id, action, diff(cur, b, ['name', 'code', 'description']));
    return row;
  });
  res.json({ team: t });
});

export default router;
