import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { parse, forbidden, badRequest, conflict as httpConflict } from '../lib/errors.js';
import { can, assetCode } from '../lib/roles.js';
import { SNAPSHOT_FIELDS, IDENT_FIELDS, statusFor } from '../lib/importEngine.js';
import { mapAssetType, FIELD_LABEL } from '../lib/importFields.js';
import { event } from '../lib/importCommit.js';

const router = Router();

const listSchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open'),
  severity: z.enum(['normal', 'critical']).optional(),
  import_id: z.uuid().optional(),
  asset_id: z.uuid().optional(),
});

router.get('/', async (req, res) => {
  if (!can.resolveConflicts(req.user)) throw forbidden();
  const f = parse(listSchema, req.query);
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.status !== 'all') add('c.status = ?', f.status);
  if (f.severity) add('c.severity = ?', f.severity);
  if (f.import_id) add('c.import_id = ?', f.import_id);
  if (f.asset_id) add('c.asset_id = ?', f.asset_id);
  const { rows } = await query(
    `SELECT c.id, c.asset_id, a.asset_no, a.reference, c.field, c.current_value, c.proposed_value, c.severity, c.status,
            c.created_at, c.resolved_at, c.resolved_value, c.resolution_note, ru.full_name AS resolved_by_name,
            i.filename, i.batch_id, c.row_number
       FROM asset_conflicts c
       JOIN assets a ON a.id = c.asset_id
       LEFT JOIN imports i ON i.id = c.import_id
       LEFT JOIN users ru ON ru.id = c.resolved_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (c.status = 'open') DESC, (c.severity = 'critical') DESC, c.created_at DESC, a.reference
      LIMIT 1000`, params);
  res.json({ items: rows.map((r) => ({ ...r, asset_code: assetCode(r.asset_no), field_label: FIELD_LABEL[r.field] || r.field })) });
});

const resolveSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(1000),
  choice: z.enum(['keep_current', 'use_proposed']),
  note: z.string().trim().max(500).optional(),
});

const PLAIN_FIELDS = new Set(['reference', ...SNAPSHOT_FIELDS, ...IDENT_FIELDS]);

router.post('/resolve', async (req, res) => {
  if (!can.resolveConflicts(req.user)) throw forbidden();
  const { ids, choice, note } = parse(resolveSchema, req.body);
  const resolved = await tx(async (c) => {
    let n = 0;
    for (const id of ids) {
      const { rows: [cf] } = await c.query('SELECT * FROM asset_conflicts WHERE id = $1 FOR UPDATE', [id]);
      if (!cf) throw badRequest('Conflict not found.');
      if (cf.status !== 'open') throw httpConflict('One of these conflicts was already resolved. Refresh and try again.');
      const { rows: [a] } = await c.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [cf.asset_id]);

      if (choice === 'use_proposed') {
        if (cf.field === 'current_facility') {
          if (!cf.proposed_ref) throw badRequest('This conflict has no facility to apply.');
          const { rows: [fac] } = await c.query('SELECT facility_type FROM facilities WHERE id = $1', [cf.proposed_ref]);
          const newStatus = ['at_warehouse', 'at_facility', 'under_investigation'].includes(a.status) ? statusFor(fac.facility_type) : a.status;
          await c.query('UPDATE assets SET current_facility_id = $2, status = $3, version = version + 1 WHERE id = $1', [a.id, cf.proposed_ref, newStatus]);
          await event(c, a.id, 'location_corrected', req.user.id, {
            from_facility_id: a.current_facility_id, to_facility_id: cf.proposed_ref, from_status: a.status, to_status: newStatus,
            import_id: cf.import_id, details: { reason: 'Import conflict resolved: spreadsheet location accepted', note: note || null },
          });
        } else if (cf.field === 'team') {
          await c.query('UPDATE assets SET team_id = $2, version = version + 1 WHERE id = $1', [a.id, cf.proposed_ref]);
          await event(c, a.id, 'updated', req.user.id, { import_id: cf.import_id, details: { team: { from: cf.current_value, to: cf.proposed_value } } });
        } else if (cf.field === 'assigned_rep') {
          await c.query('UPDATE assets SET assigned_rep_id = $2, version = version + 1 WHERE id = $1', [a.id, cf.proposed_ref]);
          await event(c, a.id, 'reassigned', req.user.id, { import_id: cf.import_id, details: { from: cf.current_value, to: cf.proposed_value } });
        } else if (cf.field === 'qr_value') {
          await c.query(
            `UPDATE asset_qr_codes SET active = false, unlinked_by = $2, unlinked_at = now(), unlink_reason = 'Replaced via import conflict'
              WHERE asset_id = $1 AND active`, [a.id, req.user.id]);
          await c.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)', [a.id, cf.proposed_value.trim(), req.user.id]);
          await event(c, a.id, 'qr_linked', req.user.id, { details: { qr_value: cf.proposed_value, replaced: cf.current_value } });
        } else if (PLAIN_FIELDS.has(cf.field)) {
          const extra = cf.field === 'source_type' ? ', asset_type = $3' : '';
          const vals = [a.id, cf.proposed_value];
          if (extra) vals.push(mapAssetType(cf.proposed_value));
          await c.query(`UPDATE assets SET ${cf.field} = $2${extra}, version = version + 1 WHERE id = $1`, vals);
          await event(c, a.id, 'updated', req.user.id, { import_id: cf.import_id, details: { [cf.field]: { from: cf.current_value, to: cf.proposed_value } } });
        } else {
          throw badRequest(`Field ${cf.field} cannot be applied automatically.`);
        }
      }

      await c.query(
        `UPDATE asset_conflicts SET status = 'resolved', resolved_value = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4
          WHERE id = $1`,
        [id, choice === 'use_proposed' ? cf.proposed_value : cf.current_value, req.user.id, note || null]);
      await event(c, a.id, 'conflict_resolved', req.user.id, {
        import_id: cf.import_id,
        details: { field: cf.field, choice, kept: cf.current_value, proposed: cf.proposed_value, note: note || null },
      });
      n++;
    }
    return n;
  });
  res.json({ ok: true, resolved });
});

export default router;
