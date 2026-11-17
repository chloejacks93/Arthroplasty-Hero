import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { parse, notFound } from '../lib/errors.js';
import { assetScope, assetCode } from '../lib/roles.js';

const router = Router();

export const STATUSES = ['at_warehouse', 'at_facility', 'in_transit', 'assigned_to_case', 'awaiting_receipt',
  'overdue', 'missing', 'under_investigation', 'out_of_service'];
export const ASSET_TYPES = ['tray', 'tote', 'implant_set', 'instrument_set', 'loaner_kit', 'other'];

const SORTS = {
  asset_no: 'a.asset_no',
  reference: 'upper(a.reference)',
  asset_type: 'a.asset_type',
  status: 'a.status',
  facility: 'upper(f.name)',
  rep: 'upper(r.full_name)',
  team: 'upper(tm.name)',
  lot: 'upper(a.lot)',
  last_scanned_at: 'a.last_scanned_at',
  last_transferred_at: 'a.last_transferred_at',
  total_cases_12m: 'a.total_cases_12m',
  days_since_last_case: 'a.days_since_last_case',
  consignment_fee: 'a.consignment_fee',
  updated_at: 'a.updated_at',
};

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(STATUSES).optional(),
  asset_type: z.enum(ASSET_TYPES).optional(),
  team_id: z.uuid().optional(),
  facility_id: z.uuid().optional(),
  rep_id: z.uuid().optional(),
  mine: z.enum(['1']).optional(),
  attention: z.enum(['1']).optional(),
  qr: z.enum(['linked', 'none']).optional(),
  sort: z.enum(Object.keys(SORTS)).default('reference'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

export const ATTENTION_STATUSES = ['missing', 'overdue', 'under_investigation', 'awaiting_receipt'];

/** Builds WHERE clause + params shared by list and export. */
export function buildAssetFilter(user, f) {
  const scope = assetScope(user, 1);
  const where = ['a.retired_at IS NULL', scope.sql];
  const params = [...scope.params];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.q) {
    const code = f.q.match(/^ah-?0*(\d+)$/i);
    if (code) add('a.asset_no = ?', Number(code[1]));
    else {
      add(`(a.reference ILIKE ? OR a.description ILIKE ? OR a.lot ILIKE ? OR a.serial_number ILIKE ?
            OR f.name ILIKE ? OR r.full_name ILIKE ? OR a.source_location ILIKE ?
            OR a.catalog_number ILIKE ? OR a.batch_number ILIKE ? OR a.notes ILIKE ?
            OR EXISTS (SELECT 1 FROM asset_qr_codes q WHERE q.asset_id = a.id AND q.active AND q.qr_value ILIKE ?))`,
      `%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
    }
  }
  if (f.status) add('a.status = ?', f.status);
  if (f.asset_type) add('a.asset_type = ?', f.asset_type);
  if (f.team_id) add('a.team_id = ?', f.team_id);
  if (f.facility_id) add('a.current_facility_id = ?', f.facility_id);
  if (f.rep_id) add('a.assigned_rep_id = ?', f.rep_id);
  if (f.mine) add('(a.assigned_rep_id = ? OR a.custodian_id = ?)', user.id);
  if (f.attention) add('a.status = ANY(?)', ATTENTION_STATUSES);
  if (f.qr) where.push(`${f.qr === 'none' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM asset_qr_codes qq WHERE qq.asset_id = a.id AND qq.active)`);
  return { where: where.join(' AND '), params };
}

export const ASSET_FROM = `
  FROM assets a
  LEFT JOIN facilities f  ON f.id = a.current_facility_id
  LEFT JOIN facilities w  ON w.id = a.warehouse_id
  LEFT JOIN users r       ON r.id = a.assigned_rep_id
  LEFT JOIN users c       ON c.id = a.custodian_id
  LEFT JOIN teams tm      ON tm.id = a.team_id
  LEFT JOIN asset_qr_codes q ON q.asset_id = a.id AND q.active`;

export const ASSET_COLUMNS = `
  a.id, a.asset_no, a.reference, a.description, a.asset_type, a.status, a.lot, a.serial_number,
  a.team_id, tm.name AS team_name,
  a.current_facility_id, f.name AS facility_name, f.facility_type,
  a.warehouse_id, w.name AS warehouse_name,
  a.assigned_rep_id, r.full_name AS rep_name,
  a.custodian_id, c.full_name AS custodian_name,
  q.qr_value, a.last_scanned_at, a.last_transferred_at, a.return_date, a.consignment_fee,
  a.total_cases_12m, a.days_since_last_case, a.set_utilization_factor, a.updated_at`;

router.get('/', async (req, res) => {
  const f = parse(listSchema, req.query);
  const { where, params } = buildAssetFilter(req.user, f);
  const order = `${SORTS[f.sort]} ${f.dir} NULLS LAST, a.asset_no ASC`;
  const offset = (f.page - 1) * f.pageSize;
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(`SELECT ${ASSET_COLUMNS} ${ASSET_FROM} WHERE ${where} ORDER BY ${order}
           LIMIT ${f.pageSize} OFFSET ${offset}`, params),
    query(`SELECT count(*)::int AS total ${ASSET_FROM} WHERE ${where}`, params),
  ]);
  res.json({
    items: rows.map((r) => ({ ...r, asset_code: assetCode(r.asset_no) })),
    total: countRows[0].total,
    page: f.page,
    pageSize: f.pageSize,
  });
});

router.get('/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const scope = assetScope(req.user, 2);
  const { rows } = await query(
    `SELECT a.*, tm.name AS team_name, f.name AS facility_name, f.facility_type, w.name AS warehouse_name,
            r.full_name AS rep_name, r.email AS rep_email, r.phone AS rep_phone,
            c.full_name AS custodian_name, q.qr_value, q.linked_at AS qr_linked_at
       ${ASSET_FROM} WHERE a.id = $1 AND ${scope.sql}`,
    [id, ...scope.params],
  );
  if (!rows[0]) throw notFound('Asset not found or not visible to you.');
  const asset = { ...rows[0], asset_code: assetCode(rows[0].asset_no) };

  const [events, transfers, sources, conflicts] = await Promise.all([
    query(
      `SELECT e.id, e.event_type, e.occurred_at, e.from_status, e.to_status, e.details,
              u.full_name AS actor_name, ff.name AS from_facility, tf.name AS to_facility,
              fc.full_name AS from_custodian, tc.full_name AS to_custodian
         FROM asset_events e
         JOIN users u ON u.id = e.actor_id
         LEFT JOIN facilities ff ON ff.id = e.from_facility_id
         LEFT JOIN facilities tf ON tf.id = e.to_facility_id
         LEFT JOIN users fc ON fc.id = e.from_custodian_id
         LEFT JOIN users tc ON tc.id = e.to_custodian_id
        WHERE e.asset_id = $1 ORDER BY e.occurred_at DESC, e.id DESC LIMIT 200`, [id]),
    query(
      `SELECT t.id, t.transfer_no, t.status, t.initiated_at, t.received_at, t.accept_by, t.reason,
              ff.name AS from_facility, tf.name AS to_facility,
              s.full_name AS sender_name, rc.full_name AS recipient_name
         FROM transfers t
         LEFT JOIN facilities ff ON ff.id = t.from_facility_id
         JOIN facilities tf ON tf.id = t.to_facility_id
         JOIN users s ON s.id = t.sender_id
         JOIN users rc ON rc.id = t.recipient_id
        WHERE t.asset_id = $1 ORDER BY t.initiated_at DESC LIMIT 50`, [id]),
    query(
      `SELECT s.field, s.value, s.recorded_at, i.filename
         FROM asset_field_sources s JOIN imports i ON i.id = s.import_id
        WHERE s.asset_id = $1 ORDER BY s.field, s.recorded_at`, [id]),
    query(`SELECT id, field, current_value, proposed_value, severity, status, created_at
             FROM asset_conflicts WHERE asset_id = $1 AND status = 'open' ORDER BY created_at`, [id]),
  ]);
  res.json({ asset, events: events.rows, transfers: transfers.rows, sources: sources.rows, conflicts: conflicts.rows });
});

export default router;
