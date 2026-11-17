import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { parse, forbidden, notFound, conflict } from '../lib/errors.js';
import { can, assetScope, assetCode } from '../lib/roles.js';
import { audit, diff } from '../lib/audit.js';

const router = Router();
const TYPES = ['warehouse', 'hospital', 'surgery_center', 'clinic', 'other'];

// Asset counts per facility, limited to what the signed-in user may see.
function countsSql(user, offset) {
  const scope = assetScope(user, offset);
  return {
    sql: `
      SELECT a.current_facility_id AS facility_id,
             count(*)::int AS assets,
             count(*) FILTER (WHERE a.asset_type = 'tray')::int AS trays,
             count(*) FILTER (WHERE a.asset_type = 'tote')::int AS totes,
             count(*) FILTER (WHERE a.asset_type NOT IN ('tray','tote'))::int AS other_types,
             count(*) FILTER (WHERE a.status = 'assigned_to_case')::int AS on_case,
             count(*) FILTER (WHERE a.status = 'missing')::int AS missing,
             count(*) FILTER (WHERE a.status = 'overdue' OR (a.return_date < current_date AND a.status NOT IN ('at_warehouse','out_of_service')))::int AS overdue,
             count(*) FILTER (WHERE a.status = 'under_investigation')::int AS investigating,
             count(DISTINCT a.assigned_rep_id)::int AS reps,
             coalesce(sum(a.consignment_fee), 0)::numeric AS consignment_fees
        FROM assets a
       WHERE a.retired_at IS NULL AND ${scope.sql}
       GROUP BY a.current_facility_id`,
    params: scope.params,
  };
}

router.get('/', async (req, res) => {
  const f = parse(z.object({
    q: z.string().trim().max(100).optional(),
    type: z.enum(TYPES).optional(),
    status: z.enum(['active', 'inactive', 'all']).default('active'),
  }), req.query);
  const c = countsSql(req.user, 1);
  const params = [...c.params];
  const where = [];
  if (f.status !== 'all') where.push(f.status === 'active' ? 'f.active' : 'NOT f.active');
  if (f.type) { params.push(f.type); where.push(`f.facility_type = $${params.length}`); }
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(f.name ILIKE $${params.length} OR f.city ILIKE $${params.length})`); }
  const { rows } = await query(
    `WITH c AS (${c.sql}),
          inbound AS (SELECT to_facility_id AS facility_id, count(*)::int AS n FROM transfers WHERE status = 'in_transit' GROUP BY 1)
     SELECT f.id, f.name, f.facility_type, f.code, f.city, f.state, f.active,
            coalesce(c.assets, 0) AS assets, coalesce(c.trays, 0) AS trays, coalesce(c.totes, 0) AS totes,
            coalesce(c.missing, 0) + coalesce(c.overdue, 0) + coalesce(c.investigating, 0) AS exceptions,
            coalesce(c.reps, 0) AS reps, coalesce(inbound.n, 0) AS incoming
       FROM facilities f LEFT JOIN c ON c.facility_id = f.id LEFT JOIN inbound ON inbound.facility_id = f.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY f.active DESC, (f.facility_type = 'warehouse') DESC, coalesce(c.assets, 0) DESC, f.name`, params);
  res.json({ items: rows, canEdit: can.administer(req.user) });
});

router.get('/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { rows: [fac] } = await query('SELECT * FROM facilities WHERE id = $1', [id]);
  if (!fac) throw notFound('Facility not found.');
  const c = countsSql(req.user, 2);
  const scope = assetScope(req.user, 2);
  const transferSql = (dir) => `
    SELECT t.id, t.transfer_no, t.initiated_at, t.accept_by, (t.accept_by < now()) AS overdue,
           a.id AS asset_id, a.asset_no, a.reference, ff.name AS from_facility, tf.name AS to_facility,
           s.full_name AS sender_name, rc.full_name AS recipient_name
      FROM transfers t JOIN assets a ON a.id = t.asset_id
      LEFT JOIN facilities ff ON ff.id = t.from_facility_id JOIN facilities tf ON tf.id = t.to_facility_id
      JOIN users s ON s.id = t.sender_id JOIN users rc ON rc.id = t.recipient_id
     WHERE t.status = 'in_transit' AND t.${dir}_facility_id = $1 AND (${scope.sql})
     ORDER BY t.initiated_at DESC LIMIT 100`;
  const [counts, incoming, outgoing, reps] = await Promise.all([
    query(`SELECT * FROM (${c.sql}) x WHERE facility_id = $1`, [id, ...c.params]),
    query(transferSql('to'), [id, ...scope.params]),
    query(transferSql('from'), [id, ...scope.params]),
    query(
      `SELECT u.id, u.full_name, u.phone, u.email, count(*)::int AS assets
         FROM assets a JOIN users u ON u.id = a.assigned_rep_id
        WHERE a.current_facility_id = $1 AND a.retired_at IS NULL AND (${scope.sql})
        GROUP BY u.id ORDER BY count(*) DESC, u.full_name`, [id, ...scope.params]),
  ]);
  const tag = (r) => ({ ...r, asset_code: assetCode(r.asset_no) });
  res.json({
    facility: fac,
    counts: counts.rows[0] || { assets: 0, trays: 0, totes: 0, other_types: 0, on_case: 0, missing: 0, overdue: 0, investigating: 0, reps: 0, consignment_fees: 0 },
    incoming: incoming.rows.map(tag),
    outgoing: outgoing.rows.map(tag),
    reps: reps.rows,
    canEdit: can.administer(req.user),
  });
});

const schema = z.object({
  name: z.string().trim().min(2).max(150),
  facility_type: z.enum(TYPES),
  code: z.string().trim().max(30).nullable().optional(),
  address_line: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  state: z.string().trim().max(40).nullable().optional(),
  postal_code: z.string().trim().max(20).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});
const FIELDS = ['name', 'facility_type', 'code', 'address_line', 'city', 'state', 'postal_code', 'phone', 'notes', 'active'];

async function nameTaken(c, name, exceptId) {
  const { rowCount } = await c.query('SELECT 1 FROM facilities WHERE lower(btrim(name)) = lower(btrim($1)) AND id <> coalesce($2, gen_random_uuid())', [name, exceptId || null]);
  if (rowCount) throw conflict(`A facility named “${name}” already exists.`);
}

router.post('/', async (req, res) => {
  if (!can.administer(req.user)) throw forbidden();
  const b = parse(schema, req.body);
  const row = await tx(async (c) => {
    await nameTaken(c, b.name);
    const keys = FIELDS.filter((f) => f !== 'active' && b[f] !== undefined);
    const { rows: [r] } = await c.query(
      `INSERT INTO facilities (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => (b[k] === '' ? null : b[k])));
    await audit(c, req.user.id, 'facility', r.id, 'created', { name: b.name, facility_type: b.facility_type });
    return r;
  });
  res.status(201).json({ facility: row });
});

router.patch('/:id', async (req, res) => {
  if (!can.administer(req.user)) throw forbidden();
  const id = parse(z.uuid(), req.params.id);
  const b = parse(schema.partial(), req.body);
  const row = await tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM facilities WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw notFound('Facility not found.');
    if (b.name) await nameTaken(c, b.name, id);
    if (b.active === false && cur.active) {
      const { rows: [n] } = await c.query(
        `SELECT (SELECT count(*)::int FROM assets WHERE current_facility_id = $1 AND retired_at IS NULL) AS assets,
                (SELECT count(*)::int FROM transfers WHERE to_facility_id = $1 AND status = 'in_transit') AS transfers`, [id]);
      if (n.assets || n.transfers) {
        throw conflict(`${cur.name} still has ${n.assets} asset${n.assets === 1 ? '' : 's'} and ${n.transfers} incoming transfer${n.transfers === 1 ? '' : 's'}. Move them first.`);
      }
    }
    const sets = [];
    const vals = [id];
    for (const f of FIELDS) {
      if (b[f] === undefined) continue;
      vals.push(b[f] === '' ? null : b[f]);
      sets.push(`${f} = $${vals.length}`);
    }
    if (!sets.length) return cur;
    const { rows: [r] } = await c.query(`UPDATE facilities SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    const action = b.active === false && cur.active ? 'deactivated' : b.active === true && !cur.active ? 'reactivated' : 'updated';
    await audit(c, req.user.id, 'facility', id, action, diff(cur, b, FIELDS.filter((x) => x !== 'active')));
    return r;
  });
  res.json({ facility: row });
});

export default router;
