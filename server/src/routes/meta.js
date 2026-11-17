import { Router } from 'express';
import { query } from '../db.js';
import { can } from '../lib/roles.js';

// Lookup lists used by filters and pickers (active records only), plus
// navigation badge counts for the signed-in user's role.
const router = Router();

router.get('/', async (req, res) => {
  const [teams, facilities, reps, conflicts, qrRequests, personal, pendingImports] = await Promise.all([
    query(`SELECT id, name, code FROM teams WHERE active ORDER BY name`),
    query(`SELECT id, name, facility_type, city, state FROM facilities WHERE active ORDER BY name`),
    query(`SELECT id, full_name, role FROM users WHERE active AND role <> 'system' ORDER BY full_name`),
    can.resolveConflicts(req.user)
      ? query(`SELECT count(*)::int AS n FROM asset_conflicts WHERE status = 'open'`)
      : Promise.resolve({ rows: [{ n: 0 }] }),
    can.linkQr(req.user)
      ? query(`SELECT count(*)::int AS n FROM qr_link_requests WHERE status = 'pending'`)
      : Promise.resolve({ rows: [{ n: 0 }] }),
    query(
      `SELECT (SELECT count(*)::int FROM transfers WHERE recipient_id = $1 AND status = 'in_transit') AS incoming,
              (SELECT count(*)::int FROM transfers WHERE sender_id = $1 AND status = 'in_transit') AS outgoing,
              (SELECT count(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL) AS unread,
              (SELECT count(*)::int FROM investigations WHERE status IN ('open','investigating')
                 AND ($2 OR reported_by = $1)) AS investigations`, [req.user.id, can.investigate(req.user)]),
    can.importData(req.user)
      ? query(`SELECT count(*)::int AS n FROM import_batches WHERE status = 'preview'`)
      : Promise.resolve({ rows: [{ n: 0 }] }),
  ]);
  res.json({
    teams: teams.rows,
    facilities: facilities.rows,
    users: reps.rows,
    counts: {
      openConflicts: conflicts.rows[0].n, pendingQrRequests: qrRequests.rows[0].n, pendingImports: pendingImports.rows[0].n,
      incomingTransfers: personal.rows[0].incoming, outgoingTransfers: personal.rows[0].outgoing,
      unreadNotifications: personal.rows[0].unread, openInvestigations: personal.rows[0].investigations,
    },
    permissions: { importData: can.importData(req.user), resolveConflicts: can.resolveConflicts(req.user), linkQr: can.linkQr(req.user), investigate: can.investigate(req.user) },
    me: { id: req.user.id },
  });
});

export default router;
