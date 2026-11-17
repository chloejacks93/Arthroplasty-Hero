import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { parse, forbidden, notFound, conflict, badRequest } from '../lib/errors.js';
import { can, assetCode } from '../lib/roles.js';
import { canonicalQr } from '../lib/qr.js';
import { event } from '../lib/importCommit.js';
import { statusFor } from '../lib/importEngine.js';
import { notifyRoles, notifyUsers, MANAGERS } from '../lib/notify.js';

const router = Router();

export const KINDS = {
  missing: { label: 'Missing / can’t find it', status: 'missing', notify: 'asset_missing' },
  unauthorized_movement: { label: 'Moved without a transfer', status: 'under_investigation', notify: 'unauthorized_movement' },
  location_discrepancy: { label: 'Wrong location on record', status: 'under_investigation', notify: 'location_discrepancy' },
  damaged: { label: 'Damaged', status: null, notify: 'problem_reported' },
  incomplete: { label: 'Incomplete / items missing', status: null, notify: 'problem_reported' },
  unknown_qr: { label: 'Label not recognised', status: null, notify: 'problem_reported' },
  other: { label: 'Something else', status: null, notify: 'problem_reported' },
};

const SELECT = `
  SELECT i.id, i.case_ref, i.kind, i.status, i.description, i.reported_at, i.resolved_at, i.resolution, i.updated_at,
         i.asset_id, a.asset_no, a.reference, a.status AS asset_status, i.qr_value,
         i.facility_id, f.name AS facility_name, af.name AS asset_facility_name,
         i.reported_by, ru.full_name AS reported_by_name, i.assigned_to, au.full_name AS assigned_to_name,
         xu.full_name AS resolved_by_name, i.transfer_id, t.transfer_no, i.asset_status_before
    FROM investigations i
    LEFT JOIN assets a ON a.id = i.asset_id
    LEFT JOIN facilities f ON f.id = i.facility_id
    LEFT JOIN facilities af ON af.id = a.current_facility_id
    JOIN users ru ON ru.id = i.reported_by
    LEFT JOIN users au ON au.id = i.assigned_to
    LEFT JOIN users xu ON xu.id = i.resolved_by
    LEFT JOIN transfers t ON t.id = i.transfer_id`;
const tag = (r) => ({ ...r, asset_code: assetCode(r.asset_no), kind_label: KINDS[r.kind]?.label || r.kind });

// ---------------------------------------------------------------------
// Report a problem (any signed-in user; physical possession is enough)
// ---------------------------------------------------------------------
const reportSchema = z.object({
  asset_id: z.uuid().optional(),
  qr_value: z.string().max(2000).optional(),
  kind: z.enum(Object.keys(KINDS)),
  facility_id: z.uuid().optional(),
  description: z.string().trim().max(1000).optional(),
}).refine((b) => b.asset_id || b.qr_value, { message: 'Choose the asset or scan its label.', path: ['asset_id'] });

router.post('/', async (req, res) => {
  const b = parse(reportSchema, req.body);
  if (['other', 'damaged', 'incomplete'].includes(b.kind) && !b.description) throw badRequest('Describe the problem in a few words.');
  const inv = await tx(async (c) => {
    let asset = null;
    if (b.asset_id) {
      ({ rows: [asset] } = await c.query('SELECT * FROM assets WHERE id = $1 AND retired_at IS NULL FOR UPDATE', [b.asset_id]));
      if (!asset) throw notFound('Asset not found.');
    }
    if (b.facility_id) {
      const { rowCount } = await c.query('SELECT 1 FROM facilities WHERE id = $1', [b.facility_id]);
      if (!rowCount) throw badRequest('Unknown facility.');
    }
    const qr = b.qr_value ? canonicalQr(b.qr_value) : null;
    const k = KINDS[b.kind];
    // An asset in transit keeps its transfer status; the report is still recorded.
    const newStatus = asset && k.status && asset.status !== 'in_transit' ? k.status : null;
    const { rows: [i] } = await c.query(
      `INSERT INTO investigations (asset_id, qr_value, kind, facility_id, reported_by, description, asset_status_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, case_ref`,
      [asset?.id || null, qr, b.kind, b.facility_id || null, req.user.id, b.description || null, asset?.status || null]);
    await c.query(`INSERT INTO investigation_events (investigation_id, actor_id, action, to_status, note) VALUES ($1,$2,'reported','open',$3)`,
      [i.id, req.user.id, b.description || null]);
    if (asset) {
      if (newStatus && newStatus !== asset.status) {
        await c.query('UPDATE assets SET status = $2, version = version + 1 WHERE id = $1', [asset.id, newStatus]);
      }
      await event(c, asset.id, 'problem_reported', req.user.id, {
        from_status: asset.status, to_status: newStatus || asset.status, investigation_id: i.id,
        to_facility_id: b.kind === 'unauthorized_movement' || b.kind === 'location_discrepancy' ? b.facility_id : null,
        details: { kind: b.kind, case_ref: i.case_ref, description: b.description || null, observed_facility_id: b.facility_id || null },
      });
    }
    await notifyRoles(c, MANAGERS, {
      kind: k.notify, title: `Problem reported: ${asset ? asset.reference : 'unlinked label'}`,
      body: `${req.user.full_name}: ${k.label}${b.description ? `. ${b.description}` : ''}`,
      asset_id: asset?.id, link: `/investigations/${i.id}`, dedupe_key: `inv:${i.id}`,
    }, { except: [req.user.id] });
    return i;
  });
  res.status(201).json({ id: inv.id, case_ref: inv.case_ref });
});

// ---------------------------------------------------------------------
// List / detail
// ---------------------------------------------------------------------
router.get('/', async (req, res) => {
  const status = parse(z.enum(['open', 'closed', 'all']).default('open'), req.query.status);
  const where = [];
  const params = [];
  if (status === 'open') where.push(`i.status IN ('open','investigating')`);
  if (status === 'closed') where.push(`i.status IN ('resolved','dismissed')`);
  if (!can.investigate(req.user)) { params.push(req.user.id); where.push(`i.reported_by = $${params.length}`); }
  if (req.query.asset_id) { params.push(parse(z.uuid(), req.query.asset_id)); where.push(`i.asset_id = $${params.length}`); }
  const { rows } = await query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY (i.status IN ('open','investigating')) DESC, i.reported_at DESC LIMIT 500`, params);
  res.json({ items: rows.map(tag), kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])) });
});

router.get('/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { rows: [i] } = await query(`${SELECT} WHERE i.id = $1`, [id]);
  if (!i) throw notFound('Investigation not found.');
  if (!can.investigate(req.user) && i.reported_by !== req.user.id) throw notFound('Investigation not found.');
  const { rows: events } = await query(
    `SELECT e.id, e.action, e.occurred_at, e.from_status, e.to_status, e.note, u.full_name AS actor_name
       FROM investigation_events e JOIN users u ON u.id = e.actor_id WHERE e.investigation_id = $1 ORDER BY e.occurred_at, e.id`, [id]);
  res.json({ investigation: tag(i), events, canManage: can.investigate(req.user) });
});

// ---------------------------------------------------------------------
// Work an investigation (management / inventory)
// ---------------------------------------------------------------------
const updateSchema = z.object({
  action: z.enum(['note', 'investigating', 'resolve', 'dismiss', 'reopen', 'assign_self']),
  note: z.string().trim().max(1000).optional(),
  correct_facility_id: z.uuid().optional(),
  set_status: z.enum(['restore', 'at_facility', 'at_warehouse', 'missing', 'out_of_service']).optional(),
});

router.post('/:id/update', async (req, res) => {
  if (!can.investigate(req.user)) throw forbidden();
  const id = parse(z.uuid(), req.params.id);
  const b = parse(updateSchema, req.body);
  if (['note', 'resolve', 'dismiss'].includes(b.action) && !b.note) throw badRequest('Add a note explaining the outcome.');
  await tx(async (c) => {
    const { rows: [i] } = await c.query('SELECT * FROM investigations WHERE id = $1 FOR UPDATE', [id]);
    if (!i) throw notFound('Investigation not found.');
    const closed = ['resolved', 'dismissed'].includes(i.status);
    if (closed && b.action !== 'reopen' && b.action !== 'note') throw conflict('This investigation is closed. Reopen it first.');
    if (!closed && b.action === 'reopen') throw conflict('This investigation is already open.');

    const log = (action, toStatus, note) => c.query(
      `INSERT INTO investigation_events (investigation_id, actor_id, action, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.user.id, action, i.status, toStatus, note || null]);

    if (b.action === 'note') return log('note', i.status, b.note);
    if (b.action === 'assign_self') {
      await c.query(`UPDATE investigations SET assigned_to = $2, status = CASE WHEN status = 'open' THEN 'investigating' ELSE status END WHERE id = $1`, [id, req.user.id]);
      return log('assigned', i.status === 'open' ? 'investigating' : i.status, b.note);
    }
    if (b.action === 'investigating') {
      await c.query(`UPDATE investigations SET status = 'investigating' WHERE id = $1`, [id]);
      return log('status_changed', 'investigating', b.note);
    }
    if (b.action === 'reopen') {
      await c.query(`UPDATE investigations SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolution = NULL WHERE id = $1`, [id]);
      return log('reopened', 'open', b.note);
    }

    // resolve / dismiss
    const toStatus = b.action === 'resolve' ? 'resolved' : 'dismissed';
    await c.query(`UPDATE investigations SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now() WHERE id = $1`,
      [id, toStatus, b.note, req.user.id]);
    await log(b.action === 'resolve' ? 'resolved' : 'dismissed', toStatus, b.note);

    if (i.asset_id) {
      const { rows: [a] } = await c.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [i.asset_id]);
      let facility = a.current_facility_id;
      let status = a.status;
      if (b.correct_facility_id) {
        const { rows: [fac] } = await c.query('SELECT id, facility_type FROM facilities WHERE id = $1 AND active', [b.correct_facility_id]);
        if (!fac) throw badRequest('Choose an active facility.');
        facility = fac.id;
        status = statusFor(fac.facility_type);
      }
      if (b.set_status === 'restore') status = i.asset_status_before && i.asset_status_before !== 'in_transit' ? i.asset_status_before : status;
      else if (b.set_status) status = b.set_status;
      else if (!b.correct_facility_id && ['missing', 'under_investigation'].includes(a.status) && i.asset_status_before
        && !['missing', 'under_investigation', 'in_transit'].includes(i.asset_status_before)) {
        status = i.asset_status_before; // default: put the asset back the way it was
      }
      if (a.status === 'in_transit') status = 'in_transit'; // an open transfer owns the status
      if (facility !== a.current_facility_id || status !== a.status) {
        await c.query('UPDATE assets SET current_facility_id = $2, status = $3, version = version + 1 WHERE id = $1', [a.id, facility, status]);
        await event(c, a.id, facility !== a.current_facility_id ? 'location_corrected' : 'status_changed', req.user.id, {
          from_facility_id: a.current_facility_id, to_facility_id: facility, from_status: a.status, to_status: status,
          investigation_id: id, details: { reason: `Investigation #${i.case_ref} ${toStatus}`, note: b.note },
        });
      }
      await event(c, a.id, 'investigation_updated', req.user.id, { investigation_id: id, details: { case_ref: i.case_ref, status: toStatus, note: b.note } });
    }
    if (i.reported_by !== req.user.id) {
      await notifyUsers(c, [i.reported_by], {
        kind: 'problem_reported', title: `Your report #${i.case_ref} was ${toStatus}`, body: b.note,
        asset_id: i.asset_id, link: `/investigations/${id}`, dedupe_key: `invclosed:${id}:${Date.now()}`,
      });
    }
    return null;
  });
  res.json({ ok: true });
});

export default router;
