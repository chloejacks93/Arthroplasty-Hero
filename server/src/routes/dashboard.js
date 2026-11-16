import { Router } from 'express';
import { query } from '../db.js';
import { assetScope, assetCode } from '../lib/roles.js';
import { ATTENTION_STATUSES } from './assets.js';

const router = Router();

router.get('/', async (req, res) => {
  const scope = assetScope(req.user, 1);
  const base = `FROM assets a WHERE a.retired_at IS NULL AND ${scope.sql}`;

  const [kpi, byFacility, attention, pendingTransfers, recent] = await Promise.all([
    query(
      `SELECT count(*)::int                                                     AS total,
              count(*) FILTER (WHERE a.asset_type = 'tray')::int                AS trays,
              count(*) FILTER (WHERE a.asset_type = 'tote')::int                AS totes,
              count(*) FILTER (WHERE a.status = 'at_warehouse')::int            AS at_warehouse,
              count(*) FILTER (WHERE a.status IN ('at_facility','assigned_to_case'))::int AS at_facilities,
              count(*) FILTER (WHERE a.status = 'in_transit')::int              AS in_transit,
              count(*) FILTER (WHERE a.status = 'missing')::int                 AS missing,
              count(*) FILTER (WHERE a.status = 'overdue'
                               OR (a.return_date < current_date AND a.status NOT IN ('at_warehouse','out_of_service')))::int AS overdue,
              count(*) FILTER (WHERE a.status = 'under_investigation')::int     AS investigating,
              count(*) FILTER (WHERE a.status = 'assigned_to_case')::int        AS on_case,
              count(*) FILTER (WHERE a.status = 'out_of_service')::int          AS out_of_service,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM asset_qr_codes q WHERE q.asset_id = a.id AND q.active))::int AS unlinked_qr
         ${base}`, scope.params),
    query(
      `SELECT f.id, f.name, f.facility_type, count(*)::int AS count,
              count(*) FILTER (WHERE a.status IN ('missing','overdue','under_investigation'))::int AS exceptions
         FROM assets a JOIN facilities f ON f.id = a.current_facility_id
        WHERE a.retired_at IS NULL AND ${scope.sql}
        GROUP BY f.id ORDER BY count DESC, f.name LIMIT 8`, scope.params),
    query(
      `SELECT a.id, a.asset_no, a.reference, a.status, a.asset_type, f.name AS facility_name, r.full_name AS rep_name,
              a.updated_at
         FROM assets a
         LEFT JOIN facilities f ON f.id = a.current_facility_id
         LEFT JOIN users r ON r.id = a.assigned_rep_id
        WHERE a.retired_at IS NULL AND ${scope.sql} AND a.status = ANY($${scope.params.length + 1})
        ORDER BY array_position($${scope.params.length + 1}::text[], a.status), a.updated_at DESC LIMIT 8`,
      [...scope.params, ['missing', 'overdue', 'under_investigation', 'awaiting_receipt']]),
    query(
      `SELECT count(*)::int AS awaiting,
              count(*) FILTER (WHERE t.accept_by < now())::int AS past_deadline
         FROM transfers t JOIN assets a ON a.id = t.asset_id
        WHERE t.status = 'in_transit' AND ${scope.sql}`, scope.params),
    query(
      `SELECT e.id, e.event_type, e.occurred_at, a.id AS asset_id, a.asset_no, a.reference,
              u.full_name AS actor_name, tf.name AS to_facility
         FROM asset_events e
         JOIN assets a ON a.id = e.asset_id
         JOIN users u ON u.id = e.actor_id
         LEFT JOIN facilities tf ON tf.id = e.to_facility_id
        WHERE ${scope.sql}
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT 10`, scope.params),
  ]);

  const tag = (rows) => rows.map((r) => ({ ...r, asset_code: assetCode(r.asset_no) }));
  res.json({
    kpis: { ...kpi.rows[0], ...pendingTransfers.rows[0] },
    byFacility: byFacility.rows,
    attention: tag(attention.rows),
    recent: tag(recent.rows),
    attentionStatuses: ATTENTION_STATUSES,
  });
});

export default router;
